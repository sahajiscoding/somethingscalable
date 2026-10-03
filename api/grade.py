"""Vercel serverless grading endpoint for Exam Checker.

Exposes the real pipeline (ingest -> Gemini vision OCR -> rubric grading)
as an HTTP API because Streamlit (app.py) needs a long-running server and
cannot run on Vercel's serverless platform. Deployed layout:

  /           -> index.html (static frontend on Vercel's CDN)
  /api/grade  -> this function (real AI grading, Gemini via google-genai)

Contract
--------
GET  /api/grade  -> health: {"ok": true, "hasApiKey": bool, "model": str}
POST /api/grade  -> JSON body:
    {
      "paper":   {"filename": "paper.pdf", "data": "<base64>"},
      "key":     {"filename": "key.pdf",   "data": "<base64>"},
      "student": {"filename": "sheet.pdf", "data": "<base64>"},
      "strict": false,
      "penalties": ["handwriting", "diagrams", ...],  # optional
      "model": "gemini-3.8-flash",                    # optional
      "apiKey": "<gemini key>",                       # optional if server env set
      "mock": false                                   # true = offline text-only grading
    }
  -> 200 {"report": {...}, "warnings": [...]}
  -> 4xx/5xx {"error": "..."} on bad input, missing key, or pipeline failure.

Limits: Vercel Hobby caps requests at ~4.5 MB and 10 s wall time. Keep each
file under ~3.5 MB; image/PDF-heavy exams may need Vercel Pro/Fluid (the
function requests maxDuration 60 in vercel.json) or the local Streamlit UI.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Stay under Vercel's ~4.5 MB request cap with headroom for JSON overhead.
MAX_FILE_BYTES = 3_500_000
MAX_BODY_BYTES = 12_000_000

VALID_PENALTIES = {"handwriting", "diagrams", "unreadable", "formatting"}


def _json_body(handler: BaseHTTPRequestHandler):
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        length = 0
    if length <= 0:
        return None, "Empty request body."
    if length > MAX_BODY_BYTES:
        return None, (
            f"Request too large ({length // 1024} KB). Vercel caps requests "
            "at ~4.5 MB — upload smaller files or grade locally."
        )
    try:
        raw = handler.rfile.read(length)
        return json.loads(raw.decode("utf-8")), None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None, "Request body must be valid JSON."


def _decode_upload(role: str, slot) -> tuple[str, bytes] | tuple[None, str]:
    if not isinstance(slot, dict):
        return None, f'Missing "{role}" document (expected filename + base64 data).'
    filename = Path(str(slot.get("filename") or f"{role}.txt")).name or f"{role}.txt"
    data_b64 = slot.get("data") or ""
    if not data_b64:
        return None, f'Document "{role}" has no file data.'
    try:
        data = base64.b64decode(data_b64, validate=True)
    except Exception:
        return None, f'Document "{role}" is not valid base64.'
    if not data:
        return None, f'Document "{role}" decoded to an empty file.'
    if len(data) > MAX_FILE_BYTES:
        return None, (
            f'Document "{role}" is {len(data) // 1024} KB (limit '
            f"{MAX_FILE_BYTES // 1024} KB per file on Vercel). Downscale the "
            "scan or grade locally via `streamlit run app.py`."
        )
    return (filename, data), None


class handler(BaseHTTPRequestHandler):
    server_version = "ExamChecker/1.0"

    def log_message(self, *args):  # keep Vercel logs clean
        pass

    # -- helpers ------------------------------------------------------
    def _send(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # CORS preflight (headers in vercel.json too)
        self.send_response(204)
        self.end_headers()

    # -- health -------------------------------------------------------
    def do_GET(self) -> None:
        from engine import DEFAULT_MODEL

        has_key = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
        self._send(200, {"ok": True, "hasApiKey": has_key, "model": DEFAULT_MODEL})

    # -- grading ------------------------------------------------------
    def do_POST(self) -> None:
        from engine import DEFAULT_MODEL
        from grade import GradeParams
        from pipeline import SessionError, run_session

        payload, err = _json_body(self)
        if err:
            self._send(400 if "too large" not in err.lower() else 413, {"error": err})
            return

        mock = bool(payload.get("mock", False))
        uploads: dict[str, tuple[str, bytes]] = {}
        for role in ("paper", "key", "student"):
            decoded, derr = _decode_upload(role, payload.get(role))
            if derr:
                self._send(400, {"error": derr})
                return
            uploads[role] = decoded

        penalties = {p for p in (payload.get("penalties") or []) if p in VALID_PENALTIES}
        params = GradeParams(strict=bool(payload.get("strict", False)), penalties=frozenset(penalties))

        api_key = (
            payload.get("apiKey")
            or self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
        )
        model = payload.get("model") or DEFAULT_MODEL

        if not mock and not api_key:
            self._send(401, {
                "error": "No Gemini API key. Send \"apiKey\" in the request or set "
                         "GEMINI_API_KEY in Vercel Project Settings → Environment Variables."
            })
            return

        try:
            with tempfile.TemporaryDirectory(prefix="examcheck_") as tmp:
                paths = {}
                for role, (filename, data) in uploads.items():
                    target = Path(tmp) / f"{role}_{filename}"
                    target.write_bytes(data)
                    paths[role] = target
                session = run_session(
                    paths["paper"], paths["key"], paths["student"],
                    api_key=api_key, model=model, mock=mock, params=params,
                )
        except SessionError as exc:
            self._send(422, {"error": str(exc)})
            return
        except Exception:  # pragma: no cover - defensive 500 with trace id
            traceback.print_exc()
            self._send(500, {"error": "Grading failed unexpectedly. Try smaller files or grade locally."})
            return

        self._send(200, {"report": session.report, "warnings": session.warnings})
