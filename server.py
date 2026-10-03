"""WeHelpTeachers web server (Flask) — the deployed backend.

Same proven layout as the reference AI project: one Flask WSGI app,
re-exported from ``api/index.py`` for Vercel. API keys live ONLY in the
environment (``NVIDIA_API_KEY``) — they are never
hardcoded, never committed, and never sent to the browser.

Split-pipeline endpoints keep every call to ~1 LLM request so capped hosts
(Vercel's 60 s functions) don't time out mid-grade; the frontend
orchestrates them and falls back to its offline demo when unreachable::

    GET  /               -> index.html (APP_SECRET injected when set)
    GET  /api/health     -> {ok, hasApiKey, model}
    POST /api/extract    -> one document (multipart file+role) -> JSON
    POST /api/align      -> extraction JSON -> aligned questions (pure code)
    POST /api/grade-one  -> one aligned question -> one graded record
    POST /api/report     -> records + meta -> full report + markdown

Local dev: put keys in ``.env``, then ``python server.py``.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from types import SimpleNamespace

from flask import Flask, Response, jsonify, request

try:
    from dotenv import load_dotenv
except ImportError:  # optional locally; Vercel injects env itself
    load_dotenv = None

# Load keys ONLY from the .env file next to this server — never from any
# other path or project.
_BASE_DIR = Path(__file__).resolve().parent
if load_dotenv is not None:
    load_dotenv(_BASE_DIR / ".env")

from engine import (  # noqa: E402
    NVIDIA_DEFAULT_MODEL,
    PENALTY_CATEGORIES,
    EngineError,
    get_nvidia_key,
    make_engine,
)
from extract import (  # noqa: E402
    ExtractionError,
    KeyEntry,
    QuestionSpec,
    StudentAnswer,
    align_questions,
    alignment_warnings,
    extract_key,
    extract_paper,
    extract_student,
)
from grade import GradeParams, grade_one_record, summarise  # noqa: E402
from ingest import IngestError, load_document  # noqa: E402
from report import build_report, render_markdown  # noqa: E402

app = Flask(__name__)

# Optional shared-secret protection for /api (same as the reference project).
# If APP_SECRET is set, every /api call must carry it as X-App-Secret;
# unset = open access. Stops strangers from burning your NVIDIA quota.
APP_SECRET = os.environ.get("APP_SECRET", "").strip()

_INDEX_HTML = _BASE_DIR / "index.html"
_SECRET_TOKEN = "__VERCEL_APP_SECRET__"

# React + Tailwind frontend (frontend/dist). When the Vite build exists it is
# served as the whole website; otherwise the legacy static index.html is used.
_DIST_DIR = _BASE_DIR / "frontend" / "dist"
_DIST_INDEX = _DIST_DIR / "index.html"


@app.before_request
def _guard_api():
    if not APP_SECRET or not request.path.startswith("/api/"):
        return None
    if request.headers.get("X-App-Secret") != APP_SECRET:
        print(f"[auth] rejected {request.method} {request.path}")
        return jsonify({"error": "Missing or invalid X-App-Secret header."}), 401
    return None


def _js_escape(value: str) -> str:
    return (value.replace("\\", "\\\\").replace('"', '\\"')
                 .replace("\n", "").replace("</", "<\\/"))


def _has_key() -> bool:
    return bool(get_nvidia_key())


def _api_error(exc: Exception):
    """Map pipeline exceptions to JSON error responses."""
    if isinstance(exc, (IngestError, ExtractionError)):
        return jsonify({"error": str(exc)}), 400
    if isinstance(exc, EngineError):
        if "429" in str(exc):
            return jsonify({
                "error": "NVIDIA is rate-limiting the model right now (429). "
                         "Wait a moment and try again."}), 429
        return jsonify({"error": str(exc)}), 502
    return jsonify({"error": f"Could not reach the API: {exc}"}), 502


def _params(body: dict) -> GradeParams:
    penalties = {p for p in (body.get("penalties") or [])
                 if p in PENALTY_CATEGORIES}
    strict = str(body.get("strict") or "").strip().lower() in (
        "1", "true", "yes", "on")
    return GradeParams(strict=strict, penalties=frozenset(penalties))


def _model(body: dict) -> str | None:
    return (body.get("model") or "").strip() or None


def _backend(body) -> str | None:
    get = body.get if isinstance(body, dict) else (lambda k, d=None: d)
    value = (get("backend") or "").strip() or None
    return value or "nvidia"


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    # The page carries APP_SECRET (when set) so the same-origin frontend can
    # attach it to /api calls — direct API abuse without loading the page
    # stays locked out while the app keeps working for real users.
    page = _DIST_INDEX if _DIST_INDEX.exists() else _INDEX_HTML
    html = page.read_text(encoding="utf-8")
    if _SECRET_TOKEN in html:
        html = html.replace(_SECRET_TOKEN, _js_escape(APP_SECRET))
    return Response(html, mimetype="text/html")


@app.get("/assets/<path:filename>")
def frontend_assets(filename: str):
    # Hashed Vite bundles for the React frontend (long-cacheable).
    safe = Path(filename).name and filename.replace("\\", "/")
    path = _DIST_DIR / "assets" / Path(*safe.split("/"))
    try:
        resolved = path.resolve()
        if _DIST_DIR.resolve() not in resolved.parents or not resolved.is_file():
            return jsonify({"error": "Not found."}), 404
    except (OSError, ValueError):
        return jsonify({"error": "Not found."}), 404
    mimetype = "text/javascript" if resolved.suffix == ".js" else "text/css" if resolved.suffix == ".css" else "application/octet-stream"
    return Response(resolved.read_bytes(), mimetype=mimetype,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------------------------------------------------------------------------
# Standard site files (robots, llms.txt, sitemap, manifest, icons, humans,
# security contact) — served by Flask so local dev and Vercel behave the same.
# ---------------------------------------------------------------------------

_SITE_FILES = {
    "llms.txt": ("llms.txt", "text/markdown"),
    "humans.txt": ("humans.txt", "text/plain"),
    "security.txt": ("security.txt", "text/plain"),
    "site.webmanifest": ("site.webmanifest", "application/manifest+json"),
    "favicon.svg": ("favicon.svg", "image/svg+xml"),
}

_CACHE_DAY = {"Cache-Control": "public, max-age=86400"}


def _site_file(filename: str, mimetype: str):
    path = _BASE_DIR / filename
    if not path.exists():
        return jsonify({"error": "Not found."}), 404
    return Response(path.read_bytes(), mimetype=mimetype, headers=_CACHE_DAY)


@app.get("/llms.txt")
def llms_txt():
    return _site_file(*_SITE_FILES["llms.txt"])


@app.get("/humans.txt")
def humans_txt():
    return _site_file(*_SITE_FILES["humans.txt"])


@app.get("/.well-known/security.txt")
def security_txt():
    return _site_file(*_SITE_FILES["security.txt"])


@app.get("/site.webmanifest")
def webmanifest():
    return _site_file(*_SITE_FILES["site.webmanifest"])


@app.get("/favicon.svg")
def favicon_svg():
    return _site_file(*_SITE_FILES["favicon.svg"])


@app.get("/favicon.ico")
def favicon_ico():
    # No .ico asset — browsers accept the SVG here.
    return _site_file(*_SITE_FILES["favicon.svg"])


@app.get("/patternwaves-bg.js")
def patternwaves_js():
    # Vanilla-JS port of the React Bits PatternWaves component (ES module,
    # imports ogl from CDN). Served here so local dev and Vercel behave the same.
    path = _BASE_DIR / "patternwaves-bg.js"
    if not path.exists():
        return jsonify({"error": "Not found."}), 404
    return Response(path.read_bytes(), mimetype="text/javascript",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/robots.txt")
def robots_txt():
    # Absolute sitemap URL needs the live host, so it is injected per request.
    text = (_BASE_DIR / "robots.txt").read_text(encoding="utf-8")
    return Response(text.replace("__HOST__", request.host),
                    mimetype="text/plain", headers=_CACHE_DAY)


@app.get("/sitemap.xml")
def sitemap_xml():
    xml = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
           f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           f'  <url><loc>https://{request.host}/</loc>'
           f'<changefreq>weekly</changefreq><priority>1.0</priority></url>\n'
           f'</urlset>\n')
    return Response(xml, mimetype="application/xml", headers=_CACHE_DAY)


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "hasApiKey": _has_key(),
                    "hasNvidiaKey": bool(get_nvidia_key()),
                    "model": NVIDIA_DEFAULT_MODEL})


# ---------------------------------------------------------------------------
# Split pipeline
# ---------------------------------------------------------------------------

_EXTRACT_KEYS = {"paper": "questions", "key": "entries", "student": "answers"}


@app.post("/api/extract")
def api_extract():
    """One vision-extraction call for a single document (multipart)."""
    role = (request.form.get("role") or "").strip()
    if role not in _EXTRACT_KEYS:
        return jsonify({"error": 'role must be "paper", "key" or "student".'}), 400
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"error": "Upload a file."}), 400
    data = upload.read()
    if not data:
        return jsonify({"error": f"{upload.filename} arrived empty — retry the upload."}), 400
    if len(data) > 10 * 1024 * 1024:
        return jsonify({"error": f"{upload.filename} exceeds 10 MB."}), 400

    try:
        with tempfile.TemporaryDirectory(prefix="examcheck_") as tmp:
            safe = Path(upload.filename).name or f"{role}.bin"
            target = Path(tmp) / f"{role}_{safe}"
            target.write_bytes(data)
            doc = load_document(target, role)
            engine = make_engine(model=_model(request.form),
                                 backend=_backend(request.form))
            if role == "paper":
                items = [q.to_dict() for q in extract_paper(engine, doc)]
            elif role == "key":
                items = [e.to_dict() for e in extract_key(engine, doc)]
            else:
                items = [a.to_dict() for a in extract_student(engine, doc)]
    except Exception as exc:  # noqa: BLE001 - mapped to JSON below
        return _api_error(exc)
    return jsonify({"role": role, "filename": doc.filename, "kind": doc.kind,
                    "pages": doc.page_count, "warnings": doc.warnings,
                    "data": {_EXTRACT_KEYS[role]: items}})


def _rebuild(spec_cls, fields: tuple, rows) -> list:
    if not isinstance(rows, list):
        raise ValueError("extraction payload must be a list.")
    out = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("extraction payload must be a list of objects.")
        out.append(spec_cls(**{k: row.get(k) for k in fields if k in row}))
    return out


@app.post("/api/align")
def api_align():
    """Map extraction JSON onto question numbers (pure code, instant)."""
    body = request.get_json(silent=True) or {}
    try:
        paper = _rebuild(QuestionSpec,
                         ("number", "text", "max_marks", "page"),
                         body.get("paper"))
        key = _rebuild(KeyEntry,
                       ("number", "expected_answer", "marking_scheme",
                        "page", "keywords"),
                       body.get("key"))
        student = _rebuild(StudentAnswer,
                           ("number", "response", "page", "legibility",
                            "uncertain_spans"),
                           body.get("student"))
    except (ValueError, TypeError) as exc:
        return jsonify({"error": f"Malformed extraction payload: {exc}"}), 400
    aligned = align_questions(paper, key, student)
    if not aligned:
        return jsonify({
            "error": "No questions could be aligned across the three documents."}), 422
    return jsonify({"aligned": [q.to_payload() for q in aligned],
                    "warnings": alignment_warnings(aligned),
                    "documents": body.get("documents") or {},
                    "model": _model(body) or NVIDIA_DEFAULT_MODEL})


@app.post("/api/grade-one")
def api_grade_one():
    """Grade exactly one aligned question (one LLM call)."""
    body = request.get_json(silent=True) or {}
    question = body.get("question") or {}
    if not isinstance(question, dict) or not question.get("number"):
        return jsonify({"error": "question (with number) is required."}), 400
    try:
        engine = make_engine(model=_model(body), backend=_backend(body))
        record = grade_one_record(engine, question, _params(body))
    except Exception as exc:  # noqa: BLE001 - mapped to JSON below
        return _api_error(exc)
    return jsonify({"record": record})


@app.post("/api/report")
def api_report():
    """Assemble records into the canonical report + markdown (pure code)."""
    body = request.get_json(silent=True) or {}
    records = body.get("records")
    if not isinstance(records, list) or not records:
        return jsonify({"error": "records (non-empty list) is required."}), 400
    docs = {}
    for role, meta in ((body.get("documents") or {}).items()):
        meta = meta or {}
        docs[role] = SimpleNamespace(
            filename=meta.get("file") or f"{role}",
            kind=meta.get("kind") or "unknown",
            page_count=meta.get("pages") or 0,
        )
    params = _params(body)
    summary = summarise(records)
    report = build_report(
        records, summary,
        engine_name=body.get("engine") or "nvidia",
        model=body.get("model") or NVIDIA_DEFAULT_MODEL,
        params=params, documents=docs,
        warnings=body.get("warnings") or [],
    )
    return jsonify({"report": report, "markdown": render_markdown(report)})


@app.post("/api/generate-exam")
def api_generate_exam():
    """Generate a question paper and matching answer key using Kimi-K3."""
    body = request.get_json(silent=True) or {}
    topic = (body.get("topic") or "Mathematics & Physics").strip()
    grade = (body.get("grade") or "High School").strip()
    try:
        count = int(body.get("count") or 5)
    except (ValueError, TypeError):
        count = 5
    try:
        marks = float(body.get("marks") or 25.0)
    except (ValueError, TypeError):
        marks = 25.0
    difficulty = (body.get("difficulty") or "Medium").strip()

    instruction = (
        f"You are an expert exam author. Generate a high-quality exam and marking key on '{topic}' "
        f"for grade/level: '{grade}'. Total questions: {count}. Total marks: {marks:g}. "
        f"Difficulty: {difficulty}.\n"
        "Return STRICT JSON only matching this schema:\n"
        "{\n"
        '  "title": "Exam Title",\n'
        '  "topic": "Subject/Topic",\n'
        '  "instructions": "General instructions for candidates",\n'
        f'  "total_marks": {marks:g},\n'
        '  "questions": [\n'
        '    {\n'
        '      "number": "Q1",\n'
        '      "text": "Clear question text",\n'
        '      "max_marks": 5.0,\n'
        '      "expected_answer": "Complete target model answer",\n'
        '      "marking_scheme": "Step-by-step marking breakdown (e.g. 2 marks for formula, 3 marks for solution)",\n'
        '      "keywords": ["keyword1", "keyword2"]\n'
        '    }\n'
        '  ]\n'
        "}\n"
    )
    try:
        engine = make_engine(model=_model(body), backend=_backend(body))
        generated = engine.generate_json("generate_exam", instruction=instruction)
    except Exception as exc:  # noqa: BLE001
        if not _has_key():
            per_q = round(marks / count, 1)
            generated = {
                "title": f"{topic} Examination",
                "topic": topic,
                "instructions": "Answer all questions. Show complete working steps.",
                "total_marks": marks,
                "questions": [
                    {
                        "number": f"Q{i}",
                        "text": f"Explain the core principles of {topic} for problem {i}, detailing all necessary equations and steps.",
                        "max_marks": per_q,
                        "expected_answer": f"Model theoretical formulation and calculation for {topic} problem {i}.",
                        "marking_scheme": f"Formula & definitions: {round(per_q*0.4, 1)}m; Calculation: {round(per_q*0.4, 1)}m; Final: {round(per_q*0.2, 1)}m.",
                        "keywords": [topic.split()[0].lower(), "derivation", "formula"]
                    }
                    for i in range(1, count + 1)
                ]
            }
            return jsonify({
                "ok": True,
                "exam": generated,
                "model": "offline-template",
                "note": "Generated with offline template; set NVIDIA_API_KEY in Vercel for live Kimi-K3 generation."
            })
        return _api_error(exc)
    return jsonify({
        "ok": True,
        "exam": generated,
        "model": getattr(engine, "model", NVIDIA_DEFAULT_MODEL),
    })


@app.errorhandler(500)
def internal_error(_exc):
    return jsonify({"error": "Internal server error."}), 500


@app.errorhandler(413)
def too_large(_exc):
    return jsonify({"error": "Upload too large — this host caps request size "
                             "(Vercel: 4.5 MB). Compress the photos."}), 413


if __name__ == "__main__":
    import socket

    port = int(os.environ.get("PORT", 5050))
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("0.0.0.0", port))
        probe.close()
    except OSError:
        fallback = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        fallback.bind(("0.0.0.0", 0))
        port = fallback.getsockname()[1]
        fallback.close()
        print(f"* Port busy — serving on {port} instead.")
    app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
