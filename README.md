# Voice-of-Store Engine

Hackathon project foundation for problem statement **R5: Turning Store Chatter Into Action**. The goal is to turn store conversations into clear, useful actions for store teams.

## Current status

The complete organizer ZIP is copied under `data/organizer-r5-v1/R5_Voice_of_Store_Engine/`; all 12 archive files match the supplied package and are included with the project. The package contains 39,769 synthetic feedback records, 3,000 public training labels, 33 taxonomy classes, 60 stores, the calendar, public incident example, baseline, sample outputs, and evaluator. The `FULL_CODE/` pipeline trains issue-type, severity, and actionability classifiers; performs a chronological, exact-text-purged validation; writes official-format submissions; and runs the causal weekly detector. FastAPI serves a read-only public benchmark overview and regional brief from the complete organizer package and generated outputs. The root dashboard is available without an account and uses these real benchmark records, predictions, flags, and evidence. The organizer evaluator is run only against public labels and the public incident key; no hidden labels or scores are used. The organizer's three reference files are also available in the top-level `sample_submission/` folder; generated project outputs remain in `submission/`. Authenticated live submissions now offer a human-reviewed same-store, cross-channel repeat check and can attach the new source message as evidence to an existing incident. Semantic paraphrase detection and PostgreSQL import of the R5 historical predictions remain incomplete.

## Proposed architecture

- **Frontend:** React, TypeScript, and Vite for the store-team experience. Supabase Auth handles sign-in; the browser uses only the Supabase URL and public client key.
- **Backend:** Python and FastAPI for health checks, read-only R5 benchmark/brief endpoints, trained inference when the local artifact is compatible, transparent-rule fallback, official store-master validation, and secure incident creation. For shared incident creation and reviewer-confirmed evidence linking, the backend verifies the Supabase access token and store membership before persisting. It does not dispatch external notifications.
- **Persistence and identity:** Supabase Auth plus PostgreSQL. The browser uses only the publishable key for sign-in and RLS-scoped reads/updates. The backend alone uses the secret/service-role key, after verifying both the user and store membership. Never put that key in a frontend variable or file.
- **Data pipeline:** The separate `ml/` package has configurable CSV/JSON/JSONL preparation, source-field validation, verbatim quote retention, and Unicode-normalized analysis text. The supervised R5 pipeline reads the organizer schema. PostgreSQL has linked evidence and store-week denominator tables, but the R5 package has not been imported to the database.
- **ML:** `FULL_CODE/r5_solution.py` implements word/character TF-IDF with three LinearSVC classifiers, leakage-aware validation, taxonomy severity/actionability policies, submission generation, and a causal store-week detector. `ml/voiceofstore_ml/deduplicate.py` retains the separate Sentence-BERT/DBSCAN path; it still needs an approved checkpoint and `min_samples`. The public synthetic organizer package is whitelisted in Git; generated model artifacts and other private inputs remain ignored.
- **Incident detection:** An application layer that turns validated model or rule outputs into traceable incident records. Labels, thresholds, and output fields must follow the official task and evaluation contract once known.

### Planned source layout

```text
frontend/          React + TypeScript + Vite
backend/           FastAPI application and analysis rules
FULL_CODE/         R5 supervised model, validation, submissions, detector
sample_submission/ Original organizer reference outputs and detector command
ml/                Data preparation and semantic deduplication utilities
submission/        Generated official-format CSVs and detector command
supabase/          Database migrations and local Supabase configuration
```

The existing React dashboard, FastAPI application, local incident storage, and Supabase migration source files are preserved. The R5 model and detector use the public organizer package. The hosted Supabase schema was inspected in the Dashboard SQL Editor. The missing duplicate-review table was applied there and its RLS, policies, and grants were verified. The hosted CLI migration history is still unrecorded; do not run `db push` until its history is repaired. The local Supabase stack has not been run because Docker/Podman is unavailable. The leakage-safe holdout metrics are in `submission/R5_validation_report.json`; the public walk-forward evaluator output is in `submission/R5_public_evaluation.json` and is a public diagnostic, not a hidden-set result.

## Configuration

