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

import base64
import math
import re
from dataclasses import dataclass
from types import SimpleNamespace
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
    # Marking mode for wrong answers:
    #   "standard"     – default; deduct from max_marks as usual
    #   "negative"     – additionally subtract `negative_marks_value` per wrong answer
    #   "non_negative" – wrong answers score 0 (no marks deducted from total)
    marking_mode: str = "standard"
    negative_marks_value: float = 0.0

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

For EVERY question produce one JSON object with these fields:
  number           - question number as given in the input
  max_marks        - maximum marks for the question
  marks_awarded    - marks the student earns, 0 <= awarded <= max_marks
  deductions       - [{{category, marks, reason}}]; must sum to
                     (max_marks - marks_awarded)
  feedback         - concise 1-2 sentence explanation of where and why marks
                     were cut (or why full marks were given)
  ocr_note         - note any suspected transcription/handwriting-recognition
                     errors affecting this answer ("" if none)
  steps            - array of step-by-step evaluation objects breaking down
                     the student's working:
                     [{{
                       "title": "Step 1: Substitute x=2",
                       "status": "correct" | "error",
                       "lines": [{{
                         "crop_id": "p1c2",
                         "text": "p(2) = 2^2 - 4",
                         "ok": true,
                         "error_tag": ""
                       }}],
                       "explanation": ""
                     }}]
                     Use error_tag (e.g. "Concept Error", "Calculation Error",
                     "Result Error", "Missing Root", "Sign Error",
                     "Incomplete Step") on the primary wrong line of an error
                     step, and provide a 1-sentence "explanation" for why that
                     step is wrong. Map "crop_id" from the question's geometry
                     list when available.
(Do NOT repeat student_answer or expected_answer in the output JSON.)

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
8. TWO-COLUMN & DIFFERENTIATION ANSWERS (critical): When a question asks to
   differentiate or compare two topics, OCR frequently flattens a student's
   two-column table so both column headings appear together at the start
   (e.g. "Topic A Topic B * point 1 ... * point 2 ..."). Recognise when the
   bullet points define or describe the two respective topics separately, do
   NOT claim the student confused the topics if each bullet point accurately
   states which topic it describes, and break each topic/point into its own
   distinct step in "steps".
9. MULTI-LINE & BULLETED ANSWERS (critical): Students frequently begin an
   answer with a short introductory heading line (e.g. "Ans. 6) Vegetative
   propagation is practiced as :") followed by bullet points ("*", "-", "•"),
   sub-parts, or concluding sentences on subsequent lines. Always evaluate ALL
   lines, bullet points, and paragraphs of "student_answer" together against
   the rubric, and include EVERY line/bullet of the student's response across
   your "steps" breakdown (never stop after the introductory heading line).

Return ONLY a JSON array of question objects (no prose, no fences).
"""

RECHECK_PROMPT_TEMPLATE = """\
TARGETED QUESTION RECHECK TASK: Re-evaluate a single exam question using the teacher's instructions.

You are an experienced, fair senior examiner performing a targeted recheck of ONE question.

- STRICT MODE: {strict}
- PENALTY CRITERIA ENABLED BY THE TEACHER: {penalties}
- VISUAL PAGE SCAN ATTACHED: {has_image}

TEACHER RECHECK INSTRUCTIONS (HIGHEST PRIORITY):
{teacher_directive}

CRITICAL RECHECK RULES:
1. FOLLOW THE TEACHER'S INSTRUCTIONS ABOVE: The teacher requested this recheck
   because the initial automated grading misunderstood the student's layout,
   two-column differentiation structure, handwriting, or valid method. Treat
   the teacher's explanation of how the student structured or wrote the answer
   as authoritative context.
2. TWO-COLUMN & DIFFERENTIATION ANSWERS: Students often write comparisons or
   differentiations in two side-by-side columns (e.g. Left column: Topic A,
   Right column: Topic B) which OCR may have flattened into a single paragraph
   starting with both headings (e.g. "Self Pollination Cross Pollination * ...").
   - Separate the points belonging to each topic logically.
   - Do NOT claim the student confused the two topics when each bullet point
     accurately defines and names its respective topic.
   - If a page scan image is attached, visually inspect the target question on
     the scan to verify the two-column/table layout, headings, and handwriting.
3. GRANULAR STEP-BY-STEP BREAKDOWN (required):
   - Always break "steps" into clear, distinct step objects for each logical
     part, topic column, or working stage of the student's answer (e.g.,
     "Step 1: Self-Pollination definition & points",
     "Step 2: Cross-Pollination definition & points",
     "Step 3: Genetic variation explanation") rather than lumping the entire
     response into a single step.
   - Mark each valid step with "status": "correct" and "ok": true on its lines.
   - Only mark a step "status": "error" if that specific step is genuinely
     wrong after accounting for the teacher's recheck instructions.
