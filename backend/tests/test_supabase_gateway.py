"""Unit tests for server-side Supabase identity and incident-write boundaries."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from uuid import UUID

from backend.classifier import classify_feedback
from backend.supabase_gateway import (
    SupabaseConfigurationError,
    SupabaseIncidentMismatchError,
    SupabaseGateway,
    SupabaseMembershipError,
    SupabaseRemoteError,
    SupabaseUnauthorizedError,
    load_local_environment,
)


USER_ID = "b34d01d0-954c-48be-a712-a97ab8913785"
STORE_ID = "aa4a5374-dca3-472e-b345-427ec022ab3e"
INCIDENT_ID = "cc46292c-ae0a-4bfe-b84b-272f4ea01ff2"
ANON_KEY = "public-test-key"
SERVICE_ROLE_KEY = "server-only-test-key"
ACCESS_TOKEN = "verified-user-access-token"


class FakeResponse:
    def __init__(self, value: object) -> None:
        self.body = json.dumps(value).encode("utf-8")

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def incident_row(decision: dict[str, object]) -> dict[str, object]:
    return {
        "id": INCIDENT_ID,
        "store_id": STORE_ID,
        **decision,
        "assigned_department": decision["recommended_department"],
        "human_verified_at": None,
        "human_verified_by": None,
        "created_at": "2026-10-28T10:00:00+00:00",
        "updated_at": "2026-10-28T10:00:00+00:00",
    }


class SupabaseGatewayTests(unittest.TestCase):
    def setUp(self) -> None:
        classification = classify_feedback("Card payment failed at checkout.")
        self.decision: dict[str, object] = {
            "feedback_text": "Card payment failed at checkout.",
            "source": "staff_report",
            **classification.to_dict(),
            "classification_method": "transparent_rules",
        }

    def make_gateway(self, opener):
        return SupabaseGateway(
            project_url="https://example.supabase.co",
            anon_key=ANON_KEY,
            service_role_key=SERVICE_ROLE_KEY,
            opener=opener,
        )

    def test_local_environment_file_loads_plain_values_without_overwriting_process(self) -> None:
        with TemporaryDirectory() as folder:
            env_file = Path(folder) / ".env"
            env_file.write_text(
                "# local settings\n"
                "SUPABASE_URL='http://localhost:54321'\n"
                "LITERAL=$HOME/value=kept\n"
                "EXISTING=file-value\n",
                encoding="utf-8",
            )
            values = {"EXISTING": "process-value"}

            load_local_environment(env_file, values)

        self.assertEqual(values["SUPABASE_URL"], "http://localhost:54321")
        self.assertEqual(values["LITERAL"], "$HOME/value=kept")
        self.assertEqual(values["EXISTING"], "process-value")

    def test_local_environment_file_rejects_invalid_entries(self) -> None:
        with TemporaryDirectory() as folder:
            env_file = Path(folder) / ".env"
            env_file.write_text("not-a-setting\n", encoding="utf-8")

            with self.assertRaises(SupabaseConfigurationError):
                load_local_environment(env_file, {})

    def test_local_environment_file_rejects_unclosed_quotes(self) -> None:
        with TemporaryDirectory() as folder:
            env_file = Path(folder) / ".env"
            env_file.write_text('SUPABASE_URL="https://example.supabase.co\n', encoding="utf-8")

            with self.assertRaises(SupabaseConfigurationError):
                load_local_environment(env_file, {})

    def test_from_environment_prefers_publishable_and_secret_keys(self) -> None:
        configured = {
            "SUPABASE_URL": "https://project.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
            "SUPABASE_SECRET_KEY": "sb_secret_test",
            "SUPABASE_ANON_KEY": "legacy-anon-test",
            "SUPABASE_SERVICE_ROLE_KEY": "legacy-service-role-test",
        }
        with patch.dict("os.environ", configured, clear=True):
            gateway = SupabaseGateway.from_environment()

        self.assertEqual(gateway.project_url, "https://project.supabase.co")
        self.assertEqual(gateway.anon_key, "sb_publishable_test")
        self.assertEqual(gateway.service_role_key, "sb_secret_test")

    def test_from_environment_keeps_legacy_key_names_supported(self) -> None:
        configured = {
            "SUPABASE_URL": "https://project.supabase.co",
            "SUPABASE_ANON_KEY": "legacy-anon-test",
            "SUPABASE_SERVICE_ROLE_KEY": "legacy-service-role-test",
        }
        with patch.dict("os.environ", configured, clear=True):
            gateway = SupabaseGateway.from_environment()

        self.assertEqual(gateway.anon_key, "legacy-anon-test")
        self.assertEqual(gateway.service_role_key, "legacy-service-role-test")

    def test_secret_key_uses_apikey_header_without_a_bearer_header(self) -> None:
        calls = []
        store = {"id": STORE_ID, "name": "Store 12", "region": "North"}

        def opener(request, timeout):
            calls.append(request)
            path = urlsplit(request.full_url).path
            if path == "/auth/v1/user":
                return FakeResponse({"id": USER_ID})
            if path == "/rest/v1/store_memberships":
                return FakeResponse([{"store_id": STORE_ID, "store": store}])
            if path == "/rest/v1/rpc/create_incident_with_evidence":
                saved = json.loads(request.data.decode("utf-8"))
                return FakeResponse({
                    "incident": incident_row(saved["p_incident"]),
                    "evidence": [{"id": "evidence-id", **saved["p_evidence"][0]}],
                })
            self.fail(f"Unexpected Supabase request path: {path}")

        gateway = SupabaseGateway(
            project_url="https://project.supabase.co",
            anon_key="sb_publishable_test",
            service_role_key="sb_secret_test",
            opener=opener,
        )
        gateway.create_incident_for_user(
            access_token=ACCESS_TOKEN,
            store_id=STORE_ID,
            decision=self.decision,
        )

        auth_request, membership_request, insert_request = calls
        self.assertEqual(auth_request.headers["Apikey"], "sb_publishable_test")
        self.assertEqual(auth_request.headers["Authorization"], f"Bearer {ACCESS_TOKEN}")
        for request in (membership_request, insert_request):
            self.assertEqual(request.headers["Apikey"], "sb_secret_test")
            self.assertIsNone(request.get_header("Authorization"))

    def test_verified_member_is_saved_with_server_classification_and_key_boundaries(self) -> None:
        calls = []
        store = {"id": STORE_ID, "name": "Store 12", "region": "North"}

        def opener(request, timeout):
            calls.append((request, timeout))
            path = urlsplit(request.full_url).path
            if path == "/auth/v1/user":
                return FakeResponse({"id": USER_ID})
            if path == "/rest/v1/store_memberships":
                return FakeResponse([{"store_id": STORE_ID, "store": store}])
            if path == "/rest/v1/rpc/create_incident_with_evidence":
                saved = json.loads(request.data.decode("utf-8"))
                saved_incident = incident_row(saved["p_incident"])
                evidence = {
                    "id": "ed46292c-ae0a-4bfe-b84b-272f4ea01ff2",
                    "incident_id": INCIDENT_ID,
                    **saved["p_evidence"][0],
                }
                return FakeResponse({"incident": saved_incident, "evidence": [evidence]})
            self.fail(f"Unexpected Supabase request path: {path}")

        result = self.make_gateway(opener).create_incident_for_user(
            access_token=ACCESS_TOKEN,
            store_id=STORE_ID,
            decision=self.decision,
        )

        self.assertEqual(result["user_id"], USER_ID)
        self.assertEqual(result["store"], store)
        self.assertEqual(result["incident"]["id"], INCIDENT_ID)
        self.assertEqual(len(result["evidence"]), 1)
        self.assertEqual(result["evidence"][0]["feedback_text"], self.decision["feedback_text"])
        self.assertEqual(len(calls), 3)
        auth_request, membership_request, insert_request = [call[0] for call in calls]
        self.assertEqual(auth_request.headers["Apikey"], ANON_KEY)
        self.assertEqual(auth_request.headers["Authorization"], f"Bearer {ACCESS_TOKEN}")
        self.assertEqual(membership_request.headers["Apikey"], SERVICE_ROLE_KEY)
        self.assertEqual(insert_request.headers["Apikey"], SERVICE_ROLE_KEY)
        self.assertEqual(calls[0][1], 10)

        inserted = json.loads(insert_request.data.decode("utf-8"))
        saved_incident = inserted["p_incident"]
        self.assertEqual(saved_incident["created_by"], USER_ID)
        self.assertEqual(saved_incident["store_id"], STORE_ID)
        self.assertEqual(saved_incident["category"], self.decision["category"])
        self.assertEqual(saved_incident["recommended_department"], "Digital / Technical Support")
        self.assertEqual(saved_incident["assigned_department"], "Digital / Technical Support")
        self.assertNotIn("human_verified_at", saved_incident)
        self.assertNotIn("human_verified_by", saved_incident)
        self.assertNotIn("user_id", saved_incident)
        self.assertEqual(inserted["p_evidence"][0]["feedback_text"], self.decision["feedback_text"])
        self.assertEqual(insert_request.full_url, "https://example.supabase.co/rest/v1/rpc/create_incident_with_evidence")
        self.assertEqual(UUID(result["incident"]["store_id"]), UUID(STORE_ID))

    def test_missing_membership_stops_before_insert(self) -> None:
        paths = []

        def opener(request, timeout):
            path = urlsplit(request.full_url).path
            paths.append(path)
            if path == "/auth/v1/user":
                return FakeResponse({"id": USER_ID})
            if path == "/rest/v1/store_memberships":
                return FakeResponse([])
            self.fail("An incident must not be inserted without verified membership.")

        with self.assertRaises(SupabaseMembershipError):
            self.make_gateway(opener).create_incident_for_user(
                access_token=ACCESS_TOKEN,
                store_id=STORE_ID,
                decision=self.decision,
            )
        self.assertEqual(paths, ["/auth/v1/user", "/rest/v1/store_memberships"])

    def test_atomic_write_requires_a_saved_incident_and_evidence_response(self) -> None:
        def opener(request, timeout):
            path = urlsplit(request.full_url).path
            if path == "/auth/v1/user":
                return FakeResponse({"id": USER_ID})
            if path == "/rest/v1/store_memberships":
                return FakeResponse([{
                    "store_id": STORE_ID,
                    "store": {"id": STORE_ID, "name": "Store 12", "region": "North"},
                }])
            if path == "/rest/v1/rpc/create_incident_with_evidence":
                return FakeResponse({"incident": {"id": INCIDENT_ID}, "evidence": []})
            self.fail(f"Unexpected Supabase request path: {path}")

        with self.assertRaisesRegex(SupabaseRemoteError, "saved incident and source evidence"):
            self.make_gateway(opener).create_incident_for_user(
                access_token=ACCESS_TOKEN,
                store_id=STORE_ID,
                decision=self.decision,
            )

    def test_expired_user_token_is_rejected_before_store_lookup(self) -> None:
        paths = []

        def opener(request, timeout):
            path = urlsplit(request.full_url).path
            paths.append(path)
            raise HTTPError(request.full_url, 401, "invalid token", {}, None)

        with self.assertRaises(SupabaseUnauthorizedError):
            self.make_gateway(opener).create_incident_for_user(
                access_token="expired-token",
                store_id=STORE_ID,
                decision=self.decision,
            )
        self.assertEqual(paths, ["/auth/v1/user"])

    def test_member_can_attach_evidence_to_an_open_matching_incident(self) -> None:
        calls = []
        freezer = classify_feedback("The freezer is broken.").to_dict()

        def opener(request, timeout):
            calls.append(request)
            path = urlsplit(request.full_url).path
            if path == "/auth/v1/user":
                return FakeResponse({"id": USER_ID})
            if path == "/rest/v1/store_memberships":
                return FakeResponse([{"store_id": STORE_ID}])
            if path == "/rest/v1/incidents":
                return FakeResponse([{
                    "id": INCIDENT_ID,
                    "store_id": STORE_ID,
                    "category": freezer["category"],
                    "severity": "High",
                    "requires_human_verification": False,
                    "escalation_required": False,
                    "human_verified_at": None,
                    "status": "Open",
                }])
            if path == "/rest/v1/incident_evidence":
                saved = json.loads(request.data.decode("utf-8"))
                return FakeResponse([{
                    "id": "ed46292c-ae0a-4bfe-b84b-272f4ea01ff2",
                    **saved,
                }])
            self.fail(f"Unexpected Supabase request path: {path}")

        result = self.make_gateway(opener).attach_evidence_to_incident_for_user(
            access_token=ACCESS_TOKEN,
            store_id=STORE_ID,
            incident_id=INCIDENT_ID,
            feedback_text="Freezer not cooling from this morning.",
            source="online_review",
            classification=freezer,
        )

        self.assertEqual(result["user_id"], USER_ID)
        self.assertEqual(result["evidence"]["incident_id"], INCIDENT_ID)
        self.assertEqual(len(calls), 4)
        insert_request = calls[-1]
        self.assertEqual(insert_request.get_method(), "POST")
        self.assertEqual(insert_request.headers["Prefer"], "return=representation")
        self.assertEqual(insert_request.headers["Authorization"], f"Bearer {SERVICE_ROLE_KEY}")
        self.assertEqual(json.loads(insert_request.data.decode("utf-8"))["source"], "online_review")

    def test_higher_severity_evidence_is_kept_separate(self) -> None:
        paths = []
        freezer = classify_feedback("The freezer is broken.").to_dict()
        urgent = {
            **freezer,
            "severity": "Critical",
            "requires_human_verification": True,
            "escalation_required": True,
        }

        def opener(request, timeout):
            path = urlsplit(request.full_url).path
            paths.append(path)
            if path == "/auth/v1/user":
                return FakeResponse({"id": USER_ID})
            if path == "/rest/v1/store_memberships":
                return FakeResponse([{"store_id": STORE_ID}])
            if path == "/rest/v1/incidents":
                return FakeResponse([{
                    "id": INCIDENT_ID,
                    "category": freezer["category"],
                    "severity": "High",
                    "requires_human_verification": False,
                    "escalation_required": False,
                    "human_verified_at": None,
                    "status": "Open",
                }])
            self.fail("Higher-severity evidence must not be attached.")

        with self.assertRaisesRegex(SupabaseIncidentMismatchError, "higher-severity"):
            self.make_gateway(opener).attach_evidence_to_incident_for_user(
                access_token=ACCESS_TOKEN,
                store_id=STORE_ID,
                incident_id=INCIDENT_ID,
                feedback_text="The freezer is broken and food is warming.",
                source="staff_report",
                classification=urgent,
            )
        self.assertEqual(paths, ["/auth/v1/user", "/rest/v1/store_memberships", "/rest/v1/incidents"])

    def test_project_url_requires_https_except_for_local_loopback(self) -> None:
        for url in (
            "http://localhost:54321",
            "http://127.0.0.1:54321",
            "http://[::1]:54321",
            "https://project.supabase.co",
        ):
            with self.subTest(url=url):
                gateway = SupabaseGateway(
                    project_url=url,
                    anon_key=ANON_KEY,
                    service_role_key=SERVICE_ROLE_KEY,
                )
                self.assertEqual(gateway.project_url, url.rstrip("/"))

        for url in (
            "http://project.supabase.co",
            "https://user:password@project.supabase.co",
            "https://project.supabase.co/path",
            "https://project.supabase.co?redirect=http://attacker.test",
        ):
            with self.subTest(url=url):
                with self.assertRaises(SupabaseConfigurationError):
                    SupabaseGateway(
                        project_url=url,
                        anon_key=ANON_KEY,
                        service_role_key=SERVICE_ROLE_KEY,
                    )


if __name__ == "__main__":
    unittest.main()
