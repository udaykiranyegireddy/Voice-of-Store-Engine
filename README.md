# Voice-of-Store Engine

Hackathon project foundation for problem statement **R5: Turning Store Chatter Into Action**. The goal is to turn store conversations into clear, useful actions for store teams.

## Current status

Only the problem statement is available so far. The official dataset and `evaluate.py` have not been provided. This repository contains planning and configuration guidance only: it does not include a sample official dataset, a trained model, model scores, or an assumed evaluation interface.

## Proposed architecture

- **Frontend:** React, TypeScript, and Vite for the store-team experience. Supabase Auth handles sign-in; the browser uses only the Supabase URL and public client key.
- **Backend:** Python and FastAPI for application endpoints, request validation, access-token verification, and coordination of incident and data operations.
- **Persistence and identity:** Supabase Auth plus Supabase-hosted PostgreSQL. Database access policies should be designed alongside the eventual data model; server secrets must never be exposed through Vite variables.
- **Data pipeline:** A separate Python package for dataset loading, validation, cleaning, and reproducible transformations. Its input contract will be based on the organizers' materials when available.
- **ML:** A separate Python package for training and inference. Training and evaluation should use the official dataset and evaluator once supplied. Generated model files belong outside source control.
- **Incident detection:** An application layer that turns validated model or rule outputs into traceable incident records. Labels, thresholds, and output fields must follow the official task and evaluation contract once known.

### Planned source layout

```text
frontend/          React + TypeScript + Vite
backend/           FastAPI application
ml/                Python data, training, and inference packages
supabase/          Database migrations and local Supabase configuration, if needed
```

This is a proposed layout, not a claim that these components have been implemented.

## Configuration

Copy `.env.example` to a local `.env` and replace placeholders only with values from your own development environment. Keep `.env` out of source control. Values prefixed with `VITE_` are bundled into the browser and must never contain secrets. Keep service-role keys, database credentials, and other private values on the server.

## Implementation plan

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the proposed phases covering authentication, the data pipeline, ML, incident detection, the dashboard, and testing.

## Development status

No dependencies are installed by this foundation step, and no external repository or database has been configured. Implementation should begin after reviewing this architecture and receiving the official data and evaluation materials.