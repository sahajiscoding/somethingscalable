"""End-to-end grading session for Exam Checker.

One call runs the whole pipeline for a single student:

    load 3 documents -> OCR/vision extraction -> question alignment
        -> rubric grading -> report document

Used by ``grade_exam.py`` (CLI), ``test_real_exam.py`` (test runner) and
``streamlit_app.py`` (Streamlit UI).  A ``progress`` callback receives human-readable
step names as the session advances (UI progress bars / CLI logging).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from engine import DEFAULT_MODEL, EngineError, make_engine
from extract import (AlignedQuestion, ExtractionError, align_questions,
                     alignment_warnings, extract_key, extract_paper,
                     extract_student)
from grade import GradeParams, GradingError, grade_answers, summarise
from ingest import Document, IngestError, load_documents
from report import build_report, write_json, write_markdown

Progress = Callable[[str], None]

ROLE_LABELS = {
    "paper": "Question paper",
    "key": "Answer key / rubric",
    "student": "Student answer sheet",
}


class SessionError(RuntimeError):
    """Top-level pipeline failure with a user-friendly message."""


@dataclass
class SessionResult:
    report: dict
    records: list[dict]
    aligned: list[AlignedQuestion]
    documents: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def summary(self) -> dict:
        return self.report["summary"]


def run_session(paper: str | Path,
                key: str | Path,
                student: str | Path,
                *,
                engine=None,
                 api_key: str | None = None,
                 model: str | None = None,
                 mock: bool = False,
                 backend: str | None = None,
                 params: GradeParams | None = None,
                 progress: Progress | None = None) -> SessionResult:
    """Run one full grading session and return the structured result."""

    def step(message: str) -> None:
        if progress:
            progress(message)

    params = params or GradeParams()
    if engine is None:
        try:
            engine = make_engine(api_key=api_key, model=model, mock=mock,
                                 backend=backend)
        except Exception as exc:
            raise SessionError(str(exc)) from exc

    # 1. Ingest -------------------------------------------------------------
    step("Loading documents (question paper, answer key, student sheet)")
    try:
        documents: dict[str, Document] = load_documents(paper, key, student)
    except IngestError as exc:
        raise SessionError(str(exc)) from exc

    warnings: list[str] = []
    for role, doc in documents.items():
        warnings.extend(f"{ROLE_LABELS[role]}: {w}" for w in doc.warnings)

    # 2. Vision extraction ---------------------------------------------------
    try:
        step(f"Extracting questions from {documents['paper'].filename}")
        paper_specs = extract_paper(engine, documents["paper"])

        step(f"Extracting answers/rubric from {documents['key'].filename}")
        key_entries = extract_key(engine, documents["key"])

        step(f"Transcribing student sheet {documents['student'].filename} "
             "(handwriting OCR)")
        student_answers = extract_student(engine, documents["student"])
    except (ExtractionError, EngineError) as exc:
        raise SessionError(str(exc)) from exc

    # 3. Mapping -------------------------------------------------------------
    step("Mapping student responses onto question numbers")
    aligned = align_questions(paper_specs, key_entries, student_answers)
    warnings.extend(alignment_warnings(aligned))
    if not aligned:
        raise SessionError(
            "No questions could be aligned across the three documents."
        )

    # 4. Grading --------------------------------------------------------------
    strict_label = "STRICT" if params.strict else "standard"
    step(f"Grading {len(aligned)} questions ({strict_label} mode, "
         f"{len(params.penalty_list)} penalty criteria)")
    try:
        records = grade_answers(engine, aligned, params)
    except (GradingError, EngineError) as exc:
        raise SessionError(str(exc)) from exc

    # 5. Report ----------------------------------------------------------------
    step("Building JSON + Markdown reports")
    summary = summarise(records)
    report = build_report(
        records, summary,
        engine_name=getattr(engine, "name", "unknown"),
        model=getattr(engine, "model", model or DEFAULT_MODEL),
        params=params, documents=documents, warnings=warnings,
    )

    return SessionResult(report=report, records=records, aligned=aligned,
                         documents=documents, warnings=warnings)


def write_reports(result: SessionResult, out_dir: str | Path,
                  stem: str = "report") -> dict[str, Path]:
    """Write report.json and report.md into ``out_dir``; return their paths."""
    out = Path(out_dir)
    return {
        "json": write_json(result.report, out / f"{stem}.json"),
        "markdown": write_markdown(result.report, out / f"{stem}.md"),
    }
