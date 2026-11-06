from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from FULL_CODE.r5_solution import (
    FLAG_COLUMNS,
    PREDICTION_COLUMNS,
    detect_week,
    generate_emerging_flags,
    model_artifact_path,
    predict_public_timeline,
    _validation_split,
    _weekly_flag_candidates,
    _active_duplicate_keys,
    policy_prediction,
    predict_all_feedback,
    validate_submission_outputs,
)


class ConstantModel:
    def __init__(self, value: str):
        self.value = value

    def predict(self, matrix):
        return np.repeat(self.value, len(matrix))


class IdentityVectorizer:
    def transform(self, texts):
        return list(texts)


def fake_bundle(taxonomy: dict[str, dict[str, object]]) -> dict[str, object]:
    return {
        "vectorizer": IdentityVectorizer(),
        "models": {
            "issue_type_id": ConstantModel("IT14"),
            "severity": ConstantModel("low"),
            "actionable": ConstantModel("1"),
        },
        "taxonomy": taxonomy,
    }


class R5PipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.taxonomy = {
            "IT14": {
                "issue_type_id": "IT14",
                "issue_type": "Out of stock / empty shelves",
                "owner_function": "Supply Chain",
                "policy_severity_floor": "low",
                "is_actionable_category": 1,
            },
            "IT18": {
                "issue_type_id": "IT18",
                "issue_type": "Allergen / ingredient labelling error",
                "owner_function": "Merchandising",
                "policy_severity_floor": "high",
                "is_actionable_category": 1,
            },
            "IT27": {
                "issue_type_id": "IT27",
                "issue_type": "Payment failure / money debited but order failed",
                "owner_function": "Digital",
                "policy_severity_floor": "medium",
                "is_actionable_category": 1,
            },
            "IT11": {
                "issue_type_id": "IT11",
                "issue_type": "Equipment breakdown (AC, lift, lights, scale, POS)",
                "owner_function": "Store Ops",
                "policy_severity_floor": "low",
                "is_actionable_category": 1,
            },
        }

    def test_model_artifact_path_uses_override_environment_or_project_default(self) -> None:
        explicit_path = Path("artifacts/custom.joblib")
        self.assertEqual(model_artifact_path(explicit_path), explicit_path)

        configured_path = Path("artifacts/from-environment.joblib")
        with patch.dict("os.environ", {"VOS_MODEL_PATH": str(configured_path)}):
            self.assertEqual(model_artifact_path(), configured_path)

        with patch.dict("os.environ", {}, clear=True):
            expected = Path(__file__).resolve().parents[2] / "ml" / "artifacts" / "r5_tfidf_classifier.joblib"
            self.assertEqual(model_artifact_path(), expected)

    def test_predictions_have_exact_official_columns_and_cover_every_feedback_id(self) -> None:
        data = self._causal_fixture()
        predictions = predict_all_feedback(data, fake_bundle(self.taxonomy))

        self.assertEqual(list(predictions.columns), PREDICTION_COLUMNS)
        self.assertEqual(set(predictions.feedback_id), set(data["feedback"].feedback_id))
        self.assertEqual(len(predictions), len(data["feedback"]))

    def test_as_of_detector_excludes_rows_after_sunday_and_cites_same_week_store_evidence(self) -> None:
        data = self._causal_fixture()
        diagnostics = []
        flags = detect_week(data, "2026-04-06", bundle=fake_bundle(self.taxonomy), diagnostics=diagnostics)

        self.assertEqual(list(flags.columns), FLAG_COLUMNS)
        self.assertEqual(len(flags), 1)
        flag = flags.iloc[0]
        self.assertEqual(flag.as_of_week_start, "2026-04-06")
        self.assertEqual(flag.store_id, "ST-001")
        cited = set(flag.evidence_feedback_ids.split(";"))
        self.assertEqual(cited, {"FB-W2-A", "FB-W2-B"})
        self.assertNotIn("FB-AFTER-SUNDAY", cited)
        predictions = predict_all_feedback(data, fake_bundle(self.taxonomy))
        validation = validate_submission_outputs(data, predictions, flags)
        self.assertEqual(validation["valid_evidence_ids"], 2)
        self.assertEqual(diagnostics[0]["as_of_week_start"], "2026-04-06")
        self.assertEqual(diagnostics[0]["store_id"], "ST-001")
        self.assertEqual(diagnostics[0]["category"], "Out of stock / empty shelves")
        self.assertEqual(diagnostics[0]["independent_feedback_count"], 2)
        self.assertGreater(diagnostics[0]["ewma_z_score"], 0)
        self.assertEqual(set(diagnostics[0]["evidence_feedback_ids"].split(";")), cited)

    def test_ongoing_store_issue_is_not_alerted_again_within_two_weeks(self) -> None:
        data = self._causal_fixture()
        data["stores"].loc[:, "avg_weekly_footfall"] = "1000"
        for index in range(4):
            data["feedback"] = pd.concat(
                [
                    data["feedback"],
                    pd.DataFrame([{
                        "feedback_id": f"FB-W3-{index}",
                        "channel": "in_app",
                        "created_at": f"2026-04-14 10:{index:02d}:00",
                        "store_id": "ST-001",
                        "text": f"A distinct ongoing stock report {index}",
                    }]),
                ],
                ignore_index=True,
            )

        flags = detect_week(data, "2026-04-13", bundle=fake_bundle(self.taxonomy))

        self.assertTrue(flags.empty)

    def test_duplicate_suppression_releases_after_two_quiet_weeks(self) -> None:
        events = pd.DataFrame([
            {"week_index": 2, "resolved_store_id": "ST-001", "issue_type_id": "IT14"},
            {"week_index": 3, "resolved_store_id": "ST-001", "issue_type_id": "IT14"},
        ])
        prior_alert = {("ST-001", "IT14"): 2}

        self.assertEqual(_active_duplicate_keys(events, prior_alert, 4), {("ST-001", "IT14")})
        self.assertEqual(_active_duplicate_keys(events, prior_alert, 6), set())

    def test_public_evaluation_flags_include_causal_training_weeks(self) -> None:
        data = self._causal_fixture()
        bundle = fake_bundle(self.taxonomy)
        first_week_predictions = pd.DataFrame(
            [{"feedback_id": "FB-W1", "issue_type_id": "IT14", "severity": "low", "actionable": 1}],
            columns=PREDICTION_COLUMNS,
        )
        with patch("FULL_CODE.r5_solution._first_week_cold_start_predictions", return_value=first_week_predictions):
            with patch("FULL_CODE.r5_solution.fit_bundle", return_value=bundle) as fit:
                predictions, causal_bundles = predict_public_timeline(data, bundle, Path("."))

        fit.assert_called_once()
        self.assertEqual(set(fit.call_args.args[0]["week_index"]), {1})
        self.assertEqual(set(causal_bundles), {2})
        flags = generate_emerging_flags(data, causal_bundles, bundle)

        self.assertEqual(list(flags.columns), FLAG_COLUMNS)
        self.assertEqual(list(flags["as_of_week_start"]), ["2026-04-06"])
        validation = validate_submission_outputs(data, predictions, flags)
        self.assertEqual(validation["valid_evidence_ids"], 2)

    def test_detector_never_spends_weekly_flag_budget_on_non_issue_categories(self) -> None:
        data = self._causal_fixture()
        events = pd.DataFrame(
            [
                {"week_index": 2, "week_start": "2026-04-06", "week_end": "2026-04-12", "created_at": "2026-04-07 09:00:00", "feedback_id": "A", "text": "stock issue one", "issue_type_id": "IT14", "resolved_store_id": "ST-001"},
                {"week_index": 2, "week_start": "2026-04-06", "week_end": "2026-04-12", "created_at": "2026-04-08 09:00:00", "feedback_id": "B", "text": "stock issue two", "issue_type_id": "IT14", "resolved_store_id": "ST-001"},
                {"week_index": 2, "week_start": "2026-04-06", "week_end": "2026-04-12", "created_at": "2026-04-09 09:00:00", "feedback_id": "C", "text": "positive note one", "issue_type_id": "NI01", "resolved_store_id": "ST-001"},
                {"week_index": 2, "week_start": "2026-04-06", "week_end": "2026-04-12", "created_at": "2026-04-10 09:00:00", "feedback_id": "D", "text": "positive note two", "issue_type_id": "NI01", "resolved_store_id": "ST-001"},
            ]
        )

        flags = _weekly_flag_candidates(events, data["calendar"].iloc[1].to_dict(), data["stores"])

        self.assertEqual(flags["issue_type_id"].tolist(), ["IT14"])

    def test_detector_ranks_footfall_normalized_spikes_ahead_of_raw_volume(self) -> None:
        data = self._causal_fixture()
        stores = pd.DataFrame(
            [
                {"store_id": "ST-LOW", "store_name": "Saffron Market Small", "region": "West", "size_sqft": "1000", "avg_weekly_footfall": "1000"},
                {"store_id": "ST-HIGH", "store_name": "Saffron Market Central", "region": "West", "size_sqft": "100000", "avg_weekly_footfall": "100000"},
            ]
        )
        events = []
        for store_id, count in (("ST-LOW", 2), ("ST-HIGH", 24)):
            for index in range(count):
                events.append(
                    {"week_index": 2, "week_start": "2026-04-06", "week_end": "2026-04-12", "created_at": f"2026-04-07 09:{index % 60:02d}:00", "feedback_id": f"{store_id}-{index}", "text": f"distinct stock shortage report {store_id} {index}", "issue_type_id": "IT14", "resolved_store_id": store_id}
                )

        flags = _weekly_flag_candidates(pd.DataFrame(events), data["calendar"].iloc[1].to_dict(), stores, max_flags=1)

        self.assertEqual(flags["store_id"].tolist(), ["ST-LOW"])

    def test_critical_issue_is_not_suppressed_by_a_low_rate_or_high_baseline(self) -> None:
        data = self._causal_fixture()
        data["stores"].loc[:, "avg_weekly_footfall"] = "100000"
        events = []
        for index in range(20):
            events.append({
                "week_index": 1,
                "week_start": "2026-03-30",
                "week_end": "2026-04-05",
                "created_at": f"2026-04-01 09:{index:02d}:00",
                "feedback_id": f"BASE-{index}",
                "text": f"prior allergen report {index}",
                "issue_type_id": "IT18",
                "severity": "high",
                "resolved_store_id": "ST-001",
            })
        for index in range(2):
            events.append({
                "week_index": 2,
                "week_start": "2026-04-06",
                "week_end": "2026-04-12",
                "created_at": f"2026-04-07 10:{index:02d}:00",
                "feedback_id": f"CRITICAL-{index}",
                "text": f"current critical allergen report {index}",
                "issue_type_id": "IT18",
                "severity": "critical",
                "resolved_store_id": "ST-001",
            })

        flags = _weekly_flag_candidates(pd.DataFrame(events), data["calendar"].iloc[1].to_dict(), data["stores"])

        self.assertEqual(flags["issue_type_id"].tolist(), ["IT18"])
        self.assertGreaterEqual(float(flags.iloc[0].confidence), 0.95)

    def test_recency_weighted_baseline_catches_rebound_after_an_older_spike(self) -> None:
        data = self._causal_fixture()
        events = []
        for index in range(4):
            events.append({
                "week_index": 1,
                "week_start": "2026-03-30",
                "week_end": "2026-04-05",
                "created_at": f"2026-04-01 09:{index:02d}:00",
                "feedback_id": f"OLD-{index}",
                "text": f"older distinct report {index}",
                "issue_type_id": "IT14",
                "resolved_store_id": "ST-001",
            })
        for index in range(4):
            events.append({
                "week_index": 3,
                "week_start": "2026-04-13",
                "week_end": "2026-04-19",
                "created_at": f"2026-04-14 09:{index:02d}:00",
                "feedback_id": f"CURRENT-{index}",
                "text": f"current distinct report {index}",
                "issue_type_id": "IT14",
                "resolved_store_id": "ST-001",
            })

        flags = _weekly_flag_candidates(pd.DataFrame(events), data["calendar"].iloc[2].to_dict(), data["stores"])

        self.assertEqual(flags["issue_type_id"].tolist(), ["IT14"])
        self.assertEqual(set(flags.iloc[0].evidence_feedback_ids.split(";")), {f"CURRENT-{index}" for index in range(4)})

    def test_exact_duplicate_cross_channel_text_is_not_counted_as_two_signals(self) -> None:
        data = self._causal_fixture()
        data["feedback"].loc[data["feedback"]["feedback_id"] == "FB-W2-B", "text"] = "Oat milk is out of stock"
        duplicate = data["feedback"].loc[data["feedback"]["feedback_id"] == "FB-W2-B"].copy()
        duplicate.loc[:, "feedback_id"] = "FB-W2-DUP"
        duplicate.loc[:, "channel"] = "call_centre_ticket"
        duplicate.loc[:, "created_at"] = "2026-04-09 11:00:00"
        duplicate.loc[:, "text"] = "Oat milk is out of stock"
        data["feedback"] = pd.concat([data["feedback"], duplicate], ignore_index=True)

        flags = detect_week(data, "2026-04-06", bundle=fake_bundle(self.taxonomy))
        self.assertEqual(len(flags), 0)

    def test_allergen_exposure_policy_keeps_high_floor_and_urgent_human_review(self) -> None:
        decision = policy_prediction(
            "IT18",
            "low",
            1,
            "A customer with a peanut allergy ate food with an undeclared peanut ingredient and had an allergic reaction.",
            self.taxonomy,
        )

        self.assertEqual(decision["issue_type_id"], "IT18")
        self.assertEqual(decision["severity"], "critical")
        self.assertTrue(decision["requires_human_verification"])
        self.assertTrue(decision["escalation_required"])

    def test_validation_holdout_sorts_string_week_indices_numerically(self) -> None:
        calendar = pd.DataFrame(
            [
                {"week_index": str(week), "week_start": f"week-{week}", "week_end": f"week-{week}-end", "labelled_period": "train"}
                for week in range(1, 14)
            ]
        )
        labeled = pd.DataFrame(
            [{"feedback_id": f"FB-{week}", "text": f"unique feedback {week}", "week_index": week, "issue_type_id": "IT01"}
             for week in range(1, 14)]
        )

        training, validation, split = _validation_split(labeled, calendar)

        self.assertEqual(split["validation_week_indices"], [10, 11, 12, 13])
        self.assertEqual(split["training_week_indices"], [1, 2, 3, 4, 5, 6, 7, 8, 9])
        self.assertEqual(set(training.week_index), set(range(1, 10)))
        self.assertEqual(set(validation.week_index), {10, 11, 12, 13})

    def test_actionability_requires_a_routable_store_except_online_digital_categories(self) -> None:
        store_bound = policy_prediction("IT14", "low", 1, "out of stock", self.taxonomy, store_known=False)
        online_payment = policy_prediction("IT27", "medium", 1, "app payment failed", self.taxonomy, store_known=False)

        self.assertEqual(store_bound["actionable"], 0)
        self.assertEqual(store_bound["actionability"], "needs_review")
        self.assertEqual(online_payment["actionable"], 1)

    def test_ordinary_refrigerator_failure_does_not_trigger_food_safety_escalation(self) -> None:
        decision = policy_prediction(
            "IT11", "low", 1, "The refrigerator is not cooling.", self.taxonomy, store_known=True,
        )

        self.assertEqual(decision["issue_type_id"], "IT11")
        self.assertFalse(decision["escalation_required"])
        self.assertFalse(decision["requires_human_verification"])

    def _causal_fixture(self) -> dict[str, pd.DataFrame]:
        feedback = pd.DataFrame(
            [
                {"feedback_id": "FB-W1", "channel": "online_review", "created_at": "2026-04-01 09:00:00", "store_id": "ST-001", "text": "Milk was unavailable last week"},
                {"feedback_id": "FB-W2-A", "channel": "in_app", "created_at": "2026-04-07 09:00:00", "store_id": "ST-001", "text": "Oat milk is out of stock"},
                {"feedback_id": "FB-W2-B", "channel": "online_review", "created_at": "2026-04-09 09:00:00", "store_id": "ST-001", "text": "The shelf has no oat milk today"},
                {"feedback_id": "FB-AFTER-SUNDAY", "channel": "in_app", "created_at": "2026-04-13 09:00:00", "store_id": "ST-001", "text": "Many items are unavailable after Sunday"},
            ]
        )
        return {
            "feedback": feedback,
            "labels": pd.DataFrame([{"feedback_id": "FB-W1", "issue_type_id": "IT14", "severity": "low", "actionable": "1"}]),
            "taxonomy": pd.DataFrame([self.taxonomy["IT14"]]),
            "stores": pd.DataFrame([{"store_id": "ST-001", "store_name": "Saffron Market Central", "region": "West", "size_sqft": "10000", "avg_weekly_footfall": "10000"}]),
            "calendar": pd.DataFrame(
                [
                    {"week_index": "1", "week_start": "2026-03-30", "week_end": "2026-04-05", "labelled_period": "train"},
                    {"week_index": "2", "week_start": "2026-04-06", "week_end": "2026-04-12", "labelled_period": "train"},
                    {"week_index": "3", "week_start": "2026-04-13", "week_end": "2026-04-19", "labelled_period": "test"},
                ]
            ),
        }


if __name__ == "__main__":
    unittest.main()