4. You may include an updated "student_answer" field (with newlines "\\n"
   separating distinct points or columns) if the original transcription
   flattened a two-column table or misread the scan.
5. Penalties: use deduction categories ONLY from "content" and enabled criteria
   ({penalty_map}). Ensure deductions sum to (max_marks - marks_awarded). If
   full marks are awarded, deductions MUST be [].

Return ONLY a JSON array containing the single rechecked question object (no prose, no fences).
"""



KEYWORD_GRADING_PROMPT = """\
GRADING TASK: mark one student's exam by keyword coverage.

You are an experienced, fair examiner.  For each question the expected
answer and a set of required keywords/concepts are provided (derived from
web search).  Mark the student's answer by checking how many of these
keywords appear in their response.

For EVERY question produce a JSON object with these fields:
  number           - question number as given in the input
  max_marks        - maximum marks for the question
  marks_awarded    - marks the student earns, 0 <= awarded <= max_marks
  deductions       - [{{category, marks, reason}}]; must sum to
                     (max_marks - marks_awarded)
  feedback         - concise 1-2 sentence explanation of where and why marks
                     were cut (or why full marks were given)
  ocr_note         - note any suspected transcription/handwriting-recognition
                     errors affecting this answer ("" if none)
(Do NOT repeat student_answer or expected_answer in the output JSON.)

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


def build_recheck_prompt(params: GradeParams, teacher_instruction: str = "",
                         has_image: bool = False) -> str:
    penalties = params.penalty_list
    inst = (teacher_instruction or "").strip()
    directive = (
        f'"{inst}"'
        if inst else
        "Carefully re-verify this question's layout, two-column/table structure, "
        "and step-by-step rubric alignment. Separate any merged points into clear "
        "steps and re-evaluate fairly."
    )
    return RECHECK_PROMPT_TEMPLATE.format(
        strict="ON" if params.strict else "OFF",
        penalties=(", " + ", ".join(PENALTY_CATEGORIES[p] for p in penalties))
        if penalties else "none (content deductions only)",
        penalty_map=", ".join(f'"{p}" = {PENALTY_CATEGORIES[p]}'
                              for p in PENALTY_CATEGORIES),
        has_image="YES (inspect the attached page image for this question)" if has_image else "NO",
        teacher_directive=directive,
    )


def _norm_compare(text: str) -> str:
    return "".join(ch for ch in (text or "").lower() if ch.isalnum())


def _symbolically_equivalent(student: str, expected: str) -> bool:
    """True only when SymPy proves the final answer matches the key.

    Conservative by construction: prose, units and unreadable placeholders do
    not parse, so they fall through to the model instead of being auto-marked.
    """
    if not student or not expected:
        return False
    try:
        from vision.arbiter import agreement, split_lines
    except Exception:  # sympy unavailable: keep the old behaviour
        return False

    lines = split_lines(student)
    candidates = ([lines[-1]] if lines else []) + [student]
    for candidate in candidates:
        try:
            if agreement(candidate, expected) == "same":
                return True
        except Exception:
            continue
    return False


