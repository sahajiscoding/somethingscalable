"""📝 Exam Checker - Streamlit UI

Dark, three-input grading console:

1. Upload a **question paper** (multi-page PDF or image)
2. Upload the **official answer key / rubric**
3. Upload the **student's answer sheet** (scan/photo of handwriting)

Pick Strict Checking Mode and the penalty criteria, hit
**Run AI Evaluation**, and get a scoreboard plus a question-by-question
report (target answer vs student answer, deductions, reasoning) that can
be downloaded as JSON and Markdown.

The heavy lifting lives in pipeline.run_session() - the same code path
used by the grade_exam.py CLI and test_real_exam.py runner.

Run locally:
    pip install -r requirements.txt
    export GEMINI_API_KEY=...
    streamlit run streamlit_app.py
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import streamlit as st

from engine import PENALTY_CATEGORIES
from grade import GradeParams
from pipeline import SessionError, run_session, write_reports

PAGE_ICON = "📝"
MODEL_OPTIONS = [
    "gemini-3.8-flash",      # default: best current Flash, strong vision
    "gemini-3.5-flash-lite", # cheapest, for bulk grading
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
]

UPLOAD_TYPES = ["pdf", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff",
                "txt", "md"]

CRITERIA_HELP = {
    "handwriting": "Bad Handwriting",
    "diagrams": "Flawed / Bad Diagrams",
    "unreadable": "Unreadable / Smudged Data",
    "formatting": "Poor Formatting / Missing Steps",
}

# ---------------------------------------------------------------------------
# Page + theme (matches index.html: #363737 canvas, white text, dim borders)
# ---------------------------------------------------------------------------

st.set_page_config(page_title="Exam Checker", page_icon=PAGE_ICON,
                   layout="wide")

st.markdown(
    """
    <style>
      .stApp, section[data-testid="stAppViewContainer"],
      .main, [data-testid="stHeader"] {
          background: #363737;
      }
      html, body, [class*="css"], .stMarkdown, .stTextInput label {
          color: #FFFFFF;
      }
      [data-testid="stSidebar"] { background: #2f3030; border-right: 1px solid rgba(255,255,255,.08); }
      h1, h2, h3 { color: #FFFFFF !important; letter-spacing: -.02em; }
      [data-testid="stFileUploader"] {
          background: rgba(0,0,0,.12);
          border: 1.5px dashed rgba(255,255,255,.22);
          border-radius: 12px; padding: 10px;
      }
      [data-testid="stFileUploader"]:hover { border-color: rgba(129,199,132,.6); }
      [data-testid="stButton"] > button {
          background: linear-gradient(145deg,#57a674,#4e9a6a);
          color: #0d1a12; font-weight: 800; border: none;
          border-radius: 10px; padding: .65rem 1rem; width: 100%;
      }
      [data-testid="stButton"] > button:hover { filter: brightness(1.08); border: none; }
      [data-testid="stMetric"] {
          background: rgba(0,0,0,.14); border: 1px solid rgba(255,255,255,.10);
          border-radius: 12px; padding: 12px 16px;
      }
      [data-testid="stMetric"] label { color: rgba(255,255,255,.6) !important; }
      [data-testid="stExpander"] {
          background: rgba(0,0,0,.12); border: 1px solid rgba(255,255,255,.10);
          border-radius: 12px; margin-bottom: .55rem;
      }
      .ec-cut  { color: #e57373; font-weight: 700; }
      .ec-good { color: #81c784; font-weight: 700; }
      .ec-note { color: rgba(255,255,255,.62); font-size: .86rem; }
      div[data-testid="stExpander"] summary p { color:#fff; font-weight:650; }
    </style>
    """,
    unsafe_allow_html=True,
)


# ---------------------------------------------------------------------------
# Sidebar: credentials + model
# ---------------------------------------------------------------------------

with st.sidebar:
    st.header("⚙️ Settings")
    api_key = st.text_input(
        "Gemini API Key",
        type="password",
        help="Sent directly to Google's API on each run; never stored. "
             "You can also set the GEMINI_API_KEY environment variable.",
    )
    if not api_key:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    model = st.selectbox("Model", MODEL_OPTIONS, index=0,
                         help="Override with the GEMINI_MODEL env var.")
    st.caption("No API key? Runs with `--mock` are available from the "
               "CLI (text documents only) via test_real_exam.py.")
    st.divider()
    st.caption("📄 pipeline: ingest → vision OCR → question mapping → "
               "rubric grading → JSON/Markdown report")


# ---------------------------------------------------------------------------
# Main: header, upload bay, control panel
# ---------------------------------------------------------------------------

st.title("Exam Checker")
st.caption("Automated grading of real answer sheets — upload a question "
           "paper, the official rubric and the student's script, then let "
           "the vision model transcribe and mark it.")

st.subheader("1 · Document Upload Bay")
c1, c2, c3 = st.columns(3)
with c1:
    paper_file = st.file_uploader("Upload Question Paper",
                                  type=UPLOAD_TYPES,
                                  help="Multi-page PDF or image")
with c2:
    key_file = st.file_uploader("Upload Official Answer Key / Rubric",
                                type=UPLOAD_TYPES)
with c3:
    sheet_file = st.file_uploader("Upload Student Answer Sheet",
                                  type=UPLOAD_TYPES,
                                  help="Scan or photo of handwriting")

uploads = {"paper": paper_file, "key": key_file, "student": sheet_file}
missing = [label for label, f in
           [("Question Paper", paper_file),
            ("Answer Key / Rubric", key_file),
            ("Student Answer Sheet", sheet_file)] if f is None]

ready = not missing
if ready:
    st.success("Ready — all three documents selected: "
               + ", ".join(f.name for f in
                           (paper_file, key_file, sheet_file)))
else:
    st.info("Waiting for: " + ", ".join(missing))

st.subheader("2 · Grading Modes & Parameters")
p1, p2 = st.columns([1, 2])
with p1:
    strict = st.toggle(
        "Strict Checking Mode",
        value=False,
        help="No partial credit; the rubric must be matched exactly.",
    )
with p2:
    st.markdown("**Penalty criteria — deduct marks for**")
    boxes = st.columns(2)
    penalties = set()
    for i, (key, label) in enumerate(CRITERIA_HELP.items()):
        with boxes[i % 2]:
            if st.checkbox(label, key=f"penalty_{key}"):
                penalties.add(key)

run_clicked = st.button("Run AI Evaluation", type="primary",
                        disabled=not ready)

# ---------------------------------------------------------------------------
# Grading session
# ---------------------------------------------------------------------------

def save_uploads(uploads: dict, directory: Path) -> dict[str, Path]:
    """Persist st.file_uploader buffers to disk with their real names."""
    paths = {}
    for role, buffer in uploads.items():
        safe_name = Path(buffer.name).name or f"{role}.txt"
        target = directory / f"{role}_{safe_name}"
        target.write_bytes(buffer.getbuffer())
        paths[role] = target
    return paths


if run_clicked:
    params = GradeParams(strict=strict, penalties=frozenset(penalties),
                         model=model)
    with tempfile.TemporaryDirectory(prefix="examcheck_") as tmp:
        paths = save_uploads(uploads, Path(tmp))
        with st.status("Running AI evaluation…", expanded=True) as status:
            def progress(message: str) -> None:
                st.write(f"• {message}")
            try:
                session = run_session(
                    paths["paper"], paths["key"], paths["student"],
                    api_key=api_key, model=model, params=params,
                    progress=progress,
                )
            except SessionError as exc:
                status.update(label="Evaluation failed", state="error")
                st.error(str(exc))
                st.stop()
            status.update(label="Evaluation complete ✅", state="complete")

        out_dir = Path(tmp)
        json_path, md_path = write_reports(session, out_dir)
        st.session_state["report"] = session.report
        st.session_state["records"] = session.records
        st.session_state["report_json"] = json_path.read_text(encoding="utf-8")
        st.session_state["report_md"] = md_path.read_text(encoding="utf-8")
        st.session_state["warnings"] = session.warnings

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

report = st.session_state.get("report")
if not report:
    st.divider()
    st.caption("The evaluation summary will appear here once a session "
               "finishes.")
    st.stop()

summary = report["summary"]
st.divider()
st.subheader("3 · Detailed Evaluation Summary")

m1, m2, m3, m4 = st.columns(4)
m1.metric("Total Marks", f"{summary['total_marks']:g}")
m2.metric("Marks Obtained", f"{summary['marks_awarded']:g}")
m3.metric("Deducted", f"-{summary['marks_deducted']:g}")
m4.metric("Score", f"{summary['percentage']:g}%")

mode = report["mode"]
st.caption(
    f"Mode: {'STRICT' if mode['strict'] else 'Standard'} · "
    f"Penalties: {', '.join(mode['penalty_criteria']) or 'none'} · "
    f"Engine: {report['engine']} (`{report['model']}`)"
)

warnings = st.session_state.get("warnings") or report.get("warnings") or []
if warnings:
    with st.expander(f"⚠️ {len(warnings)} processing warning(s)"):
        for w in warnings:
            st.write(f"- {w}")

dl1, dl2 = st.columns(2)
dl1.download_button("⬇️ Download report.json",
                    st.session_state["report_json"],
                    file_name="report.json", mime="application/json")
dl2.download_button("⬇️ Download report.md",
                    st.session_state["report_md"],
                    file_name="report.md", mime="text/markdown")

st.subheader("Question-by-Question Breakdown")

for record in report["questions"]:
    perfect = record["marks_deducted"] <= 0
    icon = "✅" if perfect else "🔻"
    title = (f"{icon} Q{record['number']} — "
             f"{record['marks_awarded']:g}/{record['max_marks']:g} marks")
    with st.expander(title, expanded=False):
        t1, t2 = st.columns(2)
        with t1:
            st.markdown("**🎯 Target Answer (Official Key)**")
            st.write(record["expected_answer"])
        with t2:
            st.markdown("**✍️ Student Answer**")
            st.write(record["student_answer"])

        if record["deductions"]:
            lines = []
            for d in record["deductions"]:
                lines.append(f'<span class="ec-cut">−{d["marks"]:g}</span> '
                             f'`{d["category"]}` — {d["reason"]}')
            st.markdown("**Marks deducted**", unsafe_allow_html=True)
            st.markdown("<br>".join(lines), unsafe_allow_html=True)
        else:
            st.markdown('<span class="ec-good">Full marks awarded — '
                        'no deductions.</span>', unsafe_allow_html=True)

        st.markdown(f"**Feedback:** {record['feedback']}")
        if record.get("ocr_note"):
            st.markdown(f'<span class="ec-note">OCR note: '
                        f'{record["ocr_note"]}</span>',
                        unsafe_allow_html=True)
        if record.get("warnings"):
            st.markdown('<span class="ec-note">⚠ ' +
                        " · ".join(record["warnings"]) + "</span>",
                        unsafe_allow_html=True)
