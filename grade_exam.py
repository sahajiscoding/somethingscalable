#!/usr/bin/env python3
"""WeHelpTeachers CLI - grade one student against a question paper + answer key.

Examples:
    export NVIDIA_API_KEY=...
    python grade_exam.py \
        --paper sample_test_data/00_synthetic/question_paper.txt \
        --key   sample_test_data/00_synthetic/answer_key.txt \
        --student sample_test_data/00_synthetic/student_sheet.txt \
        --out reports

    # Offline smoke run (text documents only, no API key):
    python grade_exam.py --paper p.txt --key k.txt --student s.txt --mock

Outputs ``report.json`` and ``report.md`` in --out (default: ./reports).
Exit codes: 0 success, 2 bad usage (argparse), 3 pipeline/input failure.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from engine import NVIDIA_DEFAULT_MODEL, PENALTY_CATEGORIES
from grade import GradeParams
from pipeline import SessionError, run_session, write_reports


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="grade_exam.py",
        description="Grade a student's exam sheet against an answer key "
                    "using the question paper for context.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--paper", required=True,
                        help="Question paper file (PDF, JPG/PNG, TXT)")
    parser.add_argument("--key", required=True,
                        help="Answer key / rubric file (PDF, image, TXT)")
    parser.add_argument("--student", required=True,
                        help="Student answer sheet (scanned PDF or image)")
    parser.add_argument("--out", default="reports",
                        help="Directory for report.json and report.md")
    parser.add_argument("--strict", action="store_true",
                        help="Strict checking mode (no partial credit)")
    parser.add_argument("--penalties", default="",
                        help="Comma-separated penalty criteria to enable: "
                             + ",".join(PENALTY_CATEGORIES))
    parser.add_argument("--api-key", default=None,
                        help="nvapi-... NVIDIA API key "
                             "(else NVIDIA_API_KEY env var)")
    parser.add_argument("--model", default=None,
                        help=f"NVIDIA model id (default: {NVIDIA_DEFAULT_MODEL})")
    parser.add_argument("--backend", default=None,
                        choices=["nvidia"],
                        help="Force a backend (NVIDIA NIM only)")
    parser.add_argument("--mock", action="store_true",
                        help="Use the offline mock engine (text files only)")
    parser.add_argument("--quiet", action="store_true",
                        help="Only print the final summary")
    return parser.parse_args(argv)


def build_params(args: argparse.Namespace) -> GradeParams:
    requested = [p.strip().lower() for p in args.penalties.split(",") if p.strip()]
    unknown = [p for p in requested if p not in PENALTY_CATEGORIES]
    if unknown:
        raise SystemExit(
            f"Unknown penalty criteria: {', '.join(unknown)}. "
            f"Valid: {', '.join(PENALTY_CATEGORIES)}"
        )
    return GradeParams(strict=args.strict, penalties=frozenset(requested),
                       model=args.model)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    params = build_params(args)

    def progress(message: str) -> None:
        if not args.quiet:
            print(f"  • {message}", flush=True)

    if not args.quiet:
        print("WeHelpTeachers - grading session")

    try:
        result = run_session(
            args.paper, args.key, args.student,
            api_key=args.api_key, model=args.model, mock=args.mock,
            backend=args.backend, params=params, progress=progress,
        )
    except SessionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 3
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    paths = write_reports(result, args.out)
    summary = result.summary

    print()
    print(f"  Total marks : {summary['total_marks']:g}")
    print(f"  Awarded     : {summary['marks_awarded']:g} "
          f"({summary['percentage']:g}%)")
    print(f"  Deducted    : {summary['marks_deducted']:g}")
    for r in result.records:
        print(f"    Q{r['number']}: {r['marks_awarded']:g}/{r['max_marks']:g}"
              f"  {r['feedback'][:70]}")
    print()
    print(f"  JSON report     : {paths['json']}")
    print(f"  Markdown report : {paths['markdown']}")
    if result.warnings:
        print(f"  Warnings        : {len(result.warnings)} "
              "(see report header)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
