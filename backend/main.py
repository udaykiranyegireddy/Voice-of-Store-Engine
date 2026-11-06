"""FastAPI endpoints for the Voice-of-Store Engine."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

if __package__:
    from .classifier import Classification, classify_feedback_for_api
    from .r5_benchmark import BenchmarkUnavailable, benchmark_brief, benchmark_duplicate_candidates, benchmark_overview, is_known_store_identifier
    from .supabase_gateway import (
        SupabaseConfigurationError,
        SupabaseIncidentMismatchError,
        SupabaseGateway,
        SupabaseMembershipError,
        SupabaseRemoteError,
        SupabaseUnauthorizedError,
        load_local_environment,
    )
else:  # Support `uvicorn main:app` when launched from the backend directory.
    from classifier import Classification, classify_feedback_for_api
    from r5_benchmark import BenchmarkUnavailable, benchmark_brief, benchmark_duplicate_candidates, benchmark_overview, is_known_store_identifier
    from supabase_gateway import (
        SupabaseConfigurationError,
        SupabaseIncidentMismatchError,
        SupabaseGateway,
        SupabaseMembershipError,
        SupabaseRemoteError,
        SupabaseUnauthorizedError,
        load_local_environment,
    )


# Read backend/.env for local configuration before deriving app settings. The
# loader accepts plain KEY=value entries and never overrides PowerShell values.
load_local_environment()


class FeedbackAnalyzeRequest(BaseModel):
    """One feedback message plus its store and origin metadata."""

    feedback_text: str = Field(min_length=1, max_length=2000)
    store_name: str | None = Field(default=None, max_length=120)
    store_id: str | None = Field(default=None, max_length=120)
    source: str = Field(min_length=1, max_length=80)

    @field_validator("feedback_text", "source")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("This field cannot be blank.")
        return cleaned

    @field_validator("store_name", "store_id")
    @classmethod
    def trim_optional_store_identifier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def require_store_identifier(self) -> FeedbackAnalyzeRequest:
        if self.store_name is None and self.store_id is None:
            raise ValueError("Provide either store_name or store_id.")
        return self


class FeedbackAnalyzeResponse(BaseModel):
    feedback_text: str
    store_name: str | None
    store_id: str | None
    source: str
    category: str
    severity: str
    actionability: Literal["actionable", "needs_review", "informational"]
    recommended_department: str
    recommended_action: str
    explanation: str
    status: str
    requires_human_verification: bool
    escalation_required: bool
    classification_method: str


class FeedbackIncidentCreateRequest(BaseModel):
    """Feedback and an authorized store ID for server-side incident creation."""

    feedback_text: str = Field(min_length=1, max_length=2000)
    store_id: UUID
    source: str = Field(min_length=1, max_length=80)

    @field_validator("feedback_text", "source")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("This field cannot be blank.")
        return cleaned


class FeedbackEvidenceAttachRequest(BaseModel):
    """A source message that a reviewer chose to link to an existing incident."""

    feedback_text: str = Field(min_length=1, max_length=2000)
    store_id: UUID
    source: str = Field(min_length=1, max_length=80)

    @field_validator("feedback_text", "source")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("This field cannot be blank.")
        return cleaned


class FeedbackIncidentCreateResponse(FeedbackAnalyzeResponse):
    incident_id: UUID
    assigned_department: str
    human_verified_at: datetime | None
    human_verified_by: UUID | None
    created_at: datetime
    updated_at: datetime


class FeedbackEvidenceAttachResponse(BaseModel):
    evidence_id: UUID
    incident_id: UUID
    source: str
    received_at: datetime


app = FastAPI(title="Voice-of-Store Engine API", version="0.2.0")
bearer_scheme = HTTPBearer(auto_error=False)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "VOS_FRONTEND_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is responding."""
    return {"status": "ok"}


@app.get("/r5/benchmark")
def get_r5_benchmark(
    feedback_limit: int = Query(default=12, ge=1, le=50),
    alert_limit: int = Query(default=10, ge=1, le=30),
) -> dict[str, object]:
    """Expose read-only, source-linked summaries from the public organizer package."""
    try:
        return benchmark_overview(feedback_limit=feedback_limit, alert_limit=alert_limit)
    except BenchmarkUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/r5/benchmark/brief")
def get_r5_benchmark_brief(
    region: str | None = None,
    week_index: int | None = Query(default=None, ge=1, le=52),
) -> dict[str, object]:
    """Generate a weekly regional brief from the public classified benchmark rows."""
    try:
        return benchmark_brief(region=region, week_index=week_index)
    except BenchmarkUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/r5/benchmark/duplicates")
def get_r5_duplicate_candidates(
    limit: int = Query(default=30, ge=1, le=100),
) -> dict[str, object]:
    """Return candidate duplicates for human review; this route never merges records."""
    try:
        return benchmark_duplicate_candidates(limit=limit)
    except BenchmarkUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/feedback/analyze", response_model=FeedbackAnalyzeResponse)
