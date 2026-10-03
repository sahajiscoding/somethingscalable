"""OCR / vision extraction for WeHelpTeachers.

Turns the three raw documents into structured, question-mapped data:

* Question paper  -> QuestionSpec(number, text, max_marks, page)
* Answer key      -> KeyEntry(number, expected_answer, marking_scheme)
* Student sheet   -> StudentAnswer(number, response, legibility, ...)

``align_questions`` then maps every student response onto its question
number (fuzzy-normalised across "Q4", "4.", "(4)", "iv"...), producing the
per-question payload the grader consumes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from typing import Any

from engine import EngineError


class ExtractionError(ValueError):
    """Raised when a document yields no usable structured content."""


# ---------------------------------------------------------------------------
# Structured records
# ---------------------------------------------------------------------------

@dataclass
class QuestionSpec:
    number: str
    text: str
    max_marks: float | None = None
    page: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class KeyEntry:
    number: str
    expected_answer: str
    marking_scheme: list[dict] = field(default_factory=list)
    page: int | None = None
    keywords: list[str] = field(default_factory=list)

    @property
    def scheme_total(self) -> float | None:
        values = [step.get("marks") for step in self.marking_scheme
                  if isinstance(step.get("marks"), (int, float))]
        return float(sum(values)) if values else None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class StudentAnswer:
    number: str
    response: str
    page: int | None = None
    legibility: str = "good"            # good | fair | poor
    uncertain_spans: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AlignedQuestion:
    """One question as seen by all three sources (plus warnings)."""
    number: str
    question: str = ""
    max_marks: float | None = None
    expected_answer: str = ""
    marking_scheme: list[dict] = field(default_factory=list)
    student_answer: str = ""
    legibility: str = "unknown"
    uncertain_spans: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    page: int | None = None
    warnings: list[str] = field(default_factory=list)

    def to_payload(self) -> dict:
        return {
            "number": self.number,
            "question": self.question,
            "max_marks": self.max_marks,
            "expected_answer": self.expected_answer,
            "marking_scheme": self.marking_scheme,
            "student_answer": self.student_answer,
            "legibility": self.legibility,
            "uncertain_spans": self.uncertain_spans,
            "keywords": self.keywords,
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------
# Extraction prompts (sent alongside the document)
# ---------------------------------------------------------------------------

_PAPER_PROMPT = """\
TRANSCRIPTION TASK: question paper.

You are preparing this exam paper for automated grading. Transcribe it to JSON.

Rules:
- Capture EVERY question with its exact printed question number (keep
  subparts such as "3(b)" inside the question text, do not split them).
- Transcribe ONLY what is printed on these pages. Never invent, complete,
  or "fix" questions from general knowledge; if a question is unreadable,
  keep the readable words and leave the rest out.
- "max_marks" is the marks allocated to that question as printed on the
  paper. If no marks are printed, return null - never guess.
- "page" is the 1-based page the question starts on.
- Preserve formulas, units, diagrams descriptions and special symbols.
- Multi-page documents: cover all pages in order.

Return ONLY this JSON shape:
{"questions": [{"number": "1", "text": "...", "max_marks": 5, "page": 1}]}
"""

_KEY_PROMPT = """\
TRANSCRIPTION TASK: official answer key / rubric.

Extract the correct answer and marking scheme for every question to JSON.

Rules:
- "number" must match the question numbering used in the key.
- Copy the key VERBATIM. Never substitute your own answer or "correct" the
  key from general knowledge — the key is the ground truth even when you
  disagree with it. If an entry is unreadable, return an empty string.
- "expected_answer" is the model/correct answer, verbatim.
- "marking_scheme" is the step-by-step breakdown:
  [{"step": "states the formula", "marks": 1}, ...]; use [] if the key
  only gives a flat answer.
- If the key lists an explicit total for the question, make the step
  marks add up to it. Never invent marks that are not in the key.
- "page" is the 1-based page the entry starts on.

Return ONLY this JSON shape:
{"entries": [{"number": "1", "expected_answer": "...",
              "marking_scheme": [{"step": "...", "marks": 1}],
              "page": 1}]}
"""

_STUDENT_PROMPT = """\
TRANSCRIPTION TASK: student exam sheet (may be handwritten or typed).

