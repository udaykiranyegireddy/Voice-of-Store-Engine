from __future__ import annotations

import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from ml.voiceofstore_ml.deduplicate import make_issue_groups, merge_prepared_inputs


def evidence(record_id: str, store_id: str = "store-1", source: str = "app", received_at: str = "2026-10-28T10:00:00Z") -> dict[str, str]:
    return {
        "source_record_id": record_id,
        "store_id": store_id,
        "source": source,
        "received_at": received_at,
        "feedback_text": f"Original quote {record_id}",
        "analysis_text": f"Normalized quote {record_id}",
    }


class DeduplicationTests(unittest.TestCase):
    def test_dbscan_labels_form_groups_and_noise_stays_singleton(self) -> None:
        rows = [evidence("a1", source="app"), evidence("b1", source="call"), evidence("c1")]
        groups = make_issue_groups(rows, [0, 0, -1])

        self.assertEqual(len(groups), 2)
        self.assertEqual(sorted(group["member_count"] for group in groups), [1, 2])
        duplicate = next(group for group in groups if group["member_count"] == 2)
        self.assertEqual(duplicate["sources"], ["app", "call"])
        self.assertEqual(
            [item["feedback_text"] for item in duplicate["evidence"]],
            ["Original quote a1", "Original quote b1"],
        )

    def test_group_ids_are_deterministic_and_store_scoped(self) -> None:
        rows = [evidence("a1"), evidence("b1", store_id="store-2")]
        groups = make_issue_groups(rows, [0, 0])
        self.assertEqual(len(groups), 2)
        self.assertNotEqual(groups[0]["issue_group_id"], groups[1]["issue_group_id"])
        self.assertEqual(groups[0]["store_id"], "store-1")
        self.assertEqual(groups[1]["store_id"], "store-2")

        same_store_same_id = [evidence("record-1", source="app"), evidence("record-1", source="call")]
        separate_groups = make_issue_groups(same_store_same_id, [0, 1])
        self.assertNotEqual(separate_groups[0]["issue_group_id"], separate_groups[1]["issue_group_id"])

    def test_mismatched_dbscan_labels_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "exactly one DBSCAN label"):
            make_issue_groups([evidence("a1")], [])

    def test_channel_files_can_be_combined_and_duplicate_source_ids_are_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            first = Path(directory) / "first.jsonl"
            second = Path(directory) / "second.jsonl"
            first.write_text(json.dumps(evidence("a1", source="app")) + "\n", encoding="utf-8")
            second.write_text(json.dumps(evidence("b1", source="call")) + "\n", encoding="utf-8")
            self.assertEqual(len(merge_prepared_inputs([first, second])), 2)
            second.write_text(json.dumps(evidence("a1", source="app")) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "repeats across prepared files"):
                merge_prepared_inputs([first, second])


if __name__ == "__main__":
    unittest.main()
