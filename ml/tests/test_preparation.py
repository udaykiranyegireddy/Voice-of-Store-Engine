from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ml.voiceofstore_ml.prepare import (
    RecordValidationError,
    iter_source_records,
    normalize_for_embedding,
    prepare_record,
)


class PreparationTests(unittest.TestCase):
    def test_normalization_keeps_original_languages_emoji_and_punctuation(self) -> None:
        original = "  फ्रिज ख़राब 😟!!!\nCard payment failed  "
        self.assertEqual(normalize_for_embedding(original), "फ्रिज ख़राब 😟!!! Card payment failed")

    def test_prepare_record_keeps_source_quote_and_normalizes_aware_timestamp(self) -> None:
        original = "  The freezer is broken. 🧊  "
        prepared = prepare_record(
            {
                "body": original,
                "store": "ST-17",
                "channel": "staff_shift_note",
                "received": "2026-10-28T15:30:00+05:30",
                "record": "note-001",
                "issue_label": "equipment_failure",
            },
            record_number=2,
            source_filename="shift_notes.csv",
            text_column="body",
            store_column="store",
            timestamp_column="received",
            source_column="channel",
            source_value=None,
            record_id_column="record",
            label_column="issue_label",
            naive_timezone=None,
        )

        self.assertEqual(prepared["feedback_text"], original)
        self.assertEqual(prepared["analysis_text"], "The freezer is broken. 🧊")
        self.assertEqual(prepared["received_at"], "2026-10-28T10:00:00Z")
        self.assertEqual(prepared["source_record_id"], "note-001")
        self.assertEqual(prepared["label"], "equipment_failure")

    def test_naive_timestamp_is_not_assigned_an_assumed_timezone(self) -> None:
        with self.assertRaisesRegex(RecordValidationError, "timestamp_timezone_missing"):
            prepare_record(
                {"body": "Payment failed", "store": "ST-17", "channel": "app", "received": "2026-10-28 12:00:00"},
                record_number=2,
                source_filename="app.csv",
                text_column="body",
                store_column="store",
                timestamp_column="received",
                source_column="channel",
                source_value=None,
                record_id_column=None,
                label_column=None,
                naive_timezone=None,
            )

    def test_missing_id_uses_filename_and_row_number_without_changing_feedback(self) -> None:
        prepared = prepare_record(
            {"body": "Payment failed", "store": "ST-17", "received": "2026-10-28T12:00:00Z"},
            record_number=8,
            source_filename="app_comments.csv",
            text_column="body",
            store_column="store",
            timestamp_column="received",
            source_column=None,
            source_value="app_comment",
            record_id_column=None,
            label_column=None,
            naive_timezone=None,
        )
        self.assertEqual(prepared["source_record_id"], "app_comments.csv:8")
        self.assertEqual(prepared["feedback_text"], "Payment failed")

    def test_csv_reader_handles_bom_and_keeps_header_names_for_explicit_mapping(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "source.csv"
            path.write_text("\ufeffmessage,location\nFreezer is broken,ST-17\n", encoding="utf-8")
            rows = list(iter_source_records(path))
        self.assertEqual(rows, [(2, {"message": "Freezer is broken", "location": "ST-17"})])


if __name__ == "__main__":
    unittest.main()