Transcribe each answer to JSON so it can be marked against an answer key.

Rules:
- "number" is the question number exactly as the student wrote it.
- "response" is a FAITHFUL verbatim transcription. Do not correct spelling,
  grammar, formulas or facts - the marker will decide credit.
- If part of an answer is smudged or you cannot read it, keep the readable
  parts, place your best guess inside square brackets, and add the uncertain
  text to "uncertain_spans".
- "legibility" overall for that answer: "good", "fair" or "poor".
- Never merge two answers, never drop a response, even if it is blank
  (return an empty string for blanks).
- NEVER invent answer content. A missing answer is data — do not fill it in
  from the question, the key, or general knowledge.
- "page" is the 1-based page the answer starts on.

Return ONLY this JSON shape:
{"answers": [{"number": "1", "response": "...", "page": 1,
              "legibility": "good", "uncertain_spans": []}]}
"""


# ---------------------------------------------------------------------------
# Extraction entry points
# ---------------------------------------------------------------------------

def extract_paper(engine, doc) -> list[QuestionSpec]:
    raw = engine.generate_json("extract_paper", document=doc,
                               instruction=_PAPER_PROMPT)
    items = _pick(raw, "questions")
    questions = [
        QuestionSpec(
            number=str(it.get("number", "")).strip() or f"#{i + 1}",
            text=str(it.get("text", "")).strip(),
            max_marks=_as_marks(it.get("max_marks")),
            page=_as_page(it.get("page")),
        )
        for i, it in enumerate(items)
    ]
    if not questions:
        raise ExtractionError(
            f"No questions found in {doc.filename}. "
            "Check the file is readable and re-run."
        )
    return questions


def extract_key(engine, doc) -> list[KeyEntry]:
    raw = engine.generate_json("extract_key", document=doc,
                               instruction=_KEY_PROMPT)
    items = _pick(raw, "entries")
    entries = [
        KeyEntry(
            number=str(it.get("number", "")).strip() or f"#{i + 1}",
            expected_answer=str(it.get("expected_answer", "")).strip(),
            marking_scheme=_as_scheme(it.get("marking_scheme")),
            page=_as_page(it.get("page")),
        )
        for i, it in enumerate(items)
    ]
    if not entries:
        raise ExtractionError(
            f"No answers found in {doc.filename}. "
            "Check the file is readable and re-run."
        )
    return entries


def extract_student(engine, doc) -> list[StudentAnswer]:
    raw = engine.generate_json("extract_student", document=doc,
                               instruction=_STUDENT_PROMPT)
    items = _pick(raw, "answers")
    answers = [
        StudentAnswer(
            number=str(it.get("number", "")).strip() or f"#{i + 1}",
            response=str(it.get("response", "") or "").strip(),
            page=_as_page(it.get("page")),
            legibility=str(it.get("legibility", "good") or "good").lower(),
            uncertain_spans=[str(s) for s in (it.get("uncertain_spans") or [])],
        )
        for i, it in enumerate(items)
    ]
    if not answers:
        raise ExtractionError(
            f"No answers could be transcribed from {doc.filename}. "
            "Try a sharper scan or a higher-contrast photo."
        )
    return answers


# ---------------------------------------------------------------------------
# Question mapping
# ---------------------------------------------------------------------------

_ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7,
          "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12}


def normalize_number(raw: Any) -> str:
    """Normalise a question number across sources: 'Q4', '4.', '(4)', 'iv'."""
    s = str(raw or "").strip().lower()
    s = s.replace("question", "").replace("ques", "").replace("q", "", 1) \
        if re.match(r"^\s*(question|ques|q)", s) else s
    s = s.strip().strip(".").strip()
    s = s.strip("()[]{}: -")
    s = re.sub(r"\s+", "", s)
    if not s:
        return ""
    if s in _ROMAN:                       # 'iv' -> '4' when standalone
        return str(_ROMAN[s])
    s = re.sub(r"^0+(?=\d)", "", s)       # '04' -> '4'
    s = s.replace("．", ".").replace("、", ".")
    return s


def _number_sort_key(num: str):
    m = re.match(r"^(\d+)([a-z]*)$", num)
    if m:
        return (0, int(m.group(1)), m.group(2))
    return (1, 0, num)


def align_questions(paper: list[QuestionSpec],
                    key: list[KeyEntry],
                    student: list[StudentAnswer]) -> list[AlignedQuestion]:
    """Map student responses onto questions by normalised number.

    Ordering follows the question paper, then any key-only/student-only
    numbers in natural order.  Every mismatch records a warning instead of
    silently dropping data.
    """
    key_by_num = {normalize_number(e.number): e for e in key}
    stu_by_num = {normalize_number(a.number): a for a in student}
    paper_nums = [normalize_number(q.number) for q in paper]

    ordered: list[str] = []
    seen: set[str] = set()
    for num in paper_nums + sorted(key_by_num, key=_number_sort_key) + \
            sorted(stu_by_num, key=_number_sort_key):
        if num and num not in seen:
            seen.add(num)
            ordered.append(num)

    spec_by_num = {normalize_number(q.number): q for q in paper}
    aligned: list[AlignedQuestion] = []

    for idx, num in enumerate(ordered):
        spec = spec_by_num.get(num)
        entry = key_by_num.get(num)
        ans = stu_by_num.get(num)
        warnings: list[str] = []

        if spec is None:
            warnings.append("Question not found in the question paper.")
        if entry is None:
            warnings.append("No official answer found in the answer key.")
        if ans is None:
            warnings.append("No answer transcribed from the student sheet.")

        max_marks = None
        if spec is not None and spec.max_marks:
            max_marks = float(spec.max_marks)
        elif entry is not None and entry.scheme_total:
            max_marks = entry.scheme_total
            warnings.append("Max marks taken from the answer key total "
                            "(not printed on the paper).")
        if max_marks is None:
            warnings.append("Max marks unknown - defaulted to 0; "
                            "set marks manually in the report.")

        aligned.append(AlignedQuestion(
            number=num or f"#{idx + 1}",
            question=(spec.text if spec else ""),
            max_marks=max_marks,
            expected_answer=(entry.expected_answer if entry else ""),
            marking_scheme=(entry.marking_scheme if entry else []),
            student_answer=(ans.response if ans else ""),
            legibility=(ans.legibility if ans else "unknown"),
            uncertain_spans=(ans.uncertain_spans if ans else []),
            keywords=(entry.keywords if entry else []),
            page=(spec.page if spec else None),
            warnings=warnings,
        ))

    return aligned


def alignment_warnings(aligned: list[AlignedQuestion]) -> list[str]:
    """Flat list of mapping warnings for the report header."""
    out: list[str] = []
    for q in aligned:
        for w in q.warnings:
            out.append(f"Q{q.number}: {w}")
    return out


# ---------------------------------------------------------------------------
# Coercion helpers
# ---------------------------------------------------------------------------

def _pick(raw: Any, key: str) -> list[dict]:
    if isinstance(raw, dict):
        value = raw.get(key)
        if isinstance(value, list):
            return [v for v in value if isinstance(v, dict)]
        # Tolerate a single object or an alternate container name.
        for alt in ("questions", "entries", "answers", "items", "results"):
            value = raw.get(alt)
            if isinstance(value, list):
                return [v for v in value if isinstance(v, dict)]
        return []
    if isinstance(raw, list):
        return [v for v in raw if isinstance(v, dict)]
    raise EngineError(f"Unexpected extraction payload type: {type(raw).__name__}")


def _as_marks(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = re.search(r"\d+(?:\.\d+)?", value)
        if m:
            return float(m.group(0))
    return None


def _as_page(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return None


def _as_scheme(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    scheme = []
    for step in value:
        if isinstance(step, dict):
            scheme.append({
                "step": str(step.get("step", step.get("description", ""))),
                "marks": (step.get("marks")
                          if isinstance(step.get("marks"), (int, float))
                          else None),
            })
        elif isinstance(step, str):
            scheme.append({"step": step, "marks": None})
    return scheme


def dumps_aligned(aligned: list[AlignedQuestion]) -> str:
    """Debug helper: pretty JSON of the aligned payload."""
    return json.dumps([q.to_payload() for q in aligned],
                      ensure_ascii=False, indent=2)
