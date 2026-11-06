"""ASGI-level API tests using a mocked Supabase persistence boundary."""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi.security import HTTPAuthorizationCredentials

from backend.main import FeedbackIncidentCreateRequest, app, create_feedback_incident
from backend.classifier import classify_feedback
from backend.supabase_gateway import SupabaseConfigurationError, SupabaseGateway


USER_ID = "b34d01d0-954c-48be-a712-a97ab8913785"
STORE_ID = "aa4a5374-dca3-472e-b345-427ec022ab3e"
INCIDENT_ID = "cc46292c-ae0a-4bfe-b84b-272f4ea01ff2"


async def asgi_request(
    *,
    path: str,
    method: str = "POST",
    payload: dict[str, object] | None = None,
    headers: list[tuple[bytes, bytes]] | None = None,
) -> tuple[int, dict[str, object]]:
    body = json.dumps(payload or {}).encode("utf-8")
    request_headers = [(b"host", b"testserver"), (b"content-type", b"application/json")]
    request_headers.extend(headers or [])
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": request_headers,
        "client": ("testclient", 12345),
        "server": ("testserver", 80),
    }
    receive_messages = [{"type": "http.request", "body": body, "more_body": False}]
    response_messages: list[dict[str, object]] = []

    async def receive() -> dict[str, object]:
        if receive_messages:
            return receive_messages.pop(0)
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        response_messages.append(message)

    await app(scope, receive, send)
    start = next(message for message in response_messages if message["type"] == "http.response.start")
    response_body = b"".join(
        message.get("body", b"")
        for message in response_messages
        if message["type"] == "http.response.body"
    )
    return int(start["status"]), json.loads(response_body.decode("utf-8"))


class FakeGateway:
    def __init__(self) -> None:
        self.call: dict[str, object] | None = None

    def create_incident_for_user(self, *, access_token: str, store_id: str, decision: dict[str, object]):
        self.call = {"access_token": access_token, "store_id": store_id, "decision": decision}
        return {
            "user_id": USER_ID,
            "store": {"id": STORE_ID, "name": "Store 12", "region": "North"},
            "incident": {
                "id": INCIDENT_ID,
                "store_id": STORE_ID,
                "feedback_text": decision["feedback_text"],
                "source": decision["source"],
                **decision,
                "assigned_department": decision["recommended_department"],
                "human_verified_at": None,
                "human_verified_by": None,
                "created_at": "2026-10-28T10:00:00+00:00",
                "updated_at": "2026-10-28T10:00:00+00:00",
            },
        }


class FeedbackIncidentApiTests(unittest.TestCase):
    def test_create_endpoint_persists_the_taxonomy_owner_as_initial_assignment(self) -> None:
        gateway = FakeGateway()
        request = FeedbackIncidentCreateRequest(
            feedback_text="A foreign object was found in the food product.",
            store_id=STORE_ID,
            source="staff_report",
        )
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="verified-token")
        decision = classify_feedback(request.feedback_text)

        with (
            patch.object(SupabaseGateway, "from_environment", return_value=gateway),
            patch("backend.main.classify_feedback_for_api", return_value=decision),
        ):
            response = create_feedback_incident(request, credentials)

        self.assertEqual(response.category, "Foreign object / contamination in product")
        self.assertEqual(response.severity, "Critical")
        self.assertEqual(response.recommended_department, "Merchandising")
        self.assertEqual(response.assigned_department, "Merchandising")
        self.assertEqual(gateway.call["access_token"], "verified-token")

    def test_authenticated_feedback_returns_the_persisted_incident_contract(self) -> None:
        gateway = FakeGateway()
        status, body = asyncio.run(_request_with_gateway(gateway))

        self.assertEqual(status, 201)
        self.assertEqual(gateway.call["access_token"], "verified-token")
        self.assertEqual(gateway.call["store_id"], STORE_ID)
        self.assertEqual(body["incident_id"], INCIDENT_ID)
        self.assertEqual(body["store_name"], "Store 12")
        self.assertEqual(body["category"], "Equipment failure")
        self.assertEqual(body["severity"], "High")
        self.assertEqual(body["recommended_department"], "Store Operations")
        self.assertEqual(body["assigned_department"], "Store Operations")
        self.assertTrue(body["recommended_action"])
        self.assertIsNone(body["human_verified_at"])
        self.assertIsNone(body["human_verified_by"])
        self.assertNotIn("user_id", gateway.call["decision"])

    def test_missing_bearer_token_is_rejected_before_persistence(self) -> None:
        status, body = asyncio.run(
            asgi_request(
                path="/feedback/incidents",
                payload={
                    "feedback_text": "Payment failed.",
                    "store_id": STORE_ID,
                    "source": "staff_report",
                },
            )
        )

        self.assertEqual(status, 401)
        self.assertEqual(body["detail"], "Sign in before creating an incident.")

    def test_missing_supabase_configuration_returns_a_safe_service_error(self) -> None:
        async def request():
            with patch.object(
                SupabaseGateway,
                "from_environment",
                side_effect=SupabaseConfigurationError("incomplete local settings"),
            ):
                return await asgi_request(
                    path="/feedback/incidents",
                    payload={
                        "feedback_text": "Payment failed.",
                        "store_id": STORE_ID,
                        "source": "staff_report",
                    },
                    headers=[(b"authorization", b"Bearer verified-token")],
                )

        status, body = asyncio.run(request())
        self.assertEqual(status, 503)
        self.assertEqual(body["detail"], "Incident persistence is not configured on the API.")
        self.assertNotIn("incomplete local settings", json.dumps(body))


def _request_with_gateway(gateway: FakeGateway):
    async def request():
        with (
            patch.object(SupabaseGateway, "from_environment", return_value=gateway),
            patch("backend.main.classify_feedback_for_api", return_value=classify_feedback("The freezer is broken.")),
        ):
            return await asgi_request(
                path="/feedback/incidents",
                payload={
                    "feedback_text": "The freezer is broken.",
                    "store_id": STORE_ID,
                    "source": "staff_report",
                },
                headers=[(b"authorization", b"Bearer verified-token")],
            )

    return request()


if __name__ == "__main__":
    unittest.main()
