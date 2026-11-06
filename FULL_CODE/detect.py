"""Organizer-required one-week entry point for the R5 emerging detector."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from FULL_CODE.r5_solution import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(["detect", *sys.argv[1:]]))
