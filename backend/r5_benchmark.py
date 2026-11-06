"""Read-only views over the public R5 organizer package and its submission outputs."""

from __future__ import annotations

import json
import hashlib
import os
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PACKAGE = PROJECT_ROOT / "data" / "organizer-r5-v1" / "R5_Voice_of_Store_Engine"
DEFAULT_SUBMISSION = PROJECT_ROOT / "submission"
SEVERITY_ORDER = {"low": 1, "medium": 2, "high": 3, "critical": 4}
APP_OWNER_NAMES = {
    "Store Ops": "Store Operations",
    "Digital": "Digital / Technical Support",
    "HR": "Store Leadership",
}


class BenchmarkUnavailable(RuntimeError):
    """Raised when public benchmark inputs are missing or inconsistent."""


def _configured_path(variable: str, default: Path) -> Path:
    value = os.getenv(variable, "").strip()
    return Path(value).expanduser().resolve() if value else default


@lru_cache(maxsize=1)
def _store_lookup() -> dict[str, set[str]]:
    package = _configured_path("VOS_R5_DATA_DIR", DEFAULT_PACKAGE)
    path = package / "data" / "store_master.csv"
    if not path.is_file():
        return {"ids": set(), "names": set()}
    try:
        stores = pd.read_csv(path, usecols=["store_id", "store_name"], dtype=str).fillna("")
    except (OSError, ValueError, pd.errors.ParserError):
        return {"ids": set(), "names": set()}
    normalize = lambda value: re.sub(r"[^a-z0-9]+", "", str(value).casefold())
    return {
        "ids": {normalize(value) for value in stores["store_id"] if value.strip()},
        "names": {normalize(value) for value in stores["store_name"] if value.strip()},
    }


def is_known_store_identifier(*, store_id: str | None = None, store_name: str | None = None) -> bool:
    """Fail closed unless an identifier matches the supplied public store master."""
    lookup = _store_lookup()
    normalize = lambda value: re.sub(r"[^a-z0-9]+", "", str(value).casefold())
    if store_id and normalize(store_id) in lookup["ids"]:
        return True
    if store_name and normalize(store_name) in lookup["names"]:
        return True
    return False


def _require_columns(frame: pd.DataFrame, columns: set[str], name: str) -> None:
    missing = columns - set(frame.columns)
    if missing:
        raise BenchmarkUnavailable(f"{name} is missing required columns: {', '.join(sorted(missing))}.")


def _load_transactions(stores: pd.DataFrame, calendar: pd.DataFrame) -> pd.DataFrame:
    """Load optional, verified store/week transaction counts without inventing values."""
    configured = os.getenv("VOS_R5_TRANSACTIONS_CSV", "").strip()
    path = _configured_path("VOS_R5_TRANSACTIONS_CSV", PROJECT_ROOT / "data" / "store_weekly_transactions.csv")
    if not path.is_file():
        if configured:
            raise BenchmarkUnavailable(f"VOS_R5_TRANSACTIONS_CSV does not exist: {path}")
        return pd.DataFrame(columns=["store_id", "week_index", "total_transactions"])
    try:
        transactions = pd.read_csv(path, dtype={"store_id": str})
    except (OSError, ValueError, pd.errors.ParserError) as error:
        raise BenchmarkUnavailable("The transaction totals CSV could not be read.") from error
    _require_columns(transactions, {"store_id", "week_index", "total_transactions"}, "transaction totals CSV")
    transactions = transactions[["store_id", "week_index", "total_transactions"]].copy()
    transactions["store_id"] = transactions["store_id"].fillna("").astype(str).str.strip()
    transactions["week_index"] = pd.to_numeric(transactions["week_index"], errors="coerce")
    transactions["total_transactions"] = pd.to_numeric(transactions["total_transactions"], errors="coerce")
    if (
        transactions["store_id"].eq("").any()
        or transactions[["week_index", "total_transactions"]].isna().any().any()
        or (transactions["week_index"] % 1 != 0).any()
        or (transactions["total_transactions"] <= 0).any()
    ):
        raise BenchmarkUnavailable("Transaction rows need a known store, whole-number week index, and positive total_transactions.")
    transactions["week_index"] = transactions["week_index"].astype(int)
    transactions["total_transactions"] = transactions["total_transactions"].astype(int)
    if transactions.duplicated(["store_id", "week_index"]).any():
        raise BenchmarkUnavailable("Transaction totals must contain only one row per store_id and week_index.")
    unknown_stores = set(transactions["store_id"]) - set(stores["store_id"].astype(str))
    valid_weeks = set(pd.to_numeric(calendar["week_index"], errors="coerce").dropna().astype(int))
    unknown_weeks = set(transactions["week_index"]) - valid_weeks
    if unknown_stores or unknown_weeks:
        raise BenchmarkUnavailable("Transaction totals reference store IDs or week indexes missing from the R5 master data.")
    return transactions