def _try_fast_grade(q: AlignedQuestion, params: GradeParams) -> dict | None:
    """Fast deterministic grading for blank responses or exact Answer Key matches."""
    student = (q.student_answer or "").strip()
    expected = (q.expected_answer or "").strip()
    max_m = float(q.max_marks or 0.0)
    if not student:
        return normalise_record(
            {
                "number": q.number,
                "max_marks": max_m,
                "marks_awarded": 0.0,
                "deductions": (
                    [{"category": CONTENT_CATEGORY, "marks": max_m, "reason": "No student answer was provided."}]
                    if max_m > 0 else []
                ),
                "feedback": "No student answer was transcribed for this question.",
                "ocr_note": "",
            },
            q,
            params,
        )
    if not params.penalty_list and expected and max_m > 0:
        ns = _norm_compare(student)
        ne = _norm_compare(expected)
        if len(ne) >= 2 and (ns == ne or (len(ne) >= 25 and ne in ns)):
            return normalise_record(
                {
                    "number": q.number,
                    "max_marks": max_m,
                    "marks_awarded": max_m,
                    "deductions": [],
                    "feedback": "Full marks awarded: response matches the official answer key across all required points.",
                    "ocr_note": "",
                },
                q,
                params,
            )
        # Equivalent forms the string check cannot see: 1/2 vs 0.5, 2^3 vs 8.
        # Only safe when the key carries no step marks to bypass.
        if not q.marking_scheme and _symbolically_equivalent(student, expected):
            return normalise_record(
                {
                    "number": q.number,
                    "max_marks": max_m,
                    "marks_awarded": max_m,
                    "deductions": [],
                    "feedback": "Full marks awarded: the final answer is symbolically equivalent to the answer key.",
                    "ocr_note": "",
                },
                q,
                params,
            )
    return None


def grade_answers(engine, aligned: list[AlignedQuestion],
                  params: GradeParams | None = None) -> list[dict]:
    """Grade every aligned question in one engine call."""
    params = params or GradeParams()
    fast_by_idx: dict[int, dict] = {}
    pending: list[AlignedQuestion] = []
    for idx, q in enumerate(aligned):
        fast = _try_fast_grade(q, params)
        if fast is not None:
            fast_by_idx[idx] = fast
        else:
            pending.append(q)

    if not pending:
        return [fast_by_idx[i] for i in range(len(aligned))]

    payload = {
        "strict": params.strict,
        "keyword_mode": params.keyword_mode,
        "penalty_criteria": params.penalty_list,
        "questions": [q.to_payload() for q in pending],
    }
    # Scale the output budget with batch size: without repeating input answers,
    # each question needs ~350 tokens.
    max_tokens = min(650 * max(1, len(pending)), 6000)
    raw = engine.generate_json("grade", data=payload,
                               instruction=build_prompt(params),
                               temperature=0.1, max_tokens=max_tokens)

    if isinstance(raw, dict):
        raw = raw.get("questions") or raw.get("results") or raw.get("grades")
    if not isinstance(raw, list) or not raw:
        raise GradingError("Grading engine returned no question records.")

    by_number: dict[str, dict] = {}
    for item in raw:
        if isinstance(item, dict) and item.get("number") is not None:
            by_number[str(item["number"]).strip()] = item

    records: list[dict] = []
    for idx, q in enumerate(aligned):
        if idx in fast_by_idx:
            records.append(fast_by_idx[idx])
            continue
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
                   "uncertain_spans", "keywords", "page", "warnings",
                   "geometry")


def grade_batch(engine, aligned_list: list[AlignedQuestion],
                params: GradeParams | None = None) -> list[dict]:
    """Grade several aligned questions in ONE engine call.

    Batching amortises the per-request overhead (TLS + Vercel cold start +
    NVIDIA queueing) across questions: one 5-question call generating
    ~1500 tokens is far quicker than five separate calls, and far fewer
    concurrent requests means no 429s and no NVIDIA-side timeouts.
    Output shape and normalisation are identical to :func:`grade_answers`.
    """
    params = params or GradeParams()
    if not aligned_list:
        return []
    return grade_answers(engine, aligned_list, params)


