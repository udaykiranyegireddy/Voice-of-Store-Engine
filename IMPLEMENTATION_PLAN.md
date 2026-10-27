# Implementation plan

This plan is intentionally provisional. The organizers have not yet supplied the official dataset or `evaluate.py`, so data schemas, model targets, scoring, and evaluation behavior remain open.

## 1. Authentication

- Configure Supabase Auth for the agreed sign-in flow.
- Add frontend session handling and attach access tokens to API requests.
- Verify Supabase access tokens in FastAPI and enforce authorization at API and database boundaries.
- Add PostgreSQL schema migrations and row-level security policies after the data model and access needs are known.

**Ready when:** a signed-in user can access only the records they are authorized to see, with secrets kept server-side.

## 2. Data pipeline

- Translate the official dataset and task instructions into a documented input contract when they arrive.
- Build separate, reproducible Python steps for loading, validation, cleaning, and transformation.
- Track data provenance and splits; keep private/raw data outside source control.
- Add checks for malformed records, missing values, and leakage based on the real data format.

**Ready when:** the official data can be processed repeatably without changing its intended labels or evaluation inputs.

## 3. ML training and inference

- Establish a simple, reproducible baseline only after the official labels and evaluation contract are known.
- Keep training and inference code in the separate `ml/` package; document dependencies and configuration.
- Evaluate with the official evaluator when available, record the exact data/model version, and report only measured results.
- Define a versioned inference output contract with the backend before integrating a model.

**Ready when:** the model can be trained and evaluated reproducibly on authorized data, and inference returns the agreed output shape.

## 4. Incident detection

- Agree on what qualifies as an incident from the official task instructions and examples.
- Convert validated model or rule outputs into explainable incident records with source references where permitted.
- Set grouping, severity, confidence, and alert thresholds only when supported by the task contract and measured validation.
- Keep detection logic independently testable from the model and API.

**Ready when:** incident records have traceable evidence and follow the agreed task rules.

## 5. Dashboard

- Build a React and TypeScript workflow for reviewing incidents and their supporting information.
- Add status changes, search, filtering, and detail views based on user needs established during the hackathon.
- Include loading, empty, and error states; ensure access follows the authenticated user's permissions.
- Avoid displaying sensitive conversation content beyond what the task and data policy allow.

**Ready when:** a store user can review and act on authorized incidents through a clear end-to-end workflow.

## 6. Testing

- Unit-test data transformations, inference-output handling, and incident rules using small synthetic fixtures clearly marked as synthetic.
- Add FastAPI contract and authorization tests, plus frontend component and workflow tests.
- Add integration coverage for Supabase schema, Auth, and row-level security in an isolated development environment.
- Run the official `evaluate.py` when it is supplied; do not substitute an invented evaluator or present synthetic results as official scores.

**Ready when:** automated checks cover the critical pipeline and user flows, and official evaluation results are reproducible.