@lru_cache(maxsize=1)
def _load_benchmark() -> dict[str, Any]:
    package = _configured_path("VOS_R5_DATA_DIR", DEFAULT_PACKAGE)
    output = _configured_path("VOS_R5_SUBMISSION_DIR", DEFAULT_SUBMISSION)
    files = {
        "feedback": package / "data" / "feedback.csv",
        "taxonomy": package / "data" / "issue_taxonomy.csv",
        "stores": package / "data" / "store_master.csv",
        "calendar": package / "data" / "week_calendar.csv",
        "labels": package / "data" / "feedback_labels_train.csv",
        "predictions": output / "R5_predictions.csv",
        "flags": output / "R5_emerging_flags.csv",
        "validation": output / "R5_validation_report.json",
        "evaluation": output / "R5_public_evaluation.json",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        raise BenchmarkUnavailable("The public R5 benchmark package or generated outputs are not installed.")

    try:
        feedback = pd.read_csv(files["feedback"], dtype={"feedback_id": str, "store_id": str})
        taxonomy = pd.read_csv(files["taxonomy"], dtype={"issue_type_id": str})
        stores = pd.read_csv(files["stores"], dtype={"store_id": str})
        calendar = pd.read_csv(files["calendar"])
        labels = pd.read_csv(files["labels"], dtype={"feedback_id": str})
        predictions = pd.read_csv(files["predictions"], dtype={"feedback_id": str, "issue_type_id": str})
        flags = pd.read_csv(files["flags"], dtype={"store_id": str, "issue_type_id": str})
        diagnostics_path = output / "R5_emerging_flag_diagnostics.csv"
        flag_diagnostics = (
            pd.read_csv(diagnostics_path, dtype={"store_id": str, "issue_type_id": str})
            if diagnostics_path.is_file()
            else pd.DataFrame()
        )
        validation = json.loads(files["validation"].read_text(encoding="utf-8"))
        evaluation = json.loads(files["evaluation"].read_text(encoding="utf-8"))
    except (OSError, ValueError, pd.errors.ParserError) as error:
        raise BenchmarkUnavailable("The public R5 benchmark files could not be read.") from error

    _require_columns(feedback, {"feedback_id", "channel", "created_at", "store_id", "text"}, "feedback.csv")
    _require_columns(taxonomy, {"issue_type_id", "issue_type", "owner_function", "policy_severity_floor"}, "issue_taxonomy.csv")
    _require_columns(stores, {"store_id", "store_name", "city", "state", "region", "avg_weekly_footfall"}, "store_master.csv")
    _require_columns(calendar, {"week_index", "week_start", "week_end", "labelled_period"}, "week_calendar.csv")
    _require_columns(predictions, {"feedback_id", "issue_type_id", "severity", "actionable"}, "R5_predictions.csv")
    _require_columns(flags, {"as_of_week_start", "store_id", "issue_type_id", "confidence", "evidence_feedback_ids"}, "R5_emerging_flags.csv")

    if feedback["feedback_id"].duplicated().any() or predictions["feedback_id"].duplicated().any():
        raise BenchmarkUnavailable("Feedback and prediction IDs must be unique in the public benchmark.")
    if len(feedback) != len(predictions) or set(feedback["feedback_id"]) != set(predictions["feedback_id"]):
        raise BenchmarkUnavailable("Generated predictions do not cover every organizer feedback ID exactly once.")

    feedback["store_id"] = feedback["store_id"].fillna("").astype(str).str.strip()
    rows = feedback.merge(predictions, on="feedback_id", how="inner", validate="one_to_one")
    rows = rows.merge(
        taxonomy[["issue_type_id", "issue_type", "owner_function", "is_actionable_category"]],
        on="issue_type_id",
        how="left",
        validate="many_to_one",
    ).merge(
        stores[["store_id", "store_name", "city", "state", "region", "avg_weekly_footfall"]],
        on="store_id",
        how="left",
        validate="many_to_one",
    )
    unknown_store = rows["store_name"].isna() & rows["store_id"].ne("")
    if rows["issue_type"].isna().any() or unknown_store.any():
        raise BenchmarkUnavailable("A generated prediction references an unknown taxonomy class or non-empty store ID.")
    rows["store_name"] = rows["store_name"].fillna("Store not identified")
    rows["city"] = rows["city"].fillna("")
    rows["state"] = rows["state"].fillna("")
    rows["region"] = rows["region"].fillna("Region not assigned")

    rows["created_at"] = pd.to_datetime(rows["created_at"], errors="coerce")
    rows["severity"] = rows["severity"].astype(str).str.casefold()
    if rows["created_at"].isna().any() or not rows["severity"].isin(SEVERITY_ORDER).all():
        raise BenchmarkUnavailable("Feedback timestamps or severity values are invalid.")
    calendar = calendar.copy()
    calendar["week_start"] = pd.to_datetime(calendar["week_start"], errors="raise")
    calendar["week_end"] = pd.to_datetime(calendar["week_end"], errors="raise") + pd.Timedelta(days=1) - pd.Timedelta(nanoseconds=1)
    calendar["week_index"] = pd.to_numeric(calendar["week_index"], errors="raise").astype(int)
    calendar = calendar.sort_values("week_start")
    rows = pd.merge_asof(
        rows.sort_values("created_at"),
        calendar[["week_start", "week_end", "week_index", "labelled_period"]],
        left_on="created_at",
        right_on="week_start",
        direction="backward",
    )
    if rows["week_index"].isna().any() or (rows["created_at"] > rows["week_end"]).any():
        raise BenchmarkUnavailable("Some organizer feedback is outside the official week calendar.")
    rows["week_index"] = rows["week_index"].astype(int)
    rows["actionable"] = pd.to_numeric(rows["actionable"], errors="raise").astype(int).astype(bool)
    flags["as_of_week_start"] = pd.to_datetime(flags["as_of_week_start"], errors="coerce")
    if flags["as_of_week_start"].isna().any():
        raise BenchmarkUnavailable("The generated emerging flags contain an invalid week start.")

    transactions = _load_transactions(stores, calendar)

    return {
        "rows": rows,
        "taxonomy": taxonomy,
        "stores": stores,
        "calendar": calendar,
        "labels": labels,
        "flags": flags,
        "transactions": transactions,
        "flag_diagnostics": flag_diagnostics,
        "validation": validation,
        "evaluation": evaluation,
    }


def _owner_for_app(owner: str) -> str:
    return APP_OWNER_NAMES.get(owner, owner)


@lru_cache(maxsize=1)
def _duplicate_candidate_queue() -> dict[str, Any]:
    """Find review candidates using exact text and conservative character similarity."""
    rows: pd.DataFrame = _load_benchmark()["rows"].copy().reset_index(drop=True)
    eligible = rows[
        pd.to_numeric(rows["is_actionable_category"], errors="coerce").fillna(0).eq(1)
        & rows["store_id"].astype(str).ne("")
    ].copy().reset_index(drop=True)
    eligible["normalized_text"] = eligible["text"].fillna("").astype(str).map(
        lambda text: re.sub(
            r"\s+",
            " ",
            re.sub(r"[^\w]+", " ", unicodedata.normalize("NFKC", text).casefold()),
        ).strip()
    )
    eligible = eligible[eligible["normalized_text"].str.len() >= 18].copy().reset_index(drop=True)
    candidates: list[dict[str, Any]] = []
    exact_groups = 0
    exact_pairs: set[tuple[str, str]] = set()

    def candidate_record(group: pd.DataFrame, *, match_type: str, similarity: float) -> dict[str, Any]:
        ordered = group.sort_values(["created_at", "feedback_id"])
        records = [_record(row) for _, row in ordered.iterrows()]
        issue_ids = sorted({str(record["issue_type_id"]) for record in records})
        ids = sorted(record["feedback_id"] for record in records)
        prefix = "EXACT" if match_type == "exact_text" else "NEAR"
        key = hashlib.sha256("|".join(ids).encode("utf-8")).hexdigest()[:12].upper()
        return {
            "candidate_id": f"{prefix}-{key}",
            "match_type": match_type,
            "similarity": round(float(similarity), 3),
            "issue_match": len(issue_ids) == 1,
            "issue_type_ids": issue_ids,
            "category": records[0]["category"] if len(issue_ids) == 1 else "Conflicting issue predictions",
            "store_id": str(ordered.iloc[0]["store_id"]),
            "store_name": records[0]["store_name"],
            "region": records[0]["region"],
            "week_index": int(ordered.iloc[0]["week_index"]),
            "channels": sorted({record["channel"] for record in records}),
            "records": records[:4],
        }

    for _, group in eligible.groupby(["store_id", "week_index", "normalized_text"], sort=False):
        if group["channel"].nunique() < 2:
            continue
        exact_groups += 1
        ids = sorted(group["feedback_id"].astype(str).tolist())
        for left_index, left_id in enumerate(ids):
            for right_id in ids[left_index + 1:]:
                exact_pairs.add((left_id, right_id))
        candidates.append(candidate_record(group, match_type="exact_text", similarity=1.0))

    near_candidates: list[dict[str, Any]] = []
    if not eligible.empty:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from threadpoolctl import threadpool_limits

        with threadpool_limits(limits=1):
            matrix = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=1).fit_transform(
                eligible["normalized_text"].tolist()
            )
            for _, indexes in eligible.groupby(["store_id", "week_index", "issue_type_id"], sort=False).groups.items():
                positions = list(indexes)
                if len(positions) < 2 or eligible.loc[positions, "channel"].nunique() < 2:
                    continue
                similarities = (matrix[positions] @ matrix[positions].T).tocoo()
                for left_position, right_position, score in zip(similarities.row, similarities.col, similarities.data):
                    if left_position >= right_position or score < 0.78:
                        continue
                    left = eligible.iloc[positions[left_position]]
                    right = eligible.iloc[positions[right_position]]
                    if left["channel"] == right["channel"] or left["normalized_text"] == right["normalized_text"]:
                        continue
                    pair = tuple(sorted((str(left["feedback_id"]), str(right["feedback_id"]))))
                    if pair in exact_pairs:
                        continue
                    near_candidates.append(candidate_record(
                        pd.DataFrame([left, right]), match_type="near_text", similarity=float(score)
                    ))
    near_candidates.sort(key=lambda item: (-item["similarity"], item["candidate_id"]))
    candidates.extend(near_candidates)
    candidates.sort(key=lambda item: (item["match_type"] != "exact_text", -item["similarity"], item["candidate_id"]))
    return {
        "summary": {
            "candidate_count": len(candidates),
            "exact_text_groups": exact_groups,
            "near_text_pairs": len(near_candidates),
            "scanned_feedback_records": int(len(eligible)),
        },
        "candidates": candidates,
        "scope": "Known store · same calendar week · cross-channel · actionable predicted issue classes",
        "method_note": "Exact normalized text and character n-gram similarity (0.78+) produce review candidates only. Similarity is not proof of a shared incident; nothing is merged automatically.",
    }


