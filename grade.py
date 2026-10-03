"""Grading logic for WeHelpTeachers.

Compares each aligned ``Student Answer`` against the ``Answer Key`` using
the context and point values from the ``Question Paper``:

* rubric-aware partial credit (step marks from the marking scheme),
* strict-mode behaviour (no partial credit for incomplete answers),
* OCR/handwriting tolerance - recognition noise must never cost marks,
* optional penalty criteria (handwriting / diagrams / unreadable /
  formatting) that are only applied when the teacher enabled them.

The model returns a JSON array; ``normalise_records`` then enforces the
schema, clamps marks into range, drops forbidden deduction categories and
reconciles marks_awarded with the deduction list so reports are always
internally consistent.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from engine import PENALTY_CATEGORIES
from extract import AlignedQuestion

# Categories the model may always use.
CONTENT_CATEGORY = "content"
# Categories that exist in the data model but may never deduct marks: OCR
# noise is an extraction artefact, never the student's fault.
FORBIDDEN_CATEGORIES = {"ocr", "ocr_noise", "recognition", "extraction"}


class GradingError(ValueError):
    """Raised when grading output cannot be salvaged."""


@dataclass(frozen=True)
class GradeParams:
    strict: bool = False
    penalties: frozenset = frozenset()
    model: str | None = None
    keyword_mode: bool = False

    @property
    def penalty_list(self) -> list[str]:
        return sorted(p for p in self.penalties if p in PENALTY_CATEGORIES)


PROMPT_TEMPLATE = """\
GRADING TASK: mark one student's exam against the official answer key.

You are an experienced, fair examiner. You receive:

- STRICT MODE: {strict}
- PENALTY CRITERIA ENABLED BY THE TEACHER: {penalties}
- QUESTIONS: numbered items carrying the question text, its max marks, the
  official expected answer, the rubric's step-by-step marking scheme, and
  the transcribed student answer (plus legibility / uncertain_spans from
  OCR).

For EVERY question produce one JSON object with exactly these fields:
  number           - question number as given in the input
  student_answer   - the student's answer (lightly cleaned of transcription
                     artefacts only; do not rewrite their reasoning)
  expected_answer  - the official answer (abridged if very long)
  max_marks        - maximum marks for the question
  marks_awarded    - marks the student earns, 0 <= awarded <= max_marks
  deductions       - [{{category, marks, reason}}]; must sum to
                     (max_marks - marks_awarded)
  feedback         - full sentence explanation of where and why marks were
                     cut (or why full marks were given)
  ocr_note         - note any suspected transcription/handwriting-recognition
                     errors affecting this answer ("" if none)

MARKING RULES:
1. Partial credit: award the rubric's step marks for each correct step even
   when the final answer is wrong; award method marks when the method is
   right and the arithmetic slips.
2. OCR/HANDWRITING TOLERANCE (critical): minor recognition errors - 0/O,
   1/l/I confusion, dropped decimal points that the scan smeared, spacing,
   missing diacritics, bracketed [guesses] - must NOT lose content marks
   when the student's intent is clear. Only deduct for content the student
   genuinely got wrong. Put recognition concerns in "ocr_note", never in
   deductions.
3. Penalties: you may use deduction categories ONLY from:
   - "content" (always allowed), and
   - the enabled criteria listed above
     ({penalty_map}).
   Never apply a disabled criterion. Keep penalties proportional: about
   0.5-1.0 marks, only where the flaw actually hurts the answer, and never
   repeat the same penalty twice for one cause on the same question.
4. Strict mode is {strict}: when enabled, withhold partial credit for
   incomplete answers and require the rubric's exact expectations; when
   disabled, be generous with partial credit.
5. Questions with no student answer: 0 marks, category "content".
6. max_marks unknown (0/null): grade with 0 max and explain in feedback.
7. NEVER INVENT INPUTS (critical): grade ONLY the expected_answer and
   student_answer given above. Never replace them with your own knowledge
   of the topic, and never mark what the student "probably meant" beyond
   what is written. If the expected answer is empty, award 0 under
   "content" and say so. Every deduction must quote or directly reference
   the provided texts.

