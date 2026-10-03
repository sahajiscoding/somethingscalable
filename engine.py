"""LLM engines for Exam Checker.

Three interchangeable engines expose the same interface:

* ``GeminiEngine`` - the real OCR/vision + grading engine built on the
  unified Google GenAI SDK (``google-genai``).  It sends PDF pages and
  images straight to Gemini, which transcribes handwriting and printed
  text and returns schema-shaped JSON.
* ``NvidiaEngine`` - OCR/vision + grading through NVIDIA NIM
  (``https://integrate.api.nvidia.com``, OpenAI-compatible).  Standard
  library only (``urllib``), no extra dependency.  Any ``nvapi-...`` key
  selects it automatically; text + images are fully supported, PDFs fall
  back to their text layer.
* ``MockEngine`` - a fully offline engine used by
  ``test_real_exam.py --mock`` so the whole pipeline can be exercised
  without an API key (text documents only; token-overlap scoring).

Interface (both engines)::

    engine.generate_json(task, document=..., data=..., instruction=...)
        -> dict | list   # task in {"extract_paper", "extract_key",
                         #          "extract_student", "grade"}
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from typing import Any

# Model defaults.  Gemini 3.8 Flash is the current recommended Flash model;
# override with the GEMINI_MODEL env var (e.g. gemini-3.5-flash-lite for
# cheaper bulk grading).
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")

# NVIDIA NIM (OpenAI-compatible chat-completions endpoint) — same proven
# setup as the reference AI project: MiniMax-M3 reads the pages and grades
# (vision + JSON). Override the model with NVIDIA_MODEL; any vision-capable
# NIM id works.
NIM_ENDPOINT = os.environ.get(
    "NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
NVIDIA_DEFAULT_MODEL = os.environ.get("NVIDIA_MODEL", "minimaxai/minimax-m3")
# Per-request HTTP timeout; Vercel kills functions at 60 s wall time, so this
# stays just under it and failures come back as clean errors, not hangs.
_NIM_TIMEOUT = 55
# Rendered-PDF page cap (same as the reference project).
_NVIDIA_MAX_PDF_PAGES = 15

# NVIDIA's free tier allows ~40 requests/minute per key. A token bucket
# refilled at NVIDIA_RPM/min (default 39) serialises bursts — parallel page
# OCR, per-question grading calls — so callers wait instead of tripping 429s.
try:
    NVIDIA_RPM = int(os.environ.get("NVIDIA_RPM", 39))
except ValueError:  # a bad env value must never crash the import
    NVIDIA_RPM = 39
_bucket_lock = threading.Lock()
_bucket_tokens = float(NVIDIA_RPM)
_bucket_last: float | None = None


def _acquire_nvidia_token() -> None:
    """Block until a rate-limit token is available, then consume it."""
    import time
    global _bucket_tokens, _bucket_last
    while True:
        with _bucket_lock:
            now = time.monotonic()
            if _bucket_last is None:
                _bucket_last = now
            _bucket_tokens = min(
                float(NVIDIA_RPM),
                _bucket_tokens + (now - _bucket_last) * NVIDIA_RPM / 60.0,
            )
            _bucket_last = now
            if _bucket_tokens >= 1.0:
                _bucket_tokens -= 1.0
                return
            wait = (1.0 - _bucket_tokens) * 60.0 / NVIDIA_RPM
        time.sleep(min(max(wait, 0.05), 2.0))


def _get_pdf_renderer():
    """Lazy PyMuPDF import — heavy and optional (text fallback otherwise)."""
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        return None


def _pdf_text_fallback(document) -> str:
    """Pull the PDF text layer with pypdf when PyMuPDF is unavailable."""
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise EngineError(
            "pypdf is required for PDF input. "
            "Install dependencies with: pip install -r requirements.txt"
        ) from exc
    import io

    texts: list[str] = []
    for chunk in document.pages:
        try:
            reader = PdfReader(io.BytesIO(chunk.data))
            texts.extend([(p.extract_text() or "") for p in reader.pages])
        except Exception as exc:
            raise EngineError(
                f"Could not read PDF {document.filename}: {exc}") from exc
    text = "\n".join(t.strip() for t in texts if t and t.strip())
    if not text:
        raise EngineError(
            f"{document.filename} looks like a scanned/image-only PDF. Without "
            "PyMuPDF it cannot be rendered — install pymupdf, upload the pages "
            "as JPG/PNG images, or use the Gemini engine."
        )
    return (f"Document text ({document.filename}, PDF text layer):\n---\n"
            f"{text}\n---")

SYSTEM_INSTRUCTION = (
    "You are an exam-processing engine that answers strictly with valid JSON. "
    "Never wrap the JSON in markdown fences, never add commentary, and never "
    "invent fields that were not requested."
)

PENALTY_CATEGORIES = {
    "handwriting": "Bad handwriting / illegible script",
    "diagrams": "Flawed or bad diagrams",
    "unreadable": "Unreadable or smudged data",
    "formatting": "Poor formatting / missing steps",
}


class EngineError(RuntimeError):
    """Raised when the engine cannot produce a usable result."""


# ---------------------------------------------------------------------------
# Real engine: Gemini via the unified google-genai SDK
# ---------------------------------------------------------------------------

class GeminiEngine:
    """Vision + grading through the Gemini API."""

    name = "gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        key = (api_key
               or os.environ.get("GEMINI_API_KEY")
               or os.environ.get("GOOGLE_API_KEY"))
        if not key:
            raise EngineError(
                "No Gemini API key found. Set GEMINI_API_KEY (or NVIDIA_API_KEY "
                "to use NVIDIA NIM instead) or pass --api-key."
            )
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise EngineError(
                "The google-genai package is not installed. "
                "Install dependencies with: pip install -r requirements.txt"
            ) from exc

        self._types = types
        self.client = genai.Client(api_key=key)
        self.model = model or DEFAULT_MODEL

    # -- public API ---------------------------------------------------------

    def generate_json(self,
                      task: str,
                      document: Any = None,
                      data: Any = None,
                      instruction: str = "",
                      temperature: float = 0.15,
                      max_attempts: int = 3) -> Any:
        types = self._types
        contents = self._build_contents(instruction, document, data)
        config = types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=16384,
            response_mime_type="application/json",
            system_instruction=SYSTEM_INSTRUCTION,
        )

        last_error = "unknown parse error"
        for _ in range(max_attempts):
            try:
                response = self.client.models.generate_content(
                    model=self.model, contents=contents, config=config
                )
            except Exception as exc:
                raise EngineError(
                    f"Gemini API call failed ({task}): {exc}"
                ) from exc

            text = (response.text or "").strip()
            if not text:
                last_error = "empty response (possibly blocked by safety filters)"
            else:
                parsed, last_error = _parse_json(text)
                if parsed is not None:
                    return parsed
            contents = list(contents) + [
                f"Your previous reply was not valid JSON ({last_error}). "
                "Reply again with the corrected JSON only."
            ]

        raise EngineError(
            f"Engine returned unparseable JSON for task '{task}': {last_error}"
        )

    # -- helpers ------------------------------------------------------------

    def _build_contents(self, instruction: str, document: Any, data: Any):
        types = self._types
        contents: list[Any] = [instruction]

        if document is not None:
            if document.kind == "text":
                contents.append(
                    f"Document text ({document.filename}):\n---\n"
                    f"{document.text}\n---"
                )
            else:
                for page in document.pages:
                    contents.append(types.Part.from_bytes(
                        data=page.data, mime_type=page.mime
                    ))
        if data is not None:
            contents.append(
                "Input data:\n" + json.dumps(data, ensure_ascii=False, indent=2)
            )
        return contents


# ---------------------------------------------------------------------------
# NVIDIA NIM engine: OpenAI-compatible chat-completions, stdlib only
# ---------------------------------------------------------------------------

class NvidiaEngine:
    """Vision + grading through NVIDIA NIM (api.nvidia.com).

    Same proven setup as the reference AI project: MiniMax-M3 reads the
    pages and grades (vision + JSON), HTTP via ``requests``. The key comes
    ONLY from the ``NVIDIA_API_KEY`` environment variable — it is never
    hardcoded. Any ``nvapi-...`` key selects this engine automatically via
    :func:`make_engine`; override with ``backend="nvidia"``.

    Images go over as base64 data-URL blocks. PDF pages are rendered to PNG
    with PyMuPDF (digital pages with enough embedded text ride along as
    text instead), so scanned handwriting works — the case a text-layer
    fallback could never handle.
    """

    name = "nvidia"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        key = api_key or os.environ.get("NVIDIA_API_KEY")
        if not key:
            raise EngineError(
                "No NVIDIA API key found. Set NVIDIA_API_KEY or pass --api-key "
                "(keys start with 'nvapi-')."
            )
        self.key = key
        self.model = model or NVIDIA_DEFAULT_MODEL

    # -- public API ---------------------------------------------------------

    def generate_json(self,
                      task: str,
                      document: Any = None,
                      data: Any = None,
                      instruction: str = "",
                      temperature: float = 0.15,
                      max_attempts: int = 3) -> Any:
        messages = self._build_messages(instruction, document, data)

        last_error = "unknown parse error"
        for _ in range(max_attempts):
            text = self._chat(messages, temperature)  # raises on HTTP failure
            if not (text or "").strip():
                last_error = "empty response"
            else:
                parsed, last_error = _parse_json(text)
                if parsed is not None:
                    return parsed
            messages = list(messages) + [{
                "role": "user",
                "content": (f"Your previous reply was not valid JSON ({last_error}). "
                            "Reply again with the corrected JSON only."),
            }]

        raise EngineError(
            f"Engine returned unparseable JSON for task '{task}': {last_error}"
        )

    # -- helpers ------------------------------------------------------------

    def _build_messages(self, instruction: str, document: Any, data: Any):
        messages: list[Any] = [
            {"role": "system", "content": SYSTEM_INSTRUCTION}
        ]
        content: list[Any] = [{"type": "text", "text": instruction}]

        if document is not None:
            if document.kind == "text":
                content.append({
                    "type": "text",
                    "text": (f"Document text ({document.filename}):\n---\n"
                             f"{document.text}\n---"),
                })
            elif document.kind == "image":
                page = document.pages[0]
                content.append(
                    self._image_block(document.filename, page.mime, page.data))
            else:  # pdf: digital pages as text, scanned pages as PNG images
                content.extend(self._pdf_blocks(document))
        if data is not None:
            content.append({
                "type": "text",
                "text": "Input data:\n" + json.dumps(data, ensure_ascii=False,
                                                      indent=2),
            })
        messages.append({"role": "user", "content": content})
        return messages

    @staticmethod
    def _image_block(filename: str, mime: str, data: bytes) -> dict:
        import base64

        if len(data) > 8 * 1024 * 1024:
            raise EngineError(
                f"{filename} is {len(data) // 1024} KB — too large to send. "
                "Compress/downscale the image and retry."
            )
        b64 = base64.b64encode(data).decode("ascii")
        return {"type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"}}

    @staticmethod
    def _pdf_blocks(document) -> list[dict]:
        """One content block per PDF page: embedded text for digital pages,
        a rendered PNG for scanned ones (handwriting lives here)."""
        fitz = _get_pdf_renderer()
        if fitz is None:
            return [{"type": "text", "text": _pdf_text_fallback(document)}]

        blocks: list[dict] = []
        page_no = 0
        try:
            for chunk in document.pages:
                with fitz.open(stream=chunk.data, filetype="pdf") as doc:
                    for page in doc:
                        page_no += 1
                        if page_no > _NVIDIA_MAX_PDF_PAGES:
                            raise EngineError(
                                f"{document.filename} has more than "
                                f"{_NVIDIA_MAX_PDF_PAGES} pages — split it and "
                                "grade the parts separately."
                            )
                        text = (page.get_text() or "").strip()
                        if len(text) >= 40:
                            blocks.append({
                                "type": "text",
                                "text": (f"--- {document.filename} page "
                                         f"{page_no} (text) ---\n{text}"),
                            })
                        else:
                            png = page.get_pixmap(dpi=150).tobytes("png")
                            blocks.append(NvidiaEngine._image_block(
                                f"{document.filename} p{page_no}",
                                "image/png", png))
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(
                f"Could not read PDF {document.filename}: {exc}") from exc
        if not blocks:
            raise EngineError(f"No pages found in {document.filename}.")
        return blocks

    def _chat(self, messages: list[Any], temperature: float) -> str:
        import time

        try:
            import requests
        except ImportError as exc:
            raise EngineError(
                "The requests package is not installed. "
                "Install dependencies with: pip install -r requirements.txt"
            ) from exc

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": 4096,
            "stream": False,
        }
        headers = {"Authorization": f"Bearer {self.key}",
                   "Accept": "application/json"}
        _acquire_nvidia_token()
        last = "no response"
        for attempt in range(2):
            try:
                resp = requests.post(NIM_ENDPOINT, headers=headers,
                                     json=payload, timeout=_NIM_TIMEOUT)
            except requests.RequestException as exc:
                raise EngineError(f"NVIDIA API unreachable: {exc}") from exc
            if resp.status_code == 200:
                try:
                    return (resp.json()["choices"][0]["message"]["content"]
                            or "")
                except (KeyError, IndexError, TypeError) as exc:
                    raise EngineError(
                        "NVIDIA API returned an unexpected payload: "
                        f"{exc}") from exc
            if resp.status_code in (401, 403):
                raise EngineError(
                    f"NVIDIA API rejected the key (HTTP {resp.status_code}). "
                    "Check NVIDIA_API_KEY."
                )
            if resp.status_code == 404:
                raise EngineError(
                    f"NVIDIA API has no model '{self.model}' (HTTP 404). "
                    "Set NVIDIA_MODEL to a hosted NIM id."
                )
            last = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if resp.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                time.sleep(5)
                _acquire_nvidia_token()
                continue
            if resp.status_code == 429:
                raise EngineError(
                    "NVIDIA API rate limit (HTTP 429) — the free tier allows "
                    "~40 req/min. Wait a moment and retry."
                )
            raise EngineError(f"NVIDIA API call failed: {last}")
        raise EngineError(f"NVIDIA API call failed after retry: {last}")


# ---------------------------------------------------------------------------
# Offline engine: deterministic, no API key, text documents only
# ---------------------------------------------------------------------------

_BLOCK_RE = re.compile(r"^\s*(?:Q\s*)?(\d+)\s*[.\):\-]\s*(.*)$", re.IGNORECASE)
_MAX_MARKS_RE = re.compile(
    r"[\(\[]\s*(\d+(?:\.\d+)?)\s*marks?\s*[\)\]]", re.IGNORECASE
)
_STOPWORDS = {
    "the", "a", "an", "of", "and", "or", "to", "in", "is", "it", "that",
    "for", "on", "with", "as", "at", "by", "be", "this", "are", "was",
}


class MockEngine:
    """Fully offline stand-in for Gemini.

    Reads numbered blocks out of *text* documents and scores answers by
    token overlap with the answer key (rounded to half marks, floored in
    strict mode).  It exists so ``test_real_exam.py --mock`` can verify the
    whole ingest -> extract -> align -> grade -> report pipeline without
    credentials - not to produce meaningful grades.
    """

    name = "mock"

    def __init__(self, model: str | None = None):
        self.model = model or "mock-offline"

    def generate_json(self,
                      task: str,
                      document: Any = None,
                      data: Any = None,
                      instruction: str = "",
                      **_kwargs) -> Any:
        if task in ("extract_keywords", "extract_expected_answer"):
            return self._extract_searched(task, data or {})
        if task in ("extract_paper", "extract_key", "extract_student"):
            return self._extract(task, document)
        if task == "grade":
            return self._grade(data or {})
        raise EngineError(f"MockEngine does not support task '{task}'")

    # -- extraction ---------------------------------------------------------

    def _extract(self, task: str, document: Any) -> dict:
        if document is None or document.kind != "text" or not document.text:
            raise EngineError(
                "Mock engine can only read plain-text documents. "
                "Set GEMINI_API_KEY (or drop --mock) to OCR scanned PDFs "
                "and images."
            )
        blocks = _parse_blocks(document.text)

        if task == "extract_paper":
            questions = []
            for num, raw in blocks.items():
                text, marks = strip_marks(raw)
                questions.append({
                    "number": num, "text": text,
                    "max_marks": marks, "page": 1,
                })
            return {"questions": questions}

        if task == "extract_key":
            return {"entries": [
                {"number": num, "expected_answer": raw,
                 "marking_scheme": [], "page": 1}
                for num, raw in blocks.items()
            ]}

        answers = []
        for num, raw in blocks.items():
            low = raw.lower()
            if "illegible" in low or "smudge" in low or "??" in low:
                legibility = "poor"
            elif len(_tokens(raw)) < 5:
                legibility = "fair"
            else:
                legibility = "good"
            answers.append({
                "number": num, "response": raw, "page": 1,
                "legibility": legibility, "uncertain_spans": [],
            })
        return {"answers": answers}

    # -- web-search extraction (offline stand-in) ---------------------------

    def _extract_searched(self, task: str, data: dict) -> dict:
        """Offline stand-in for web-search keyword / answer extraction.

        Returns keywords parsed from the text, or the search-result blob
        itself as the expected answer, using the question text as source.
        """
        from search import heuristic_keywords
        text = str(data.get("text") or data.get("search_results") or "")
        if task == "extract_keywords":
            return {"keywords": heuristic_keywords(text)}
        if task == "extract_expected_answer":
            return {"expected_answer": text[:500].strip() if text else ""}
        return {}

    # -- grading: keyword coverage (offline mock path) ---------------------

    def _grade_keywords(self, keywords: list[str], answer: str,
                        max_marks: float, strict: bool,
                        penalties: set[str], legibility: str
                        ) -> tuple[float, list[dict], str]:
        """Score by keyword coverage.

        Returns ``(awarded, deductions, mode_label)``.  Awards
        ``coverage * max_marks`` clamped to half-marks (floored in strict
        mode); missing keywords are deducted as ``content``.
        """
        answer_lower = (answer or "").lower()
        matched = [kw for kw in keywords if kw.lower() in answer_lower]
        total = len(keywords) if keywords else 1
        coverage = len(matched) / total if total else 0.0

        raw = coverage * max_marks
        step = 0.5
        content_awarded = (math.floor(raw / step) * step if strict
                           else round(raw / step) * step)
        content_awarded = max(0.0, min(max_marks, content_awarded))

        deductions: list[dict] = []
        content_deduct = round(max_marks - content_awarded, 2)
        if content_deduct > 0:
            missing = [kw for kw in keywords
                       if kw.lower() not in answer_lower]
            if missing:
                reason = f"Missing keywords: {', '.join(missing)}"
            else:
                reason = (f"keyword coverage {len(matched)}/{total} "
                          "lower than full marks")
            deductions.append({
                "category": "content",
                "marks": content_deduct,
                "reason": reason,
            })

        remaining = content_awarded
        poor = legibility in ("poor", "unreadable") or not answer.strip()
        tokens = _tokens(answer)

        def take(category: str, amount: float, reason: str) -> None:
            nonlocal remaining
            if category not in penalties or remaining <= 0:
                return
            amount = min(amount, remaining)
            if amount <= 0:
                return
            remaining = round(remaining - amount, 2)
            deductions.append({"category": category, "marks": amount,
                               "reason": reason})

        if poor:
            take("handwriting", 0.5,
                 "handwriting penalties applied (mock heuristic)")
            take("unreadable", 0.5,
                 "response marked unreadable/smudged (mock heuristic)")
        if len(tokens) < 4:
            take("formatting", 0.5,
                 "response too brief (mock heuristic)")

        awarded = round(max(0.0, remaining), 2)
        mode_label = f"{len(matched)}/{total} keywords matched"
        return awarded, deductions, mode_label

    # -- grading: token-overlap (original) ------------------------------------

    def _grade(self, payload: dict) -> list[dict]:
        strict = bool(payload.get("strict"))
        keyword_mode = bool(payload.get("keyword_mode"))
        penalties = set(payload.get("penalty_criteria") or [])
        records = []

        for q in payload.get("questions", []):
            max_marks = float(q.get("max_marks") or 0.0)
            expected = q.get("expected_answer") or ""
            answer = q.get("student_answer") or ""
            legibility = (q.get("legibility") or "good").lower()

            if keyword_mode:
                score, deductions, mode_label = self._grade_keywords(
                    q.get("keywords") or [], answer, max_marks,
                    strict, penalties, legibility,
                )
                awarded = score
                records.append({
                    "number": q.get("number"),
                    "student_answer": answer or "(no answer transcribed)",
                    "expected_answer": expected or "(expected from web search)",
                    "max_marks": max_marks,
                    "marks_awarded": awarded,
                    "deductions": deductions,
                    "feedback": (
                        f"[MOCK] scored {awarded}/{max_marks:g} by keyword "
                        f"coverage ({mode_label}); "
                        "replace with a real Gemini run for genuine marking."
                    ),
                    "ocr_note": "",
                })
                continue

            overlap = _overlap_ratio(expected, answer)
            raw = overlap * max_marks
            step = 0.5
            content_awarded = (math.floor(raw / step) * step if strict
                               else round(raw / step) * step)
            content_awarded = max(0.0, min(max_marks, content_awarded))

            deductions: list[dict] = []
            content_deduct = round(max_marks - content_awarded, 2)
            if content_deduct > 0:
                deductions.append({
                    "category": "content",
                    "marks": content_deduct,
                    "reason": ("student response matched "
                               f"{overlap * 100:.0f}% of the expected answer "
                               "under token-overlap scoring (mock engine)"),
                })

            remaining = content_awarded
            poor = legibility in ("poor", "unreadable") or not answer.strip()
            tokens = _tokens(answer)

            def take(category: str, amount: float, reason: str) -> None:
                nonlocal remaining
                if category not in penalties or remaining <= 0:
                    return
                amount = min(amount, remaining)
                if amount <= 0:
                    return
                remaining = round(remaining - amount, 2)
                deductions.append({"category": category, "marks": amount,
                                   "reason": reason})

            if poor:
                take("handwriting", 0.5,
                     "handwriting penalties were applied (mock heuristic)")
                take("unreadable", 0.5,
                     "response marked unreadable/smudged (mock heuristic)")
            if len(tokens) < 4:
                take("formatting", 0.5,
                     "response too brief to show working steps (mock heuristic)")

            awarded = round(max(0.0, remaining), 2)
            records.append({
                "number": q.get("number"),
                "student_answer": answer or "(no answer transcribed)",
                "expected_answer": expected or "(not found in answer key)",
                "max_marks": max_marks,
                "marks_awarded": awarded,
                "deductions": deductions,
                "feedback": (
                    f"[MOCK] scored {awarded}/{max_marks:g} by token overlap; "
                    "replace with a real Gemini run for genuine marking."
                ),
                "ocr_note": "",
            })
        return records


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _parse_json(text: str) -> tuple[Any | None, str]:
    """Parse JSON from a model reply, tolerating fences and prose."""
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```[a-zA-Z]*\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        return json.loads(candidate), "ok"
    except json.JSONDecodeError as exc:
        first, last = candidate.find("{"), candidate.find("[")
        start = min(i for i in (first, last) if i != -1) if (first != -1 or last != -1) else -1
        end = max(candidate.rfind("}"), candidate.rfind("]"))
        if start != -1 and end > start:
            try:
                return json.loads(candidate[start:end + 1]), "ok"
            except json.JSONDecodeError:
                pass
        return None, str(exc)


def _parse_blocks(text: str) -> dict[str, str]:
    """Split numbered text into {question number: body} (mock extraction)."""
    blocks: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        m = _BLOCK_RE.match(line)
        if m:
            current = m.group(1)
            blocks[current] = [m.group(2).strip()] if m.group(2).strip() else []
        elif current is not None and line.strip():
            blocks[current].append(line.strip())
    return {num: " ".join(parts).strip() for num, parts in blocks.items()
            if " ".join(parts).strip()}


def strip_marks(text: str) -> tuple[str, float | None]:
    """Return (text without a trailing '(5 marks)', marks or None)."""
    m = _MAX_MARKS_RE.search(text)
    if not m:
        return text, None
    cleaned = (text[:m.start()] + text[m.end():]).strip()
    return cleaned, float(m.group(1))


def _tokens(text: str) -> set[str]:
    """Content tokens: words (minus stopwords) plus numeric fragments, so
    that formula-heavy answers still compare sensibly."""
    return {
        w for w in re.findall(r"[a-z0-9]+", (text or "").lower())
        if w not in _STOPWORDS and (len(w) > 1 or w.isdigit())
    }


def _overlap_ratio(expected: str, answer: str) -> float:
    """Similarity of the shorter answer to the longer one (0..1).

    Using min() as the denominator keeps terse-but-correct answers (a
    maths solution with no prose) from being crushed by a verbose key.
    """
    exp, act = _tokens(expected), _tokens(answer)
    if not exp or not act:
        return 0.0
    shared = len(exp & act)
    if not shared:
        return 0.0
    return min(1.0, shared / min(len(exp), len(act)))


def make_engine(api_key: str | None = None,
                model: str | None = None,
                mock: bool = False,
                backend: str | None = None):
    """Factory used by the CLI, test runners, Streamlit app and API.

    ``backend`` is ``"gemini"``, ``"nvidia"`` or ``None`` (auto-detect: an
    ``nvapi-`` key selects NVIDIA NIM, anything else selects Gemini).  A
    Gemini-model id passed with an NVIDIA key is ignored in favour of
    ``NVIDIA_MODEL`` so the UI default never breaks NVIDIA runs.
    """
    if mock:
        return MockEngine(model=model)
    if backend is None:
        key = (api_key
               or os.environ.get("GEMINI_API_KEY")
               or os.environ.get("GOOGLE_API_KEY")
               or os.environ.get("NVIDIA_API_KEY"))
        backend = "nvidia" if (key or "").startswith("nvapi-") else "gemini"
    if backend == "nvidia":
        if not model or model.startswith("gemini-"):
            model = NVIDIA_DEFAULT_MODEL
        return NvidiaEngine(api_key=api_key, model=model)
    return GeminiEngine(api_key=api_key, model=model)