def aligned_from_dict(aligned: dict) -> AlignedQuestion:
    """Coerce one ``/api/align`` payload dict into an :class:`AlignedQuestion`.

    Shared by :func:`grade_one_record` and the ``/api/grade-batch`` endpoint
    so single-question and batched grading stay identical.
    """
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
    return AlignedQuestion(**question)


def _page_image_to_doc(page_image: str | None, q_number: str):
    """Convert a data:image/...;base64,... URL into a duck-typed image document for Vision engines."""
    if not page_image or not isinstance(page_image, str):
        return None
    raw = page_image.strip()
    if not raw.startswith("data:image/") or ";base64," not in raw:
        return None
    try:
        header, b64_str = raw.split(";base64,", 1)
        mime = header.replace("data:", "", 1).strip() or "image/jpeg"
        img_bytes = base64.b64decode(b64_str)
        if not img_bytes:
            return None
        return SimpleNamespace(
            filename=f"student_q{q_number}_page.jpg",
            kind="image",
            pages=[SimpleNamespace(mime=mime, data=img_bytes)],
            page_count=1,
            warnings=[],
        )
    except Exception:
        return None


def recheck_one_record(
    engine,
    aligned: dict,
    params: GradeParams | None = None,
    *,
    teacher_instruction: str = "",
    previous_record: dict | None = None,
    page_image: str | None = None,
) -> dict:
    """Re-evaluate a single aligned question with custom teacher instructions and optional page scan."""
    params = params or GradeParams()
    q = aligned_from_dict(aligned)
    inst = (teacher_instruction or "").strip()

    payload: dict[str, Any] = {
        "strict": params.strict,
        "keyword_mode": params.keyword_mode,
        "penalty_criteria": params.penalty_list,
        "teacher_instruction": inst,
        "questions": [q.to_payload()],
    }
    if isinstance(previous_record, dict):
        payload["previous_evaluation"] = {
            "marks_awarded": previous_record.get("marks_awarded"),
            "max_marks": previous_record.get("max_marks"),
            "feedback": previous_record.get("feedback"),
            "deductions": previous_record.get("deductions"),
        }

    doc = None
    if getattr(engine, "name", "") != "mock":
        doc = _page_image_to_doc(page_image, q.number)

    raw = None
    if doc is not None:
        try:
            raw = engine.generate_json(
                "grade",
                document=doc,
                data=payload,
                instruction=build_recheck_prompt(params, inst, has_image=True),
                temperature=0.1,
                max_tokens=1500,
            )
        except Exception:
            raw = None

    if raw is None:
        raw = engine.generate_json(
            "grade",
            data=payload,
            instruction=build_recheck_prompt(params, inst, has_image=False),
            temperature=0.1,
            max_tokens=1500,
        )

    item: dict | None = None
    if isinstance(raw, dict):
        inner = raw.get("questions") or raw.get("results") or raw.get("grades") or raw.get("record")
        if isinstance(inner, list) and inner and isinstance(inner[0], dict):
            item = inner[0]
        elif isinstance(inner, dict):
            item = inner
        elif any(k in raw for k in ("marks_awarded", "steps", "feedback", "deductions", "number")):
            item = raw
    elif isinstance(raw, list) and raw and isinstance(raw[0], dict):
        item = raw[0]

    if item is None:
        raise GradingError("Recheck engine returned no valid question record.")

    return normalise_record(item, q, params)


def grade_one_record(engine, aligned: dict,
                     params: GradeParams | None = None) -> dict:
    """Grade a single aligned question (split-pipeline server endpoint).

    ``aligned`` is one :meth:`AlignedQuestion.to_payload` dict, as returned
    by ``/api/align``. Reuses :func:`grade_answers` so single-question and
    full-batch grading stay identical.
    """
    params = params or GradeParams()
    return grade_answers(engine, [aligned_from_dict(aligned)], params)[0]