def analyze_feedback(request: FeedbackAnalyzeRequest) -> FeedbackAnalyzeResponse:
    """Classify feedback with the trained R5 model when available and safe rule fallback."""
    result: Classification = classify_feedback_for_api(
        request.feedback_text,
        source=request.source,
        store_known=is_known_store_identifier(store_name=request.store_name, store_id=request.store_id),
    )
    return FeedbackAnalyzeResponse(
        feedback_text=request.feedback_text,
        store_name=request.store_name,
        store_id=request.store_id,
        source=request.source,
        **result.to_dict(),
    )


@app.post("/feedback/incidents", response_model=FeedbackIncidentCreateResponse, status_code=201)
def create_feedback_incident(
    request: FeedbackIncidentCreateRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> FeedbackIncidentCreateResponse:
    """Verify the Supabase user and store membership, classify, and persist."""
    if credentials is None or credentials.scheme.casefold() != "bearer":
        raise HTTPException(status_code=401, detail="Sign in before creating an incident.")

    decision: Classification = classify_feedback_for_api(
        request.feedback_text,
        source=request.source,
        store_known=True,
    )
    try:
        gateway = SupabaseGateway.from_environment()
        persisted = gateway.create_incident_for_user(
            access_token=credentials.credentials,
            store_id=str(request.store_id),
            decision={
                "feedback_text": request.feedback_text,
                "source": request.source,
                **decision.to_dict(),
            },
        )
    except SupabaseConfigurationError as error:
        raise HTTPException(status_code=503, detail="Incident persistence is not configured on the API.") from error
    except SupabaseUnauthorizedError as error:
        raise HTTPException(status_code=401, detail="Your Supabase session is invalid or expired.") from error
    except SupabaseMembershipError as error:
        raise HTTPException(status_code=403, detail="Your account is not authorized for this store.") from error
    except SupabaseRemoteError as error:
        raise HTTPException(status_code=502, detail="Supabase could not complete the incident request.") from error

    store = persisted["store"]
    incident = persisted["incident"]
    return FeedbackIncidentCreateResponse(
        feedback_text=incident["feedback_text"],
        store_name=store["name"],
        store_id=incident["store_id"],
        source=incident["source"],
        category=incident["category"],
        severity=incident["severity"],
        actionability=incident["actionability"],
        recommended_department=incident["recommended_department"],
        recommended_action=incident["recommended_action"],
        explanation=incident["explanation"],
        status=incident["status"],
        requires_human_verification=incident["requires_human_verification"],
        escalation_required=incident["escalation_required"],
        human_verified_at=incident["human_verified_at"],
        human_verified_by=incident["human_verified_by"],
        classification_method=incident["classification_method"],
        incident_id=incident["id"],
        assigned_department=incident["assigned_department"],
        created_at=incident["created_at"],
        updated_at=incident["updated_at"],
    )


@app.post(
    "/feedback/incidents/{incident_id}/evidence",
    response_model=FeedbackEvidenceAttachResponse,
    status_code=201,
)
def attach_feedback_evidence(
    incident_id: UUID,
    request: FeedbackEvidenceAttachRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> FeedbackEvidenceAttachResponse:
    """Link a separately reviewed report to an incident in the user's store."""
    if credentials is None or credentials.scheme.casefold() != "bearer":
        raise HTTPException(status_code=401, detail="Sign in before attaching incident evidence.")

    classification: Classification = classify_feedback_for_api(
        request.feedback_text,
        source=request.source,
        store_known=True,
    )
    try:
        gateway = SupabaseGateway.from_environment()
        result = gateway.attach_evidence_to_incident_for_user(
            access_token=credentials.credentials,
            store_id=str(request.store_id),
            incident_id=str(incident_id),
            feedback_text=request.feedback_text,
            source=request.source,
            classification=classification.to_dict(),
        )
    except SupabaseConfigurationError as error:
        raise HTTPException(status_code=503, detail="Incident persistence is not configured on the API.") from error
    except SupabaseUnauthorizedError as error:
        raise HTTPException(status_code=401, detail="Your Supabase session is invalid or expired.") from error
    except SupabaseMembershipError as error:
        raise HTTPException(status_code=403, detail="That incident is not available to your account in this store.") from error
    except SupabaseIncidentMismatchError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except SupabaseRemoteError as error:
        raise HTTPException(status_code=502, detail="Supabase could not attach the source evidence.") from error

    evidence = result["evidence"]
    return FeedbackEvidenceAttachResponse(
        evidence_id=evidence["id"],
        incident_id=evidence["incident_id"],
        source=evidence["source"],
        received_at=evidence["received_at"],
    )
