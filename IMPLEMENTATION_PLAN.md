# Implementation plan and status

The complete supplied organizer ZIP is included under `data/organizer-r5-v1/R5_Voice_of_Store_Engine/` and was compared byte-for-byte with the archive. The public synthetic package is whitelisted in Git; other raw inputs remain ignored. It contains 39,769 feedback rows, 3,000 public labels, 33 taxonomy rows, 60 stores, a 26-week calendar, one public incident example, baseline code, sample submissions, and `evaluate.py`. Do not read or infer hidden labels. The classifier has one chronological holdout result recorded below; public evaluator classification is in-sample and must not be treated as a generalization score.

## 1. Authentication

**Implemented:** Supabase Auth sign-in/sign-up, FastAPI token validation, store-membership checks, and PostgreSQL row-level security. The browser can read authorized data and update in-app status/team and review audit fields. Incident creation and evidence writes use a server-only key after backend verification.

**Implemented for evaluation access:** The root page exposes a read-only public R5 benchmark and classifier demo without requiring an account. Private paths still require Supabase Auth. Unauthenticated analysis can be saved in browser-local storage with a local-only notice; shared writes remain store-membership protected.

**Hosted schema checked:** The linked production project contained the objects from migrations 1–3. Migration 4's shared duplicate-vote table was absent; its timestamp-trigger dependency existed. Migration 4 was applied transactionally through the Supabase SQL Editor. A catalog query then confirmed the expected tables/view/functions/triggers/review columns/policies/RLS entries and authenticated grants, with no expected object missing.

**Remaining:** The hosted `supabase_migrations.schema_migrations` relation is absent, so the CLI cannot show remote history. `supabase migration repair --status applied --linked` for versions `20261028100357`, `20261028113303`, `20261028115426`, and `20261031120000` was attempted but the CLI requires an access token. Do not run `db push --linked` before recording the already-present migrations, because it could try to recreate existing objects. A signed-in live user with store membership is still needed for end-to-end authenticated workflow checks.

## 2. Data pipeline

**Prepared:** PostgreSQL stores issue groups, linked original source quotes, source/channel metadata, explicit period boundaries, and weekly transaction denominators. Authenticated live reports are checked for recent same-store, same-category cross-channel matches using exact normalization and character-trigram overlap. A person chooses to attach a report as evidence or keep it as a separate issue; no automatic merge occurs.

**Implemented prototype:** `ml/voiceofstore_ml/prepare.py` accepts explicit CSV/JSON/JSONL column mappings, validates required fields and time zones, preserves original text alongside a separate normalized field, and writes rejected rows to ignored private-data outputs. `deduplicate.py` implements the brief's Sentence-BERT/DBSCAN path with cosine `eps=0.15`, store-scoped clustering, all source evidence retained, and explicit runtime parameters for the missing checkpoint and `min_samples`.

**Implemented:** FastAPI read-only `/r5/benchmark` and `/r5/benchmark/brief` endpoints join all 39,769 original feedback IDs to generated predictions, taxonomy, store master, calendar, and evidence-checked flags. They surface source quotes, preserve records without store IDs, expose the 60 official store options, and compute region/week summaries.

**Remaining:** The organizer feedback has not been imported into PostgreSQL. The separate quote-preparation and Sentence-BERT/DBSCAN workflow has not been run because its checkpoint and `min_samples` are unspecified; live candidate suggestions are conservative character-overlap matches, not semantic paraphrase detection. No transaction-count file was provided; the benchmark brief labels its average-footfall proxy and reports classified feedback rows rather than confirmed incident groups.

## 3. ML training and inference

**Implemented:** `FULL_CODE/r5_solution.py` joins the 3,000 public labels to feedback by `feedback_id`, trains word/character TF-IDF with LinearSVC models for `issue_type_id`, `severity`, and `actionable`, applies taxonomy severity floors and store-routability policy, and writes one official-format prediction row per feedback ID. It validates chronologically on weeks 10–13, trains on weeks 1–9, and purges exact normalized duplicate text from training. Actual holdout: 957 rows across all 33 issue types; issue macro-F1 **0.878496**, severity weighted-F1 **0.898445**, actionable positive-F1 **0.938924**, combined classification score **0.898590**, actionable precision **0.944954**, and actionable high/critical precision **0.970370**. This is one public temporal split, not hidden-set performance.

