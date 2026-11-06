# R5 data preparation and semantic deduplication

This folder contains the configurable preparation and semantic-deduplication utilities. The supervised R5 classifiers and causal emerging detector live in `FULL_CODE/r5_solution.py`; they consume only organizer package files beside the supplied `feedback.csv`.

## What is implemented

- `voiceofstore_ml.prepare` reads CSV, JSON arrays, and JSONL using source-column names supplied at runtime.
- It validates feedback text, store identifiers, channel/source, and timestamps. Timezone-naive timestamps are rejected unless an explicit IANA timezone is supplied.
- It retains `feedback_text` exactly and creates a separate Unicode-normalized `analysis_text`; it does not translate or strip emoji.
- Invalid rows are written, including their raw contents, to an adjacent rejects JSONL file. Keep both outputs under ignored `data/`, `datasets/`, or `ml/data/` folders. Existing outputs are not overwritten.
- `voiceofstore_ml.deduplicate` embeds records with the user-supplied Sentence-BERT checkpoint, then runs DBSCAN using cosine distance and `eps=0.15` from the R5 brief. It requires the organizer-provided `min_samples` value, clusters separately by store, and retains every source quote in the output group. DBSCAN noise points remain individual groups.
- `FULL_CODE/r5_solution.py` joins public labels to feedback IDs and trains TF-IDF/LinearSVC models for issue type, severity, and actionability. It validates on later public weeks after removing exact normalized text duplicates from training, applies taxonomy severity floors, writes full-length organizer-format predictions, and emits evidence-backed flags for both public and test periods. Public training-period predictions use labels from earlier weeks only; the first calendar week uses the organizer's public rules baseline because no earlier labels exist.
- `FULL_CODE/detect.py` implements the organizer-required one-week command. It reads the package from the folder containing `feedback.csv`, limits feedback to the specified week's Sunday, and produces same-store/week/type evidence IDs. It also writes a paired diagnostics CSV with the selected store/category, evidence IDs, current normalized rate, four-week mean, EWMA baseline, z-score, and rate lift; the organizer-required flags CSV keeps its exact official schema.

The complete public synthetic organizer package is included under `data/organizer-r5-v1/R5_Voice_of_Store_Engine/`; other raw/private datasets remain ignored. The Sentence-BERT checkpoint and `min_samples` remain unspecified, so semantic clustering has not been run. Store normalization in the detector uses the provided average weekly footfall because the package does not include a transaction CSV. Exact repeated normalized text is removed from event counts, but semantic cross-channel deduplication is not implemented. The detector excludes non-issue classes, compares each store/type with its preceding four weeks using a recency-weighted EWMA and Poisson-aware noise floor, and ranks footfall-normalized increases with policy severity priority before raw volume. Critical groups with two or more independent current-week reports bypass the trend threshold; the classifier continues to emit mandatory critical severity for individual critical feedback. A store/type alert stays suppressed while feedback continues and can alert again after two quiet weeks.

## Python 3.13 setup for supervised R5 training

Use the shared backend environment from the project root in PowerShell. The exact clean-checkout setup, pinned dependency versions, artifact path, and recovery guidance are maintained in the root [README.md](../README.md):

```powershell
py -3.13 -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

The pinned R5 dependencies are also listed in `ml/r5-requirements.txt`. For the older Sentence-BERT/DBSCAN utility, install the separate `ml/requirements.txt` only if its approved checkpoint and parameters are available; that dependency set is substantially larger.

Train, validate, and write the ignored model artifact and generated reports from the project root. The explicit output directory keeps this command away from existing official submission files:

```powershell
.\backend\.venv\Scripts\python.exe -m FULL_CODE.r5_solution train `
  --feedback data\organizer-r5-v1\R5_Voice_of_Store_Engine\data\feedback.csv `
  --out-dir ml\output\r5-training `
  --model-out ml\artifacts\r5_tfidf_classifier.joblib
```

The backend loads `ml/artifacts/r5_tfidf_classifier.joblib` by default. Do not retrain an existing compatible artifact unless you intend to rebuild it. Generated model files and `ml/output/` are Git-ignored. `R5_validation_report.json` records the exact temporal split and measured holdout metrics. The full predictions file is refit on all public labels after validation and is not itself a held-out metric.

## Prepare one source file

Copy the authorized source file under `data/private/`. Replace every bracketed column name with the exact header from that file; if source is encoded by the file itself, provide its verified channel name using `--source-value`.

```powershell
.\.venv-ml\Scripts\python.exe -m ml.voiceofstore_ml.prepare `
  --input data\private\<official-source-file>.csv `
  --output data\processed\<source-name>.prepared.jsonl `
  --text-column "<exact feedback header>" `
  --store-column "<exact store ID header>" `
  --timestamp-column "<exact timestamp header>" `
  --source-column "<exact source header>" `
  --record-id-column "<exact record ID header>"
```

If the source has no record ID field, omit `--record-id-column`; the preparation command creates an ID from the filename and row number. If timestamps lack offsets, use `--naive-timezone "<IANA timezone from organizer documentation>"` only after confirming the source timezone. Do not infer it from the machine's local clock.

The preparation command exits non-zero if any rows are rejected, even though it writes valid rows and a rejects report. Review the rejects report before continuing. Choose a new output name for each rerun so existing data is not overwritten.

## Deduplicate prepared records

Use only the embedding checkpoint approved for the task and the `min_samples` value from organizer instructions or an explicitly reviewed experiment. Neither value is filled in by this project. Repeat `--input` once for every prepared source channel so DBSCAN can compare records across channels for the same store.

```powershell
.\.venv-ml\Scripts\python.exe -m ml.voiceofstore_ml.deduplicate `
  --input data\processed\<source-name>.prepared.jsonl `
  --input data\processed\<second-source>.prepared.jsonl `
  --output data\processed\<source-name>.issue-groups.jsonl `
  --embedding-model "<approved Sentence-BERT checkpoint or local path>" `
  --min-samples <organizer-provided integer>
```

The command can download model weights when given a remote checkpoint. Review that choice and the checkpoint license/network requirements before running it. It writes grouped records only under Git-ignored data directories and refuses to overwrite an existing output.

## Tests

The utility tests use in-memory examples and the R5 tests cover the chronological split, as-of cutoff, evidence, safety policy, and official output columns. From the project root in an environment with the lightweight R5 requirements installed:

```powershell
.\backend\.venv\Scripts\python.exe -m unittest discover -s ml\tests -t . -v
```

Training and inference have been run on the public package. The official evaluator has been run on the public labels using causal, week-by-week public predictions; the inference artifact for new feedback is separately refit on all public labels. The latest public diagnostic scored classification 0.8234, lead 0.3333, and primary 0.6274; the one public incident was detected in the same week as the naive detector. Dataset import to PostgreSQL, regional-rate comparison using true transaction totals, and hidden-set evaluation remain outstanding.
