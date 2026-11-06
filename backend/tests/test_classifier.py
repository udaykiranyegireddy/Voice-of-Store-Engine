import os
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

from backend.classifier import classify_feedback, classify_feedback_for_api
from backend.main import FeedbackAnalyzeRequest, FeedbackAnalyzeResponse, analyze_feedback


class FeedbackClassifierTests(unittest.TestCase):
    def test_payment_failure_routes_to_digital_support(self) -> None:
        examples = (
            "The mobile payment failed and the checkout app shows a transaction error.",
            "The digital checkout app is failing.",
            "The card reader is not working.",
            "Checkout is not working.",
            "The checkout doesn't work.",
        )
        for feedback in examples:
            with self.subTest(feedback=feedback):
                result = classify_feedback(feedback)
                self.assertEqual(result.category, "Payment failure")
                self.assertEqual(result.recommended_department, "Digital / Technical Support")
                self.assertEqual(result.severity, "High")
                self.assertEqual(result.actionability, "actionable")
                self.assertTrue(result.recommended_action)
                self.assertFalse(result.escalation_required)

    def test_broken_freezer_routes_to_taxonomy_owner(self) -> None:
        result = classify_feedback("The freezer is broken and needs repair.")

        self.assertEqual(result.category, "Equipment failure")
        self.assertEqual(result.severity, "High")
        self.assertEqual(result.recommended_department, "Store Operations")
        self.assertEqual(result.actionability, "actionable")
        self.assertEqual(result.status, "Open")

    def test_stock_shortage_routes_to_supply_chain(self) -> None:
        examples = (
            "The oat milk is out of stock and the shelf has not been replenished.",
            "Several products are unavailable on the shelf.",
            "The replenishment delivery was missed.",
        )
        for feedback in examples:
            with self.subTest(feedback=feedback):
                result = classify_feedback(feedback)
                self.assertEqual(result.category, "Availability")
                self.assertEqual(result.recommended_department, "Supply Chain")
                self.assertEqual(result.actionability, "actionable")
                self.assertTrue(result.recommended_action)
        self.assertEqual(classify_feedback(examples[0]).severity, "High")
        self.assertIn("replenishment", classify_feedback(examples[0]).recommended_action)

    def test_incorrect_allergen_label_requires_critical_escalation(self) -> None:
        result = classify_feedback("The allergen label incorrectly omits peanuts.")

        self.assertEqual(result.category, "Allergen / ingredient labelling error")
        self.assertEqual(result.severity, "Critical")
        self.assertEqual(result.recommended_department, "Merchandising")
        self.assertEqual(result.status, "Requires human verification")
        self.assertEqual(result.actionability, "needs_review")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)
        self.assertIn("immediately", result.recommended_action.lower())
        self.assertIn("not a confirmed hazard", result.explanation)

    def test_reported_allergen_exposure_requires_critical_escalation(self) -> None:
        result = classify_feedback(
            "A customer with a peanut allergy ate a product containing undeclared peanuts."
        )

        self.assertEqual(result.category, "Allergen / ingredient labelling error")
        self.assertEqual(result.severity, "Critical")
        self.assertEqual(result.recommended_department, "Merchandising")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)

    def test_food_safety_report_requires_review_while_escalation_remains_urgent(self) -> None:
        result = classify_feedback("The chilled food was left unrefrigerated.")

        self.assertEqual(result.category, "Refrigeration / cold-chain failure")
        self.assertEqual(result.severity, "Critical")
        self.assertEqual(result.actionability, "needs_review")
        self.assertEqual(result.status, "Requires human verification")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)

    def test_refrigeration_not_cooling_is_critical_and_routed_to_store_operations(self) -> None:
        result = classify_feedback("The freezer is not cooling and the food is thawing.")

        self.assertEqual(result.category, "Refrigeration / cold-chain failure")
        self.assertEqual(result.recommended_department, "Store Operations")
        self.assertEqual(result.severity, "Critical")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)

    def test_hygiene_risk_also_requires_immediate_escalation(self) -> None:
        result = classify_feedback("Food hygiene conditions are unsafe.")

        self.assertEqual(result.category, "Hygiene lapse (pests, dirty food areas, foul smell)")
        self.assertEqual(result.severity, "Critical")
        self.assertEqual(result.recommended_department, "Store Operations")
        self.assertTrue(result.escalation_required)
        self.assertTrue(result.requires_human_verification)

    def test_unhygienic_food_handling_is_a_critical_hygiene_lapse(self) -> None:
        examples = (
            "A staff member handled ready-to-eat food unhygienically.",
            "The employee handled ready-to-eat food with dirty hands.",
        )
        for feedback in examples:
            with self.subTest(feedback=feedback):
                result = classify_feedback(feedback)

                self.assertEqual(result.category, "Hygiene lapse (pests, dirty food areas, foul smell)")
                self.assertEqual(result.severity, "Critical")
                self.assertEqual(result.recommended_department, "Store Operations")
                self.assertTrue(result.requires_human_verification)
                self.assertTrue(result.escalation_required)

    def test_a_single_hygiene_mention_is_critical_and_routed_to_store_operations(self) -> None:
        result = classify_feedback("The restroom hygiene is poor.")

        self.assertEqual(result.category, "Hygiene lapse (pests, dirty food areas, foul smell)")
        self.assertEqual(result.severity, "Critical")
        self.assertEqual(result.recommended_department, "Store Operations")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)

    def test_foreign_object_report_routes_to_merchandising_as_critical(self) -> None:
        result = classify_feedback("A foreign object was found in the food product.")

        self.assertEqual(result.category, "Foreign object / contamination in product")
        self.assertEqual(result.recommended_department, "Merchandising")
        self.assertEqual(result.severity, "Critical")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)

    def test_model_routing_uses_taxonomy_owner_and_critical_safety_floor(self) -> None:
        fake_model = ModuleType("FULL_CODE.r5_solution")
        fake_model.load_model_bundle = lambda: {"test": True}
        fake_model.model_artifact_path = lambda: None
        fake_model.predict_one = lambda *_args: {
            "issue_type_id": "IT18",
            "owner_function": "Merchandising",
            "category": "Allergen / ingredient labelling error",
            "severity": "high",
            "recommended_action": "Review the report and route follow-up to Merchandising.",
            "explanation": "Test taxonomy prediction.",
            "status": "Open",
            "requires_human_verification": False,
            "actionability": "actionable",
            "escalation_required": False,
            "classification_method": "tfidf_linear_svc+taxonomy_policy",
        }

        with patch.dict(sys.modules, {"FULL_CODE.r5_solution": fake_model}):
            result = classify_feedback_for_api("Please inspect this product label.")

        self.assertEqual(result.category, "Allergen / ingredient labelling error")
        self.assertEqual(result.recommended_department, "Merchandising")
        self.assertEqual(result.severity, "Critical")
        self.assertEqual(result.actionability, "needs_review")
        self.assertEqual(result.status, "Needs human review")
        self.assertTrue(result.requires_human_verification)
        self.assertTrue(result.escalation_required)

    def test_staff_misconduct_is_high_priority_and_requires_human_review(self) -> None:
        examples = (
            "A staff member threatened me during checkout.",
            "I am reporting employee misconduct.",
            "A team member bullied a customer.",
        )
        for feedback in examples:
            with self.subTest(feedback=feedback):
                result = classify_feedback(feedback)
                self.assertEqual(result.category, "Staff behavior")
                self.assertEqual(result.severity, "High")
                self.assertEqual(result.recommended_department, "Store Leadership")
                self.assertEqual(result.actionability, "needs_review")
                self.assertEqual(result.status, "Needs human review")
                self.assertTrue(result.requires_human_verification)
                self.assertTrue(result.escalation_required)
                self.assertIn("not treat the report as substantiated", result.recommended_action)

    def test_ordinary_refrigerator_failure_is_not_a_food_safety_incident(self) -> None:
        result = classify_feedback(
            "The refrigerator stopped working, but the food stayed cold and there was no food-safety incident."
        )

        self.assertEqual(result.category, "Equipment failure")
        self.assertEqual(result.severity, "High")
        self.assertEqual(result.recommended_department, "Store Operations")
        self.assertFalse(result.requires_human_verification)
        self.assertFalse(result.escalation_required)

    def test_ambiguous_feedback_is_sent_for_human_review(self) -> None:
        result = classify_feedback("A customer said something was not right during a visit.")

        self.assertEqual(result.category, "Unknown")
        self.assertEqual(result.severity, "Unclassified")
        self.assertEqual(result.actionability, "needs_review")
        self.assertEqual(result.status, "Needs human review")
        self.assertTrue(result.requires_human_verification)
        self.assertFalse(result.escalation_required)

    def test_positive_feedback_is_informational(self) -> None:
        result = classify_feedback("Thanks, the staff provided great service.")

        self.assertEqual(result.category, "Informational")
        self.assertEqual(result.actionability, "informational")
        self.assertFalse(result.requires_human_verification)
        self.assertFalse(result.escalation_required)

    def test_analysis_response_includes_typed_decision_fields(self) -> None:
        request = FeedbackAnalyzeRequest(
            feedback_text="The payment failed at the card reader.",
            store_id="DEMO-01",
            source="staff_report",
        )
        with patch(
            "backend.main.classify_feedback_for_api",
            return_value=classify_feedback("The payment failed at the card reader."),
        ):
            response = analyze_feedback(request)
        payload = response.model_dump()

        self.assertIsInstance(response, FeedbackAnalyzeResponse)
        self.assertIsInstance(payload["actionability"], str)
        self.assertIn(payload["actionability"], {"actionable", "needs_review", "informational"})
        self.assertIsInstance(payload["recommended_action"], str)
        self.assertTrue(payload["recommended_action"].strip())
        self.assertIsInstance(payload["escalation_required"], bool)
        self.assertEqual(payload["recommended_department"], "Digital / Technical Support")

    def test_departments_remain_configurable(self) -> None:
        with patch.dict(
            os.environ,
            {
                "VOS_DEPARTMENT_DIGITAL_SUPPORT": "Technology Desk",
                "VOS_DEPARTMENT_SUPPLY_CHAIN": "Inventory Team",
            },
        ):
            payment = classify_feedback("Card declined while I tried to pay.")
            stock = classify_feedback("The product is out of stock.")

        self.assertEqual(payment.recommended_department, "Technology Desk")
        self.assertEqual(stock.recommended_department, "Inventory Team")


if __name__ == "__main__":
    unittest.main()
