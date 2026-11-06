"""Leakage-aware R5 classification and causal store-level issue detection."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Mapping

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import f1_score, precision_score
from sklearn.pipeline import FeatureUnion
from sklearn.svm import LinearSVC


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_PATH = PROJECT_ROOT / "ml" / "artifacts" / "r5_tfidf_classifier.joblib"
PREDICTION_COLUMNS = ["feedback_id", "issue_type_id", "severity", "actionable"]
FLAG_COLUMNS = ["as_of_week_start", "store_id", "issue_type_id", "confidence", "evidence_feedback_ids"]
FLAG_DIAGNOSTIC_COLUMNS = [
    "as_of_week_start", "store_id", "issue_type_id", "category", "independent_feedback_count",
    "current_rate_per_1000_footfall", "rolling_mean_per_1000_footfall",
    "ewma_baseline_per_1000_footfall", "baseline_std_per_1000_footfall",
    "ewma_z_score", "rate_lift", "evidence_feedback_ids",
]
FLAG_COOLDOWN_WEEKS = 2
SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
NON_ISSUE_IDS = {"NI01", "NI02", "NI03"}
SVM_C = 0.5
SVM_MAX_ITER = 2000
SVM_TOL = 1e-3

_ALLERGEN_TERM = re.compile(
    r"\b(?:allergen|allergy|allergic|peanuts?|tree nuts?|sesame|milk allergy|dairy allergy|"
    r"egg allergy|soy allergy|wheat allergy)\b",
    re.I,
)
_ALLERGEN_ERROR = re.compile(
    r"\b(?:wrong|incorrect|missing|omits?|omitted|undeclared|not declared|not listed|"
    r"label(?:ling|ing)? error|allergic reaction|reaction|expos(?:e|ed|ure)|ate|eaten|contains?)\b",
    re.I,
)
_MISCONDUCT = re.compile(
    r"\b(?:threat(?:en|ened|ening)?|harass(?:ment|ed|ing)?|abus(?:e|ed|ive)|assault(?:ed)?|"
    r"misconduct|bully(?:ing|ied)?|discriminat(?:e|ed|ion)|cheat(?:ed|ing)|stole|theft)\b",
    re.I,
)
_HYGIENE = re.compile(
    r"\b(?:hygiene|hygienic|unhygienic|sanitation|unsanitary|pests?|cockroaches?|rats?|"
    r"flies|dirty hands|unwashed hands|dirty food area|foul smell|bad smell|badbu|naatram)\b",
    re.I,
)
_CONTAMINATION = re.compile(
    r"\b(?:contaminat(?:ed|ion)|foreign object|worm|insect|cockroach|hair in (?:the )?food|"
    r"glass (?:piece|in)|metal (?:piece|in)|stone in (?:the )?food)\b",
    re.I,
)
_PHYSICAL_HAZARD = re.compile(
    r"\b(?:wet floor|slippery|slip(?:ped|ping)?|exposed wire|live wire|electric shock|"
    r"falling stock|falling shelf|trip hazard|fire exit blocked)\b",
    re.I,
)
_COLD_CHAIN = re.compile(
    r"\b(?:freez(?:er|ing)|frzr|refrigerat(?:or|ion)|fridge|chiller|cooler|cold chain)\b",
    re.I,
)
_COLD_CHAIN_RISK = re.compile(
    r"\b(?:melt(?:ed|ing)?|thaw(?:ed|ing)?|unsafe temperature|food spoil(?:ed|age)|"
    r"milk spoil(?:ed|age)|warm (?:food|milk|meat|dairy|produce)|food was warm|temperature abuse)\b",
    re.I,
)
_EXPIRED = re.compile(r"\b(?:expired|past (?:the )?use.by|past expiry|out of date|near.expiry)\b", re.I)
_CRITICAL_HARM = re.compile(
    r"\b(?:hospitali[sz]ed|hospital|food poisoning|seriously ill|became sick|injur(?:y|ies)|"
    r"stitches|allergic reaction|anaphylaxis|assault(?:ed)?|harass(?:ment|ed|ing)?|"
    r"vaanthi|aajari|beemar)\b",
    re.I,
)
_UNDECLARED_ALLERGEN = re.compile(
    r"\b(?:undeclared|not declared|not listed|missing from (?:the )?label|omits?|omitted)\b",
    re.I,
)


class PackageError(ValueError):
    """Raised when the organizer's public input files do not match the documented schema."""


def _require_columns(frame: pd.DataFrame, columns: Iterable[str], name: str) -> None:
    missing = sorted(set(columns) - set(frame.columns))
    if missing:
        raise PackageError(f"{name} is missing required columns: {', '.join(missing)}")


def load_package(data_dir: Path) -> dict[str, pd.DataFrame]:
    """Load only the documented public package files beside the supplied feedback.csv."""
    paths = {
        "feedback": data_dir / "feedback.csv",
        "labels": data_dir / "feedback_labels_train.csv",
        "taxonomy": data_dir / "issue_taxonomy.csv",
        "stores": data_dir / "store_master.csv",
        "calendar": data_dir / "week_calendar.csv",
    }
    for path in paths.values():
        if not path.is_file():
            raise PackageError(f"Required organizer file is missing beside feedback.csv: {path.name}")

    data = {
        "feedback": pd.read_csv(paths["feedback"], dtype=str, keep_default_na=False),
        "labels": pd.read_csv(paths["labels"], dtype=str, keep_default_na=False),
        "taxonomy": pd.read_csv(paths["taxonomy"], dtype=str, keep_default_na=False),
        "stores": pd.read_csv(paths["stores"], dtype=str, keep_default_na=False),
        "calendar": pd.read_csv(paths["calendar"], dtype=str, keep_default_na=False),
    }
    _require_columns(data["feedback"], ("feedback_id", "channel", "created_at", "store_id", "text"), "feedback.csv")
    _require_columns(data["labels"], ("feedback_id", "issue_type_id", "severity", "actionable"), "feedback_labels_train.csv")
    _require_columns(
        data["taxonomy"],
        ("issue_type_id", "issue_type", "owner_function", "policy_severity_floor", "is_actionable_category"),
        "issue_taxonomy.csv",
    )
    _require_columns(data["stores"], ("store_id", "store_name", "region", "size_sqft", "avg_weekly_footfall"), "store_master.csv")
    _require_columns(data["calendar"], ("week_index", "week_start", "week_end", "labelled_period"), "week_calendar.csv")
    if data["feedback"]["feedback_id"].duplicated().any():
        raise PackageError("feedback.csv contains duplicate feedback_id values.")
    if data["labels"]["feedback_id"].duplicated().any():
        raise PackageError("feedback_labels_train.csv contains duplicate feedback_id values.")
    if data["taxonomy"]["issue_type_id"].duplicated().any():
        raise PackageError("issue_taxonomy.csv contains duplicate issue_type_id values.")
    return data


