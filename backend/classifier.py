"""Transparent keyword rules for initial feedback triage.

These rules are a demo triage aid, not a trained model or a determination that
a reported hazard is confirmed. Departments can be overridden with the
VOS_DEPARTMENT_* environment variables documented in the README.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Literal


Actionability = Literal["actionable", "needs_review", "informational"]


@dataclass(frozen=True)
class Classification:
    category: str
    severity: str
    recommended_department: str
    explanation: str
    status: str
    requires_human_verification: bool
    actionability: Actionability
    recommended_action: str
    escalation_required: bool
    classification_method: str = "transparent_rules"

    def to_dict(self) -> dict[str, str | bool]:
        return asdict(self)


_DEPARTMENTS = {
    "equipment_failure": ("Store Operations", "VOS_DEPARTMENT_EQUIPMENT_FAILURE"),
    "food_safety": ("Store Operations", "VOS_DEPARTMENT_FOOD_SAFETY"),
    "payment_failure": ("Digital / Technical Support", "VOS_DEPARTMENT_DIGITAL_SUPPORT"),
    "availability": ("Supply Chain", "VOS_DEPARTMENT_SUPPLY_CHAIN"),
    "checkout": ("Store Operations", "VOS_DEPARTMENT_CHECKOUT"),
    "product_quality": ("Merchandising", "VOS_DEPARTMENT_PRODUCT_QUALITY"),
    "store_environment": ("Store Operations", "VOS_DEPARTMENT_STORE_ENVIRONMENT"),
    "staff_behavior": ("Store Leadership", "VOS_DEPARTMENT_STAFF_BEHAVIOR"),
    "unknown": ("Store Operations", "VOS_DEPARTMENT_UNKNOWN"),
}

_ALLERGEN_TERMS = (
    "allergen", "allergy", "allergic", "peanut", "peanuts", "tree nut",
    "tree nuts", "milk allergy", "dairy allergy", "egg allergy", "soy allergy",
    "wheat allergy", "sesame allergy", "undeclared ingredient", "may contain",
    "wrong allergen", "allergen label", "ingredient label",
)
_FOOD_SAFETY_TERMS = (
    "food poisoning", "cross contamination", "contaminated",
    "unhygienic food handling", "unhygienic handling of food",
    "food handled unhygienically", "handled food unhygienically",
    "handled ready to eat food unhygienically",
    "handled food with dirty gloves", "handled food with unclean gloves",
    "handled ready to eat food with dirty hands",
    "handled ready to eat food with unwashed hands",
    "food handled with dirty hands", "food handled with unwashed hands",
    "dirty hands while handling food", "unwashed hands while handling food",
    "dirty gloves while handling food", "food handler did not wash hands",
    "food handlers did not wash hands", "did not wash hands before handling food",
    "food safety",
    "raw chicken", "raw meat", "undercooked", "spoiled", "mold", "mould",
    "unsafe temperature", "temperature abuse", "food left out", "thawed",
    "defrosted", "warm refrigerator", "warm fridge", "warm cooler",
    "fridge is warm", "refrigerator is warm", "cooler is warm", "warm food",
    "food was warm", "milk was warm", "not cold enough", "not kept refrigerated",
    "left unrefrigerated", "unrefrigerated", "food is thawing", "food was thawing",
    "frozen food is soft", "ice cream is soft", "left at room temperature",
    "pest in food", "foreign object in food", "serious hygiene", "hygiene risk",
    "food hygiene", "unsafe food handling",
)
_CONTAMINATION_TERMS = (
    "foreign object", "contamination", "contaminated", "food poisoning",
    "insect in food", "glass in food", "plastic in food", "metal in food",
    "stone in food", "hair in food", "pest in food",
)
_COLD_CHAIN_TERMS = (
    "unsafe temperature", "temperature abuse", "not cooling", "not staying cold",
    "not keeping food cold", "food left out", "thawed",
    "defrosted", "warm refrigerator", "warm fridge", "warm cooler",
    "fridge is warm", "refrigerator is warm", "cooler is warm", "warm food",
    "food was warm", "milk was warm", "not cold enough", "not kept refrigerated",
    "left unrefrigerated", "unrefrigerated", "food is thawing", "food was thawing",
    "frozen food is soft", "ice cream is soft", "left at room temperature",
)
_PAYMENT_FAILURE_TERMS = (
    "payment failed", "payment fails", "payment failing", "payment failure", "payment error", "payment issue",
    "payment not working", "failed payment", "failed to pay", "cannot pay",
    "unable to pay", "unable to process payment", "payment could not be processed",
    "payment not going through", "payment wont go through", "payment won t go through",
    "card declined", "payment declined", "card reader", "card terminal", "card machine",
    "card reader error", "card reader failed", "card reader not working",
    "payment terminal", "payment terminal error", "payment terminal failed",
    "payment terminal not working", "payment processing", "payment system down",
    "payment system outage", "transaction failed", "transaction error",
    "transaction failure", "charged twice", "double charged", "duplicate charge",
    "payment app", "app payment", "checkout app", "checkout application",
    "checkout app error", "checkout app failed", "checkout app crashing",
    "payment app error", "payment app failed", "app payment error", "app payment failed",
    "mobile app payment error", "mobile app payment failed", "mobile payment error",
    "mobile payment failed", "digital checkout", "digital checkout error",
    "digital checkout failed", "mobile checkout", "online checkout", "online checkout error",
    "checkout not working", "checkout is not working", "checkout isn t working",
    "checkout does not work", "checkout doesn t work", "checkout not responding",
    "checkout is broken", "checkout error", "checkout failed", "checkout failure",
    "digital payment",
    "pos system", "point of sale",
)
_EQUIPMENT_TERMS = (
    "broken", "malfunction", "out of order", "not working", "stopped working",
    "failed", "failure", "freezer", "refrigerator", "fridge", "walk in cooler",
    "cooler", "oven", "conveyor belt", "scanner", "self checkout machine",
    "register machine", "leaking machine",
)
_STOCK_TERMS = (
    "out of stock", "no stock", "sold out", "stock shortage", "supply shortage",
    "inventory shortage", "stockout", "stock out", "low stock", "low inventory",
    "unavailable product", "unavailable products", "product unavailable", "products unavailable",
    "products are unavailable", "product is unavailable", "item unavailable", "items unavailable",
    "items are unavailable", "item is unavailable", "product not available", "item not available",
    "not available on shelf", "not available in store", "no inventory", "out of inventory",
    "empty shelf", "empty shelves", "shelf is empty", "shelves are empty",
    "replenishment", "replenished", "not replenished", "restock", "restocking",
    "restocked", "not restocked", "never restocked", "missed delivery",
    "delivery is missing", "shipment delayed",
)
_CHECKOUT_TERMS = (
    "checkout", "check out", "queue", "waiting in line", "long line",
    "cashier", "payment", "charged twice", "card declined", "price at checkout",
)
_PRODUCT_QUALITY_TERMS = (
    "damaged", "crushed", "defective", "poor quality", "quality issue",
    "packaging", "expired", "broken seal", "product was bad",
)
_ENVIRONMENT_TERMS = (
    "spill", "slippery", "trip hazard", "tripping", "dirty", "unclean",
    "restroom", "bathroom", "lighting", "too cold in the store", "too hot in the store",
)
_HYGIENE_TERMS = (
    "hygiene", "sanitation", "unhygienic", "unhygienically", "unsanitary", "pest", "pests",
    "cockroach", "cockroaches", "foul smell", "dirty food area", "dirty food areas",
    "dirty hands while handling food", "unwashed hands while handling food",
    "dirty gloves while handling food", "food handler did not wash hands",
    "food handlers did not wash hands", "did not wash hands before handling food",
    "handled food with dirty gloves", "handled food with unclean gloves",
    "handled ready to eat food with dirty hands", "handled ready to eat food with unwashed hands",
)
_STAFF_TERMS = (
    "rude", "unhelpful", "ignored me", "staff behavior", "associate behavior",
    "harassed", "harassment", "discriminated", "discrimination", "threatened",
    "staff was dismissive", "employee was dismissive", "misconduct", "abuse",
    "assault", "bullying", "bullied", "staff intimidation", "employee intimidation",
)
_STAFF_MISCONDUCT_TERMS = (
    "harassed", "harassment", "discriminated", "discrimination", "threatened",
    "misconduct", "abuse", "assault", "bullying", "bullied", "staff intimidation",
    "employee intimidation",
)
_NEGATED_FOOD_SAFETY_MENTION = re.compile(
    r"\b(?:no|not)\s+(?:(?:a|any)\s+)?food safety\s+"
    r"(?:risk|issue|concern|incident|hazard)\b"
)
_INFORMATIONAL_TERMS = (
    "thank you", "thanks", "great service", "excellent service", "friendly staff",
    "great experience", "excellent experience", "love this store", "well stocked",
)
_NEGATIVE_CONTEXT_TERMS = (
    "but", "however", "not", "never", "issue", "problem", "wrong", "bad",
    "poor", "did not", "didn t", "failed", "failure", "unable", "broken",
    "shortage", "missing", "unavailable", "sold out", "out of stock",
)


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def _first_match(text: str, terms: tuple[str, ...]) -> str | None:
    normalized = f" {_normalize(text)} "
    for term in terms:
        normalized_term = _normalize(term)
        if f" {normalized_term} " in normalized:
            return term
    return None


def _food_safety_match(text: str) -> str | None:
    """Ignore an explicitly negated generic safety mention, but retain concrete hazards."""
    match = _first_match(text, _FOOD_SAFETY_TERMS)
    if match == "food safety" and _NEGATED_FOOD_SAFETY_MENTION.search(_normalize(text)):
        return None
    return match


def _department(category_key: str) -> str:
    default, environment_key = _DEPARTMENTS[category_key]
    configured = os.getenv(environment_key, "").strip()
    return configured or default


def _result(
    category: str,
    category_key: str,
    severity: str,
    explanation: str,
    recommended_action: str,
    status: str = "Open",
    requires_human_verification: bool = False,
    actionability: Actionability = "actionable",
    escalation_required: bool = False,
) -> Classification:
    return Classification(
        category=category,
        severity=severity,
        recommended_department=_department(category_key),
        explanation=explanation,
        status=status,
        requires_human_verification=requires_human_verification,
        actionability=actionability,
        recommended_action=recommended_action,
        escalation_required=escalation_required,
    )


def classify_feedback(feedback_text: str) -> Classification:
    """Return a rule match, prioritizing possible food-safety and allergen risks."""
    allergen_match = _first_match(feedback_text, _ALLERGEN_TERMS)
    if allergen_match:
        return _result(
            category="Allergen / ingredient labelling error",
            category_key="product_quality",
            severity="Critical",
            explanation=(
                f"Matched the allergen triage keyword “{allergen_match}”. "
                "This is a critical candidate requiring immediate escalation and human verification, "
                "not a confirmed hazard."
            ),
            recommended_action=(
                f"Route this report immediately to {_department('product_quality')} for manager verification and follow "
                "the store's established allergen response procedure."
            ),
            status="Requires human verification",
            requires_human_verification=True,
            actionability="needs_review",
            escalation_required=True,
        )

    cold_chain_match = _first_match(feedback_text, _COLD_CHAIN_TERMS)
    if cold_chain_match:
        return _result(
            "Refrigeration / cold-chain failure", "equipment_failure", "Critical",
            f"Matched the cold-chain safety keyword “{cold_chain_match}”. "
            "This is an unverified critical report requiring immediate escalation.",
            f"Route this report immediately to {_department('equipment_failure')} for manager verification and follow "
            "the store's cold-chain response procedure.",
            status="Requires human verification",
            requires_human_verification=True,
            actionability="needs_review",
            escalation_required=True,
        )

    contamination_match = _first_match(feedback_text, _CONTAMINATION_TERMS)
    if contamination_match:
        return _result(
            "Foreign object / contamination in product", "product_quality", "Critical",
            f"Matched the product-contamination triage keyword “{contamination_match}”. "
            "This is an unverified critical report requiring immediate escalation.",
            f"Route this report immediately to {_department('product_quality')} for manager verification and follow "
            "the store's product-contamination response procedure.",
            status="Requires human verification",
            requires_human_verification=True,
            actionability="needs_review",
            escalation_required=True,
        )

    hygiene_match = _first_match(feedback_text, _HYGIENE_TERMS)
    if hygiene_match:
        return _result(
            "Hygiene lapse (pests, dirty food areas, foul smell)", "store_environment", "Critical",
            f"Matched the hygiene policy keyword “{hygiene_match}”. The report remains unverified until a person reviews it.",
            f"Route this report immediately to {_department('store_environment')} for manager verification, address any immediate hazard, "
            "and follow the store's hygiene response procedure; do not treat the report as confirmed.",
            status="Requires human verification",
            requires_human_verification=True,
            actionability="needs_review",
            escalation_required=True,
        )

    food_safety_match = _food_safety_match(feedback_text)
    if food_safety_match:
        return _result(
            category="Food safety",
            category_key="food_safety",
            severity="Critical",
            explanation=(
                f"Matched the food-safety triage keyword “{food_safety_match}”. "
                "This is a critical candidate requiring immediate escalation and human verification, "
                "not a confirmed hazard."
            ),
            recommended_action=(
                f"Route this report immediately to {_department('food_safety')} for manager verification and follow "
                "the store's established food-safety response procedure."
            ),
            status="Requires human verification",
            requires_human_verification=True,
            actionability="needs_review",
            escalation_required=True,
        )

    payment_match = _first_match(feedback_text, _PAYMENT_FAILURE_TERMS)
    if payment_match:
        return _result(
            category="Payment failure",
            category_key="payment_failure",
            severity="High",
            explanation=f"Matched the payment or digital-checkout failure keyword “{payment_match}”.",
            recommended_action=(
                f"Have {_department('payment_failure')} investigate the payment flow and verify a test "
                "transaction after remediation."
            ),
        )

    equipment_match = _first_match(feedback_text, _EQUIPMENT_TERMS)
    if equipment_match:
        high_severity_terms = (
            "broken", "out of order", "failed", "failure", "freezer", "refrigerator",
            "fridge", "walk in cooler", "cooler", "leaking machine",
        )
        severity = "High" if _first_match(feedback_text, high_severity_terms) else "Medium"
        return _result(
            "Equipment failure", "equipment_failure", severity,
            f"Matched the equipment-failure keyword “{equipment_match}”.",
            "Have Store Operations inspect the reported equipment, arrange repair, and confirm it is safe to use.",
        )

    stock_match = _first_match(feedback_text, _STOCK_TERMS)
    if stock_match:
        high_severity_terms = (
            "out of stock", "sold out", "stock shortage", "supply shortage", "inventory shortage",
        )
        severity = "High" if _first_match(feedback_text, high_severity_terms) else "Medium"
        return _result(
            category="Availability",
            category_key="availability",
            severity=severity,
            explanation=f"Matched the stock-availability or replenishment keyword “{stock_match}”.",
            recommended_action=(
                f"Check on-hand inventory and delivery status, then coordinate replenishment with {_department('availability')}."
            ),
        )

    staff_match = _first_match(feedback_text, _STAFF_TERMS)
    if staff_match:
        misconduct_match = _first_match(feedback_text, _STAFF_MISCONDUCT_TERMS)
        if misconduct_match:
            return _result(
                "Staff behavior", "staff_behavior", "High",
                f"Matched the staff-misconduct policy keyword “{misconduct_match}”. "
                "The report remains unverified until a person reviews it.",
                "Escalate immediately to the configured staff-behavior owner under store policy "
                "and obtain human review; do not treat the report as substantiated.",
                status="Needs human review",
                requires_human_verification=True,
                actionability="needs_review",
                escalation_required=True,
            )
        return _result(
            "Staff behavior", "staff_behavior", "Medium",
            f"Matched the staff-behavior keyword “{staff_match}”.",
            "Have store leadership review the reported interaction and determine an appropriate follow-up.",
        )

    checkout_match = _first_match(feedback_text, _CHECKOUT_TERMS)
    if checkout_match:
        high_severity_terms = ("long line", "queue", "waiting in line", "charged twice")
        severity = "High" if _first_match(feedback_text, high_severity_terms) else "Medium"
        return _result(
            "Checkout", "checkout", severity,
            f"Matched the checkout keyword “{checkout_match}”.",
            "Review checkout availability and queue conditions, then adjust store coverage if needed.",
        )

    quality_match = _first_match(feedback_text, _PRODUCT_QUALITY_TERMS)
    if quality_match:
        severity = "High" if quality_match in {"expired", "broken seal"} else "Medium"
        return _result(
            "Product quality", "product_quality", severity,
            f"Matched the product-quality keyword “{quality_match}”.",
            "Inspect the affected product and packaging, and review its lot or shelf condition before restocking.",
        )

    environment_match = _first_match(feedback_text, _ENVIRONMENT_TERMS)
    if environment_match:
        high_severity_terms = ("spill", "slippery", "trip hazard", "tripping")
        severity = "High" if _first_match(feedback_text, high_severity_terms) else "Medium"
        return _result(
            "Store environment", "store_environment", severity,
            f"Matched the store-environment keyword “{environment_match}”.",
            "Inspect the reported area, address any immediate hazard, and confirm the area is safe.",
        )

    informational_match = _first_match(feedback_text, _INFORMATIONAL_TERMS)
    if informational_match and not _first_match(feedback_text, _NEGATIVE_CONTEXT_TERMS):
        return _result(
            category="Informational",
            category_key="unknown",
            severity="Low",
            explanation=f"Matched a positive-feedback phrase “{informational_match}” without a recognized issue.",
            recommended_action="No immediate operational intervention is indicated; retain as positive feedback.",
            status="Informational",
            actionability="informational",
        )

    return _result(
        category="Unknown",
        category_key="unknown",
        severity="Unclassified",
        explanation="No configured keyword rule matched this feedback; manual review is needed.",
        recommended_action=(
            "Have a manager review the feedback and decide whether it describes an operational issue or needs another owner."
        ),
        status="Needs human review",
        requires_human_verification=True,
        actionability="needs_review",
    )


_APP_DEPARTMENTS_BY_OWNER = {
    "Store Ops": "Store Operations",
    "Digital": "Digital / Technical Support",
    "HR": "Store Leadership",
    "Supply Chain": "Supply Chain",
    "Merchandising": "Merchandising",
    "None (not actionable)": "None (not actionable)",
}
_TAXONOMY_CRITICAL_ISSUES = {"IT06", "IT17", "IT18"}


def classify_feedback_for_api(
    feedback_text: str,
    *,
    source: str = "unknown",
    store_known: bool = True,
) -> Classification:
    """Use the trained R5 model when present, preserving urgent keyword safety rules.

    The transparent rule classifier remains the safe fallback, so starting FastAPI
    does not require an artifact. The trained model is loaded from
    ``ml/artifacts/r5_tfidf_classifier.joblib`` or ``VOS_MODEL_PATH``.
    """
    rule_result = classify_feedback(feedback_text)
    if rule_result.escalation_required:
        return replace(rule_result, classification_method="transparent_rules+safety_policy")
    if rule_result.category == "Informational":
        return rule_result
    if (
        rule_result.category == "Equipment failure"
        and _NEGATED_FOOD_SAFETY_MENTION.search(_normalize(feedback_text))
    ):
        # Do not let a noisy model prediction turn an explicitly negated,
        # otherwise ordinary equipment report into an urgent safety alert.
        return replace(rule_result, classification_method="transparent_rules+negated_safety_context")

    project_root = Path(__file__).resolve().parents[1]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    try:
        from FULL_CODE.r5_solution import load_model_bundle, model_artifact_path, predict_one

        bundle = load_model_bundle()
        if bundle is None:
            model_path = model_artifact_path().resolve()
            return replace(
                rule_result,
                explanation=(
                    f"{rule_result.explanation} The trained R5 model artifact is missing at {model_path}; "
                    "transparent rules were used. From the project root, install the pinned dependencies with "
                    "`.\\backend\\.venv\\Scripts\\python.exe -m pip install -r backend\\requirements.txt`, "
                    "then generate the artifact with "
                    "`.\\backend\\.venv\\Scripts\\python.exe -m FULL_CODE.r5_solution train --feedback "
                    "data\\organizer-r5-v1\\R5_Voice_of_Store_Engine\\data\\feedback.csv "
                    "--out-dir ml\\output\\r5-training --model-out "
                    "ml\\artifacts\\r5_tfidf_classifier.joblib`."
                ),
                classification_method="transparent_rules_fallback",
            )
        prediction = predict_one(feedback_text, source, store_known, bundle)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        # Invalid or incompatible local artifacts must not make feedback analysis
        # unavailable. The explicit method field makes the fallback visible.
        return replace(
            rule_result,
            explanation=(
                f"{rule_result.explanation} The trained model could not be loaded ({error}); "
                "transparent rules were used. Check the artifact path and pinned scikit-learn version."
            ),
            classification_method="transparent_rules_fallback",
        )

    issue_id = str(prediction["issue_type_id"])
    owner = str(prediction["owner_function"])
    department = _APP_DEPARTMENTS_BY_OWNER.get(owner, owner)
    recommended_action = str(prediction["recommended_action"])
    if owner and owner != department:
        recommended_action = recommended_action.replace(owner, department)
    severity = str(prediction["severity"]).capitalize()
    status = str(prediction["status"])
    requires_human_verification = bool(prediction["requires_human_verification"])
    actionability = prediction["actionability"]
    escalation_required = bool(prediction["escalation_required"])
    cold_chain_safety = issue_id == "IT10" and _first_match(feedback_text, _COLD_CHAIN_TERMS)
    if issue_id in _TAXONOMY_CRITICAL_ISSUES or cold_chain_safety:
        severity = "Critical"
        status = "Needs human review"
        requires_human_verification = True
        actionability = "needs_review"
        escalation_required = True
        recommended_action = (
            f"Route this report immediately to {department} for manager verification under store policy. "
            "This system does not send an external alert or confirm that the reported hazard is present."
        )
    return Classification(
        category=str(prediction["category"]),
        severity=severity,
        recommended_department=department,
        explanation=str(prediction["explanation"]),
        status=status,
        requires_human_verification=requires_human_verification,
        actionability=actionability,
        recommended_action=recommended_action,
        escalation_required=escalation_required,
        classification_method=str(prediction["classification_method"]),
    )