The API artifact is fitted on all 3,000 public labels for inference on new feedback. Submission predictions use only earlier labels for public weeks 2–13, the organizer's public rules baseline for week 1, and all public labels for weeks 14–26. The official public evaluator reported classification **0.8234**, lead **0.3333**, and primary **0.6274**. The single public incident was first flagged in the naive-detection week (week 8), which is a match but provides no lead over that baseline. This is a public walk-forward diagnostic, not hidden-set performance. The lightweight model artifact is local and Git-ignored. The pre-existing Sentence-BERT/DBSCAN pipeline remains separate and still requires an approved checkpoint and `min_samples`.

The live analysis endpoint checks submitted store IDs/names against the official store master before applying store-routability policy. Unknown identifiers stay in human review; shared incident creation separately requires database membership. LinearSVC does not expose calibrated per-message confidence, so the UI does not invent one. Detector scores are identified as heuristics.

## 4. Incident detection

**Implemented prototype:** Rules identify issue category, severity, actionability, suggested department/action, review status, and escalation. Payment failures route to Digital / Technical Support, refrigeration equipment to Facilities & Maintenance, and stock availability to Supply Chain. Food safety/allergen, hygiene, and serious staff-misconduct reports require the configured safety/human-review path regardless of report volume. A database trigger protects safety severity and review audit history.

**Partially implemented:** The organizer model and taxonomy drive the 33-class decision contract. `FULL_CODE/detect.py` limits feedback to the as-of Sunday and the current plus four prior weeks, groups by store/week/predicted issue, normalizes counts by official average weekly footfall, excludes non-issue categories, retains evidence IDs, and caps flags at three per week. Candidate ranking combines capped lift with a sublinear evidence-count factor. Submission output now covers all 26 weeks; all 75 flags were locally schema-checked and all 439 cited IDs passed package validation. The public evaluator counted 36 flags in the public half, all with valid evidence; its first matching flag was week 8, the same week as the naive detector. The live workflow supports human-confirmed evidence grouping, but this detector still counts public feedback rows rather than confirmed incidents. Footfall is a proxy because there is no transaction CSV. No external notification or work-completion confirmation exists.

## 5. Dashboard

**Implemented:** The responsive root dashboard is public and uses organizer feedback and generated prediction outputs rather than static preview metrics. It shows full dataset coverage, all 26 weekly severity series, source-linked records, evidence-backed flags, an interactive region/week top-five brief with download, an architecture flow, and separate holdout/public-evaluator results. Authenticated live records remain store-scoped. Live regional reporting reads an RLS-protected view and uses verified transaction denominators when present. The table filters by store, region, category, severity, owner, channel, status, and text.

**Limitations:** The public benchmark brief uses average footfall because no transaction totals are included. Its records are classified feedback, not deduplicated incident groups or completed work. English and code-mixed subsets have not been scored separately. Live regional reports need verified transaction denominators and incident history.

## 6. Testing

**Verified locally:** 31 classifier and Supabase gateway tests pass, including authenticated membership checks and evidence-attachment severity safeguards. Ten focused benchmark/import checks pass; 24 ML checks pass. Forty-three frontend tests pass, including shared-vote service and cross-channel duplicate-matching tests, and the TypeScript/Vite production build succeeds. The public evaluator result remains classification **0.8234**, lead **0.3333**, and primary **0.6274**; it has not been improved or presented as hidden-set performance.

**Not verified end to end:** The full ASGI test suite stalls in its custom request helper in this environment. Local PostgreSQL/pgTAP tests were not run because Docker/Podman is unavailable. Production catalog state and the new duplicate-review RLS/grants were verified with read-only SQL queries, but no authenticated user vote was submitted. Hidden planted-incident labels and transaction totals are not in the supplied public package.

## Immediate next step

Sign in to the Supabase CLI and repair hosted migration history before any future `db push`. Then test live review votes with an authorized account that has store membership. For score evidence, obtain transaction totals or confirmation that footfall is accepted, plus hidden language labels and planted-incident truth from the organizer. The single public incident is insufficient to validate lead-time tuning; semantic paraphrase detection also needs a selected model/checkpoint and evaluation labels.