Return ONLY a JSON array of question objects (no prose, no fences).
"""



KEYWORD_GRADING_PROMPT = """\
GRADING TASK: mark one student's exam by keyword coverage.

You are an experienced, fair examiner.  For each question the expected
answer and a set of required keywords/concepts are provided (derived from
web search).  Mark the student's answer by checking how many of these
keywords appear in their response.

For EVERY question produce a JSON object with exactly these fields:
  number           - question number as given in the input
  student_answer   - the student's answer (lightly cleaned of transcription
                     artefacts only; do not rewrite their reasoning)
  expected_answer  - the model/expected answer (abridged if very long)
  max_marks        - maximum marks for the question
  marks_awarded    - marks the student earns, 0 <= awarded <= max_marks
  deductions       - [{{category, marks, reason}}]; must sum to
                     (max_marks - marks_awarded)
  feedback         - full sentence explanation of where and why marks were
                     cut (or why full marks were given)
  ocr_note         - note any suspected transcription/handwriting-recognition
                     errors affecting this answer ("" if none)

MARKING RULES:
1. Count how many of the provided keywords appear in the student's answer
   (case-insensitive, partial word matches count).
2. coverage = matched_keywords / total_keywords.
3. Award marks = coverage * max_marks, rounded to the nearest half-mark.
4. Missing keywords are deducted under the "content" category with a
   reason listing which keywords were missing.
5. OCR/HANDWRITING TOLERANCE: recognition errors must not lose content
   marks when the student's intent is clear.  Put concerns in "ocr_note".
6. Penalties only from enabled criteria ({penalty_map}).
7. No answer: 0 marks, category "content".
8. Strict mode is {strict}: when enabled, round down (floor) to half-marks;
   when disabled, round to the nearest half-mark.