def _calendar_indices(frame: pd.DataFrame, calendar: pd.DataFrame) -> np.ndarray:
    starts = pd.to_datetime(calendar["week_start"], errors="raise").to_numpy(dtype="datetime64[ns]")
    ends = pd.to_datetime(calendar["week_end"], errors="raise").to_numpy(dtype="datetime64[ns]")
    indices = calendar["week_index"].astype(int).to_numpy()
    timestamps = pd.to_datetime(frame["created_at"], errors="raise").to_numpy(dtype="datetime64[ns]")
    positions = np.searchsorted(starts, timestamps, side="right") - 1
    result = np.full(len(frame), -1, dtype=int)
    valid = (positions >= 0) & (positions < len(calendar))
    valid_positions = np.flatnonzero(valid)
    mapped = positions[valid]
    in_week = timestamps[valid] <= ends[mapped] + np.timedelta64(1, "D") - np.timedelta64(1, "ns")
    result[valid_positions[in_week]] = indices[mapped[in_week]]
    return result


def _join_public_labels(data: Mapping[str, pd.DataFrame]) -> pd.DataFrame:
    feedback = data["feedback"].copy()
    feedback["week_index"] = _calendar_indices(feedback, data["calendar"])
    labeled = data["labels"].merge(
        feedback[["feedback_id", "text", "channel", "created_at", "store_id", "week_index"]],
        on="feedback_id",
        how="left",
        validate="one_to_one",
        indicator=True,
    )
    missing = labeled["_merge"] != "both"
    if missing.any():
        raise PackageError(f"{int(missing.sum())} public label rows do not join to feedback.csv.")
    labeled = labeled.drop(columns="_merge")
    if (labeled["week_index"] < 1).any():
        raise PackageError("Some labeled feedback does not belong to a week in week_calendar.csv.")
    labeled["issue_type_id"] = labeled["issue_type_id"].str.upper()
    labeled["severity"] = labeled["severity"].str.lower()
    labeled["actionable"] = pd.to_numeric(labeled["actionable"], errors="raise").astype(int)
    return labeled


def _normalize_for_grouping(text: str) -> str:
    value = unicodedata.normalize("NFKC", str(text)).casefold()
    return re.sub(r"\W+", " ", value, flags=re.UNICODE).strip()


def _feature_text(text: str, source: str, store_known: bool) -> str:
    safe_source = re.sub(r"[^a-z0-9]+", "_", str(source).casefold()).strip("_") or "unknown"
    known = "yes" if store_known else "no"
    return f"channel_{safe_source} store_known_{known} {unicodedata.normalize('NFKC', str(text))}"


def _locality_index(stores: pd.DataFrame) -> list[tuple[str, str]]:
    localities: list[tuple[str, str]] = []
    for row in stores.itertuples(index=False):
        parts = str(row.store_name).split(" ", 2)
        if len(parts) == 3 and parts[2].strip():
            localities.append((str(row.store_id).upper(), parts[2].casefold()))
    return localities


def resolve_store_ids(feedback: pd.DataFrame, stores: pd.DataFrame) -> list[str | None]:
    """Resolve explicit IDs, or a unique store locality named in otherwise unscoped feedback."""
    valid_ids = set(stores["store_id"].astype(str).str.upper())
    localities = _locality_index(stores)
    resolved: list[str | None] = []
    for row in feedback.itertuples(index=False):
        explicit = str(getattr(row, "store_id", "")).strip().upper()
        if explicit in valid_ids:
            resolved.append(explicit)
            continue
        normalized_text = str(getattr(row, "text", "")).casefold()
        matches = {store_id for store_id, locality in localities if locality in normalized_text}
        resolved.append(next(iter(matches)) if len(matches) == 1 else None)
    return resolved


def _model_texts(frame: pd.DataFrame, stores: pd.DataFrame) -> list[str]:
    resolved = resolve_store_ids(frame, stores)
    return [
        _feature_text(text, source, store_id is not None)
        for text, source, store_id in zip(frame["text"], frame["channel"], resolved, strict=True)
    ]


def _new_vectorizer() -> FeatureUnion:
    return FeatureUnion(
        [
            (
                "word",
                TfidfVectorizer(
                    ngram_range=(1, 2), min_df=2, max_features=60_000, sublinear_tf=True,
                    dtype=np.float32,
                ),
            ),
            (
                "char",
                TfidfVectorizer(
                    analyzer="char_wb", ngram_range=(2, 5), min_df=2, max_features=150_000,
                    sublinear_tf=True, dtype=np.float32,
                ),
            ),
        ],
    )


def fit_bundle(training: pd.DataFrame, taxonomy: pd.DataFrame, stores: pd.DataFrame) -> dict[str, Any]:
    if training.empty:
        raise PackageError("No public labeled rows are available before this detector cutoff.")
    train = training.reset_index(drop=True)
    vectorizer = _new_vectorizer()
    matrix = vectorizer.fit_transform(_model_texts(train, stores))
    models: dict[str, Any] = {}
    for target, balanced in (("issue_type_id", True), ("severity", False), ("actionable", False)):
        labels = train[target].astype(str).to_numpy()
        unique = np.unique(labels)
        if len(unique) == 1:
            model = DummyClassifier(strategy="constant", constant=unique[0]).fit(matrix, labels)
        else:
            model = LinearSVC(
                C=SVM_C,
                class_weight="balanced" if balanced else None,
                random_state=42,
                max_iter=SVM_MAX_ITER,
                tol=SVM_TOL,
            ).fit(matrix, labels)
        models[target] = model

    taxonomy_rows = {}
    for row in taxonomy.to_dict(orient="records"):
        taxonomy_rows[str(row["issue_type_id"]).upper()] = {
            **row,
            "is_actionable_category": int(row["is_actionable_category"]),
            "policy_severity_floor": str(row["policy_severity_floor"]).lower(),
        }
    return {
        "schema_version": 1,
        "sklearn_version": sklearn.__version__,
        "vectorizer": vectorizer,
        "models": models,
        "taxonomy": taxonomy_rows,
    }


def _safety_override(text: str, predicted_issue: str) -> tuple[str, bool] | None:
    """Retain the project's urgent-review behavior, using only issue evidence in the text."""
    lowered = unicodedata.normalize("NFKC", str(text)).casefold()
    allergen_term = _ALLERGEN_TERM.search(lowered)
    allergen_context = _ALLERGEN_ERROR.search(lowered)
    if allergen_term and allergen_context:
        return "IT18", True
    if _MISCONDUCT.search(lowered) and re.search(r"\b(?:staff|employee|associate|cashier|team member|worker)\b", lowered):
        return "IT04", True
    if _CONTAMINATION.search(lowered) and re.search(r"\b(?:food|product|meal|drink|produce|item)\b", lowered):
        return "IT17", True
    if _HYGIENE.search(lowered):
        return "IT06", True
    if _PHYSICAL_HAZARD.search(lowered):
        return "IT08", True
    if _COLD_CHAIN.search(lowered) and _COLD_CHAIN_RISK.search(lowered):
        return "IT10", True
    if _EXPIRED.search(lowered):
        return "IT16", False
    if predicted_issue in {"IT04", "IT06", "IT08", "IT17", "IT18"}:
        return predicted_issue, True
    return None