def grade_batch_records(engine, aligned_list: list[dict],
                        params: GradeParams | None = None) -> list[dict]:
    """Grade a batch of aligned questions in a single LLM call.

    ``aligned_list`` is a list of :meth:`AlignedQuestion.to_payload` dicts,
    as returned by ``/api/align``. Thin wrapper over :func:`grade_batch`
    so the endpoint accepts raw payloads while sharing one code path.
    """
    params = params or GradeParams()
    questions = [aligned_from_dict(a) for a in aligned_list
                 if isinstance(a, dict)]
    if not questions:
        return []
    return grade_batch(engine, questions, params)


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

    marks_deducted = max(0.0, round(max_marks - awarded, 2))

    # --- Marking-mode adjustments ---
    # "non_negative": wrong answers score 0 (no penalty beyond losing the
    #   question's own marks — the total never goes below zero).
    # "negative": wrong answers lose an additional `negative_marks_value`
    #   (marks_awarded can go below 0 for this question, which the summary
    #   will reflect in the total).
    if params.marking_mode == "non_negative" and marks_deducted > 0:
        # Already 0 if fully wrong; nothing extra to deduct.
        awarded = max(0.0, awarded)
        marks_deducted = max(0.0, round(max_marks - awarded, 2))
    elif params.marking_mode == "negative" and marks_deducted > 0:
        penalty = round(params.negative_marks_value, 2)
        if penalty > 0:
            awarded = round(awarded - penalty, 2)
            marks_deducted = round(max_marks - awarded, 2)
            deductions.append({
                "category": "negative_marking",
                "marks": penalty,
                "reason": f"Negative marking penalty: −{penalty} for incorrect answer",
            })
            feedback = (f"{feedback}  [Negative marking: −{penalty} applied]"
                        if feedback else
                        f"Negative marking: −{penalty} applied for incorrect answer.")

    geometry = [dict(g) for g in (q.geometry or []) if isinstance(g, dict)]
    steps = _normalise_steps(
        item.get("steps"),
        geometry=geometry,
        student_answer=student_answer,
        deductions=deductions,
        awarded=awarded,
        marks_deducted=marks_deducted,
        feedback=feedback,
    )

    return {
        "number": q.number,
        "question": q.question,
        "student_answer": student_answer,
        "expected_answer": expected_answer,
        "max_marks": max_marks,
        "marks_awarded": awarded,
        "marks_deducted": marks_deducted,
        "deductions": deductions,
        "feedback": feedback,
        "ocr_note": ocr_note,
        "legibility": q.legibility,
        "page": q.page,
        "warnings": list(q.warnings),
        "geometry": geometry,
        "steps": steps,
    }


def _infer_error_tag(reason: str, category: str = "content", is_last: bool = False) -> str:
    low = (reason or "").lower()
    if category == "handwriting":
        return "Handwriting Issue"
    if category == "diagrams":
        return "Diagram Flaw"
    if category == "unreadable":
        return "Unreadable Span"
    if category == "formatting":
        return "Missing Steps"
    if any(w in low for w in ("calculat", "arithmetic", "evaluat", "substitut", "multipl", "divid", "add", "subtract", "sign")):
        return "Calculation Error"
    if any(w in low for w in ("root", "missing", "omitted", "forgot", "incomplete")):
        return "Missing Root" if "root" in low else "Incomplete Step"
    if is_last or any(w in low for w in ("conclus", "result", "final", "hence", "therefore")):
        return "Result Error"
    return "Concept Error"


