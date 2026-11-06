from __future__ import annotations

import asyncio
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.classifier import classify_feedback_for_api
from backend.tests.test_api_incidents import asgi_request
class R5ModelApiIntegrationTests(unittest.TestCase):
    def require_model_bundle(self) -> None:
        try:
            from FULL_CODE.r5_solution import load_model_bundle

            bundle = load_model_bundle()
        except ImportError as error:
            self.skipTest(f"R5 inference dependencies are unavailable: {error}.")
        if bundle is None:
            self.skipTest("R5 model artifact has not been trained yet.")

    def test_feedback_api_uses_trained_classifier_when_artifact_is_available(self) -> None:
        self.require_model_bundle()

        decision = classify_feedback_for_api(
            "The payment app failed and my money was debited, but the order did not go through.",
            source="customer_feedback",
            store_known=True,
        )

        self.assertEqual(decision.classification_method, "tfidf_linear_svc+taxonomy_policy")
        self.assertEqual(decision.recommended_department, "Digital / Technical Support")
        self.assertIn("Payment", decision.category)
        self.assertIn(decision.severity, {"Low", "Medium", "High", "Critical"})

    def test_missing_artifact_reports_path_and_regeneration_command(self) -> None:
        project_root = Path(__file__).resolve().parents[2]
        missing_path = project_root / ".codex-backups" / "2026-10-30" / "missing-model-test" / "model.joblib"
        self.assertFalse(missing_path.is_file())

        with patch.dict(os.environ, {"VOS_MODEL_PATH": str(missing_path)}):
            decision = classify_feedback_for_api(
                "The payment app failed after the order was placed.",
                source="customer_feedback",
                store_known=True,
            )

        self.assertEqual(decision.classification_method, "transparent_rules_fallback")
        self.assertIn(str(missing_path.resolve()), decision.explanation)
        self.assertIn("FULL_CODE.r5_solution train", decision.explanation)
        self.assertIn("data\\organizer-r5-v1\\R5_Voice_of_Store_Engine\\data\\feedback.csv", decision.explanation)

    def test_freezer_model_recommendation_keeps_department_and_action_consistent(self) -> None:
        self.require_model_bundle()

        decision = classify_feedback_for_api(
            "The freezer is broken and needs repair.",
            source="staff_report",
            store_known=True,
        )

        self.assertEqual(decision.recommended_department, "Store Operations")
        self.assertIn("Store Operations", decision.recommended_action)

    def test_explicit_safety_rules_remain_a_priority_with_model_available(self) -> None:
        self.require_model_bundle()

        decision = classify_feedback_for_api(
            "The employee handled ready-to-eat food with dirty hands.",
            source="staff_report",
            store_known=True,
        )

        self.assertTrue(decision.requires_human_verification)
        self.assertTrue(decision.escalation_required)
        self.assertEqual(decision.classification_method, "transparent_rules+safety_policy")

    def test_negated_safety_mention_keeps_ordinary_equipment_routed_to_facilities(self) -> None:
        self.require_model_bundle()

        decision = classify_feedback_for_api(
            "The refrigerator is broken and there is no food-safety incident.",
            source="staff_report",
            store_known=True,
        )

        self.assertEqual(decision.category, "Equipment failure")
        self.assertEqual(decision.recommended_department, "Store Operations")
        self.assertFalse(decision.requires_human_verification)
        self.assertFalse(decision.escalation_required)
        self.assertEqual(decision.classification_method, "transparent_rules+negated_safety_context")

    def test_fastapi_analyze_endpoint_returns_model_fields_and_safety_escalation(self) -> None:
        self.require_model_bundle()

        status, payment = asyncio.run(
            asgi_request(
                path="/feedback/analyze",
                payload={
                    "feedback_text": "The payment app failed and money was debited, but the order did not go through.",
                    "store_id": "ST-001",
                    "source": "customer_feedback",
                },
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(payment["classification_method"], "tfidf_linear_svc+taxonomy_policy")
        self.assertEqual(payment["recommended_department"], "Digital / Technical Support")
        self.assertIsInstance(payment["actionability"], str)
        self.assertIsInstance(payment["escalation_required"], bool)

        status, safety = asyncio.run(
            asgi_request(
                path="/feedback/analyze",
                payload={
                    "feedback_text": "A customer ate food containing peanuts despite reporting a peanut allergy.",
                    "store_id": "ST-001",
                    "source": "customer_feedback",
                },
            )
        )
        self.assertEqual(status, 200)
        self.assertTrue(safety["requires_human_verification"])
        self.assertTrue(safety["escalation_required"])

        status, equipment = asyncio.run(
            asgi_request(
                path="/feedback/analyze",
                payload={
                    "feedback_text": "The refrigerator is broken and there is no food-safety incident.",
                    "store_id": "ST-001",
                    "source": "staff_report",
                },
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(equipment["category"], "Equipment failure")
        self.assertEqual(equipment["recommended_department"], "Store Operations")
        self.assertFalse(equipment["requires_human_verification"])
        self.assertFalse(equipment["escalation_required"])


if __name__ == "__main__":
    unittest.main()