def benchmark_duplicate_candidates(*, limit: int = 30) -> dict[str, Any]:
    """Return a bounded, human-reviewable cross-channel duplicate candidate queue."""
    queue = _duplicate_candidate_queue()
    return {**queue, "candidates": queue["candidates"][:limit]}


def _optional_float(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    return float(value)


def _record(row: pd.Series) -> dict[str, Any]:
    created_at = pd.Timestamp(row["created_at"])
    state = str(row["state"]).strip()
    city = str(row["city"]).strip()
    location = ", ".join(part for part in (city, state) if part and part.casefold() != "nan")
    return {
        "feedback_id": str(row["feedback_id"]),
        "text": str(row["text"]),
        "channel": str(row["channel"]),
        "created_at": created_at.isoformat(),
        "store_id": str(row["store_id"] or ""),
        "store_name": str(row["store_name"]),
        "location": location,
        "region": str(row["region"]),
        "week_index": int(row["week_index"]),
        "category": str(row["issue_type"]),
        "issue_type_id": str(row["issue_type_id"]),
        "severity": str(row["severity"]).capitalize(),
        "actionable": bool(row["actionable"]),
        "owner_function": str(row["owner_function"]),
        "assigned_department": _owner_for_app(str(row["owner_function"])),
    }


def _validation_metrics(data: dict[str, Any]) -> dict[str, Any]:
    validation = data["validation"].get("validation", data["validation"])
    public = data["evaluation"]
    return {
        "holdout": {
            "method": validation.get("validation_split", {}).get("method", "chronological public holdout"),
            "rows": int(validation.get("validation_rows", 0)),
            "issue_type_classes": int(validation.get("issue_type_classes_in_validation", 0)),
            "issue_type_macro_f1": float(validation.get("issue_type_macro_f1", 0)),
            "severity_weighted_f1": float(validation.get("severity_weighted_f1", 0)),
            "actionable_positive_f1": float(validation.get("actionable_positive_f1", 0)),
            "actionable_precision": float(validation.get("actionable_precision", 0)),
            "actionable_high_or_critical_precision": float(validation.get("actionable_high_or_critical_precision", 0)),
        },
        "public_evaluator": {
            "rows": int(public.get("n_scored", 0)),
            "classification_score": float(public.get("classification_score", 0)),
            "primary_score": float(public.get("primary_score", 0)),
            "lead_score": float(public.get("lead_score", 0)),
            "flags_in_scored_period": int(public.get("n_flags", 0)),
            "valid_flags": int(public.get("n_flags_valid", 0)),
            "first_public_incident_flag_week": next(
                (incident.get("your_first_matching_flag") for incident in public.get("incidents", []) if incident.get("your_first_matching_flag")),
                None,
            ),
            "baseline_first_flag_week": next(
                (incident.get("naive_detect_week_start") for incident in public.get("incidents", []) if incident.get("naive_detect_week_start")),
                None,
            ),
        },
    }


def benchmark_overview(*, feedback_limit: int = 12, alert_limit: int = 10) -> dict[str, Any]:
    """Return compact, source-linked views over the full public package."""
    data = _load_benchmark()
    rows: pd.DataFrame = data["rows"]
    calendar: pd.DataFrame = data["calendar"]
    stores: pd.DataFrame = data["stores"]
    taxonomy: pd.DataFrame = data["taxonomy"]
    flags: pd.DataFrame = data["flags"]
    summary = {
        "feedback_records": int(len(rows)),
        "prediction_records": int(rows["feedback_id"].nunique()),
        "public_training_labels": int(len(data["labels"])),
        "taxonomy_categories": int(taxonomy["issue_type_id"].nunique()),
        "stores": int(stores["store_id"].nunique()),
        "store_options": [
            {
                "store_id": str(row.store_id),
                "store_name": str(row.store_name),
                "region": str(row.region),
                "location": ", ".join(part for part in (str(row.city), str(row.state)) if part and part.casefold() != "nan"),
            }
            for row in stores.sort_values(["region", "store_name"]).itertuples(index=False)
        ],
        "regions": sorted(stores["region"].dropna().astype(str).unique().tolist()),
        "weeks": int(calendar["week_index"].nunique()),
        "first_week_start": calendar["week_start"].min().date().isoformat(),
        "last_week_start": calendar["week_start"].max().date().isoformat(),
        "emerging_flag_rows": int(len(flags)),
        "valid_evidence_ids": int(data["validation"].get("submission_validation", {}).get("valid_evidence_ids", 0)),
        "channel_counts": {str(key): int(value) for key, value in rows["channel"].value_counts().items()},
        "critical_or_high_predictions": int(rows["severity"].isin(["critical", "high"]).sum()),
        "actionable_predictions": int(rows["actionable"].sum()),
        "transaction_rows_loaded": int(len(data["transactions"])),
        "transaction_weeks_loaded": int(data["transactions"]["week_index"].nunique()),
    }

    trend = []
    for week in calendar.sort_values("week_index").itertuples(index=False):
        period = rows[rows["week_index"] == int(week.week_index)]
        counts = period["severity"].value_counts()
        trend.append({
            "week_index": int(week.week_index),
            "week_start": pd.Timestamp(week.week_start).date().isoformat(),
            "week": f"W{int(week.week_index):02d}",
            "critical": int(counts.get("critical", 0)),
            "high": int(counts.get("high", 0)),
            "medium": int(counts.get("medium", 0)),
            "low": int(counts.get("low", 0)),
            "unclassified": 0,
            "total": int(len(period)),
        })

    categories = (
        rows.groupby(["issue_type_id", "issue_type", "owner_function"], as_index=False)
        .size()
        .rename(columns={"size": "count", "issue_type": "category"})
        .sort_values(["count", "issue_type_id"], ascending=[False, True])
        .head(8)
    )
    category_records = [
        {"category": str(row.category), "short_label": str(row.category)[:22], "count": int(row.count),
         "owner_function": str(row.owner_function)}
        for row in categories.itertuples(index=False)
    ]

    latest_feedback = rows.sort_values(["created_at", "feedback_id"], ascending=[False, True]).head(feedback_limit)
    feedback_records = [_record(row) for _, row in latest_feedback.iterrows()]

    public_incident_week = None
    incidents = data["evaluation"].get("incidents", [])
    if incidents:
        public_incident_week = incidents[0].get("your_first_matching_flag")
    flags_sorted = flags.sort_values("as_of_week_start", ascending=False)
    if public_incident_week:
        public_date = pd.to_datetime(public_incident_week)
        flags_sorted = pd.concat([
            flags_sorted[flags_sorted["as_of_week_start"] == public_date],
            flags_sorted[flags_sorted["as_of_week_start"] != public_date],
        ]).drop_duplicates()

    row_by_id = rows.set_index(rows["feedback_id"].astype(str), drop=False)
    diagnostics: pd.DataFrame = data.get("flag_diagnostics", pd.DataFrame())
    diagnostic_by_key = {}
    if not diagnostics.empty:
        diagnostic_by_key = {
            (str(row.as_of_week_start), str(row.store_id).upper(), str(row.issue_type_id).upper()): row._asdict()
            for row in diagnostics.itertuples(index=False)
        }
    alert_records = []
    for flag in flags_sorted.head(alert_limit).itertuples(index=False):
        evidence_ids = [part.strip() for part in str(flag.evidence_feedback_ids).split(";") if part.strip()]
        evidence_rows = [row_by_id.loc[identifier] for identifier in evidence_ids if identifier in row_by_id.index]
        if not evidence_rows:
            continue
        first = evidence_rows[0]
        quote_records = [_record(row) for row in evidence_rows[:3]]
        diagnostic = diagnostic_by_key.get((str(flag.as_of_week_start), str(flag.store_id).upper(), str(flag.issue_type_id).upper()), {})
        alert_records.append({
            "week_start": pd.Timestamp(flag.as_of_week_start).date().isoformat(),
            "store_id": str(flag.store_id),
            "store_name": str(first["store_name"]),
            "region": str(first["region"]),
            "issue_type_id": str(flag.issue_type_id),
            "category": str(first["issue_type"]),
            "owner_function": str(first["owner_function"]),
            "severity": max((str(item["severity"]) for item in evidence_rows), key=lambda value: SEVERITY_ORDER[value]).capitalize(),
            "detector_score": float(flag.confidence),
            "current_rate_per_1000_footfall": _optional_float(diagnostic.get("current_rate_per_1000_footfall")),
            "rolling_mean_per_1000_footfall": _optional_float(diagnostic.get("rolling_mean_per_1000_footfall")),
            "ewma_baseline_per_1000_footfall": _optional_float(diagnostic.get("ewma_baseline_per_1000_footfall")),
            "ewma_z_score": _optional_float(diagnostic.get("ewma_z_score")),
            "evidence_count": len(evidence_ids),
            "evidence_feedback_ids": evidence_ids,
            "evidence": quote_records,
            "matches_public_incident_example": bool(public_incident_week and pd.Timestamp(flag.as_of_week_start) == pd.to_datetime(public_incident_week) and str(flag.issue_type_id) == "IT17"),
        })

    return {
        "source_label": "Organizer-provided synthetic R5 benchmark",
        "summary": summary,
        "metrics": _validation_metrics(data),
        "trend": trend,
        "categories": category_records,
        "feedback": feedback_records,
        "alerts": alert_records,
    }


def benchmark_brief(*, region: str | None = None, week_index: int | None = None) -> dict[str, Any]:
    """Build a traceable five-category regional summary from classified benchmark rows."""
    data = _load_benchmark()
    rows: pd.DataFrame = data["rows"]
    stores: pd.DataFrame = data["stores"]
    calendar: pd.DataFrame = data["calendar"]
    flags: pd.DataFrame = data["flags"]
    transactions: pd.DataFrame = data["transactions"]
    regions = sorted(stores["region"].dropna().astype(str).unique().tolist())
    if region is None:
        region = regions[0] if regions else ""
    if region not in regions:
        raise ValueError(f"Unknown region. Choose one of: {', '.join(regions)}.")
    available_weeks = calendar.sort_values("week_index").to_dict(orient="records")
    valid_weeks = {int(item["week_index"]) for item in available_weeks}
    if week_index is None:
        week_index = max(valid_weeks)
    if week_index not in valid_weeks:
        raise ValueError("The selected week is outside the official R5 calendar.")

    selected_calendar = next(item for item in available_weeks if int(item["week_index"]) == week_index)
    region_stores = stores[stores["region"].astype(str) == region].copy()
    selected = rows[(rows["region"].astype(str) == region) & (rows["week_index"] == week_index)].copy()
    selected_operational = selected[pd.to_numeric(selected["is_actionable_category"], errors="coerce").fillna(0).eq(1)]
    prior_calendar = [item for item in available_weeks if int(item["week_index"]) < week_index]
    previous_week_index = int(prior_calendar[-1]["week_index"]) if prior_calendar else None
    previous = (
        rows[(rows["region"].astype(str) == region) & (rows["week_index"] == previous_week_index)].copy()
        if previous_week_index is not None
        else rows.iloc[0:0].copy()
    )
    previous_week_available = previous_week_index is not None and not previous.empty
    baseline_footfall = pd.to_numeric(region_stores["avg_weekly_footfall"], errors="coerce").fillna(0)
    footfall_denominator = float(baseline_footfall.sum())
    region_store_ids = set(region_stores["store_id"].astype(str))
    current_transactions = transactions[
        transactions["store_id"].astype(str).isin(region_store_ids)
        & transactions["week_index"].eq(week_index)
    ]
    previous_transactions = (
        transactions[
            transactions["store_id"].astype(str).isin(region_store_ids)
            & transactions["week_index"].eq(previous_week_index)
        ]
        if previous_week_index is not None
        else transactions.iloc[0:0]
    )
    use_transactions = not current_transactions.empty or not previous_transactions.empty
    normalization_source = "transactions" if use_transactions else "footfall_proxy"
    current_transaction_stores = set(current_transactions["store_id"].astype(str))
    previous_transaction_stores = set(previous_transactions["store_id"].astype(str))

    issue_counts = selected_operational.groupby(["issue_type_id", "issue_type", "owner_function"], as_index=False).size()
    issue_counts = issue_counts.sort_values(["size", "issue_type_id"], ascending=[False, True])
    previous_counts = previous.groupby("issue_type_id").size().to_dict()
    selected_flag_start = pd.Timestamp(selected_calendar["week_start"])
    region_store_ids = set(region_stores["store_id"].astype(str))
    selected_flags = flags[
        (flags["as_of_week_start"].dt.normalize() == selected_flag_start.normalize())
        & flags["store_id"].astype(str).isin(region_store_ids)
    ].sort_values(["issue_type_id", "store_id"])
    row_by_id = rows.set_index(rows["feedback_id"].astype(str), drop=False)
    store_name_by_id = dict(zip(stores["store_id"].astype(str), stores["store_name"].astype(str)))
    emerging_by_issue: dict[str, dict[str, Any]] = {}
    for flag in selected_flags.itertuples(index=False):
        issue_id = str(flag.issue_type_id)
        store_id = str(flag.store_id)
        store_name = store_name_by_id.get(store_id)
        if not store_name:
            continue
        evidence_ids = [part.strip() for part in str(flag.evidence_feedback_ids).split(";") if part.strip()]
        evidence_rows = []
        for identifier in evidence_ids:
            if identifier not in row_by_id.index:
                continue
            evidence_row = row_by_id.loc[identifier]
            if (
                str(evidence_row["store_id"]) == store_id
                and str(evidence_row["issue_type_id"]) == issue_id
                and str(evidence_row["region"]) == region
            ):
                evidence_rows.append(evidence_row)
        if not evidence_rows:
            continue
        emerging = emerging_by_issue.setdefault(issue_id, {
            "category": str(evidence_rows[0]["issue_type"]),
            "issue_type_id": issue_id,
            "responsible_department": _owner_for_app(str(evidence_rows[0]["owner_function"])),
            "flag_count": 0,
            "flagged_stores": set(),
            "quotes": [],
            "seen_feedback_ids": set(),
        })
        emerging["flag_count"] += 1
        emerging["flagged_stores"].add(store_name)
        for evidence_row in evidence_rows:
            feedback_id = str(evidence_row["feedback_id"])
            if feedback_id in emerging["seen_feedback_ids"]:
                continue
            emerging["seen_feedback_ids"].add(feedback_id)
            if len(emerging["quotes"]) < 3:
                emerging["quotes"].append(_record(evidence_row))

    emerging_issues = [
        {
            "category": item["category"],
            "issue_type_id": issue_id,
            "responsible_department": item["responsible_department"],
            "flag_count": int(item["flag_count"]),
            "flagged_stores": sorted(item["flagged_stores"]),
            "evidence_count": len(item["seen_feedback_ids"]),
            "quotes": item["quotes"],
        }
        for issue_id, item in sorted(emerging_by_issue.items(), key=lambda pair: (-pair[1]["flag_count"], pair[0]))
    ]
    emerging_by_id = {item["issue_type_id"]: item for item in emerging_issues}
    issues = []
    for item in issue_counts.itertuples(index=False):
        issue_rows = selected_operational[selected_operational["issue_type_id"] == item.issue_type_id]
        prior_count = int(previous_counts.get(item.issue_type_id, 0)) if previous_week_available else None
        current_count = int(item.size)
        issue_previous_rows = previous[previous["issue_type_id"] == item.issue_type_id]
        if use_transactions:
            current_exposure_stores = current_transaction_stores
            previous_exposure_stores = previous_transaction_stores
            if current_transaction_stores and previous_transaction_stores:
                common_stores = current_transaction_stores & previous_transaction_stores
                current_exposure_stores = common_stores
                previous_exposure_stores = common_stores
            current_exposure = current_transactions[
                current_transactions["store_id"].astype(str).isin(current_exposure_stores)
            ]
            previous_exposure = previous_transactions[
                previous_transactions["store_id"].astype(str).isin(previous_exposure_stores)
            ]
            current_rate_rows = issue_rows[issue_rows["store_id"].astype(str).isin(current_exposure_stores)]
            previous_rate_rows = issue_previous_rows[
                issue_previous_rows["store_id"].astype(str).isin(previous_exposure_stores)
            ]
            current_denominator = float(current_exposure["total_transactions"].sum())
            previous_denominator = float(previous_exposure["total_transactions"].sum())
            current_rate = len(current_rate_rows) * 1000 / current_denominator if current_denominator > 0 else None
            previous_rate = (
                len(previous_rate_rows) * 1000 / previous_denominator
                if previous_denominator > 0 and prior_count is not None
                else None
            )
            rate_store_coverage = int(len(current_exposure_stores))
            rate_feedback_count = int(len(current_rate_rows))
            rate_denominator = current_denominator
            previous_rate_denominator = previous_denominator
            rate_store_ids = sorted(current_exposure_stores)
            previous_rate_store_ids = sorted(previous_exposure_stores)
        else:
            current_rate = current_count * 1000 / footfall_denominator if footfall_denominator > 0 else None
            previous_rate = prior_count * 1000 / footfall_denominator if footfall_denominator > 0 and prior_count is not None else None
            rate_store_coverage = int(region_stores["avg_weekly_footfall"].notna().sum())
            rate_feedback_count = current_count
            rate_denominator = footfall_denominator
            previous_rate_denominator = footfall_denominator
            rate_store_ids = sorted(
                region_stores.loc[pd.to_numeric(region_stores["avg_weekly_footfall"], errors="coerce").gt(0), "store_id"].astype(str)
            )
            previous_rate_store_ids = rate_store_ids
        if current_rate is None or previous_rate is None:
            trend = "no_baseline"
        elif current_rate > previous_rate:
            trend = "up"
        elif current_rate < previous_rate:
            trend = "down"
        else:
            trend = "flat"
        affected = issue_rows.groupby(["store_id", "store_name", "city", "state"], as_index=False).size().sort_values("size", ascending=False)
        quotes = []
        for _, quote in issue_rows.sort_values(["created_at", "feedback_id"]).head(3).iterrows():
            location = ", ".join(part for part in (str(quote["city"]), str(quote["state"])) if part and part.casefold() != "nan")
            quotes.append({
                "feedback_id": str(quote["feedback_id"]),
                "text": str(quote["text"]),
                "source": str(quote["channel"]),
                "store_name": str(quote["store_name"]),
                "location": location,
            })
        actionable_share = float(issue_rows["actionable"].mean()) if len(issue_rows) else 0.0
        highest_severity = max(issue_rows["severity"].tolist(), key=lambda value: SEVERITY_ORDER[value]).capitalize()
        emerging = emerging_by_id.get(str(item.issue_type_id))
        responsible_department = _owner_for_app(str(item.owner_function))
        recommended_action = (
            f"Review the source reports with {responsible_department} and verify conditions at the listed stores."
        )
        issues.append({
            "category": str(item.issue_type),
            "issue_type_id": str(item.issue_type_id),
            "severity": highest_severity,
            "owner_function": str(item.owner_function),
            "responsible_department": responsible_department,
            "feedback_count": current_count,
            "actionable_share": actionable_share,
            "normalized_rate_per_1000_exposure": current_rate,
            "previous_feedback_count": prior_count,
            "previous_rate_per_1000_exposure": previous_rate,
            "rate_store_coverage": rate_store_coverage,
            "rate_feedback_count": rate_feedback_count,
            "rate_denominator": rate_denominator,
            "previous_rate_denominator": previous_rate_denominator,
            "rate_store_ids": rate_store_ids,
            "previous_rate_store_ids": previous_rate_store_ids,
            "normalization_source": normalization_source,
            "trend": trend,
            "affected_stores": [str(row.store_name) for row in affected.itertuples(index=False)],
            "quotes": quotes,
            "emerging_flag_count": emerging["flag_count"] if emerging else 0,
            "emerging_stores": emerging["flagged_stores"] if emerging else [],
            "recommended_action": recommended_action,
            "recommended_investigation": recommended_action,
        })

    return {
        "region": region,
        "week_index": int(week_index),
        "week_start": pd.Timestamp(selected_calendar["week_start"]).date().isoformat(),
        "week_end": pd.Timestamp(selected_calendar["week_end"]).date().isoformat(),
        "previous_week_index": previous_week_index,
        "previous_week_available": bool(previous_week_available),
        "previous_week_feedback_rows": int(len(previous)),
        "available_regions": regions,
        "available_weeks": [
            {"week_index": int(item["week_index"]), "week_start": pd.Timestamp(item["week_start"]).date().isoformat()}
            for item in available_weeks
        ],
        "source_status": "available",
        "feedback_rows": int(len(selected)),
        "expected_store_count": int(len(region_stores)),
        "covered_store_count": int(len(current_transaction_stores)) if use_transactions else int(region_stores["avg_weekly_footfall"].notna().sum()),
        "normalization_source": normalization_source,
        "normalization_note": (
            f"Rates use transaction totals from the configured import for this region/week. {len(current_transaction_stores)}/{len(region_stores)} stores have current-week totals; reports at stores without totals are excluded from the rate but remain in feedback counts. Detector flags remain as generated with footfall scaling. These are classified feedback rows, not deduplicated incident groups."
            if use_transactions
            else "No transaction totals are loaded for this region/week. Rates use the organizer store master’s average weekly footfall as a proxy. These are classified feedback rows, not deduplicated incident groups."
        ),
        "validation_precision": _validation_metrics(data)["holdout"],
        "issues": issues[:5],
        "all_issues": issues,
        "emerging_issues": emerging_issues,
        "empty_period_message": (
            "The benchmark contains no feedback rows for this region and week."
            if selected.empty
            else "No actionable operational issues were classified for this region and week."
            if issue_counts.empty
            else None
        ),
    }
