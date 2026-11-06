"""Validate organizer-provided records without assuming their column names.

Original feedback is retained verbatim in `feedback_text`; normalized text is
an additional analysis field and never replaces evidence.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class RecordValidationError(ValueError):
    """A source row is missing a required value or has an invalid timestamp."""


def normalize_for_embedding(text: str) -> str:
    """Normalize Unicode/spacing while preserving language, emoji and meaning."""
    normalized = unicodedata.normalize("NFKC", text)
    safe_characters = (
        character for character in normalized
        if unicodedata.category(character) != "Cc" or character.isspace()
    )
    return " ".join("".join(safe_characters).split())


def _required_text(record: Mapping[str, Any], column: str, field: str) -> str:
    value = record.get(column)
    if value is None:
        raise RecordValidationError(f"missing_{field}")
    text = str(value)
    if not text.strip():
        raise RecordValidationError(f"empty_{field}")
    return text


def _normalize_timestamp(value: str, naive_timezone: str | None) -> str:
    candidate = value.strip()
    try:
        parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError as error:
        raise RecordValidationError("invalid_timestamp") from error

    if parsed.tzinfo is None:
        if not naive_timezone:
            raise RecordValidationError("timestamp_timezone_missing")
        try:
            parsed = parsed.replace(tzinfo=ZoneInfo(naive_timezone))
        except ZoneInfoNotFoundError as error:
            raise RecordValidationError("unknown_assumed_timezone") from error

    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def prepare_record(
    record: Mapping[str, Any],
    *,
    record_number: int,
    source_filename: str,
    text_column: str,
    store_column: str,
    timestamp_column: str,
    source_column: str | None,
    source_value: str | None,
    record_id_column: str | None,
    label_column: str | None,
    naive_timezone: str | None,
) -> dict[str, Any]:
    original_text = _required_text(record, text_column, "feedback_text")
    analysis_text = normalize_for_embedding(original_text)
    if not analysis_text:
        raise RecordValidationError("empty_normalized_text")

    store_id = _required_text(record, store_column, "store_id")
    timestamp_source = _required_text(record, timestamp_column, "timestamp")
    received_at = _normalize_timestamp(timestamp_source, naive_timezone)

    if source_value is not None:
        source = source_value
    elif source_column is not None:
        source = _required_text(record, source_column, "source")
    else:
        raise RecordValidationError("source_column_or_value_required")
    if not source.strip():
        raise RecordValidationError("empty_source")

    if record_id_column:
        source_record_id = _required_text(record, record_id_column, "source_record_id")
    else:
        source_record_id = f"{Path(source_filename).name}:{record_number}"

    prepared: dict[str, Any] = {
        "schema_version": 1,
        "source_record_id": source_record_id,
        "store_id": store_id,
        "source": source,
        "received_at": received_at,
        "feedback_text": original_text,
        "analysis_text": analysis_text,
    }
    if label_column:
        label = _required_text(record, label_column, "label")
        prepared["label"] = label
    return prepared


def iter_source_records(path: Path) -> Iterator[tuple[int, Mapping[str, Any]]]:
    """Read CSV, JSON array, or JSON Lines while keeping source row numbers."""
    suffix = path.suffix.casefold()
    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as source_file:
            for row_number, row in enumerate(csv.DictReader(source_file), start=2):
                yield row_number, row
        return

    if suffix in {".jsonl", ".ndjson"}:
        with path.open("r", encoding="utf-8-sig") as source_file:
            for row_number, line in enumerate(source_file, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RecordValidationError(f"invalid_json_line_{row_number}") from error
                if not isinstance(record, Mapping):
                    raise RecordValidationError(f"json_line_not_object_{row_number}")
                yield row_number, record
        return

    if suffix == ".json":
        try:
            with path.open("r", encoding="utf-8-sig") as source_file:
                records = json.load(source_file)
        except json.JSONDecodeError as error:
            raise RecordValidationError("invalid_json_document") from error
        if not isinstance(records, list):
            raise RecordValidationError("json_document_must_be_an_array")
        for row_number, record in enumerate(records, start=1):
            if not isinstance(record, Mapping):
                raise RecordValidationError(f"json_record_not_object_{row_number}")
            yield row_number, record
        return

    raise RecordValidationError("unsupported_file_type_use_csv_json_or_jsonl")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Organizer-provided CSV, JSON array, or JSONL file")
    parser.add_argument("--output", required=True, type=Path, help="Prepared JSONL destination; keep it under ignored data/")
    parser.add_argument("--text-column", required=True, help="Source column containing the original feedback text")
    parser.add_argument("--store-column", required=True, help="Source column containing the store identifier")
    parser.add_argument("--timestamp-column", required=True, help="Source column containing the source-record timestamp")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-column", help="Source column containing channel/source name")
    source.add_argument("--source-value", help="Explicit source name when one file represents a single channel")
    parser.add_argument("--record-id-column", help="Optional stable source-record ID column; generated row IDs are used when omitted")
    parser.add_argument("--label-column", help="Optional provided label column; no labels are inferred or fabricated")
    parser.add_argument("--naive-timezone", help="IANA time zone for timestamps without an offset; required only for naive timestamps")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    source_path = args.input.resolve()
    output_path = args.output.resolve()
    project_root = Path(__file__).resolve().parents[2]
    private_roots = (project_root / "data", project_root / "datasets", project_root / "ml" / "data")
    if not any(output_path == root or root in output_path.parents for root in private_roots):
        print("Output must be inside ignored project data/, datasets/, or ml/data/.", file=sys.stderr)
        return 2
    if source_path == output_path:
        print("Input and output paths must be different.", file=sys.stderr)
        return 2
    rejects_path = output_path.with_suffix(output_path.suffix + ".rejects.jsonl")
    if output_path.exists() or rejects_path.exists():
        print("Output already exists; choose new paths to avoid overwriting data.", file=sys.stderr)
        return 2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    valid_count = 0
    rejected_count = 0
    seen_ids: set[tuple[str, str]] = set()

    try:
        with output_path.open("x", encoding="utf-8", newline="\n") as prepared_file, rejects_path.open(
            "x", encoding="utf-8", newline="\n"
        ) as rejects_file:
            for row_number, record in iter_source_records(source_path):
                try:
                    prepared = prepare_record(
                        record,
                        record_number=row_number,
                        source_filename=source_path.name,
                        text_column=args.text_column,
                        store_column=args.store_column,
                        timestamp_column=args.timestamp_column,
                        source_column=args.source_column,
                        source_value=args.source_value,
                        record_id_column=args.record_id_column,
                        label_column=args.label_column,
                        naive_timezone=args.naive_timezone,
                    )
                    identity = (prepared["source"], prepared["source_record_id"])
                    if identity in seen_ids:
                        raise RecordValidationError("duplicate_source_record_id")
                    seen_ids.add(identity)
                    prepared_file.write(json.dumps(prepared, ensure_ascii=False) + "\n")
                    valid_count += 1
                except RecordValidationError as error:
                    rejects_file.write(json.dumps({
                        "source_file": source_path.name,
                        "source_row": row_number,
                        "error": str(error),
                        "raw_record": record,
                    }, ensure_ascii=False) + "\n")
                    rejected_count += 1
    except (OSError, RecordValidationError) as error:
        print(f"Could not prepare source file: {error}", file=sys.stderr)
        return 2

    if valid_count == 0:
        print("No valid rows were prepared; inspect the ignored rejects file.", file=sys.stderr)
        return 2

    print(f"Prepared {valid_count} rows; rejected {rejected_count}. Output: {output_path}")
    print(f"Rejected source rows, including raw contents, were written to: {rejects_path}")
    return 2 if rejected_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
