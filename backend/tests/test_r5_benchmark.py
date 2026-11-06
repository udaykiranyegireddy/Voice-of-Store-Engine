from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from backend.r5_benchmark import BenchmarkUnavailable, _load_benchmark, _load_transactions, benchmark_brief, benchmark_overview, is_known_store_identifier
from backend.main import get_r5_duplicate_candidates
from backend.tests.test_api_incidents import asgi_request


class R5BenchmarkTests(unittest.TestCase):
    def test_transaction_import_accepts_a_verified_store_week_row(self) -> None:
        data_dir = Path(__file__).resolve().parents[2] / "data" / "organizer-r5-v1" / "R5_Voice_of_Store_Engine" / "data"
        stores = pd.read_csv(data_dir / "store_master.csv", dtype={"store_id": str})
        calendar = pd.read_csv(data_dir / "week_calendar.csv")
        store_id = str(stores.iloc[0]["store_id"])
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / "data") as directory:
            path = Path(directory) / "transactions.csv"
            path.write_text(f"store_id,week_index,total_transactions\n{store_id},1,1250\n", encoding="utf-8")
            with patch.dict(os.environ, {"VOS_R5_TRANSACTIONS_CSV": str(path)}):
                rows = _load_transactions(stores, calendar)
        self.assertEqual(rows.iloc[0]["store_id"], store_id)
        self.assertEqual(rows.iloc[0]["total_transactions"], 1250)

    def test_transaction_import_rejects_duplicate_store_week_rows(self) -> None:
        data_dir = Path(__file__).resolve().parents[2] / "data" / "organizer-r5-v1" / "R5_Voice_of_Store_Engine" / "data"
        stores = pd.read_csv(data_dir / "store_master.csv", dtype={"store_id": str})
        calendar = pd.read_csv(data_dir / "week_calendar.csv")
        store_id = str(stores.iloc[0]["store_id"])
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / "data") as directory:
            path = Path(directory) / "transactions.csv"
            path.write_text(
                f"store_id,week_index,total_transactions\n{store_id},1,1250\n{store_id},1,1300\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"VOS_R5_TRANSACTIONS_CSV": str(path)}):
                with self.assertRaises(BenchmarkUnavailable):
                    _load_transactions(stores, calendar)

    def test_regional_brief_uses_transaction_denominators_when_configured(self) -> None:
        data_dir = Path(__file__).resolve().parents[2] / "data" / "organizer-r5-v1" / "R5_Voice_of_Store_Engine" / "data"
        stores = pd.read_csv(data_dir / "store_master.csv", dtype={"store_id": str})
        east_ids = stores.loc[stores["region"].eq("East"), "store_id"].astype(str).tolist()
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / "data") as directory:
            path = Path(directory) / "transactions.csv"
            rows = ["store_id,week_index,total_transactions"]
            rows.extend(f"{store_id},{week_index},1000" for store_id in east_ids for week_index in (1, 2))
            path.write_text("\n".join(rows) + "\n", encoding="utf-8")
            with patch.dict(os.environ, {"VOS_R5_TRANSACTIONS_CSV": str(path)}):
                _load_benchmark.cache_clear()
                try:
                    brief = benchmark_brief(region="East", week_index=2)
                finally:
                    _load_benchmark.cache_clear()
        self.assertEqual(brief["normalization_source"], "transactions")
        self.assertEqual(brief["covered_store_count"], len(east_ids))
        self.assertTrue(all(issue["normalization_source"] == "transactions" for issue in brief["issues"]))
        self.assertTrue(all(issue["previous_rate_per_1000_exposure"] is not None for issue in brief["issues"]))

    def test_overview_uses_complete_organizer_coverage_and_source_records(self) -> None:
        result = benchmark_overview(feedback_limit=2, alert_limit=10)

        self.assertEqual(result["source_label"], "Organizer-provided synthetic R5 benchmark")
        self.assertEqual(result["summary"]["feedback_records"], 39769)
        self.assertEqual(result["summary"]["prediction_records"], 39769)
        self.assertEqual(result["summary"]["public_training_labels"], 3000)
        self.assertEqual(result["summary"]["taxonomy_categories"], 33)
        self.assertEqual(result["summary"]["stores"], 60)
        self.assertEqual(result["summary"]["transaction_rows_loaded"], 0)
        self.assertEqual(result["summary"]["emerging_flag_rows"], 75)
        self.assertEqual(len(result["feedback"]), 2)
        self.assertTrue(result["feedback"][0]["feedback_id"].startswith("FB-"))
        self.assertTrue(result["feedback"][0]["text"])
        self.assertTrue(result["alerts"])
        self.assertTrue(any(item["matches_public_incident_example"] for item in result["alerts"]))
        self.assertNotEqual(result["metrics"]["public_evaluator"]["first_public_incident_flag_week"], None)
        public_alert = next(item for item in result["alerts"] if item["matches_public_incident_example"])
        self.assertTrue(public_alert["store_id"])
        self.assertTrue(public_alert["evidence_feedback_ids"])
        self.assertIn("current_rate_per_1000_footfall", public_alert)
        self.assertIn("rolling_mean_per_1000_footfall", public_alert)
        self.assertIn("ewma_baseline_per_1000_footfall", public_alert)
        self.assertIn("ewma_z_score", public_alert)

    def test_regional_brief_contains_five_or_fewer_real_evidence_backed_issues(self) -> None:
        brief = benchmark_brief(region="East", week_index=1)

        self.assertEqual(brief["region"], "East")
        self.assertEqual(brief["week_index"], 1)
        self.assertLessEqual(len(brief["issues"]), 5)
        self.assertTrue(all(not issue["issue_type_id"].startswith("NI") for issue in brief["issues"]))
        if brief["issues"]:
            self.assertTrue(brief["issues"][0]["quotes"])
            self.assertTrue(brief["issues"][0]["quotes"][0]["feedback_id"].startswith("FB-"))
            self.assertIn("footfall", brief["normalization_note"])
            self.assertTrue(brief["issues"][0]["responsible_department"])
            self.assertTrue(brief["issues"][0]["recommended_action"])

    def test_first_week_reports_missing_previous_week_without_zero_baseline(self) -> None:
        brief = benchmark_brief(region="East", week_index=1)

        self.assertIsNone(brief["previous_week_index"])
        self.assertFalse(brief["previous_week_available"])
        self.assertEqual(brief["previous_week_feedback_rows"], 0)
        self.assertTrue(all(issue["trend"] == "no_baseline" for issue in brief["issues"]))
        self.assertTrue(all(issue["previous_feedback_count"] is None for issue in brief["issues"]))
        self.assertTrue(all(issue["previous_rate_per_1000_exposure"] is None for issue in brief["issues"]))

    def test_week_with_prior_feedback_reports_a_real_previous_week_comparison(self) -> None:
        brief = benchmark_brief(region="East", week_index=2)

        self.assertEqual(brief["previous_week_index"], 1)
        self.assertTrue(brief["previous_week_available"])
        self.assertGreater(brief["previous_week_feedback_rows"], 0)
        self.assertTrue(all(issue["previous_feedback_count"] is not None for issue in brief["issues"]))

    def test_weekly_brief_includes_region_scoped_generated_flags_and_real_evidence(self) -> None:
        brief = benchmark_brief(region="North", week_index=26)

        flagged_issue = next(issue for issue in brief["issues"] if issue["issue_type_id"] == "IT16")
        emerging_issue = next(issue for issue in brief["emerging_issues"] if issue["issue_type_id"] == "IT16")
        self.assertGreater(flagged_issue["emerging_flag_count"], 0)
        self.assertEqual(flagged_issue["emerging_stores"], emerging_issue["flagged_stores"])
        self.assertTrue(emerging_issue["quotes"])
        self.assertTrue(all(quote["feedback_id"].startswith("FB-") for quote in emerging_issue["quotes"]))
        self.assertEqual(emerging_issue["responsible_department"], "Store Operations")

    def test_store_routability_requires_a_real_store_master_match(self) -> None:
        self.assertTrue(is_known_store_identifier(store_id="ST-001JY"))
        self.assertTrue(is_known_store_identifier(store_name="Saffron Market Gariahat"))
        self.assertFalse(is_known_store_identifier(store_name="A store that is not in the master"))

    def test_duplicate_candidate_endpoint_returns_cross_channel_review_items(self) -> None:
        candidates = get_r5_duplicate_candidates(limit=10)
        self.assertGreater(candidates["summary"]["candidate_count"], 0)
        self.assertTrue(all(len(candidate["channels"]) > 1 for candidate in candidates["candidates"]))

    def test_public_benchmark_routes_work_without_an_authentication_header(self) -> None:
        status, payload = asyncio.run(
            asgi_request(path="/r5/benchmark", method="GET")
        )
        self.assertEqual(status, 200)
        self.assertIn("summary", payload)
        self.assertIn("alerts", payload)

        status, brief = asyncio.run(
            asgi_request(path="/r5/benchmark/brief", method="GET")
        )
        self.assertEqual(status, 200)
        self.assertEqual(brief["region"], brief["available_regions"][0])



if __name__ == "__main__":
    unittest.main()
