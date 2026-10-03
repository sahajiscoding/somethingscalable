"""Report writers for WeHelpTeachers (JSON + Markdown).

``build_report`` assembles the canonical document; ``write_json`` /
``render_markdown`` / ``write_markdown`` serialise it.  Both formats carry
per question: number, extracted student answer, expected answer,
marks awarded / max marks, deductions and feedback/reasoning.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REPORT_VERSION = 1


def build_report(records: list[dict], summary: dict, *,
                 engine_name: str, model: str, params, documents: dict,
                 warnings: list[str] | None = None) -> dict:
    """Assemble the canonical report document."""
    return {
        "report_version": REPORT_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "engine": engine_name,
        "model": model,
        "mode": {
            "strict": bool(params.strict),
            "penalty_criteria": list(params.penalty_list),
        },
        "documents": {
            role: {"file": doc.filename, "kind": doc.kind,
                   "pages": doc.page_count}
            for role, doc in documents.items()
        },
        "summary": summary,
        "warnings": list(warnings or []),
        "questions": records,
    }


def write_json(report: dict, path: str | Path) -> Path:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    return out


def render_markdown(report: dict) -> str:
    summary = report["summary"]
    mode = report["mode"]
    lines: list[str] = []
    add = lines.append

    add("# WeHelpTeachers - Grading Report")
    add("")
    add(f"- **Generated:** {report['generated_at']}")
    add(f"- **Engine:** {report['engine']} (`{report['model']}`)")
    add(f"- **Mode:** {'STRICT' if mode['strict'] else 'Standard'} checking")
    crit = ", ".join(mode["penalty_criteria"]) or "none"
    add(f"- **Penalty criteria:** {crit}")
    docs = ", ".join(
        f"{role}: `{d['file']}` ({d['pages']} page(s))"
        for role, d in report["documents"].items())
    add(f"- **Documents:** {docs}")
    add("")

    add("## Summary")
    add("")
    add("| Total Marks | Marks Awarded | Marks Deducted | Percentage | Questions |")
    add("|---:|---:|---:|---:|---:|")
    add(f"| {summary['total_marks']:g} | {summary['marks_awarded']:g} | "
        f"{summary['marks_deducted']:g} | {summary['percentage']:g}% | "
        f"{summary['questions_graded']} |")
    add("")
    by_cat = summary.get("deductions_by_category") or {}
    if by_cat:
        add("**Deductions by category**")
        add("")
        for category, marks in sorted(by_cat.items(),
                                      key=lambda kv: -kv[1]):
            add(f"- `{category}`: -{marks:g}")
        add("")
    if summary.get("questions_without_answer"):
        add(f"**{summary['questions_without_answer']} question(s) had no "
            "transcribed student answer.**")
        add("")

    for w in report.get("warnings", []):
        add(f"> Warning: {w}")
    if report.get("warnings"):
        add("")

    add("## Question-by-question breakdown")
    add("")
    add("| # | Question | Student Answer | Expected Answer | Awarded / Max | Deducted |")
    add("|---|---|---|---|---:|---:|")
    for r in report["questions"]:
        add("| {num} | {q} | {s} | {e} | **{a:g} / {m:g}** | -{d:g} |".format(
            num=_cell(r["number"]),
            q=_cell(_clip(r.get("question", ""), 90)),
            s=_cell(_clip(r["student_answer"], 110)),
            e=_cell(_clip(r["expected_answer"], 110)),
            a=r["marks_awarded"],
            m=r["max_marks"],
            d=r["marks_deducted"],
        ))
    add("")

    add("## Detailed feedback")
    add("")
    for r in report["questions"]:
        add(f"### Q{r['number']} - {r['marks_awarded']:g} / {r['max_marks']:g} marks")
        add("")
        add(f"- **Extracted student answer:** {r['student_answer']}")
        add(f"- **Expected answer:** {r['expected_answer']}")
        if r["deductions"]:
            add("- **Deductions:**")
            for d in r["deductions"]:
                add(f"  - -{d['marks']:g} `{d['category']}` - {d['reason']}")
        else:
            add("- **Deductions:** none")
        add(f"- **Feedback / reasoning:** {r['feedback']}")
        if r.get("ocr_note"):
            add(f"- **OCR note:** {r['ocr_note']}")
        if r.get("legibility") and r["legibility"] != "unknown":
            add(f"- **Handwriting legibility:** {r['legibility']}")
        for w in r.get("warnings", []):
            add(f"- **Warning:** {w}")
        add("")

    return "\n".join(lines).rstrip() + "\n"


def write_markdown(report: dict, path: str | Path) -> Path:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(report), encoding="utf-8")
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clip(text: str, limit: int) -> str:
    text = (text or "").replace("\n", " ").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _cell(text: str) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ").strip() or "—"