def _normalise_steps(
    raw_steps: Any,
    *,
    geometry: list[dict],
    student_answer: str,
    deductions: list[dict],
    awarded: float,
    marks_deducted: float,
    feedback: str,
) -> list[dict]:
    """Validate model-emitted steps or synthesize deterministic steps from geometry/lines."""
    crop_ids = [str(g.get("crop_id") or "") for g in geometry if g.get("crop_id")]
    crop_by_id = {str(g.get("crop_id")): g for g in geometry if g.get("crop_id")}

    def _match_crop_id(text: str, fallback_idx: int) -> str:
        t_norm = _loose(text)
        if t_norm:
            for g in geometry:
                cid = str(g.get("crop_id") or "")
                g_norm = _loose(str(g.get("latex") or ""))
                if cid and g_norm and t_norm == g_norm:
                    return cid
            for g in geometry:
                cid = str(g.get("crop_id") or "")
                g_norm = _loose(str(g.get("latex") or ""))
                if cid and len(g_norm) >= 4 and (t_norm in g_norm or g_norm in t_norm):
                    return cid
        if 0 <= fallback_idx < len(crop_ids):
            return crop_ids[fallback_idx]
        return crop_ids[-1] if crop_ids else ""

    if isinstance(raw_steps, list) and raw_steps:
        out: list[dict] = []
        line_cursor = 0
        for idx, s in enumerate(raw_steps):
            if not isinstance(s, dict):
                continue
            title = str(s.get("title") or f"Step {idx + 1}").strip()
            if not title.lower().startswith("step"):
                title = f"Step {idx + 1}: {title}"
            status_raw = str(s.get("status") or "").strip().lower()
            status = "error" if status_raw in ("error", "incorrect", "wrong", "false", "fail") else "correct"
            explanation = str(s.get("explanation") or s.get("reason") or "").strip()

            raw_lines = s.get("lines")
            norm_lines: list[dict] = []
            if isinstance(raw_lines, list):
                for ln in raw_lines:
                    if isinstance(ln, dict):
                        txt = str(ln.get("text") or ln.get("latex") or "").strip()
                        if not txt:
                            continue
                        cid = str(ln.get("crop_id") or "").strip()
                        if not cid or (crop_by_id and cid not in crop_by_id):
                            cid = _match_crop_id(txt, line_cursor)
                        ok_val = ln.get("ok")
                        ok = bool(ok_val) if isinstance(ok_val, bool) else (status == "correct")
                        tag = str(ln.get("error_tag") or "").strip()
                        norm_lines.append({
                            "crop_id": cid,
                            "text": txt,
                            "ok": ok,
                            "error_tag": "" if ok else tag,
                        })
                        line_cursor += 1
                    elif isinstance(ln, str) and ln.strip():
                        txt = ln.strip()
                        cid = _match_crop_id(txt, line_cursor)
                        norm_lines.append({
                            "crop_id": cid,
                            "text": txt,
                            "ok": status == "correct",
                            "error_tag": "",
                        })
                        line_cursor += 1

            if not norm_lines:
                fallback_txt = str(s.get("text") or s.get("latex") or "").strip()
                if not fallback_txt and 0 <= line_cursor < len(geometry):
                    fallback_txt = str(geometry[line_cursor].get("latex") or "").strip()
                if fallback_txt:
                    cid = _match_crop_id(fallback_txt, line_cursor)
                    norm_lines.append({
                        "crop_id": cid,
                        "text": fallback_txt,
                        "ok": status == "correct",
                        "error_tag": "",
                    })
                    line_cursor += 1

            if status == "error" and norm_lines:
                if all(ln["ok"] for ln in norm_lines):
                    for ln in norm_lines:
                        ln["ok"] = False
                if not any(ln.get("error_tag") for ln in norm_lines):
                    primary = next((ln for ln in norm_lines if not ln["ok"]), norm_lines[0])
                    primary["error_tag"] = _infer_error_tag(
                        explanation or feedback,
                        deductions[0]["category"] if deductions else "content",
                        is_last=(idx == len(raw_steps) - 1),
                    )
                if not explanation:
                    explanation = deductions[0]["reason"] if deductions else feedback

            out.append({
                "title": title,
                "status": status,
                "lines": norm_lines,
                "explanation": explanation if status == "error" else "",
            })
        if out:
            return out

    def _split_prose_bullets(text: str) -> list[str]:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if len(lines) == 1 and len(lines[0]) > 60 and (" * " in lines[0] or " • " in lines[0]):
            parts = [p.strip() for p in re.split(r"\s+(?:\*|•)\s+(?=[A-Z])", lines[0]) if p.strip()]
            if len(parts) > 1:
                return parts
        if len(lines) == 1 and ";" in lines[0]:
            parts = [s.strip() for s in lines[0].split(";") if s.strip()]
            if len(parts) > 1:
                return parts
        return lines

    # Deterministic fallback when model omits steps or fast-grading ran
    source_lines: list[tuple[str, str]] = []
    seen_norm: set[str] = set()
    for g in geometry:
        cid = str(g.get("crop_id") or "")
        txt = str(g.get("latex") or "").strip()
        if txt:
            for sub in _split_prose_bullets(txt):
                norm_sub = _loose(sub)
                if norm_sub:
                    seen_norm.add(norm_sub)
                source_lines.append((cid, sub))
    raw_ans = student_answer if student_answer != "(no answer transcribed)" else ""
    split_ans = _split_prose_bullets(raw_ans) if raw_ans else []
    for idx, ln in enumerate(split_ans):
        norm_ln = _loose(ln)
        if not source_lines or (norm_ln and norm_ln not in seen_norm):
            cid = _match_crop_id(ln, idx) if crop_ids else ""
            if norm_ln:
                seen_norm.add(norm_ln)
            source_lines.append((cid, ln))

    if not source_lines:
        return [{
            "title": "Step 1: Student response",
            "status": "error" if marks_deducted > 0 else "correct",
            "lines": [{
                "crop_id": crop_ids[0] if crop_ids else "",
                "text": "(no answer transcribed)",
                "ok": marks_deducted <= 0,
                "error_tag": "Missing Answer" if marks_deducted > 0 else "",
            }],
            "explanation": feedback if marks_deducted > 0 else "",
        }]

    if marks_deducted <= 0:
        return [
            {
                "title": f"Step {idx + 1}: Working step {idx + 1}",
                "status": "correct",
                "lines": [{"crop_id": cid, "text": txt, "ok": True, "error_tag": ""}],
                "explanation": "",
            }
            for idx, (cid, txt) in enumerate(source_lines)
        ]

    # Partial or zero marks: mark initial steps correct when partial credit was earned
    n = len(source_lines)
    correct_cutoff = max(1, n // 2) if (awarded > 0 and n >= 2) else 0
    steps_out: list[dict] = []
    if correct_cutoff > 0:
        for idx in range(correct_cutoff):
            cid, txt = source_lines[idx]
            steps_out.append({
                "title": f"Step {idx + 1}: Initial working",
                "status": "correct",
                "lines": [{"crop_id": cid, "text": txt, "ok": True, "error_tag": ""}],
                "explanation": "",
            })

    rem = source_lines[correct_cutoff:]
    reasons = [d["reason"] for d in deductions if d.get("reason")] or [feedback]
    cats = [d["category"] for d in deductions if d.get("category")] or ["content"]
    for offset, (cid, txt) in enumerate(rem):
        step_num = correct_cutoff + offset + 1
        reason = reasons[min(offset, len(reasons) - 1)]
        cat = cats[min(offset, len(cats) - 1)]
        is_last = (offset == len(rem) - 1)
        title_label = "Conclusion" if (is_last and n >= 2) else "Calculation & evaluation"
        steps_out.append({
            "title": f"Step {step_num}: {title_label}",
            "status": "error",
            "lines": [{
                "crop_id": cid,
                "text": txt,
                "ok": False,
                "error_tag": _infer_error_tag(reason, cat, is_last=is_last),
            }],
            "explanation": reason,
        })
    return steps_out


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