For the frontend, copy `.env.example` into `frontend/.env.local` and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_API_BASE_URL`. The app also accepts the legacy `VITE_SUPABASE_ANON_KEY` while older local environments are being migrated. For backend persistence, copy `backend/.env.example` to `backend/.env` and set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only `SUPABASE_SECRET_KEY`. The backend still accepts the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` names. Keep local env files out of source control. Supabase's publishable key may be used in the browser with these migrations' RLS policies; a secret or service-role key must stay on the backend and must never be placed in a `VITE_*` variable or frontend file. [Supabase's API key guidance](https://supabase.com/docs/guides/getting-started/api-keys) and [data security guide](https://supabase.com/docs/guides/database/secure-data) describe these key boundaries.

The public R5 benchmark endpoints do not require sign-in. `/` is a read-only benchmark and analysis demo; `/dashboard`, `/workspace`, `/incidents`, and `/settings` require a Supabase session. Unauthenticated analyses can be saved in browser-local storage, with a visible notice that they are not shared with a team. Shared incident writes still require an authorized store membership.

The backend requires HTTPS for remote Supabase URLs. Plain HTTP is accepted only for local loopback addresses such as `127.0.0.1` and `localhost`.

The frontend applies the same rule to authenticated incident submission and will not send a bearer token to a remote HTTP API.

## Connect the hosted Supabase project

The frontend client uses the existing email/password and Google auth flow, protected store reads, and direct incident status updates. Incident creation continues through FastAPI, which verifies the signed-in user's access token and store membership before writing with a server-only key. No Supabase-generated example app or new database objects are needed.

Set the local frontend environment in `frontend/.env.local` (Vite also accepts `frontend/.env`):

```dotenv
VITE_SUPABASE_URL=https://nxtpqjybosaibjncmbvf.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=replace-with-the-project-publishable-key
VITE_API_BASE_URL=http://127.0.0.1:8000
```

For hosted database writes, set `backend/.env` from `backend/.env.example`. Use the same project URL and publishable key there, plus the project's secret key in `SUPABASE_SECRET_KEY`. The legacy `SUPABASE_SERVICE_ROLE_KEY` name is also supported. The secret/service-role key is server-only. The backend `.env` is required for `POST /feedback/incidents`; the browser never receives that key.

In the hosted project's **Authentication → URL Configuration**, set the development Site URL to `http://127.0.0.1:5173` and allow the app's local callback URLs `http://127.0.0.1:5173/**` and `http://localhost:5173/**`. Enable the Google provider in the project if the Google sign-in button will be used.

### Hosted migration status and safe follow-up

The linked project is `nxtpqjybosaibjncmbvf`. A catalog check confirmed the tables, view, trigger functions, human-review columns, RLS settings, and policies required by all four local migrations. The duplicate-review table was absent, so migration `20261031120000_r5_duplicate_review_votes.sql` was applied transactionally through the Supabase SQL Editor. A second catalog check confirmed that the table exists, RLS is enabled, the four reviewer policies are present, and authenticated users have only the intended table grants.

The hosted database has no `supabase_migrations.schema_migrations` relation, and the CLI reports no remote migration versions. The CLI repair attempt was blocked because this workspace has no Supabase CLI access token. Since the older migration objects already exist, **do not run `db push --linked` yet**: the CLI could replay migrations 1–4 against existing objects.

After signing in to the Supabase CLI, record the four already-applied versions so future previews do not replay them:

```powershell
Set-Location .\frontend
npx supabase --workdir .. login
npx supabase --workdir .. link --project-ref nxtpqjybosaibjncmbvf
npx supabase --workdir .. migration repair --status applied --linked 20261028100357 20261028113303 20261028115426 20261031120000
npx supabase --workdir .. migration list --linked
```

Only run that repair after confirming the CLI is linked to the same project and the catalog check still shows the four migrations' objects. `db diff --linked` also requires Docker Desktop or Podman locally; it is not needed to use the existing hosted schema. The project ref is stored under `supabase/.temp/`; do not share the database password or any secret key.

The three earlier migrations are:

1. `supabase/migrations/20261028100357_incident_workflow.sql` — stores, memberships, incidents, RLS policies, and incident safety/update triggers.
2. `supabase/migrations/20261028113303_incident_human_review_audit.sql` — human-review audit columns and review-confirmation rules.
3. `supabase/migrations/20261028115426_r5_evidence_and_transactions.sql` — linked evidence, transaction totals, the weekly-rate view, RLS rules, and the server-only incident/evidence function.
4. `supabase/migrations/20261031120000_r5_duplicate_review_votes.sql` — shared authenticated duplicate-review decisions with per-user write policies.

The migrations do not seed stores, memberships, incidents, or transaction totals; the authenticated test account still needs membership in a real store before protected live workflows can be tested end to end.

For a fresh project, use the standard CLI preview-and-apply flow instead of the repair instructions above. This read-only query shows whether application objects already exist:

```sql
select table_name, table_type
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'stores', 'store_memberships', 'incidents', 'incident_evidence',
    'store_weekly_transactions', 'store_weekly_issue_rates', 'r5_duplicate_review_votes'
  )
order by table_name;
```

On a fresh project with none of the listed objects, preview the migrations first, then apply them with `--linked`:

```powershell
npx supabase --workdir .. db push --dry-run --linked
npx supabase --workdir .. db push --linked
```

`db push` applies pending files in timestamp order and records them in the remote migration history. If application objects already exist without matching history, reconcile first. See Supabase's [database migration workflow](https://supabase.com/docs/guides/local-development/cli-workflows).

## Run the backend locally (Windows PowerShell)

Open a VS Code terminal at the project root. In the first terminal, create a local Python 3.13 environment if needed, install the backend and trained-model inference requirements, and start FastAPI:

```powershell
Set-Location .\backend
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The health check, `/feedback/analyze`, `/r5/benchmark`, and `/r5/benchmark/brief` work without API keys, Supabase, or a database. The benchmark overview reports full row coverage, weekly predictions, emerging flags with original quotes, and the public evaluation results. The brief accepts `region` and `week_index` query parameters. If the model artifact exists at `ml/artifacts/r5_tfidf_classifier.joblib` and the pinned scikit-learn runtime matches, the API uses the trained R5 classifiers while keeping rule-based safety escalation active. A provided store name or ID must match the organizer store master before an issue is treated as store-routable; unknown names require review. Explicitly negated food-safety wording on an ordinary equipment complaint is kept on the transparent equipment route. If the artifact is absent, the API uses transparent keyword rules and includes the expected path and exact training command in the analysis explanation. If the artifact cannot be loaded because it is incompatible or corrupt, the API also explains the load failure and continues with rules. To enable persistent incidents, first copy `backend/.env.example` to `backend/.env` and replace all three placeholders with values from your Supabase project. Use the same start command; the backend reads `backend/.env` automatically:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The backend reads simple `KEY=value` entries and full-line comments from `backend/.env`; it does not execute PowerShell or shell syntax. Values already set in the process environment take precedence. If project values are still placeholders, do not use the persistence endpoint. Never share or commit `backend/.env`.

The default department mapping can be overridden for the current PowerShell session, for example:

```powershell
$env:VOS_DEPARTMENT_FOOD_SAFETY = 'Food Protection'
```

Available mapping variables are `VOS_DEPARTMENT_EQUIPMENT_FAILURE`, `VOS_DEPARTMENT_FOOD_SAFETY`, `VOS_DEPARTMENT_DIGITAL_SUPPORT`, `VOS_DEPARTMENT_SUPPLY_CHAIN`, `VOS_DEPARTMENT_CHECKOUT`, `VOS_DEPARTMENT_PRODUCT_QUALITY`, `VOS_DEPARTMENT_STORE_ENVIRONMENT`, `VOS_DEPARTMENT_STAFF_BEHAVIOR`, and `VOS_DEPARTMENT_UNKNOWN`. If omitted, built-in department names are used.

`POST /feedback/analyze` returns the classification decision without saving it. A signed-in user who selects an authorized store can use `POST /feedback/incidents`; FastAPI verifies the user's Supabase session and membership, then atomically saves the issue group and its original quote as linked source evidence using server-generated fields. Before creation, the live form checks recent incidents from the same store, category, and a different channel. Exact and high character-overlap matches pause for human choice: attach the new message as supporting evidence with `POST /feedback/incidents/{incident_id}/evidence`, or create a separate incident. This is a conservative text-overlap aid, not semantic paraphrase detection, and never merges automatically. The initial in-app `assigned_department` is set to the recommendation. This is not an external message or confirmation that work was completed. Browser clients have no database insert permission. Database migrations restrict authenticated users to reading authorized records and updating team/status fields. A review-required incident cannot leave its review state until a signed-in member explicitly confirms review; PostgreSQL records the reviewer and database timestamp. Food safety incidents remain Critical and escalated. A rule match is not confirmation of a hazard; staff must follow the store's established procedure.

In another PowerShell window, check the health route:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/health
```

To try the feedback endpoint directly, submit a synthetic example:

```powershell
$body = @{
  feedback_text = 'The allergen label on these cookies does not mention peanuts.'
  store_name = 'Demo Store'
  source = 'customer_feedback'
} | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:8000/feedback/analyze -Method Post -ContentType 'application/json' -Body $body
```

Model and rule outputs are triage recommendations, not confirmed findings or external assignments. Potential food-safety and allergen matches require human verification; FastAPI does not dispatch external alerts. Stop the development server with `Ctrl+C`.

## Run the frontend locally (Windows PowerShell)

Open a second VS Code terminal at the project root and run:

```powershell
Set-Location .\frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) consistently; browser-local incidents are scoped to this origin, so `localhost` and `127.0.0.1` have separate local records. The root page is a public, read-only benchmark powered by the organizer package. It includes original feedback, generated classifications, detector evidence, a region/week brief, and clearly separated evaluation results. A submitted unauthenticated analysis is saved in this browser only. When signed in and assigned to a store, the live view reads and updates only that account's authorized incidents; new shared incidents are created through FastAPI. Stop Vite with `Ctrl+C`.

## R5 data preparation and semantic deduplication

The complete, permitted organizer package is under `data/organizer-r5-v1/R5_Voice_of_Store_Engine/`. The trainer reads `feedback.csv`, `feedback_labels_train.csv`, `issue_taxonomy.csv`, `store_master.csv`, and `week_calendar.csv` from that package. Use Python 3.13 and the pinned ML dependencies in `backend/requirements.txt` (the same versions are listed in `ml/r5-requirements.txt`). From the project root, create the local environment and install the project dependencies once:

```powershell
py -3.13 -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

Do not retrain an existing compatible artifact. If you have a clean checkout with no local artifact, or intentionally want to rebuild it, create the model and generated reports with this exact command from the project root:

```powershell
.\backend\.venv\Scripts\python.exe -m FULL_CODE.r5_solution train `
  --feedback data\organizer-r5-v1\R5_Voice_of_Store_Engine\data\feedback.csv `
  --out-dir ml\output\r5-training `
  --model-out ml\artifacts\r5_tfidf_classifier.joblib
```

The API loads `ml/artifacts/r5_tfidf_classifier.joblib` by default. Set `VOS_MODEL_PATH` only when intentionally loading an artifact from another location. The explicit `--out-dir` keeps this recovery/rebuild command from overwriting the existing official files in `submission/`; the artifact remains Git-ignored. The pinned requirements lock pandas 3.1.0, NumPy 2.5.4, SciPy 1.18.1, joblib 1.6.0, scikit-learn 1.9.0, and threadpoolctl 3.7.0 so training and inference agree on the artifact's supported scikit-learn version.

The command validates on a chronological holdout of public training weeks, purges exact normalized duplicate text between train and holdout, then refits on all public labels for submission. It writes the validation report, all-record prediction file, causal detector flags, and command record under `ml/output/r5-training/`; the fitted artifact goes to `ml/artifacts/`. `R5_validation_report.json` contains the actual holdout metrics and pipeline limitations. The output CSVs cover every feedback ID; they do not contain hidden labels or hidden scores. Confirm the default-path artifact can be opened by the inference loader with:

```powershell
.\backend\.venv\Scripts\python.exe -c "from FULL_CODE.r5_solution import load_model_bundle; bundle = load_model_bundle(); print('Loaded R5 model with scikit-learn', bundle['sklearn_version'])"
```

The measured holdout used weeks 1–9 for training and weeks 10–13 for validation (37 exact-text duplicates purged; 957 validation rows). It scored issue-type macro-F1 **0.878496**, severity weighted-F1 **0.898445**, actionable positive-F1 **0.938924**, and weighted classification score **0.898590**. The public evaluator's walk-forward diagnostic scored **0.8234** classification, **0.3333** lead, and **0.6274** primary. Its one public incident was first flagged in the published naive-detection week (week 8), so this result shows a match but no lead over the naive baseline. All 36 flags scored in the public 13-week half passed evidence checks; none used hidden labels. These public scores are not hidden-test performance.

The one-week detector command is also included at `submission/detector_cmd.txt`. To run it for a date inside a week:

```powershell
python FULL_CODE/detect.py `
  --feedback data\organizer-r5-v1\R5_Voice_of_Store_Engine\data\feedback.csv `
  --as-of 2026-07-13 `
  --out submission\one-week-flags.csv
```

The detector reads required files beside `feedback.csv`, uses only feedback through that calendar week's Sunday and the current plus four prior weeks, normalizes event counts by store weekly footfall, and cites at least two distinct same-store, same-week feedback records. It excludes non-issue taxonomy classes, caps output at three flags per week, and ranks candidates using capped lift with a sublinear evidence-count factor. The flags shipped with the public submission remain footfall-based.

### Review duplicate candidates and add verified transactions

The public dashboard's cross-channel review queue is available at `GET /r5/benchmark/duplicates`. It scans records with a known store and actionable predicted category, then surfaces exact normalized-text matches and same-store/same-week character n-gram matches with similarity of at least 0.78. These are review candidates, not confirmed incidents. A shared template sentence can still score highly when amounts or other facts differ. The dashboard stores “same incident” / “keep separate” choices in the current browser and can export them to CSV. Confirmed matches with the same predicted issue type collapse the duplicate count, rate numerator and repeated quote in the selected regional brief, including when the top-five list needs to be reranked. The original source records and model predictions remain intact; generated detector flags are not recalculated, and review choices are not written to Supabase. A validated multilingual semantic model and shared persistence for review decisions remain future work.

The weekly benchmark brief accepts verified store/week totals through a CSV with exactly these required fields (additional fields are ignored): `store_id,week_index,total_transactions`. Download the blank [transaction template](data/store_weekly_transactions_template.csv), fill it only with supplied/verified counts, and either save it as `data/store_weekly_transactions.csv` or set `VOS_R5_TRANSACTIONS_CSV` in `backend/.env` to its path. The loader rejects unknown stores/weeks, duplicate store/week rows, and missing or non-positive totals. When totals exist for the selected region/week, the brief divides reports at covered stores by their transaction counts and displays coverage; uncovered stores remain in raw report totals and are excluded from that rate. If no totals exist for the selected period, the brief keeps the visible footfall proxy. No transaction totals are present in the supplied organizer ZIP. The pre-generated public emerging flags are not recalculated by this optional import and continue to use footfall.

## Run local Supabase (Windows PowerShell)

The Supabase CLI is a project-local frontend development dependency. The local Supabase stack requires Docker Desktop, which is not currently available in the development environment. From a third terminal:

```powershell
Set-Location .\frontend
$env:SUPABASE_HOME = Join-Path (Get-Location).Path '..\.supabase-home'
npx supabase --workdir .. start
npx supabase --workdir .. migration up --local
npx supabase --workdir .. status
npx supabase --workdir .. test db
```

The database test command runs the pgTAP authorization, human-review, duplicate-review vote, evidence, transaction-denominator, and rate-view checks in `supabase/tests/`. It requires the local Supabase stack to be running.

While in `frontend/`, create the local settings file and replace its publishable key and API URL with the values for the local stack shown by `status`:

```powershell
Copy-Item ..\.env.example .env.local
```

Set `VITE_API_BASE_URL=http://127.0.0.1:8000`, then restart Vite after changing environment values. `.supabase-home` is ignored by Git and keeps local CLI state inside the project folder. In a separate backend terminal, copy `backend/.env.example` to `backend/.env` and fill in `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` from `npx supabase status`; legacy anon/service-role key names are also accepted. Start FastAPI using the regular command above. Keep the secret/service-role key only in the backend environment.

Sign up in the dashboard, then use Supabase Studio's SQL editor at `http://127.0.0.1:54323` to add the real store master row and grant the new account access. Replace all placeholders with values provided by your team; no demo store or account is seeded:

```sql
insert into public.stores (store_code, name, region)
values ('<STORE_CODE>', '<STORE_NAME>', '<REGION>');

insert into public.store_memberships (user_id, store_id, role)
select auth_user.id, store.id, 'manager'
from auth.users as auth_user
join public.stores as store on store.store_code = '<STORE_CODE>'
where auth_user.email = '<SIGNED_IN_EMAIL>';
```

Weekly rates stay unavailable until verified transaction totals are loaded for the same store and explicit source period. Use the official totals and period boundaries when supplied; do not copy sample counts into this table. For a verified source row, an administrator can use this Studio SQL template, replacing each placeholder with real project values:

```sql
insert into public.store_weekly_transactions
  (store_id, period_start, period_end, total_transactions, source_reference)
values
  ('<STORE_UUID>', '<SOURCE_PERIOD_START_WITH_TIMEZONE>', '<SOURCE_PERIOD_END_WITH_TIMEZONE>', <VERIFIED_TRANSACTION_COUNT>, '<SOURCE_FILE_OR_BATCH>');
```

The regional report averages per-store issue rates equally and shows denominator coverage. Stores with missing or zero denominators are excluded; the dashboard does not fall back to raw counts. The emerging-issue watch currently requires a rate above that store/category's four preceding completed periods and at least two deduplicated issue groups. These thresholds are provisional until checked against the official evaluator. The database can retain multiple original quotes under a group, but current live form submissions are stored one group per message, so semantic deduplication remains future work.

The migrations enable RLS on every exposed application table and view, revoke broad client-role grants, scope incidents, source quotes, and weekly transaction totals through `store_memberships`, and keep store and membership administration out of the browser. Signed-in users can read shared duplicate-review votes and create/change/remove only their own vote. FastAPI verifies membership before calling the atomic incident/evidence write with its server-only key. For the current hosted project, repair CLI migration history before any `db push`; its schema objects already exist.

For this Windows environment, if npm reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, use Node's Windows certificate store for the current PowerShell session and retry the install without disabling TLS verification:

```powershell
$env:NODE_USE_SYSTEM_CA = '1'
npm install
Remove-Item Env:NODE_USE_SYSTEM_CA
```

## Implementation plan

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the proposed phases covering authentication, the data pipeline, ML, incident detection, the dashboard, and testing.

## Development status

Backend and ML inference dependencies are declared in `backend/requirements.txt`; the pinned ML dependencies are repeated in `ml/r5-requirements.txt`. The TypeScript/Vite production build succeeds, 43 frontend checks pass, 31 classifier/gateway checks pass, 10 focused benchmark checks pass, and 24 ML checks pass. The full ASGI test suite did not complete because its custom request helper stalled in this environment. The live duplicate-review table and RLS policies are present in Supabase, but CLI migration history still needs authentication and repair. The organizer package has no transaction totals, language-specific labels, or hidden planted-incident truth. Duplicate candidates remain conservative exact/character-overlap suggestions; semantic paraphrase resolution, language-subset scoring, and hidden-set performance verification need additional labels or organizer data.

## Run backend checks

From the project root, run the backend classifier and Supabase gateway unit tests with the existing Python 3.13 virtual environment:

```powershell
.\backend\.venv\Scripts\python.exe -m unittest discover -s backend\tests -v
```

Run the frontend tests and production build with:

```powershell
Set-Location .\frontend
npm test
npm run build
```