def policy_prediction(
    issue_id: str,
    severity: str,
    actionable: int,
    text: str,
    taxonomy: Mapping[str, Mapping[str, Any]],
    store_known: bool = True,
) -> dict[str, Any]:
    issue_id = str(issue_id).upper()
    risk_override = _safety_override(text, issue_id)
    urgent = False
    if risk_override:
        issue_id, urgent = risk_override
    issue = taxonomy.get(issue_id)
    if issue is None:
        raise PackageError(f"Model predicted issue type absent from the organizer taxonomy: {issue_id}")
    floor = str(issue["policy_severity_floor"]).lower()
    predicted_severity = str(severity).lower()
    if predicted_severity not in SEVERITY_ORDER or floor not in SEVERITY_ORDER:
        raise PackageError(f"Invalid severity or policy floor for {issue_id}.")
    final_severity = max((predicted_severity, floor), key=lambda value: SEVERITY_ORDER[value])
    online_digital_ids = {"IT26", "IT27", "IT28", "IT29"}
    routable = store_known or issue_id in online_digital_ids
    final_actionable = int(bool(int(actionable)) and int(issue["is_actionable_category"]) == 1 and routable)
    critical_harm = bool(_CRITICAL_HARM.search(str(text)))
    undeclared_allergen = issue_id == "IT18" and bool(_UNDECLARED_ALLERGEN.search(str(text)))
    if critical_harm or undeclared_allergen:
        final_severity = "critical"

    owner = str(issue["owner_function"])
    issue_name = str(issue["issue_type"])
    requires_review = urgent or (final_actionable == 0 and issue_id not in NON_ISSUE_IDS)
    if issue_id in NON_ISSUE_IDS:
        actionability = "informational"
        status = "Informational"
        requires_review = issue_id == "NI02"
    elif urgent or final_actionable == 0:
        actionability = "needs_review"
        status = "Needs human review"
    else:
        actionability = "actionable"
        status = "Open"

    if urgent:
        action = (
            f"Escalate for immediate human verification under store policy and notify the designated {owner} owner. "
            "This recommendation does not confirm that an external alert was sent."
        )
    elif issue_id in NON_ISSUE_IDS:
        action = "No operational action is recommended for this non-issue category."
    elif final_actionable == 0:
        action = f"Ask a manager to verify the missing details before routing this report to {owner}."
    else:
        action = f"Review the reported issue and route follow-up to {owner}."

    return {
        "issue_type_id": issue_id,
        "category": issue_name,
        "severity": final_severity,
        "actionable": final_actionable,
        "owner_function": owner,
        "actionability": actionability,
        "recommended_action": action,
        "status": status,
        "requires_human_verification": bool(requires_review),
        "escalation_required": bool(urgent),
        "classification_method": "tfidf_linear_svc+taxonomy_policy",
        "explanation": (
            f"TF-IDF LinearSVC predicted {issue_id} ({issue_name}); severity is no lower than the taxonomy floor ({floor})."
        ),
    }


