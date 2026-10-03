#!/usr/bin/env python3
"""Real-world end-to-end test runner for Exam Checker.

Discovers grading sessions (question paper + answer key + student sheet)
under ``sample_test_data/``, runs the full pipeline on each one, writes
``output/report.json`` and ``output/report.md``, then validates both.

    python test_real_exam.py                 # every case (needs API key)
    python test_real_exam.py --case 00_synthetic
    python test_real_exam.py --mock          # offline, text documents only

Exit code 0 = all cases passed, 1 = at least one failure, 2 = setup error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from grade import GradeParams
from pipeline import SessionError, run_session, write_reports

DATA_DIR = Path(__file__).resolve().parent / "sample_test_data"

# Role detection is priority-ordered: "answer_key.pdf" must resolve to the
# key, not to the student sheet (both contain the word "answer").
ROLE_PATTERNS = {
    "key": ("key", "rubric", "official"),
    "student": ("student", "sheet", "script", "answer"),
    "paper": ("paper", "question", "exam"),
}
ROLE_LABELS = {
    "paper": "Question paper",
    "key": "Answer key / rubric",
    "student": "Student answer sheet",
}
SUPPORTED = {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif",
             ".tiff", ".txt", ".md", ".markdown", ".csv", ".text", ".rtf"}
IGNORED_DIRS = {"output", "__pycache__"}

REQUIRED_QUESTION_FIELDS = (
    "number", "student_answer", "expected_answer", "max_marks",
    "marks_awarded", "feedback", "deductions",
)
MARKDOWN_SECTIONS = (
    "# Exam Checker - Grading Report",
    "## Summary",
    "## Question-by-question breakdown",
    "## Detailed feedback",
    "| # | Question | Student Answer | Expected Answer | Awarded / Max |",
    "Feedback / reasoning",
)


class CaseError(Exception):
    """A test case could not be set up or produced an invalid report."""


# ---------------------------------------------------------------------------
# Case discovery
# ---------------------------------------------------------------------------

def discover_cases(data_dir: Path) -> list[Path]:
    if not data_dir.is_dir():
        raise CaseError(f"data directory not found: {data_dir}")
    cases = []
    for child in sorted(data_dir.iterdir()):
        if not child.is_dir() or child.name in IGNORED_DIRS:
            continue
        if resolve_documents(child)[0] or _candidate_files(child):
            cases.append(child)
    return cases


def _candidate_files(case_dir: Path) -> list[Path]:
    return [p for p in sorted(case_dir.iterdir())
            if p.is_file() and p.suffix.lower() in SUPPORTED]


def resolve_documents(case_dir: Path) -> tuple[dict[str, Path], list[str]]:
    """Map the three roles to files in a case folder.

    Returns (documents, problems). Missing roles are reported as problems.
    """
    files = _candidate_files(case_dir)
    docs: dict[str, Path] = {}
    used: set[Path] = set()
    notes: list[str] = []

    for role, patterns in ROLE_PATTERNS.items():
        for f in files:
            if f in used:
                continue
            name = f.name.lower()
            if any(p in name for p in patterns):
                docs[role] = f
                used.add(f)
                break

    # Forgiving fallback: exactly three files, exactly one role unfilled.
    if len(files) == 3 and len(docs) == 2:
        missing_role = next(r for r in ROLE_PATTERNS if r not in docs)
        leftover = next(f for f in files if f not in used)
        docs[missing_role] = leftover
        notes.append(f"assigned '{leftover.name}' -> {ROLE_LABELS[missing_role]} "
                     "by elimination")

    problems = [
        f"missing {ROLE_LABELS[role]} (file name must contain "
        f"{'/'.join(ROLE_PATTERNS[role])})"
        for role in ROLE_PATTERNS if role not in docs
    ]
    return docs, problems


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate(case_dir: Path, report_path: Path, md_path: Path) -> list[str]:
    errors: list[str] = []

    if not report_path.is_file():
        return [f"report.json was not written to {report_path}"]
    if not md_path.is_file():
        return [f"report.md was not written to {md_path}"]

    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"report.json is not valid JSON: {exc}"]

    for key in ("generated_at", "engine", "model", "mode", "documents",
                "summary", "questions"):
        if key not in report:
            errors.append(f"report.json missing top-level key '{key}'")

    docs = report.get("documents") or {}
    for role in ROLE_PATTERNS:
        if role not in docs:
            errors.append(f"report.json missing document entry '{role}'")

    questions = report.get("questions") or []
    if not questions:
        errors.append("report.json contains no graded questions")
        return errors

    total_sum = 0.0
    awarded_sum = 0.0
    for q in questions:
        label = f"Q{q.get('number', '?')}"
        for field in REQUIRED_QUESTION_FIELDS:
            if field not in q:
                errors.append(f"{label}: missing field '{field}'")
        if "feedback" in q and not str(q["feedback"]).strip():
            errors.append(f"{label}: feedback/reasoning is empty")

        max_marks = q.get("max_marks")
        awarded = q.get("marks_awarded")
        if not isinstance(max_marks, (int, float)) or max_marks < 0:
            errors.append(f"{label}: max_marks must be a non-negative number")
            continue
        if not isinstance(awarded, (int, float)):
            errors.append(f"{label}: marks_awarded must be a number")
            continue
        if -0.01 <= awarded <= max_marks + 0.01:
            awarded_sum += awarded
            total_sum += max_marks
        else:
            errors.append(
                f"{label}: marks_awarded {awarded} outside 0..{max_marks}")

        deductions = q.get("deductions")
        if not isinstance(deductions, list):
            errors.append(f"{label}: deductions must be a list")
        else:
            cut = sum(d.get("marks", 0) for d in deductions
                      if isinstance(d, dict))
            expected_cut = max(0.0, round(max_marks - awarded, 2))
            if abs(cut - expected_cut) > 0.01:
                errors.append(
                    f"{label}: deductions sum {cut:.2f} != "
                    f"max-awarded {expected_cut:.2f}")

    summary = report.get("summary") or {}
    if abs(summary.get("total_marks", -1) - total_sum) > 0.01:
        errors.append("summary.total_marks does not match question totals")
    if abs(summary.get("marks_awarded", -1) - awarded_sum) > 0.01:
        errors.append("summary.marks_awarded does not match question totals")

    md = md_path.read_text(encoding="utf-8")
    for section in MARKDOWN_SECTIONS:
        if section not in md:
            errors.append(f"report.md missing section/column: {section}")
    for q in questions:
        if f"### Q{q.get('number', '?')} " not in md:
            errors.append(
                f"report.md has no detail section for Q{q.get('number', '?')}")

    return errors


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_case(case_dir: Path, args: argparse.Namespace) -> dict:
    result: dict = {"case": case_dir.name, "status": "FAIL", "errors": [],
                    "notes": []}

    docs, problems = resolve_documents(case_dir)
    if len(docs) < 3:
        result["errors"] = problems or ["could not resolve three documents"]
        return result
    result["notes"].extend(problems)
    result["documents"] = {role: p.name for role, p in docs.items()}

    params = GradeParams(
        strict=args.strict,
        penalties=frozenset(p for p in args.penalties.split(",") if p),
    )

    def progress(message: str) -> None:
        if args.verbose:
            print(f"      · {message}", flush=True)

    try:
        session = run_session(
            docs["paper"], docs["key"], docs["student"],
            api_key=args.api_key, model=args.model, mock=args.mock,
            params=params, progress=progress,
        )
    except SessionError as exc:
        result["errors"].append(f"pipeline error: {exc}")
        return result

    out_dir = case_dir / "output"
    paths = write_reports(session, out_dir)

    result["errors"] = validate(case_dir, paths["json"], paths["markdown"])
    result["output"] = {"json": str(paths["json"]),
                        "markdown": str(paths["markdown"])}
    result["summary"] = session.summary
    result["engine"] = session.report["engine"]
    result["records"] = [
        {"number": r["number"], "awarded": r["marks_awarded"],
         "max": r["max_marks"]} for r in session.records]

    if not result["errors"]:
        result["status"] = "PASS"
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run end-to-end grading tests against sample_test_data.")
    parser.add_argument("--data-dir", default=str(DATA_DIR),
                        help="Directory containing one folder per test case")
    parser.add_argument("--case", default=None,
                        help="Run only this case (folder name)")
    parser.add_argument("--mock", action="store_true",
                        help="Offline mock engine (text documents only)")
    parser.add_argument("--strict", action="store_true",
                        help="Grade in strict checking mode")
    parser.add_argument("--penalties", default="handwriting,formatting",
                        help="Comma-separated penalty criteria to enable "
                             "(empty for none)")
    parser.add_argument("--api-key", default=None,
                        help="API key: Gemini key, or nvapi-... NVIDIA key")
    parser.add_argument("--model", default=None,
                        help="Model id (backend default if omitted)")
    parser.add_argument("--verbose", action="store_true",
                        help="Print pipeline progress")
    args = parser.parse_args(argv)

    if not args.mock and not (args.api_key
                              or os.environ.get("GEMINI_API_KEY")
                              or os.environ.get("GOOGLE_API_KEY")
                              or os.environ.get("NVIDIA_API_KEY")):
        print("ERROR: no API key set.\n"
              "  • export GEMINI_API_KEY=... (or NVIDIA_API_KEY=...)  to run real OCR + grading, or\n"
              "  • re-run with --mock         for an offline text-only run.",
              file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir)
    try:
        cases = discover_cases(data_dir)
    except CaseError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.case:
        cases = [c for c in cases if c.name == args.case]
        if not cases:
            print(f"ERROR: no case named '{args.case}' in {data_dir}",
                  file=sys.stderr)
            return 2

    print(f"Exam Checker - real exam test runner")
    print(f"  data dir : {data_dir}")
    print(f"  engine   : {'mock (offline)' if args.mock else 'gemini'}")
    print(f"  cases    : {len(cases)}\n")

    results = []
    for case_dir in cases:
        docs, missing = resolve_documents(case_dir)
        if len(docs) == 0 and missing:
            print(f"  SKIP  {case_dir.name} - no documents yet "
                  "(drop your files here)")
            continue
        print(f"  RUN   {case_dir.name} ...", flush=True)
        res = run_case(case_dir, args)
        results.append(res)

        if res["status"] == "PASS":
            s = res.get("summary", {})
            print(f"  PASS  {res['case']} - "
                  f"{s.get('marks_awarded', '?')}/{s.get('total_marks', '?')} "
                  f"marks, {s.get('questions_graded', '?')} questions "
                  f"[{res.get('engine')}]")
            for r in res.get("records", []):
                print(f"          Q{r['number']}: {r['awarded']:g}/{r['max']:g}")
            print(f"          -> {res['output']['markdown']}")
        else:
            print(f"  FAIL  {res['case']}")
            for err in res["errors"]:
                print(f"          - {err}")
        for note in res.get("notes", []):
            print(f"          note: {note}")
        print()

    if not results:
        print("No runnable cases found. Drop a question paper, answer key "
              "and student sheet into a folder under "
              f"{data_dir} and re-run.")
        return 2

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = len(results) - passed
    print("=" * 60)
    print(f"  {passed} passed, {failed} failed, {len(cases) - len(results)} "
          "skipped")
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
