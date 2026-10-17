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
  disagree with it.
- "expected_answer" is the model/correct answer text. If the document only
  lists marking steps or bullet points, combine them into "expected_answer"
  as well.
- "marking_scheme" is the step-by-step breakdown:
  [{"step": "states the formula", "marks": 1}, ...]; use [] if the key
  only gives a flat answer.
- If the key lists an explicit total for the question, make the step
  marks add up to it.
- "page" is the 1-based page the entry starts on.

Return ONLY this JSON shape:
{"entries": [{"number": "1", "expected_answer": "...",
              "marking_scheme": [{"step": "...", "marks": 1}],
              "page": 1}]}
"""

_STUDENT_PROMPT = """\
TRANSCRIPTION TASK: student exam sheet (or model answer sheet / answer key uploaded as a test submission).

Transcribe each answer in the document to JSON so it can be marked against an answer key.

Rules:
- "number" is the question number as written (e.g. "1", "2", "Q1").
- "response" is a FAITHFUL verbatim transcription of the answer or solution
  written for that question. Do not correct spelling, grammar, formulas or
  facts - the marker will decide credit.
- CRITICAL: Teachers frequently upload the Official Answer Key, Marking Rubric,
  or a printed Model Solution Sheet in this slot to test the grading pipeline.
  If this document is an Answer Key, Rubric, or Solution Sheet (e.g. containing
  "Model Target Answer", "Answer:", "Official Solution", or marking steps),
  you MUST transcribe each question's model answer / solution into "response".
  NEVER return an empty "answers" list just because the document is an answer
  key or rubric. If both "Question Text" and "Model Target Answer" appear,
  transcribe ONLY the answer/solution into "response".
- If part of a handwritten answer is smudged or hard to read, keep the readable
  parts, place your best guess inside square brackets, and add the uncertain
  text to "uncertain_spans".
- "legibility" overall for that answer: "good", "fair" or "poor".
- Never merge two answers, never drop a response.
- "page" is the 1-based page the answer starts on.

Return ONLY this JSON shape:
{"answers": [{"number": "1", "response": "...", "page": 1,
              "legibility": "good", "uncertain_spans": []}]}
