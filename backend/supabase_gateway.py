"""Server-side Supabase Auth and incident persistence using the standard library."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from ipaddress import ip_address
from pathlib import Path
from typing import Any, Callable, MutableMapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


class SupabaseGatewayError(Exception):
    """Base class for safe-to-map Supabase gateway failures."""


class SupabaseConfigurationError(SupabaseGatewayError):
    pass


class SupabaseUnauthorizedError(SupabaseGatewayError):
    pass


class SupabaseMembershipError(SupabaseGatewayError):
    pass


class SupabaseIncidentMismatchError(SupabaseGatewayError):
    pass


class SupabaseRemoteError(SupabaseGatewayError):
    pass


def load_local_environment(
    path: Path | None = None,
    environ: MutableMapping[str, str] | None = None,
) -> None:
    """Load plain KEY=value settings from backend/.env without shell evaluation.

    Existing process environment values take precedence. This intentionally
    supports only the simple format used by the project's .env.example.
    """
    env_path = path or Path(__file__).with_name(".env")
    target = environ if environ is not None else os.environ
    try:
        lines = env_path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return
    except OSError as error:
        raise SupabaseConfigurationError("The backend environment file could not be read.") from error

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = stripped.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise SupabaseConfigurationError(
                f"The backend environment file has an invalid entry on line {line_number}."
            )
        value = value.strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise SupabaseConfigurationError(
                    f"The backend environment file has an invalid value on line {line_number}."
                )
            value = value[1:-1]
        target.setdefault(key, value)


def _normalize_project_url(value: str) -> str:
    """Require TLS for remote Supabase and permit plain HTTP only on loopback."""
    try:
        parsed = urlsplit(value.strip())
        hostname = parsed.hostname
        _ = parsed.port  # Force validation of malformed port values.
    except ValueError as error:
        raise SupabaseConfigurationError("Supabase project URL is invalid.") from error

    if (
        not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise SupabaseConfigurationError("Supabase project URL is invalid.")

    is_loopback = hostname.casefold() == "localhost"
    if not is_loopback:
        try:
            is_loopback = ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = False

    if parsed.scheme != "https" and not (parsed.scheme == "http" and is_loopback):
        raise SupabaseConfigurationError(
            "Use HTTPS for a remote Supabase URL; HTTP is allowed only for local loopback."
        )
    return value.strip().rstrip("/")


class SupabaseGateway:
    """Verify a user token and write an incident after checking store membership.

    The service-role key is read only by this backend class. Callers must never
    send it to the browser or accept a user id from the request body.
    """

    def __init__(
        self,
        *,
        project_url: str,
        anon_key: str,
        service_role_key: str,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.project_url = _normalize_project_url(project_url)
        self.anon_key = anon_key
        self.service_role_key = service_role_key
        self._opener = opener or urlopen

    @classmethod
    def from_environment(cls) -> SupabaseGateway:
        load_local_environment()
        project_url = os.getenv("SUPABASE_URL", "").strip()
        public_api_key = (
            os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip()
            or os.getenv("SUPABASE_ANON_KEY", "").strip()
        )
        server_api_key = (
            os.getenv("SUPABASE_SECRET_KEY", "").strip()
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        )
        if not project_url or not public_api_key or not server_api_key:
            raise SupabaseConfigurationError("Supabase server configuration is incomplete.")
        return cls(
            project_url=project_url,
            anon_key=public_api_key,
            service_role_key=server_api_key,
        )

    def create_incident_for_user(
        self,
        *,
        access_token: str,
        store_id: str,
        decision: dict[str, Any],
    ) -> dict[str, Any]:
        """Verify identity and store access, then persist only server analysis."""
        user = self._request(
            "GET",
            "/auth/v1/user",
            api_key=self.anon_key,
            bearer_token=access_token,
        )
        if not isinstance(user, dict) or not isinstance(user.get("id"), str):
            raise SupabaseUnauthorizedError("The Supabase session is invalid.")
        user_id = user["id"]

        membership_query = urlencode(
            {
                "select": "store_id,store:stores!inner(id,name,region)",
                "user_id": f"eq.{user_id}",
                "store_id": f"eq.{store_id}",
            }
        )
        service_bearer_token = (
            None if self.service_role_key.startswith("sb_secret_") else self.service_role_key
        )
        memberships = self._request(
            "GET",
            f"/rest/v1/store_memberships?{membership_query}",
            api_key=self.service_role_key,
            bearer_token=service_bearer_token,
        )
        if not isinstance(memberships, list) or not memberships:
            raise SupabaseMembershipError("The account has no access to this store.")
        membership = memberships[0]
        store = membership.get("store") if isinstance(membership, dict) else None
        if not isinstance(store, dict) or store.get("id") != store_id:
            raise SupabaseMembershipError("The account has no access to this store.")

        fields = {
            "store_id": store_id,
            "created_by": user_id,
            "feedback_text": decision["feedback_text"],
            "source": decision["source"],
            "category": decision["category"],
            "severity": decision["severity"],
            "actionability": decision["actionability"],
            "recommended_department": decision["recommended_department"],
            "assigned_department": decision["recommended_department"],
            "recommended_action": decision["recommended_action"],
            "explanation": decision["explanation"],
            "status": decision["status"],
            "requires_human_verification": decision["requires_human_verification"],
            "escalation_required": decision["escalation_required"],
            "classification_method": decision["classification_method"],
        }
        evidence = {
            "source_record_id": decision.get("source_record_id"),
            "feedback_text": decision["feedback_text"],
            "source": decision["source"],
            "received_at": decision.get("received_at"),
        }
        saved = self._request(
            "POST",
            "/rest/v1/rpc/create_incident_with_evidence",
            api_key=self.service_role_key,
            bearer_token=service_bearer_token,
            payload={"p_incident": fields, "p_evidence": [evidence]},
        )
        incident = saved.get("incident") if isinstance(saved, dict) else None
        saved_evidence = saved.get("evidence") if isinstance(saved, dict) else None
        if (
            not isinstance(incident, dict)
            or not isinstance(incident.get("id"), str)
            or not isinstance(saved_evidence, list)
            or len(saved_evidence) != 1
            or not isinstance(saved_evidence[0], dict)
        ):
            raise SupabaseRemoteError("Supabase did not return the saved incident and source evidence.")
        return {
            "user_id": user_id,
            "store": store,
            "incident": incident,
            "evidence": saved_evidence,
        }

    def attach_evidence_to_incident_for_user(
        self,
        *,
        access_token: str,
        store_id: str,
        incident_id: str,
        feedback_text: str,
        source: str,
        classification: dict[str, Any],
    ) -> dict[str, Any]:
        """Attach a user-confirmed repeat report after checking identity and store access."""
        user = self._request(
            "GET",
            "/auth/v1/user",
            api_key=self.anon_key,
            bearer_token=access_token,
        )
        if not isinstance(user, dict) or not isinstance(user.get("id"), str):
            raise SupabaseUnauthorizedError("The Supabase session is invalid.")

        membership_query = urlencode(
            {
                "select": "store_id",
                "user_id": f"eq.{user['id']}",
                "store_id": f"eq.{store_id}",
            }
        )
        service_bearer_token = (
            None if self.service_role_key.startswith("sb_secret_") else self.service_role_key
        )
        memberships = self._request(
            "GET",
            f"/rest/v1/store_memberships?{membership_query}",
            api_key=self.service_role_key,
            bearer_token=service_bearer_token,
        )
        if not isinstance(memberships, list) or not memberships:
            raise SupabaseMembershipError("The account has no access to this store.")

        incident_query = urlencode(
            {
                "select": "id,store_id,category,severity,requires_human_verification,escalation_required,human_verified_at,status",
                "id": f"eq.{incident_id}",
                "store_id": f"eq.{store_id}",
            }
        )
        matching_incidents = self._request(
            "GET",
            f"/rest/v1/incidents?{incident_query}",
            api_key=self.service_role_key,
            bearer_token=service_bearer_token,
        )
        if not isinstance(matching_incidents, list) or not matching_incidents:
            raise SupabaseMembershipError("That incident is not available in this store.")
        incident = matching_incidents[0]
        if str(incident.get("category", "")).casefold() != str(classification.get("category", "")).casefold():
            raise SupabaseIncidentMismatchError("The new report has a different issue category.")
        severity_rank = {"unclassified": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
        prior_severity = severity_rank.get(str(incident.get("severity", "")).casefold(), -1)
        incoming_severity = severity_rank.get(str(classification.get("severity", "")).casefold(), -1)
        if incoming_severity > prior_severity:
            raise SupabaseIncidentMismatchError("A higher-severity report must remain a separate incident for review.")
        if classification.get("requires_human_verification") and not incident.get("requires_human_verification"):
            raise SupabaseIncidentMismatchError("A report requiring human verification must remain a separate incident.")
        if classification.get("escalation_required") and not incident.get("escalation_required"):
            raise SupabaseIncidentMismatchError("An escalated report must remain a separate incident.")
        if classification.get("requires_human_verification") and incident.get("human_verified_at"):
            raise SupabaseIncidentMismatchError("New safety evidence cannot be attached to an already-reviewed incident.")
        if str(incident.get("status", "")).casefold() == "resolved":
            raise SupabaseIncidentMismatchError("A resolved incident cannot accept new reports; create a new incident.")

        rows = self._request(
            "POST",
            "/rest/v1/incident_evidence",
            api_key=self.service_role_key,
            bearer_token=service_bearer_token,
            payload={
                "incident_id": incident_id,
                "feedback_text": feedback_text,
                "source": source,
                "received_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="return=representation",
        )
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise SupabaseRemoteError("Supabase did not return the attached source evidence.")
        evidence = rows[0]
        if evidence.get("incident_id") != incident_id or not isinstance(evidence.get("id"), str):
            raise SupabaseRemoteError("Supabase returned evidence for a different incident.")
        return {"user_id": user["id"], "evidence": evidence}

    def _request(
        self,
        method: str,
        path: str,
        *,
        api_key: str,
        bearer_token: str | None,
        payload: dict[str, Any] | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = {
            "apikey": api_key,
            "Accept": "application/json",
        }
        if bearer_token is not None:
            headers["Authorization"] = f"Bearer {bearer_token}"
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode("utf-8")
        if prefer:
            headers["Prefer"] = prefer

        request = Request(
            f"{self.project_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with self._opener(request, timeout=10) as response:
                raw = response.read()
        except HTTPError as error:
            if path == "/auth/v1/user" and error.code in (401, 403):
                raise SupabaseUnauthorizedError("The Supabase session is invalid or expired.") from error
            raise SupabaseRemoteError("Supabase rejected an incident request.") from error
        except (URLError, TimeoutError, OSError) as error:
            raise SupabaseRemoteError("Supabase could not be reached.") from error

        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SupabaseRemoteError("Supabase returned an unreadable response.") from error