def predict_frame(frame: pd.DataFrame, bundle: Mapping[str, Any], stores: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return pd.DataFrame(columns=[*PREDICTION_COLUMNS, "category", "owner_function", "actionability"])
    matrix = bundle["vectorizer"].transform(_model_texts(frame, stores))
    raw = {
        target: bundle["models"][target].predict(matrix).astype(str)
        for target in ("issue_type_id", "severity", "actionable")
    }
    records: list[dict[str, Any]] = []
    resolved_store_ids = resolve_store_ids(frame, stores)
    for index, row in enumerate(frame.itertuples(index=False)):
        policy = policy_prediction(
            raw["issue_type_id"][index],
            raw["severity"][index],
            int(raw["actionable"][index]),
            str(row.text),
            bundle["taxonomy"],
            store_known=resolved_store_ids[index] is not None,
        )
        records.append({
            "feedback_id": str(row.feedback_id),
            "issue_type_id": policy["issue_type_id"],
            "severity": policy["severity"],
            "actionable": policy["actionable"],
            "category": policy["category"],
            "owner_function": policy["owner_function"],
            "actionability": policy["actionability"],
        })
    return pd.DataFrame.from_records(records)


def predict_one(text: str, source: str, store_known: bool, bundle: Mapping[str, Any]) -> dict[str, Any]:
    frame = pd.DataFrame([{
        "feedback_id": "request",
        "text": str(text),
        "channel": str(source),
        "store_id": "provided" if store_known else "",
    }])
    matrix = bundle["vectorizer"].transform([_feature_text(text, source, store_known)])
    raw_issue = str(bundle["models"]["issue_type_id"].predict(matrix)[0])
    raw_severity = str(bundle["models"]["severity"].predict(matrix)[0])
    raw_actionable = int(bundle["models"]["actionable"].predict(matrix)[0])
    return policy_prediction(raw_issue, raw_severity, raw_actionable, text, bundle["taxonomy"], store_known=store_known)


def model_artifact_path(path: Path | None = None) -> Path:
    """Return the explicitly supplied, environment-configured, or project-default artifact path."""
    if path is not None:
        return Path(path).expanduser()
    configured_path = os.getenv("VOS_MODEL_PATH")
    return Path(configured_path).expanduser() if configured_path else DEFAULT_MODEL_PATH


def load_model_bundle(path: Path | None = None) -> dict[str, Any] | None:
    model_path = model_artifact_path(path)
    if not model_path.is_file():
        return None
    bundle = joblib.load(model_path)
    if not isinstance(bundle, dict) or bundle.get("schema_version") != 1:
        raise PackageError("The trained classifier artifact has an unsupported format.")
    if bundle.get("sklearn_version") != sklearn.__version__:
        raise PackageError(
            f"Classifier artifact uses scikit-learn {bundle.get('sklearn_version')}; current runtime is {sklearn.__version__}."
        )
    return bundle


def _validation_split(labeled: pd.DataFrame, calendar: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    public_weeks = calendar[calendar["labelled_period"].str.casefold() == "train"].copy()
    public_weeks["_week_index_num"] = pd.to_numeric(public_weeks["week_index"], errors="raise")
    public_weeks = public_weeks.sort_values("_week_index_num")
    if len(public_weeks) < 2:
        raise PackageError("At least two public labeled weeks are required for time-based validation.")
    holdout_count = max(1, int(np.ceil(len(public_weeks) * 0.30)))
    validation_weeks = set(public_weeks.tail(holdout_count)["week_index"].astype(int))
    validation = labeled[labeled["week_index"].isin(validation_weeks)].copy()
    training = labeled[~labeled["week_index"].isin(validation_weeks)].copy()
    validation_text = {_normalize_for_grouping(text) for text in validation["text"]}
    before_purge = len(training)
    training = training[~training["text"].map(_normalize_for_grouping).isin(validation_text)].copy()
    if training.empty or validation.empty:
        raise PackageError("The temporal validation split is empty after duplicate-text purge.")
    split = {
        "method": "chronological_holdout_with_exact_normalized_text_purge",
        "training_week_indices": sorted(set(training["week_index"].astype(int))),
        "validation_week_indices": sorted(validation_weeks),
        "training_rows_before_purge": before_purge,
        "training_rows_after_purge": len(training),
        "purged_training_rows": before_purge - len(training),
        "validation_rows": len(validation),
        "validation_issue_types": int(validation["issue_type_id"].nunique()),
    }
    return training.reset_index(drop=True), validation.reset_index(drop=True), split


def _metric_report(validation: pd.DataFrame, predicted: pd.DataFrame, split: Mapping[str, Any]) -> dict[str, Any]:
    truth = validation[["feedback_id", "issue_type_id", "severity", "actionable"]].merge(
        predicted, on="feedback_id", how="left", suffixes=("", "_pred"), validate="one_to_one",
    )
    issue_f1 = f1_score(truth["issue_type_id"], truth["issue_type_id_pred"], average="macro", zero_division=0)
    severity_f1 = f1_score(truth["severity"], truth["severity_pred"], average="weighted", zero_division=0)
    actionable_f1 = f1_score(
        truth["actionable"].astype(int), truth["actionable_pred"].astype(int), average="binary", pos_label=1, zero_division=0,
    )
    combined = 0.5 * issue_f1 + 0.25 * severity_f1 + 0.25 * actionable_f1
    predicted_actionable = truth["actionable_pred"].astype(int) == 1
    predicted_escalated = predicted_actionable & truth["severity_pred"].isin(("high", "critical"))
    return {
        "validation_split": dict(split),
        "issue_type_macro_f1": round(float(issue_f1), 6),
        "severity_weighted_f1": round(float(severity_f1), 6),
        "actionable_positive_f1": round(float(actionable_f1), 6),
        "classification_score": round(float(combined), 6),
        "actionable_precision": round(float(precision_score(
            truth["actionable"].astype(int), truth["actionable_pred"].astype(int), zero_division=0,
        )), 6),
        "actionable_high_or_critical_precision": round(float(truth.loc[predicted_escalated, "actionable"].astype(int).mean()) if predicted_escalated.any() else 0.0, 6),
        "validation_rows": int(len(truth)),
        "issue_type_classes_in_validation": int(truth["issue_type_id"].nunique()),
    }


def validate_model(data: Mapping[str, pd.DataFrame]) -> dict[str, Any]:
    labeled = _join_public_labels(data)
    training, validation, split = _validation_split(labeled, data["calendar"])
    bundle = fit_bundle(training, data["taxonomy"], data["stores"])
    predicted = predict_frame(validation, bundle, data["stores"])
    return _metric_report(validation, predicted, split)


def train_full(data: Mapping[str, pd.DataFrame]) -> dict[str, Any]:
    labeled = _join_public_labels(data)
    return fit_bundle(labeled, data["taxonomy"], data["stores"])


def predict_all_feedback(data: Mapping[str, pd.DataFrame], bundle: Mapping[str, Any]) -> pd.DataFrame:
    """Predict every feedback row and retain only the official submission columns."""
    feedback = data["feedback"]
    predictions = predict_frame(feedback, bundle, data["stores"])
    if predictions["feedback_id"].duplicated().any() or len(predictions) != len(feedback):
        raise PackageError("Predictions must contain exactly one row for every feedback_id.")
    predictions = predictions[PREDICTION_COLUMNS].sort_values("feedback_id").reset_index(drop=True)
    predictions["severity"] = predictions["severity"].str.lower()
    predictions["actionable"] = predictions["actionable"].astype(int)
    valid_ids = set(bundle["taxonomy"])
    if not set(predictions["issue_type_id"]).issubset(valid_ids):
        raise PackageError("A prediction uses an issue_type_id absent from issue_taxonomy.csv.")
    return predictions


def _first_week_cold_start_predictions(
    frame: pd.DataFrame,
    taxonomy: pd.DataFrame,
    stores: pd.DataFrame,
    data_dir: Path,
) -> pd.DataFrame:
    """Use the organizer's public rules baseline when no prior labels exist."""
    baseline_path = data_dir.parent / "baseline" / "baseline.py"
    if not baseline_path.is_file():
        raise PackageError(
            "The first public week has no earlier labels; the organizer's public baseline/baseline.py "
            "is required for causal cold-start predictions."
        )
    spec = importlib.util.spec_from_file_location("vos_r5_public_baseline", baseline_path)
    if spec is None or spec.loader is None:
        raise PackageError(f"Could not load organizer baseline module: {baseline_path}")
    baseline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baseline)
    taxonomy_by_id = taxonomy.set_index("issue_type_id")
    taxonomy_rows = {
        str(key).upper(): value
        for key, value in taxonomy_by_id.to_dict(orient="index").items()
    }
    labeled = baseline.label(frame.copy(), taxonomy_by_id)
    resolved_stores = resolve_store_ids(frame, stores)
    rows = []
    for row, store_known in zip(labeled.itertuples(index=False), resolved_stores, strict=True):
        policy = policy_prediction(
            str(row.issue_type_id), str(row.severity), int(row.actionable), str(row.text),
            taxonomy_rows,
            store_known=store_known is not None,
        )
        rows.append({
            "feedback_id": str(row.feedback_id),
            "issue_type_id": policy["issue_type_id"],
            "severity": policy["severity"],
            "actionable": policy["actionable"],
        })
    return pd.DataFrame.from_records(rows, columns=PREDICTION_COLUMNS)


def predict_public_timeline(
    data: Mapping[str, pd.DataFrame],
    full_bundle: Mapping[str, Any],
    data_dir: Path,
) -> tuple[pd.DataFrame, dict[int, Mapping[str, Any]]]:
    """Predict each public week using only earlier labels; test weeks use all public labels."""
    feedback = data["feedback"].copy()
    feedback["week_index"] = _calendar_indices(feedback, data["calendar"])
    labeled = _join_public_labels(data)
    first_week = int(pd.to_numeric(data["calendar"]["week_index"], errors="raise").min())
    causal_bundles: dict[int, Mapping[str, Any]] = {}
    outputs: list[pd.DataFrame] = []
    for week in data["calendar"].sort_values("week_index", key=lambda values: pd.to_numeric(values)).itertuples(index=False):
        week_index = int(week.week_index)
        current = feedback[feedback["week_index"] == week_index].drop(columns="week_index")
        if str(week.labelled_period).casefold() == "test":
            week_bundle = full_bundle
        elif week_index == first_week:
            outputs.append(_first_week_cold_start_predictions(current, data["taxonomy"], data["stores"], data_dir))
            continue
        else:
            prior_labels = labeled[labeled["week_index"] < week_index]
            week_bundle = fit_bundle(prior_labels, data["taxonomy"], data["stores"])
            causal_bundles[week_index] = week_bundle
        outputs.append(predict_frame(current, week_bundle, data["stores"])[PREDICTION_COLUMNS])
    predictions = pd.concat(outputs, ignore_index=True)[PREDICTION_COLUMNS]
    predictions = predictions.sort_values("feedback_id").reset_index(drop=True)
    predictions["severity"] = predictions["severity"].str.lower()
    predictions["actionable"] = predictions["actionable"].astype(int)
    if predictions["feedback_id"].duplicated().any() or len(predictions) != len(feedback):
        raise PackageError("Walk-forward predictions must contain exactly one row for every feedback_id.")
    return predictions, causal_bundles


def validate_submission_outputs(
    data: Mapping[str, pd.DataFrame],
    predictions: pd.DataFrame,
    flags: pd.DataFrame,
    *,
    max_flags_per_week: int = 3,
) -> dict[str, int]:
    """Fail closed on the official CSV schemas and every cited evidence rule."""
    if list(predictions.columns) != PREDICTION_COLUMNS:
        raise PackageError("R5_predictions.csv columns do not match the official order.")
    if predictions["feedback_id"].duplicated().any() or set(predictions["feedback_id"]) != set(data["feedback"]["feedback_id"]):
        raise PackageError("R5_predictions.csv must contain one row for every feedback_id.")
    if not predictions["issue_type_id"].isin(set(data["taxonomy"]["issue_type_id"].str.upper())).all():
        raise PackageError("R5_predictions.csv contains an unknown issue_type_id.")
    if not predictions["severity"].isin(set(SEVERITY_ORDER)).all():
        raise PackageError("R5_predictions.csv contains an invalid severity.")
    if not predictions["actionable"].isin((0, 1)).all():
        raise PackageError("R5_predictions.csv actionable values must be 0 or 1.")
    if list(flags.columns) != FLAG_COLUMNS:
        raise PackageError("R5_emerging_flags.csv columns do not match the official order.")
    if flags.empty:
        return {"prediction_rows": int(len(predictions)), "flag_rows": 0, "valid_evidence_ids": 0}
    if flags[["as_of_week_start", "store_id", "issue_type_id"]].astype(str).agg("|".join, axis=1).duplicated().any():
        raise PackageError("R5_emerging_flags.csv contains duplicate week/store/type keys.")
    confidence = pd.to_numeric(flags["confidence"], errors="coerce")
    if confidence.isna().any() or ((confidence < 0) | (confidence > 1)).any():
        raise PackageError("Every flag confidence must be numeric and between 0 and 1.")
    counts = flags.groupby("as_of_week_start").size()
    if (counts > max_flags_per_week).any():
        raise PackageError(f"R5_emerging_flags.csv exceeds {max_flags_per_week} flags in a week.")

    calendar = data["calendar"].copy()
    starts = pd.to_datetime(calendar["week_start"], errors="raise").dt.strftime("%Y-%m-%d")
    ends = pd.to_datetime(calendar["week_end"], errors="raise").dt.strftime("%Y-%m-%d")
    week_ranges = {start: (pd.Timestamp(start), pd.Timestamp(end) + pd.Timedelta(days=1)) for start, end in zip(starts, ends, strict=True)}
    if not set(flags["as_of_week_start"].astype(str)).issubset(week_ranges):
        raise PackageError("A flag references a week_start absent from week_calendar.csv.")

    stores = data["stores"].copy()
    valid_stores = set(stores["store_id"].astype(str).str.upper())
    localities = dict(_locality_index(stores))
    feedback = data["feedback"].set_index("feedback_id", drop=False)
    prediction_types = predictions.set_index("feedback_id")["issue_type_id"].astype(str).str.upper().to_dict()
    valid_evidence_count = 0
    for row in flags.itertuples(index=False):
        store_id = str(row.store_id).strip().upper()
        issue_id = str(row.issue_type_id).strip().upper()
        if store_id not in valid_stores or issue_id not in set(data["taxonomy"]["issue_type_id"].str.upper()):
            raise PackageError("A flag references an unknown store or issue type.")
        start, end = week_ranges[str(row.as_of_week_start)]
        evidence_ids = list(dict.fromkeys(part.strip().upper() for part in str(row.evidence_feedback_ids).replace(",", ";").split(";") if part.strip()))
        if len(evidence_ids) < 2:
            raise PackageError("Every flag must cite at least two distinct feedback_ids.")
        for feedback_id in evidence_ids:
            if feedback_id not in feedback.index:
                raise PackageError(f"Flag cites an unknown feedback_id: {feedback_id}.")
            source = feedback.loc[feedback_id]
            created = pd.Timestamp(source["created_at"])
            if created < start or created >= end:
                raise PackageError(f"Evidence {feedback_id} was not created in its flag week.")
            explicit_store = str(source["store_id"]).strip().upper()
            if explicit_store:
                belongs = explicit_store == store_id
            else:
                locality = localities.get(store_id, "").casefold()
                belongs = bool(locality) and locality in str(source["text"]).casefold()
            if not belongs:
                raise PackageError(f"Evidence {feedback_id} does not belong to flagged store {store_id}.")
            if prediction_types.get(feedback_id) != issue_id:
                raise PackageError(f"Evidence {feedback_id} does not have predicted issue type {issue_id}.")
            valid_evidence_count += 1
    return {
        "prediction_rows": int(len(predictions)),
        "flag_rows": int(len(flags)),
        "valid_evidence_ids": valid_evidence_count,
    }


def _normalized_event_rows(
    feedback: pd.DataFrame,
    predictions: pd.DataFrame,
    stores: pd.DataFrame,
    calendar: pd.DataFrame,
) -> pd.DataFrame:
    rows = feedback.copy()
    rows["week_index"] = _calendar_indices(rows, calendar)
    rows = rows.merge(
        predictions[["feedback_id", "issue_type_id", "severity"]], on="feedback_id", how="left", validate="one_to_one",
    )
    rows["resolved_store_id"] = resolve_store_ids(rows, stores)
    rows["normalized_text"] = rows["text"].map(_normalize_for_grouping)
    # Exact normalized duplicate messages across channels count as one signal;
    # retain a real feedback_id as auditable evidence for each distinct message.
    rows = rows.sort_values(["created_at", "feedback_id"]).drop_duplicates(
        ["week_index", "resolved_store_id", "issue_type_id", "normalized_text"], keep="first",
    )
    return rows


def _weekly_flag_candidates(
    event_rows: pd.DataFrame,
    current_week: Mapping[str, Any],
    stores: pd.DataFrame,
    *,
    max_flags: int = 3,
    recently_flagged: set[tuple[str, str]] | None = None,
    taxonomy: pd.DataFrame | None = None,
    diagnostics: list[dict[str, Any]] | None = None,
) -> pd.DataFrame:
    """Find store/type increases using current and four completed prior weeks only."""
    week_index = int(current_week["week_index"])
    week_start = str(current_week["week_start"])
    end = pd.to_datetime(current_week["week_end"], errors="raise") + pd.Timedelta(days=1) - pd.Timedelta(nanoseconds=1)
    visible = event_rows[pd.to_datetime(event_rows["created_at"], errors="raise") <= end].copy()
    current = visible[visible["week_index"] == week_index]
    previous = visible[visible["week_index"].between(max(1, week_index - 4), week_index - 1)]
    store_ids = set(stores["store_id"].astype(str).str.upper())
    footfall = stores.set_index(stores["store_id"].astype(str).str.upper())["avg_weekly_footfall"]
    footfall = pd.to_numeric(footfall, errors="coerce")
    issue_names = (
        taxonomy.set_index(taxonomy["issue_type_id"].astype(str).str.upper())["issue_type"].astype(str).to_dict()
        if taxonomy is not None and {"issue_type_id", "issue_type"}.issubset(taxonomy.columns)
        else {}
    )
    recently_flagged = recently_flagged or set()
    candidates: list[dict[str, Any]] = []

    for (store_id, issue_id), group in current.groupby(["resolved_store_id", "issue_type_id"], dropna=False):
        if (
            not store_id or pd.isna(store_id) or str(store_id).upper() not in store_ids
            or pd.isna(issue_id) or str(issue_id).upper() in NON_ISSUE_IDS
            or (str(store_id).upper(), str(issue_id).upper()) in recently_flagged
        ):
            continue
        denominator = float(footfall.get(str(store_id).upper(), 0) or 0)
        if denominator <= 0:
            continue
        evidence = group.sort_values(["created_at", "feedback_id"])
        if len(evidence) < 2:
            continue
        critical_issue = "severity" in evidence and evidence["severity"].astype(str).str.casefold().eq("critical").any()
        prior_group = previous[(previous["resolved_store_id"] == store_id) & (previous["issue_type_id"] == issue_id)]
        baseline_counts = [int((prior_group["week_index"] == week).sum()) for week in range(max(1, week_index - 4), week_index)]
        while len(baseline_counts) < 4:
            baseline_counts.insert(0, 0)
        baseline_rates = np.asarray(baseline_counts, dtype=float) * 1000.0 / denominator
        current_count = int(len(evidence))
        current_rate = current_count * 1000.0 / denominator
        baseline_mean = float(baseline_rates.mean())
        baseline_std = float(baseline_rates.std(ddof=0))
        # A recency-weighted baseline catches a sharp rebound after an older,
        # isolated spike without treating every quiet week as a fresh baseline.
        # The Poisson noise floor and two-distinct-message minimum keep sparse
        # stores from alerting on one unusual report.
        weights = np.power(0.5, np.arange(len(baseline_rates) - 1, -1, -1, dtype=float))
        weights /= weights.sum()
        baseline_ewma = float(np.dot(baseline_rates, weights))
        baseline_ewma_count = baseline_ewma * denominator / 1000.0
        poisson_noise_rate = np.sqrt(max(baseline_ewma_count, 0.0)) * 1000.0 / denominator
        expected_noise_rate = max(baseline_std, poisson_noise_rate)
        # Use the smaller recency-weighted center and a 1.5-sigma one-sided
        # threshold, with a two-message floor. Rates stay normalized by the
        # organizer's store footfall instead of invented transaction counts.
        minimum_rate = max(0.001, baseline_ewma * 1.5, baseline_ewma + 1.5 * expected_noise_rate)
        if not critical_issue and current_rate < minimum_rate:
            continue
        lift = current_rate / max(baseline_ewma, 0.001)
        confidence = min(0.99, max(0.5, 0.5 + 0.08 * min(lift - 1.0, 5.0)))
        if critical_issue:
            confidence = max(confidence, 0.95)
        severity_weight = {"low": 1.0, "medium": 1.15, "high": 3.0, "critical": 5.0}
        highest_severity = (
            max(evidence["severity"].astype(str).str.casefold(), key=lambda value: SEVERITY_ORDER.get(value, -1))
            if "severity" in evidence
            else "low"
        )
        # Rank store-local rate increases before raw volume, with only a
        # sublinear support bonus. Policy severity increases the priority of
        # dangerous rises without changing the underlying classifier output.
        rank = (
            min(lift, 5.0)
            * current_rate
            * float(np.log1p(current_count))
            * severity_weight.get(highest_severity, 1.0)
        )
        candidates.append({
            "as_of_week_start": week_start,
            "store_id": str(store_id).upper(),
            "issue_type_id": str(issue_id).upper(),
            "confidence": round(confidence, 4),
            "evidence_feedback_ids": ";".join(evidence["feedback_id"].astype(str).head(8)),
            "_rank": rank,
            "_diagnostic": {
                "as_of_week_start": week_start,
                "store_id": str(store_id).upper(),
                "issue_type_id": str(issue_id).upper(),
                "category": issue_names.get(str(issue_id).upper(), str(issue_id).upper()),
                "independent_feedback_count": current_count,
                "current_rate_per_1000_footfall": round(current_rate, 6),
                "rolling_mean_per_1000_footfall": round(baseline_mean, 6),
                "ewma_baseline_per_1000_footfall": round(baseline_ewma, 6),
                "baseline_std_per_1000_footfall": round(baseline_std, 6),
                "ewma_z_score": round((current_rate - baseline_ewma) / max(expected_noise_rate, 1e-12), 4),
                "rate_lift": round(lift, 4),
                "evidence_feedback_ids": ";".join(evidence["feedback_id"].astype(str).head(8)),
            },
        })

    candidates.sort(key=lambda row: (-row["_rank"], row["store_id"], row["issue_type_id"]))
    selected_rows = candidates[:max_flags]
    if diagnostics is not None:
        diagnostics.extend(row["_diagnostic"] for row in selected_rows)
    selected = [
        {key: value for key, value in row.items() if key not in {"_rank", "_diagnostic"}}
        for row in selected_rows
    ]
    return pd.DataFrame.from_records(selected, columns=FLAG_COLUMNS)


def _active_duplicate_keys(
    event_rows: pd.DataFrame,
    last_flag_week: Mapping[tuple[str, str], int],
    current_week_index: int,
) -> set[tuple[str, str]]:
    """Keep an alert quiet until its store/type has had two full weeks without evidence."""
    history = event_rows[pd.to_numeric(event_rows["week_index"], errors="raise") < current_week_index]
    if history.empty or not last_flag_week:
        return set()
    latest_activity = history.groupby(["resolved_store_id", "issue_type_id"])["week_index"].max().to_dict()
    active: set[tuple[str, str]] = set()
    for key, flag_week in last_flag_week.items():
        last_activity = int(latest_activity.get(key, flag_week))
        if current_week_index - last_activity <= FLAG_COOLDOWN_WEEKS:
            active.add(key)
    return active


def detect_week(
    data: Mapping[str, pd.DataFrame],
    as_of: str | date,
    *,
    bundle: Mapping[str, Any] | None = None,
    recently_flagged: set[tuple[str, str]] | None = None,
    diagnostics: list[dict[str, Any]] | None = None,
) -> pd.DataFrame:
    """Produce one week's flags; feedback rows after that week's Sunday are excluded."""
    target_date = pd.Timestamp(as_of).date()
    calendar = data["calendar"].copy()
    starts = pd.to_datetime(calendar["week_start"], errors="raise").dt.date
    ends = pd.to_datetime(calendar["week_end"], errors="raise").dt.date
    matched = calendar[(starts <= target_date) & (ends >= target_date)]
    if matched.empty:
        raise PackageError(f"--as-of {target_date.isoformat()} is outside week_calendar.csv.")
    current_week = matched.iloc[0].to_dict()
    week_index = int(current_week["week_index"])

    labeled = _join_public_labels(data)
    prior_labels = labeled[labeled["week_index"] < week_index]
    # The scored (test) period starts after all public labels. For earlier
    # weeks, train only on labels whose weeks had already ended.
    if bundle is None:
        if prior_labels.empty:
            return pd.DataFrame(columns=FLAG_COLUMNS)
        bundle = fit_bundle(prior_labels, data["taxonomy"], data["stores"])

    week_end = pd.Timestamp(current_week["week_end"]) + pd.Timedelta(days=1) - pd.Timedelta(nanoseconds=1)
    # The detector compares only the current week with the four preceding
    # weeks, so earlier feedback cannot affect a candidate or its evidence.
    feedback_weeks = _calendar_indices(data["feedback"], calendar)
    visible_mask = (
        (feedback_weeks >= max(1, week_index - (4 + FLAG_COOLDOWN_WEEKS)))
        & (feedback_weeks <= week_index)
        & (pd.to_datetime(data["feedback"]["created_at"], errors="raise") <= week_end).to_numpy()
    )
    visible_feedback = data["feedback"].loc[visible_mask].copy()
    event_rows = _normalized_event_rows(
        visible_feedback,
        predict_all_feedback({**data, "feedback": visible_feedback}, bundle),
        data["stores"],
        data["calendar"],
    )
    if week_index not in set(event_rows["week_index"].astype(int)):
        return pd.DataFrame(columns=FLAG_COLUMNS)
    if recently_flagged is None:
        recent_keys: set[tuple[str, str]] = set()
        historical_calendar = calendar.copy()
        historical_calendar["_week_index_num"] = pd.to_numeric(historical_calendar["week_index"], errors="raise")
        for row in historical_calendar[
            historical_calendar["_week_index_num"].between(max(1, week_index - FLAG_COOLDOWN_WEEKS), week_index - 1)
        ].sort_values("_week_index_num").itertuples(index=False):
            prior_flags = _weekly_flag_candidates(
                event_rows,
                row._asdict(),
                data["stores"],
                taxonomy=data["taxonomy"],
            )
            recent_keys.update(zip(prior_flags["store_id"], prior_flags["issue_type_id"], strict=True))
        recently_flagged = recent_keys
    return _weekly_flag_candidates(
        event_rows,
        current_week,
        data["stores"],
        recently_flagged=recently_flagged,
        taxonomy=data["taxonomy"],
        diagnostics=diagnostics,
    )


def generate_emerging_flags(
    data: Mapping[str, pd.DataFrame],
    causal_bundles: Mapping[int, Mapping[str, Any]],
    full_bundle: Mapping[str, Any],
    *,
    diagnostics: list[dict[str, Any]] | None = None,
) -> pd.DataFrame:
    """Build causal flags for the public half and reproducible flags for the test half."""
    calendar = data["calendar"].copy()
    calendar["_week_index_num"] = pd.to_numeric(calendar["week_index"], errors="raise")
    first_week_index = int(calendar["_week_index_num"].min())
    train_weeks = calendar[calendar["labelled_period"].str.casefold() == "train"].sort_values("_week_index_num")
    test_weeks = calendar[calendar["labelled_period"].str.casefold() == "test"].sort_values("_week_index_num")

    frames: list[pd.DataFrame] = []
    last_flag_week: dict[tuple[str, str], int] = {}
    for row in train_weeks.itertuples(index=False):
        week_index = int(row.week_index)
        if week_index == first_week_index:
            frames.append(pd.DataFrame(columns=FLAG_COLUMNS))
        else:
            if week_index not in causal_bundles:
                raise PackageError(f"No prior-label model is available for public week {week_index}.")
            recent_keys = {
                key for key, previous_week in last_flag_week.items()
                if week_index - previous_week <= FLAG_COOLDOWN_WEEKS
            }
            week_flags = detect_week(
                data,
                str(row.week_start),
                bundle=causal_bundles[week_index],
                recently_flagged=recent_keys,
                diagnostics=diagnostics,
            )
            frames.append(week_flags)
            last_flag_week.update({(str(flag.store_id), str(flag.issue_type_id)): week_index for flag in week_flags.itertuples(index=False)})

    # Recompute all historical classifications with the same final public
    # model used by detect.py for weeks after the labeled period.
    full_predictions = predict_all_feedback(data, full_bundle)
    event_rows = _normalized_event_rows(data["feedback"], full_predictions, data["stores"], data["calendar"])
    for row in test_weeks.itertuples(index=False):
        week_index = int(row.week_index)
        recent_keys = _active_duplicate_keys(event_rows, last_flag_week, week_index)
        week_flags = _weekly_flag_candidates(
            event_rows,
            row._asdict(),
            data["stores"],
            recently_flagged=recent_keys,
            taxonomy=data["taxonomy"],
            diagnostics=diagnostics,
        )
        frames.append(week_flags)
        last_flag_week.update({(str(flag.store_id), str(flag.issue_type_id)): week_index for flag in week_flags.itertuples(index=False)})
    if not frames:
        return pd.DataFrame(columns=FLAG_COLUMNS)
    return pd.concat(frames, ignore_index=True).reindex(columns=FLAG_COLUMNS)


def generate_flags_from_predictions(
    data: Mapping[str, pd.DataFrame],
    predictions: pd.DataFrame,
    *,
    diagnostics: list[dict[str, Any]] | None = None,
) -> pd.DataFrame:
    """Generate causal weekly flags from already-produced public prediction rows."""
    event_rows = _normalized_event_rows(data["feedback"], predictions, data["stores"], data["calendar"])
    calendar = data["calendar"].copy()
    calendar["_week_index_num"] = pd.to_numeric(calendar["week_index"], errors="raise")
    first_week_index = int(calendar["_week_index_num"].min())
    frames: list[pd.DataFrame] = []
    last_flag_week: dict[tuple[str, str], int] = {}
    for row in calendar.sort_values("_week_index_num").itertuples(index=False):
        week_index = int(row.week_index)
        if week_index == first_week_index:
            frames.append(pd.DataFrame(columns=FLAG_COLUMNS))
            continue
        recent_keys = _active_duplicate_keys(event_rows, last_flag_week, week_index)
        week_flags = _weekly_flag_candidates(
            event_rows,
            row._asdict(),
            data["stores"],
            recently_flagged=recent_keys,
            taxonomy=data["taxonomy"],
            diagnostics=diagnostics,
        )
        frames.append(week_flags)
        last_flag_week.update({(str(flag.store_id), str(flag.issue_type_id)): week_index for flag in week_flags.itertuples(index=False)})
    if not frames:
        return pd.DataFrame(columns=FLAG_COLUMNS)
    return pd.concat(frames, ignore_index=True).reindex(columns=FLAG_COLUMNS)


def _write_csv(frame: pd.DataFrame, path: Path, columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.reindex(columns=columns).to_csv(path, index=False, encoding="utf-8", lineterminator="\n")


def run_training(feedback_path: Path, output_dir: Path, model_path: Path) -> dict[str, Any]:
    data = load_package(feedback_path.resolve().parent)
    validation_report = validate_model(data)
    bundle = train_full(data)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, model_path)

    predictions, _causal_bundles = predict_public_timeline(data, bundle, feedback_path.resolve().parent)
    _write_csv(predictions, output_dir / "R5_predictions.csv", PREDICTION_COLUMNS)

    train_week_count = int((data["calendar"]["labelled_period"].str.casefold() == "train").sum())
    test_week_count = int((data["calendar"]["labelled_period"].str.casefold() == "test").sum())
    flag_diagnostics: list[dict[str, Any]] = []
    flags = generate_flags_from_predictions(data, predictions, diagnostics=flag_diagnostics)
    submission_validation = validate_submission_outputs(data, predictions, flags)
    _write_csv(flags, output_dir / "R5_emerging_flags.csv", FLAG_COLUMNS)
    _write_csv(
        pd.DataFrame.from_records(flag_diagnostics, columns=FLAG_DIAGNOSTIC_COLUMNS),
        output_dir / "R5_emerging_flag_diagnostics.csv",
        FLAG_DIAGNOSTIC_COLUMNS,
    )

    command = "python FULL_CODE/detect.py --feedback {feedback} --as-of {asof} --out {out}\n"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "detector_cmd.txt").write_text(command, encoding="utf-8", newline="\n")
    report = {
        "dataset_rows": int(len(data["feedback"])),
        "public_training_labels": int(len(data["labels"])),
        "prediction_rows": int(len(predictions)),
        "prediction_columns": PREDICTION_COLUMNS,
        "emerging_flag_rows": int(len(flags)),
        "emerging_flag_columns": FLAG_COLUMNS,
        "submission_validation": submission_validation,
        "model_path": str(model_path),
        "classifier": {
            "features": "word+character TF-IDF",
            "estimators": "three LinearSVC models with taxonomy policy",
            "C": SVM_C,
            "max_iter": SVM_MAX_ITER,
            "tolerance": SVM_TOL,
        },
        "prediction_timeline": "public training weeks use earlier labels only; week one uses the organizer's public rules baseline; test weeks use all public training labels",
        "flag_generation_periods": {
            "public_training_weeks": train_week_count,
            "held_out_test_weeks": test_week_count,
            "causal_training_week_bundles": int(len(causal_bundles)),
        },
        "validation": validation_report,
        "limitations": [
            "Validation uses one chronological holdout of public weeks, with exact normalized duplicate text purged from training.",
            "Cross-channel deduplication currently removes exact normalized duplicate text only; semantic deduplication is not implemented.",
            "Emerging-issue normalization uses avg_weekly_footfall from the official store master because no transaction file is provided.",
            "Flags are bounded to three per week, suppress same-store/type repeats for two weeks, and cite distinct exact-text groups from the same store and calendar week.",
            "R5_emerging_flag_diagnostics.csv pairs each selected flag with its current rate, four-week baseline, EWMA baseline, z-score, rate lift, and evidence IDs; the official flags CSV retains the required organizer schema.",
        ],
    }
    (output_dir / "R5_validation_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Voice-of-Store R5 model and causal emerging-issue detector")
    subparsers = parser.add_subparsers(dest="command", required=True)

    train_parser = subparsers.add_parser("train", help="validate, fit, and generate official-format CSVs")
    train_parser.add_argument("--feedback", type=Path, required=True, help="path to the organizer feedback.csv")
    train_parser.add_argument("--out-dir", type=Path, default=PROJECT_ROOT / "submission")
    train_parser.add_argument("--model-out", type=Path, default=DEFAULT_MODEL_PATH)

    detect_parser = subparsers.add_parser("detect", help="write flags for the week containing --as-of")
    detect_parser.add_argument("--feedback", type=Path, required=True, help="path to organizer feedback.csv")
    detect_parser.add_argument("--as-of", required=True, help="a date within the week to detect")
    detect_parser.add_argument("--out", type=Path, required=True)

    args = parser.parse_args(argv)
    if args.command == "train":
        report = run_training(args.feedback, args.out_dir, args.model_out)
        print(json.dumps(report, indent=2))
        return 0

    data = load_package(args.feedback.resolve().parent)
    diagnostics: list[dict[str, Any]] = []
    flags = detect_week(data, args.as_of, diagnostics=diagnostics)
    _write_csv(flags, args.out, FLAG_COLUMNS)
    diagnostics_path = args.out.with_name(f"{args.out.stem}_diagnostics.csv")
    _write_csv(
        pd.DataFrame.from_records(diagnostics, columns=FLAG_DIAGNOSTIC_COLUMNS),
        diagnostics_path,
        FLAG_DIAGNOSTIC_COLUMNS,
    )
    print(json.dumps({
        "as_of": args.as_of,
        "flags_written": len(flags),
        "output": str(args.out),
        "diagnostics_output": str(diagnostics_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