"""


# ---------------------------------------------------------------------------
# Instant Digital Text / PDF Extraction Helpers (0 LLM calls when structured)
# ---------------------------------------------------------------------------

def _get_digital_text(doc) -> str | None:
    """Return full text if ``doc`` is a text file or a digital PDF where all
    pages have embedded selectable text (no scanned image pages)."""
    if getattr(doc, "text", None) and str(doc.text).strip():
        return str(doc.text).strip()
    if getattr(doc, "kind", None) != "pdf":
        return None
    try:
        import pymupdf
        page_texts: list[str] = []
        for chunk in getattr(doc, "pages", []):
            with pymupdf.open(stream=chunk.data, filetype="pdf") as pdf:
                for page in pdf:
                    t = (page.get_text() or "").strip()
                    if len(t) < 15:
                        return None  # scanned page — needs Vision OCR
                    page_texts.append(t)
        return "\n\n".join(page_texts).strip() if page_texts else None
    except Exception:
        return None


_WHT_RUBRIC_Q_RE = re.compile(
    r"(?:^|\n)\s*(Q?\d+[a-zA-Z]?)\s*(?:—|-|--)\s*Official Solution\s*&\s*Marking Breakdown"
    r"(?:[^\n]*?\[Max Marks:\s*(\d+(?:\.\d+)?)\])?",
    re.IGNORECASE,
)
_WHT_PAPER_Q_RE = re.compile(
    r"(?:^|\n)\s*(Q\d+)\s*\n?\s*\[(\d+(?:\.\d+)?)\s*Marks?\]",
    re.IGNORECASE,
)
_GEN_TXT_Q_RE = re.compile(
    r"(?:^|\n)\s*(Q?\d+[a-zA-Z]?)\s*\(\s*(\d+(?:\.\d+)?)\s*marks?\s*\)",
    re.IGNORECASE,
)
_NUMBERED_LINE_RE = re.compile(
    r"^\s*(?:Question\s+|Ques\.?\s+|Q\.?\s*)?(\d+)\s*[.\):\-]\s*(.+)$",
    re.IGNORECASE,
)


def _clean_pdf_boilerplate(text: str) -> str:
    lines = []
    for ln in text.splitlines():
        s = ln.strip()
        if re.match(r"^Page\s+\d+\s+of\s+\d+$", s, re.IGNORECASE):
            continue
        if s in (
            "WeHelpTeachers · Official Examination Paper",
            "WeHelpTeachers - Official Examination Paper",
            "WeHelpTeachers · Official Marking Rubric & Answer Key",
            "WeHelpTeachers - Official Marking Rubric & Answer Key",
            "— END OF QUESTION PAPER —",
            "- END OF QUESTION PAPER -",
            "CONFIDENTIAL · EXAMINATION QUESTION PAPER",
            "OFFICIAL EVALUATOR GUIDE · STRICTLY FOR EXAMINERS",
        ):
            continue
        lines.append(ln)
    return "\n".join(lines).strip()


def _extract_rubric_sections(block: str, max_m: float | None) -> dict | None:
    """Extract Question/Model Target Answer/Step-by-Step Marking Breakdown from a block."""
    ans_match = re.search(
        r"(?:Model Target Answer|Expected Answer|Official Answer|Answer):\s*([\s\S]*?)(?=Step-by-Step Marking Breakdown:|Marking Scheme:|Scheme:|Required Keywords:|Keywords:|$)",
        block, re.IGNORECASE,
    )
    scheme_match = re.search(
        r"(?:Step-by-Step Marking Breakdown|Marking Scheme|Scheme):\s*([\s\S]*?)(?=Required Keywords:|Keywords:|$)",
        block, re.IGNORECASE,
    )
    kw_match = re.search(
        r"(?:Required Keywords|Keywords):\s*([^\n]+)",
        block, re.IGNORECASE,
    )
    qtext_match = re.search(
        r"(?:Question Text|Question):\s*([\s\S]*?)(?=Model Target Answer:|Expected Answer:|Official Answer:|Answer:|Step-by-Step Marking Breakdown:|Marking Scheme:|Scheme:|$)",
        block, re.IGNORECASE,
    )
    if not (ans_match or scheme_match or qtext_match):
        return None

    expected = (ans_match.group(1).strip() if ans_match else block.strip())
    expected = re.sub(r"\s+", " ", expected).strip()
    scheme_raw = (scheme_match.group(1).strip() if scheme_match else "")
    scheme_raw = re.sub(r"\s+", " ", scheme_raw).strip()
    qtext = (qtext_match.group(1).strip() if qtext_match else "")
    qtext = re.sub(r"\s+", " ", qtext).strip()
    keywords = (
        [k.strip() for k in kw_match.group(1).split(",") if k.strip()]
        if kw_match else []
    )
    scheme_list = _as_scheme(scheme_raw) if scheme_raw else []
    if max_m and not scheme_list and expected:
        scheme_list = [{"step": "Complete model answer", "marks": max_m}]
    return {
        "text": qtext or expected,
        "expected_answer": expected,
        "response": expected,
        "max_marks": max_m,
        "marking_scheme": scheme_list,
        "keywords": keywords,
        "page": 1,
    }


def _parse_wht_rubric_blocks(text: str) -> list[dict]:
    """Parse PDFs generated by ``generateAnswerKeyPdf``, ``generateExamPaperPdf``, or ``buildGenKeyText``."""
    cleaned = _clean_pdf_boilerplate(text)

    # Case 1: generateAnswerKeyPdf ("Q1 — Official Solution & Marking Breakdown")
    matches = list(_WHT_RUBRIC_Q_RE.finditer(cleaned))
    if matches:
        out: list[dict] = []
        for i, m in enumerate(matches):
            q_num = m.group(1).strip()
            marks_str = m.group(2)
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(cleaned)
            block = cleaned[start:end].strip()

            if not marks_str:
                mm = re.search(r"\[Max Marks:\s*(\d+(?:\.\d+)?)\]", block, re.IGNORECASE)
                if mm:
                    marks_str = mm.group(1)
                    block = (block[:mm.start()] + block[mm.end():]).strip()

            max_m = float(marks_str) if marks_str else None
            sec = _extract_rubric_sections(block, max_m)
            if sec:
                sec["number"] = q_num
                out.append(sec)
            else:
                expected = re.sub(r"\s+", " ", block).strip()
                out.append({
                    "number": q_num,
                    "text": expected,
                    "expected_answer": expected,
                    "response": expected,
                    "max_marks": max_m,
                    "marking_scheme": [{"step": "Complete model answer", "marks": max_m}] if max_m else [],
                    "keywords": [],
                    "page": 1,
                })
        return out

    # Case 2: buildGenKeyText / buildGenPaperText ("Q1 (5 marks)")
    gen_matches = list(_GEN_TXT_Q_RE.finditer(cleaned))
    if gen_matches:
        out = []
        for i, m in enumerate(gen_matches):
            q_num = m.group(1).strip()
            max_m = float(m.group(2))
            start = m.end()
            end = gen_matches[i + 1].start() if i + 1 < len(gen_matches) else len(cleaned)
            block = cleaned[start:end].strip()

            sec = _extract_rubric_sections(block, max_m)
            if sec:
                sec["number"] = q_num
                out.append(sec)
            else:
                q_body = re.sub(r"\s+", " ", block).strip()
                if q_body:
                    out.append({
                        "number": q_num,
                        "text": q_body,
                        "expected_answer": q_body,
                        "response": q_body,
                        "max_marks": max_m,
                        "marking_scheme": [{"step": "Complete answer", "marks": max_m}],
                        "keywords": [],
                        "page": 1,
                    })
        if out:
            return out

    # Case 3: generateExamPaperPdf or rubric with ("Q1 \n [5 Marks]")
    paper_matches = list(_WHT_PAPER_Q_RE.finditer(cleaned))
    if paper_matches:
        out = []
        for i, m in enumerate(paper_matches):
            q_num = m.group(1).strip()
            max_m = float(m.group(2))
            start = m.end()
            end = paper_matches[i + 1].start() if i + 1 < len(paper_matches) else len(cleaned)
            block = cleaned[start:end].strip()
            sec = _extract_rubric_sections(block, max_m)
            if sec:
                sec["number"] = q_num
                out.append(sec)
            else:
                q_body = re.sub(r"\s+", " ", block).strip()
                if q_body:
                    out.append({
                        "number": q_num,
                        "text": q_body,
                        "expected_answer": q_body,
                        "response": q_body,
                        "max_marks": max_m,
                        "marking_scheme": [{"step": "Complete answer", "marks": max_m}],
                        "keywords": [],
                        "page": 1,
                    })
        if out:
            return out

    return []


def _parse_numbered_text_blocks(text: str) -> list[dict]:
    """Fallback parser for standard numbered text documents ('1. ...', 'Q1: ...')."""
    wht = _parse_wht_rubric_blocks(text)
    if wht:
        return wht

    from engine import strip_marks
    cleaned = _clean_pdf_boilerplate(text)
    blocks: dict[str, list[str]] = {}
    order: list[str] = []
    current: str | None = None

    for line in cleaned.splitlines():
        m = _NUMBERED_LINE_RE.match(line)
        if m:
            current = m.group(1)
            if current not in blocks:
                blocks[current] = []
                order.append(current)
            rest = m.group(2).strip()
            if rest:
                blocks[current].append(rest)
        elif current is not None and line.strip():
            blocks[current].append(line.strip())

    out: list[dict] = []
    for num in order:
        raw_body = " ".join(blocks[num]).strip()
        if not raw_body:
            continue
        body_no_marks, marks = strip_marks(raw_body)
        # Check for inline "Marks: ..." breakdown in answer keys
        scheme_list: list[dict] = []
        expected_body = body_no_marks
        marks_line = re.search(r"\bMarks\s*:\s*(.+)$", body_no_marks, re.IGNORECASE)
        if marks_line:
            expected_body = body_no_marks[:marks_line.start()].strip()
            scheme_list = _as_scheme(marks_line.group(1).strip())
            if marks is None and scheme_list:
                s_tot = sum(s["marks"] for s in scheme_list if isinstance(s.get("marks"), (int, float)))
                if s_tot > 0:
                    marks = float(s_tot)
        out.append({
            "number": num,
            "text": body_no_marks,
            "expected_answer": expected_body or body_no_marks,
            "response": expected_body or body_no_marks,
            "max_marks": marks,
            "marking_scheme": scheme_list,
            "page": 1,
        })
    return out


# ---------------------------------------------------------------------------
# Extraction entry points
# ---------------------------------------------------------------------------

def extract_paper(engine, doc) -> list[QuestionSpec]:
    # Instant zero-LLM fast path for WeHelpTeachers digital PDFs / structured text
    digital_text = _get_digital_text(doc)
    if digital_text:
        fast_items = _parse_wht_rubric_blocks(digital_text)
        if not fast_items and doc.kind == "text" and getattr(engine, "name", "") != "mock":
            fast_items = _parse_numbered_text_blocks(digital_text)
        if fast_items:
            return [
                QuestionSpec(
                    number=str(it["number"]),
                    text=str(it.get("text") or ""),
                    max_marks=_as_marks(it.get("max_marks")),
                    page=_as_page(it.get("page")) or 1,
                )
                for it in fast_items
            ]

    try:
        raw = engine.generate_json("extract_paper", document=doc,
                                   instruction=_PAPER_PROMPT)
        items = _pick(raw, "questions")
    except EngineError:
        items = _parse_numbered_text_blocks(digital_text) if digital_text else []
        if not items:
            raise

    if not items and digital_text:
        items = _parse_numbered_text_blocks(digital_text)

    questions = [
        QuestionSpec(
            number=str(it.get("number") or it.get("id") or it.get("q") or "").strip() or f"#{i + 1}",
            text=str(
                it.get("text")
                or it.get("question")
                or it.get("question_text")
                or it.get("prompt")
                or it.get("problem")
                or it.get("expected_answer")
                or ""
            ).strip(),
            max_marks=_as_marks(it.get("max_marks") if it.get("max_marks") is not None else it.get("marks")),
            page=_as_page(it.get("page")),
        )
        for i, it in enumerate(items)
    ]
    questions = [q for q in questions if q.text]
    if not questions:
        raise ExtractionError(
            f"No questions found in {doc.filename}. "
            "Check the file is readable and re-run."
        )
    return questions


def extract_key(engine, doc) -> list[KeyEntry]:
    # Instant zero-LLM fast path for WeHelpTeachers digital rubric PDFs / structured text
    digital_text = _get_digital_text(doc)
    if digital_text:
        fast_items = _parse_wht_rubric_blocks(digital_text)
        if not fast_items and doc.kind == "text" and getattr(engine, "name", "") != "mock":
            fast_items = _parse_numbered_text_blocks(digital_text)
        if fast_items:
            return [
                KeyEntry(
                    number=str(it["number"]),
                    expected_answer=str(it.get("expected_answer") or it.get("text") or ""),
                    marking_scheme=_as_scheme(it.get("marking_scheme")),
                    page=_as_page(it.get("page")) or 1,
                    keywords=list(it.get("keywords") or []),
                )
                for it in fast_items
            ]

    try:
        raw = engine.generate_json("extract_key", document=doc,
                                   instruction=_KEY_PROMPT)
        items = _pick(raw, "entries")
    except EngineError:
        items = _parse_numbered_text_blocks(digital_text) if digital_text else []
        if not items:
            raise

    if not items and digital_text:
        items = _parse_numbered_text_blocks(digital_text)

    entries = []
    for i, it in enumerate(items):
        scheme = _as_scheme(it.get("marking_scheme") or it.get("scheme") or it.get("rubric"))
        exp = str(
            it.get("expected_answer")
            or it.get("answer")
            or it.get("model_answer")
            or it.get("solution")
            or it.get("response")
            or it.get("text")
            or ""
        ).strip()
        if not exp and scheme:
            exp = "; ".join(s.get("step", "") for s in scheme if s.get("step"))
        if exp or scheme:
            entries.append(
                KeyEntry(
                    number=str(it.get("number") or it.get("id") or it.get("q") or "").strip() or f"#{i + 1}",
                    expected_answer=exp,
                    marking_scheme=scheme,
                    page=_as_page(it.get("page")),
                    keywords=[str(k) for k in (it.get("keywords") or []) if k],
                )
            )
    if not entries:
        raise ExtractionError(
            f"No answers found in {doc.filename}. "
            "Check the file is readable and re-run."
        )
    return entries


def extract_student(engine, doc) -> list[StudentAnswer]:
    # Instant zero-LLM fast path when a digital rubric/key PDF or structured text
    # is uploaded in the student slot (e.g. testing with the actual answer key).
    digital_text = _get_digital_text(doc)
    if digital_text:
        fast_items = _parse_wht_rubric_blocks(digital_text)
        if not fast_items and doc.kind == "text" and getattr(engine, "name", "") != "mock":
            fast_items = _parse_numbered_text_blocks(digital_text)
        if fast_items:
            return [
                StudentAnswer(
                    number=str(it["number"]),
                    response=str(it.get("response") or it.get("expected_answer") or it.get("text") or ""),
                    page=_as_page(it.get("page")) or 1,
                    legibility="good",
                    uncertain_spans=[],
                )
                for it in fast_items
            ]

    try:
        raw = engine.generate_json("extract_student", document=doc,
                                   instruction=_STUDENT_PROMPT)
        items = _pick(raw, "answers")
    except EngineError:
        items = _parse_numbered_text_blocks(digital_text) if digital_text else []
        if not items:
            raise

    if not items:
        digital_text = _get_digital_text(doc)
        if digital_text:
            items = _parse_numbered_text_blocks(digital_text)

    answers = []
    for i, it in enumerate(items):
        resp = str(
            it.get("response")
            or it.get("student_answer")
            or it.get("answer")
            or it.get("expected_answer")
            or it.get("model_answer")
            or it.get("solution")
            or it.get("text")
            or ""
        ).strip()
        if not resp and isinstance(it.get("marking_scheme"), list):
            resp = "; ".join(
                str(s.get("step", "")) for s in it["marking_scheme"]
                if isinstance(s, dict) and s.get("step")
            ).strip()
        answers.append(
            StudentAnswer(
                number=str(it.get("number") or it.get("id") or it.get("q") or "").strip() or f"#{i + 1}",
                response=resp,
                page=_as_page(it.get("page")),
                legibility=str(it.get("legibility", "good") or "good").lower(),
                uncertain_spans=[str(s) for s in (it.get("uncertain_spans") or [])],
            )
        )
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
    def _coerce_list(items: list) -> list[dict]:
        out: list[dict] = []
        for idx, v in enumerate(items):
            if isinstance(v, dict):
                out.append(v)
            elif isinstance(v, str) and v.strip():
                num_m = re.match(r"^\s*(?:Q(?:uestion)?\s*)?(\d+[a-z]?)[.):\-]\s*(.+)$", v.strip(), re.I | re.S)
                if num_m:
                    num, body = num_m.group(1), num_m.group(2).strip()
                else:
                    num, body = str(idx + 1), v.strip()
                out.append({
                    "number": num,
                    "text": body,
                    "expected_answer": body,
                    "response": body,
                })
        return out

    if isinstance(raw, dict):
        value = raw.get(key)
        if isinstance(value, list):
            return _coerce_list(value)
        if isinstance(value, dict):
            return [value]
        # Tolerate a single object or an alternate container name.
        for alt in (
            "questions",
            "entries",
            "answers",
            "student_answers",
            "solutions",
            "responses",
            "rubric",
            "answer_key",
            "items",
            "results",
            "data",
        ):
            value = raw.get(alt)
            if isinstance(value, list):
                return _coerce_list(value)
            if isinstance(value, dict) and any(k in value for k in ("number", "text", "expected_answer", "response")):
                return [value]
        # Single-item object directly at root
        if any(k in raw for k in ("number", "question_number", "text", "question", "expected_answer", "response", "answer")):
            return [raw]
        # Number-keyed dictionary e.g. {"1": "answer 1", "2": {"response": "answer 2"}}
        keyed_items: list[dict] = []
        for k, v in raw.items():
            norm_k = normalize_number(k)
            if norm_k and re.match(r"^\d+", norm_k):
                if isinstance(v, dict):
                    item = dict(v)
                    item.setdefault("number", norm_k)
                    keyed_items.append(item)
                elif isinstance(v, str) and v.strip():
                    keyed_items.append({
                        "number": norm_k,
                        "text": v.strip(),
                        "expected_answer": v.strip(),
                        "response": v.strip(),
                    })
        if keyed_items:
            return keyed_items
        return []
    if isinstance(raw, list):
        return _coerce_list(raw)
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
    if isinstance(value, str) and value.strip():
        parts = [p.strip() for p in re.split(r"[;\n]+", value) if p.strip()]
        value = parts
    if not isinstance(value, list):
        return []
    scheme = []
    for step in value:
        if isinstance(step, dict):
            scheme.append({
                "step": str(step.get("step", step.get("description", step.get("criterion", "")))),
                "marks": _as_marks(step.get("marks")),
            })
        elif isinstance(step, str):
            m = re.match(r"^(.+?):\s*(\d+(?:\.\d+)?)\s*m(?:arks?)?\s*$", step.strip(), re.I)
            if m:
                scheme.append({"step": m.group(1).strip(), "marks": float(m.group(2))})
            else:
                scheme.append({"step": step, "marks": None})
    return scheme


def dumps_aligned(aligned: list[AlignedQuestion]) -> str:
    """Debug helper: pretty JSON of the aligned payload."""
    return json.dumps([q.to_payload() for q in aligned],
                      ensure_ascii=False, indent=2)