Return ONLY a JSON array of question objects (no prose, no fences).
"""


def build_prompt(params: GradeParams) -> str:
    penalties = params.penalty_list
    if params.keyword_mode:
        return KEYWORD_GRADING_PROMPT.format(
            strict="ON" if params.strict else "OFF",
            penalty_map=", ".join(f'"{p}" = {PENALTY_CATEGORIES[p]}'
                                  for p in PENALTY_CATEGORIES),
        )
    return PROMPT_TEMPLATE.format(
        strict="ON" if params.strict else "OFF",
        penalties=(", " + ", ".join(PENALTY_CATEGORIES[p] for p in penalties))
        if penalties else "none (content deductions only)",
        penalty_map=", ".join(f'"{p}" = {PENALTY_CATEGORIES[p]}'
                              for p in PENALTY_CATEGORIES),
    )


def grade_answers(engine, aligned: list[AlignedQuestion],
                  params: GradeParams | None = None) -> list[dict]:
    """Grade every aligned question in one engine call."""
    params = params or GradeParams()
    payload = {
        "strict": params.strict,
        "keyword_mode": params.keyword_mode,
        "penalty_criteria": params.penalty_list,
        "questions": [q.to_payload() for q in aligned],
    }
    raw = engine.generate_json("grade", data=payload,
                               instruction=build_prompt(params),
                               temperature=0.1)

    if isinstance(raw, dict):
        raw = raw.get("questions") or raw.get("results") or raw.get("grades")
    if not isinstance(raw, list) or not raw:
        raise GradingError("Grading engine returned no question records.")

    by_number: dict[str, dict] = {}
    for item in raw:
        if isinstance(item, dict) and item.get("number") is not None:
            by_number[str(item["number"]).strip()] = item

    aligned_by_number = {q.number: q for q in aligned}
    records: list[dict] = []
    for q in aligned:
        item = by_number.get(q.number)
        if item is None:
            # Fall back to fuzzy match (model may re-format numbers).
            item = next(
                (v for k, v in by_number.items()
                 if _loose(k) == _loose(q.number)),
                None,
            )
        records.append(normalise_record(item, q, params))
    return records


_ALIGNED_FIELDS = ("number", "question", "max_marks", "expected_answer",
                   "marking_scheme", "student_answer", "legibility",
                   "uncertain_spans", "keywords", "page", "warnings")


def grade_one_record(engine, aligned: dict,
                     params: GradeParams | None = None) -> dict:
    """Grade a single aligned question (split-pipeline server endpoint).

    ``aligned`` is one :meth:`AlignedQuestion.to_payload` dict, as returned
    by ``/api/align``. Reuses :func:`grade_answers` so single-question and
    full-batch grading stay identical.
    """
    params = params or GradeParams()
    question = {k: aligned.get(k) for k in _ALIGNED_FIELDS if k in aligned}
    question["number"] = str(question.get("number") or "?")
    if not isinstance(question.get("marking_scheme"), list):
        question["marking_scheme"] = []
    if not isinstance(question.get("uncertain_spans"), list):
        question["uncertain_spans"] = []
    if not isinstance(question.get("keywords"), list):
        question["keywords"] = []
    if not isinstance(question.get("warnings"), list):
        question["warnings"] = []
    return grade_answers(engine, [AlignedQuestion(**question)], params)[0]


def normalise_record(item: dict | None, q: AlignedQuestion,
                     params: GradeParams) -> dict:
    """Enforce the report schema on one grading record."""
    item = item or {}
    max_marks = float(q.max_marks or 0.0)

    allowed = {CONTENT_CATEGORY, *params.penalty_list}
    deductions: list[dict] = []
    for d in (item.get("deductions") or []):
        if not isinstance(d, dict):
            continue
        category = str(d.get("category", CONTENT_CATEGORY) or "").lower().strip()
        marks = _as_float(d.get("marks"))
        reason = str(d.get("reason", "")).strip()
        if marks is None or marks <= 0:
            continue
        if category in FORBIDDEN_CATEGORIES:
            # OCR noise must never deduct - fold it into the ocr note.
            continue
        if category not in allowed:
            category = CONTENT_CATEGORY
            reason = (f"{reason} (categorised as content: criterion not "
                      f"enabled)" if reason else
                      "categorised as content: criterion not enabled")
        deductions.append({"category": category,
                           "marks": round(marks, 2),
                           "reason": reason or "marks deducted"})

    total_deducted = round(sum(d["marks"] for d in deductions), 2)
    awarded = _as_float(item.get("marks_awarded"))

    if max_marks <= 0:
        # Unknown maximum: keep the model's number but expose the problem.
        awarded = max(0.0, awarded or 0.0)
    else:
        if awarded is None or total_deducted != round(
                max_marks - awarded, 2):
            # Prefer the deduction list as source of truth, then re-derive.
            if not deductions and awarded is not None:
                cut = round(max_marks - min(max(0.0, awarded), max_marks), 2)
                if cut > 0:
                    deductions.append({
                        "category": CONTENT_CATEGORY,
                        "marks": cut,
                        "reason": str(item.get("feedback", "")).strip()
                        or "marks deducted for incorrect/incomplete answer",
                    })
                total_deducted = round(sum(d["marks"] for d in deductions), 2)
            awarded = round(max(0.0, min(max_marks,
                                         max_marks - total_deducted)), 2)
        else:
            awarded = round(min(max(0.0, awarded), max_marks), 2)
        # Re-clamp deductions that together exceed the question's marks.
        if total_deducted > max_marks:
            scale = max_marks / total_deducted
            for d in deductions:
                d["marks"] = round(d["marks"] * scale, 2)
            total_deducted = round(sum(d["marks"] for d in deductions), 2)
            awarded = round(max(0.0, max_marks - total_deducted), 2)

    # Keyword-mode override: recompute marks from keyword coverage
    if params.keyword_mode and max_marks > 0:
        keywords = q.keywords or []
        answer = q.student_answer or ""
        answer_lower = answer.lower()
        matched = [kw for kw in keywords if kw.lower() in answer_lower]
        total = len(keywords) if keywords else 1
        coverage = len(matched) / total if total else 0.0
        raw = coverage * max_marks
        step = 0.5
        content_awarded = (math.floor(raw / step) * step if params.strict
                           else round(raw / step) * step)
        content_awarded = max(0.0, min(max_marks, content_awarded))
        # Keep penalty deductions, replace content deductions
        penalty_deductions = [
            d for d in deductions if d["category"] != CONTENT_CATEGORY
        ]
        content_deduct = round(max_marks - content_awarded, 2)
        new_deductions: list[dict] = []
        if content_deduct > 0:
            missing = [kw for kw in keywords
                       if kw.lower() not in answer_lower]
            if missing:
                reason = f"Missing keywords: {', '.join(missing)}"
            else:
                reason = (f"keyword coverage {len(matched)}/{total} "
                          "below full marks")
            new_deductions.append({
                "category": CONTENT_CATEGORY,
                "marks": content_deduct,
                "reason": reason,
            })
        new_deductions.extend(penalty_deductions)
        td = round(sum(d["marks"] for d in new_deductions), 2)
        if td > max_marks:
            scale = max_marks / td if td else 1.0
            for d in new_deductions:
                d["marks"] = round(d["marks"] * scale, 2)
            td = round(sum(d["marks"] for d in new_deductions), 2)
        deductions = new_deductions
        total_deducted = td
        awarded = round(max(0.0, min(max_marks,
                                     max_marks - total_deducted)), 2)

    feedback = str(item.get("feedback", "") or "").strip()
    if not feedback:
        feedback = ("No feedback returned by the grader; see deduction list."
                    if deductions else "Fully correct.")

    ocr_note = str(item.get("ocr_note", "") or "").strip()
    dropped = [d for d in item.get("deductions", [])
               if isinstance(d, dict)
               and str(d.get("category", "")).lower() in FORBIDDEN_CATEGORIES]
    if dropped and not ocr_note:
        ocr_note = "Recognition note: possible OCR/handwriting noise ignored."

    student_answer = str(item.get("student_answer") or "").strip() \
        or q.student_answer or "(no answer transcribed)"
    expected_answer = str(item.get("expected_answer") or "").strip() \
        or q.expected_answer or "(not found in answer key)"

    return {
        "number": q.number,
        "question": q.question,
        "student_answer": student_answer,
        "expected_answer": expected_answer,
        "max_marks": max_marks,
        "marks_awarded": awarded,
        "marks_deducted": max(0.0, round(max_marks - awarded, 2)),
        "deductions": deductions,
        "feedback": feedback,
        "ocr_note": ocr_note,
        "legibility": q.legibility,
        "page": q.page,
        "warnings": list(q.warnings),
    }


def summarise(records: list[dict]) -> dict:
    """Aggregate totals used by both report formats."""
    total = round(sum(r["max_marks"] for r in records), 2)
    awarded = round(sum(r["marks_awarded"] for r in records), 2)
    by_category: dict[str, float] = {}
    for r in records:
        for d in r["deductions"]:
            by_category[d["category"]] = round(
                by_category.get(d["category"], 0.0) + d["marks"], 2)
    return {
        "questions_graded": len(records),
        "total_marks": total,
        "marks_awarded": awarded,
        "marks_deducted": round(total - awarded, 2),
        "percentage": round(100.0 * awarded / total, 1) if total else 0.0,
        "deductions_by_category": by_category,
        "questions_without_answer": sum(
            1 for r in records
            if r["student_answer"] in ("(no answer transcribed)", "")),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().rstrip("*"))
        except ValueError:
            return None
    return None


def _loose(number: str) -> str:
    return "".join(ch for ch in str(number).lower() if ch.isalnum())
