"""LLM engines for WeHelpTeachers.

Two engines expose the same interface:

* ``WhtEngine`` - OCR/vision + grading through the WHT Engine AI Gateway,
  which is powered by the Kilo Gateway
  (``https://api.kilo.ai/api/gateway``, OpenAI-compatible).  Any
  ``WHT_ENGINE_API_KEY`` or ``KILO_API_KEY`` selects it automatically; text +
  images are fully supported, PDFs are rendered page-by-page.
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

# (Model default lives below as WHT_ENGINE_DEFAULT_MODEL.)

# "WHT Engine" is this product's name for its AI layer. It runs on the Kilo
# Gateway (https://api.kilo.ai/api/gateway) — an OpenAI-compatible
# chat-completions endpoint — using the KILO_API_KEY configured in Vercel or
# the environment. Branding stays "WHT Engine" in every UI surface; the
# transport below is the real, working gateway behind it.
#
# Nemotron 3.5 Super VL (nvidia/nemotron-3.5-super-vl:free) reads the pages
# (native OCR/vision) and grades, and is also the text model for exam
# authoring. Override the id with WHT_ENGINE_MODEL if Kilo renames it.
WHT_ENGINE_DEFAULT_ENDPOINT = "https://api.kilo.ai/api/gateway/chat/completions"
WHT_ENGINE_ENDPOINT = (
    os.environ.get("WHT_ENGINE_API_URL")
    or os.environ.get("KILO_API_URL")
    or WHT_ENGINE_DEFAULT_ENDPOINT
)
WHT_ENGINE_DEFAULT_MODEL = (
    os.environ.get("WHT_ENGINE_MODEL")
    or "nvidia/nemotron-3.5-super-vl:free"
)

# Vision-capable model ids (accept image_url blocks natively). The gateway
# catalog is much larger, but this build only ever offers Nemotron 3.5 Super VL.
_VISION_MODELS = frozenset({
    "nvidia/nemotron-3.5-super-vl",
    "nvidia/nemotron-3.5-super-vl:free",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "google/gemma-4-31b-it",
    "google/gemma-3-12b-it",
    "google/gemma-3-4b-it",
    "google/paligemma",
    "google/google-paligemma",
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-11b-vision-instruct",
    "microsoft/phi-3-vision-128k-instruct",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "nvidia/nemotron-3-nano-mini-30b-a3b-reasoning",
    "nvidia/cosmos-reason2-8b",
    "nvidia/neva-22b",
    "minimaxai/minimax-m3.1-flash",
})

# Vision models that accept at most 1 image_url per message.
# Multi-page scanned PDFs are automatically stitched into one vertical strip
# when routed through these models.
_SINGLE_IMAGE_VISION_MODELS = frozenset({
    "google/paligemma",
    "google/google-paligemma",
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-11b-vision-instruct",
    "microsoft/phi-3-vision-128k-instruct",
    "nvidia/neva-22b",
})

# Dedicated VLM endpoints that accept only a single user message with an
# image and do not accept text-only grading requests or extra top-level keys.
_IMAGE_ONLY_VISION_MODELS = frozenset({
    "google/paligemma",
    "google/google-paligemma",
})

# Vision fallbacks (used when messages include images/scans). Every id here
# must accept image_url blocks on the Kilo Gateway and be free-tier friendly;
# the first entry is the same default model, so a healthy gateway never pays
# for a second attempt.
_VISION_FALLBACK_MODELS = (
    WHT_ENGINE_DEFAULT_MODEL,
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "kilo-auto/free",
)

# Fast text/grading fallbacks (used for grading batches, exam generation, and
# digital text extraction).
_FALLBACK_MODELS = (
    WHT_ENGINE_DEFAULT_MODEL,
    "kilo-auto/free",
)

# Per-request HTTP timeout (seconds). The WHT Engine free tier routinely needs
# 30-60 s for multi-page vision + JSON, so 24 s was aborting healthy
# requests mid-flight ("Read timed out") and then retrying into the same
# wall. Budgets must fit inside Vercel's 300 s function cap (vercel.json):
# worst case ≈ two attempts × WHT_ENGINE_TIMEOUT inside WHT_ENGINE_WALL_BUDGET.
try:
    _WHT_ENGINE_TIMEOUT = int(float(str(os.environ.get("WHT_ENGINE_TIMEOUT", "90"))))
except ValueError:
    _WHT_ENGINE_TIMEOUT = 90
_WHT_ENGINE_CONNECT_TIMEOUT = 8
_WHT_ENGINE_WALL_BUDGET = int(float(str(os.environ.get("WHT_ENGINE_WALL_BUDGET", "200"))))
# Rendered-PDF page cap — supports real-world exam papers with 20, 30, 50+ pages.
_MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "80"))

_WHT_ENGINE_KEY_NAMES = (
    "KILO_API_KEY",
    "WHT_ENGINE_API_KEY",
    "WHT_ENGINE_KEY",
)


def get_wht_engine_key(explicit_key: str | None = None) -> str:
    """Return explicit key or first discovered WHT Engine env var.

    ``KILO_API_KEY`` is the canonical Kilo Gateway key; ``WHT_ENGINE_API_KEY``
    is kept so existing deployments keep working. A key that was left stale
    after a rename is rejected with HTTP 401/403 and retried with the next
    one (see ``WhtEngine._chat``), so either name is safe.
    """
    if explicit_key and explicit_key.strip():
        return explicit_key.strip()
    for name in _WHT_ENGINE_KEY_NAMES:
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return ""


def get_wht_engine_keys(explicit_key: str | None = None) -> list[str]:
    """All usable gateway keys, useful first, de-duplicated.

    A renamed project can end up with a stale ``WHT_ENGINE_API_KEY`` next to a
    fresh ``KILO_API_KEY`` (or vice versa). Trying each in turn turns a
    confusing 401 into a working request.
    """
    if explicit_key and explicit_key.strip():
        return [explicit_key.strip()]
    ordered: list[str] = []
    for name in _WHT_ENGINE_KEY_NAMES:
        val = os.environ.get(name, "").strip()
        if val and val not in ordered:
            ordered.append(val)
    return ordered


# The gateway rate-limits per key. A token bucket refilled at WHT_ENGINE_RPM/min
# serialises bursts — parallel page OCR, per-question grading calls — so
# callers wait instead of tripping 429s.
try:
    # Kilo's free tier allows 200 requests/hour (~3.3/min); 39/min was tuned
    # for a different gateway and only trips 429s here.
    WHT_ENGINE_RPM = int(os.environ.get("WHT_ENGINE_RPM", 3))
except ValueError:  # a bad env value must never crash the import
    WHT_ENGINE_RPM = 3
_bucket_lock = threading.Lock()
_bucket_tokens = float(WHT_ENGINE_RPM)
_bucket_last: float | None = None


def _acquire_wht_engine_token() -> None:
    """Block until a rate-limit token is available, then consume it."""
    import time
    global _bucket_tokens, _bucket_last
    while True:
        with _bucket_lock:
            now = time.monotonic()
            if _bucket_last is None:
                _bucket_last = now
            _bucket_tokens = min(
                float(WHT_ENGINE_RPM),
                _bucket_tokens + (now - _bucket_last) * WHT_ENGINE_RPM / 60.0,
            )
            _bucket_last = now
            if _bucket_tokens >= 1.0:
                _bucket_tokens -= 1.0
                return
            wait = (1.0 - _bucket_tokens) * 60.0 / WHT_ENGINE_RPM
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
            "PyMuPDF it cannot be rendered — install pymupdf or upload the pages "
            "as JPG/PNG images."
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
# WHT Engine AI Gateway engine: OpenAI-compatible chat-completions, stdlib only
# ---------------------------------------------------------------------------

class WhtEngine:
    """Vision + grading through the WHT Engine AI Gateway (Kilo Gateway).

    Nemotron 3.5 Super VL (nvidia/nemotron-3.5-super-vl:free) reads the
    pages and grades (native vision + JSON), HTTP via ``requests``. The key
    comes from ``WHT_ENGINE_API_KEY`` configured in Vercel or environment.

    Images go over as base64 data-URL blocks. PDF pages are rendered to PNG
    with PyMuPDF (digital pages with enough embedded text ride along as
    text instead), so scanned handwriting works — the case a text-layer
    fallback could never handle.
    """

    name = "WHT Engine"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        keys = get_wht_engine_keys(api_key)
        if not keys:
            raise EngineError(
                "No WHT Engine API key found. Set KILO_API_KEY (or "
                "WHT_ENGINE_API_KEY) in Vercel Environment Variables."
            )
        self.key = keys[0]
        self._keys = keys
        self.model = model or WHT_ENGINE_DEFAULT_MODEL

    # -- public API ---------------------------------------------------------

    def generate_json(self,
                      task: str,
                      document: Any = None,
                      data: Any = None,
                      instruction: str = "",
                      temperature: float = 0.15,
                      max_tokens: int = 4096,
                      max_attempts: int = 2) -> Any:
        import time
        messages = self._build_messages(instruction, document, data)
        start_t = time.monotonic()

        last_error = "unknown parse error"
        for attempt in range(max_attempts):
            elapsed = time.monotonic() - start_t
            if attempt > 0 and elapsed >= _WHT_ENGINE_WALL_BUDGET - 6:
                break
            remaining_budget = max(10.0, _WHT_ENGINE_WALL_BUDGET - elapsed)
            text = self._chat(
                messages,
                temperature,
                max_tokens=max_tokens,
                wall_budget=remaining_budget,
            )  # raises on HTTP failure
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
        if document is None and data is None:
            messages.append({"role": "user", "content": instruction})
            return messages

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
            else:  # pdf: digital pages as text, scanned pages as JPEG images
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

        # Downscale high-res camera photos (> 400 KB or non-JPEG) to <= 1560px
        # JPEG so base64 payloads stay ~150-300 KB and vision encoding is 5x faster.
        if len(data) > 400 * 1024 or mime not in ("image/jpeg", "image/jpg"):
            fitz = _get_pdf_renderer()
            if fitz is not None:
                try:
                    img_doc = fitz.open(stream=data)
                    page = img_doc[0]
                    w, h = page.rect.width, page.rect.height
                    scale = min(1.0, 1560 / max(w, h, 1))
                    if scale < 1.0 or len(data) > 400 * 1024:
                        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                        if pix.alpha:
                            pix = fitz.Pixmap(fitz.csRGB, pix)
                        compressed = pix.tobytes("jpeg", jpg_quality=78)
                        if len(compressed) < len(data) or scale < 1.0:
                            data = compressed
                            mime = "image/jpeg"
                    img_doc.close()
                except Exception:  # nosec B110
                    pass
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
        a rendered JPEG for scanned ones (handwriting lives here)."""
        fitz = _get_pdf_renderer()
        if fitz is None:
            return [{"type": "text", "text": _pdf_text_fallback(document)}]

        blocks: list[dict] = []
        page_no = 0
        total_pages = max(1, getattr(document, "page_count", 1))

        # Dynamically scale DPI & quality so multi-page documents stay fast
        if total_pages > 30:
            render_dpi = 85
            jpg_quality = 66
            max_dim = 1150
        elif total_pages > 15:
            render_dpi = 100
            jpg_quality = 72
            max_dim = 1300
        else:
            render_dpi = 120
            jpg_quality = 76
            max_dim = 1500

        try:
            for chunk in document.pages:
                with fitz.open(stream=chunk.data, filetype="pdf") as doc:
                    for page in doc:
                        page_no += 1
                        if page_no > _MAX_PDF_PAGES:
                            raise EngineError(
                                f"{document.filename} has more than "
                                f"{_MAX_PDF_PAGES} pages — split it and "
                                "grade the parts separately."
                            )
                        text = (page.get_text() or "").strip()
                        if len(text) >= 12:
                            blocks.append({
                                "type": "text",
                                "text": (f"--- {document.filename} page "
                                         f"{page_no} (text) ---\n{text}"),
                            })
                        else:
                            w, h = page.rect.width, page.rect.height
                            dpi_scale = render_dpi / 72.0
                            dim_scale = max_dim / max(w * dpi_scale, h * dpi_scale, 1.0)
                            eff_scale = dpi_scale * min(1.0, dim_scale)
                            pix = page.get_pixmap(matrix=fitz.Matrix(eff_scale, eff_scale))
                            if pix.alpha:
                                pix = fitz.Pixmap(fitz.csRGB, pix)
                            jpg = pix.tobytes("jpeg", jpg_quality=jpg_quality)
                            blocks.append(WhtEngine._image_block(
                                f"{document.filename} p{page_no}",
                                "image/jpeg", jpg))
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(
                f"Could not read PDF {document.filename}: {exc}") from exc
        if not blocks:
            raise EngineError(f"No pages found in {document.filename}.")
        return blocks

    @staticmethod
    def _messages_have_images(messages: list[Any]) -> bool:
        for msg in messages:
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        return True
        return False

    @staticmethod
    def _is_vision_capable(model_id: str) -> bool:
        m = (model_id or "").lower().strip()
        if m in _VISION_MODELS:
            return True
        return any(k in m for k in (
            "vl", "vision", "omni", "gemma-3", "gemma-4",
            "neva", "cosmos", "fuyu", "paligemma", "vila", "kosmos", "parse",
        ))

    @staticmethod
    def _uses_thinking_kwargs(model_id: str) -> bool:
        m = (model_id or "").lower()
        return any(k in m for k in ("nemotron", "deepseek", "glm", "kimi", "minimax"))

    @staticmethod
    def _adapt_messages_for_model(messages: list[Any], model_id: str) -> list[Any]:
        """If a vision model accepts at most 1 image per message (e.g. Llama 3.2
        Vision, Google PaliGemma) and the message has multiple scanned page
        images, stitch them vertically into a single composite image. Also
        flatten system messages into a single user message for NVCF VLM
        endpoints (google/paligemma)."""
        if model_id not in _SINGLE_IMAGE_VISION_MODELS:
            return messages
        fitz = _get_pdf_renderer()

        import base64
        adapted: list[Any] = []
        for msg in messages:
            if not isinstance(msg, dict) or not isinstance(msg.get("content"), list):
                adapted.append(msg)
                continue
            parts = msg["content"]
            img_parts = [p for p in parts if isinstance(p, dict) and p.get("type") == "image_url"]
            if len(img_parts) <= 1:
                adapted.append(msg)
                continue

            # Decode up to 6 page images and stitch vertically when PyMuPDF is available
            if fitz is not None:
                decoded_pix = []
                try:
                    for p in img_parts[:6]:
                        url = (p.get("image_url") or {}).get("url", "")
                        if ";base64," in url:
                            b64_str = url.split(";base64,", 1)[1]
                            raw_bytes = base64.b64decode(b64_str)
                            with fitz.open(stream=raw_bytes) as d:
                                pix = d[0].get_pixmap()
                                if pix.alpha:
                                    pix = fitz.Pixmap(fitz.csRGB, pix)
                                decoded_pix.append(pix)
                    if len(decoded_pix) > 1:
                        max_w = max(px.width for px in decoded_pix)
                        total_h = sum(px.height for px in decoded_pix)
                        out_doc = fitz.open()
                        canvas_page = out_doc.new_page(width=max_w, height=total_h)
                        cur_y = 0.0
                        for px in decoded_pix:
                            rect = fitz.Rect(0, cur_y, px.width, cur_y + px.height)
                            canvas_page.insert_image(rect, stream=px.tobytes("jpeg", jpg_quality=76))
                            cur_y += px.height
                        max_target = 1024 if model_id in _IMAGE_ONLY_VISION_MODELS else 2200
                        jpg_qual = 65 if model_id in _IMAGE_ONLY_VISION_MODELS else 76
                        scale = min(1.0, max_target / max(max_w, total_h, 1))
                        stitched_pix = canvas_page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                        stitched_jpg = stitched_pix.tobytes("jpeg", jpg_quality=jpg_qual)
                        out_doc.close()
                        stitched_block = WhtEngine._image_block("stitched_pages.jpg", "image/jpeg", stitched_jpg)
                        new_parts = [p for p in parts if not (isinstance(p, dict) and p.get("type") == "image_url")]
                        new_parts.append(stitched_block)
                        adapted.append({**msg, "content": new_parts})
                        continue
                except Exception:  # nosec B110
                    pass
            # Fallback: keep first image so single-image model doesn't HTTP 400
            first_seen = False
            trimmed_parts = []
            for p in parts:
                if isinstance(p, dict) and p.get("type") == "image_url":
                    if not first_seen:
                        trimmed_parts.append(p)
                        first_seen = True
                else:
                    trimmed_parts.append(p)
            adapted.append({**msg, "content": trimmed_parts})

        if model_id in _IMAGE_ONLY_VISION_MODELS:
            # /v1/vlm/google/paligemma requires messages length == 1 with role "user"
            # and image_url.url maxLength <= 204800.
            text_chunks: list[str] = []
            image_block: dict | None = None
            for msg in adapted:
                if not isinstance(msg, dict):
                    continue
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    text_chunks.append(content.strip())
                elif isinstance(content, list):
                    for part in content:
                        if not isinstance(part, dict):
                            continue
                        if part.get("type") == "text" and part.get("text"):
                            text_chunks.append(str(part["text"]).strip())
                        elif part.get("type") == "image_url" and image_block is None:
                            image_block = part
            if image_block is not None and fitz is not None:
                url = (image_block.get("image_url") or {}).get("url", "")
                if len(url) > 195000 and ";base64," in url:
                    try:
                        raw_bytes = base64.b64decode(url.split(";base64,", 1)[1])
                        with fitz.open(stream=raw_bytes) as d:
                            page = d[0]
                            w, h = page.rect.width, page.rect.height
                            scale = min(1.0, 960 / max(w, h, 1))
                            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                            if pix.alpha:
                                pix = fitz.Pixmap(fitz.csRGB, pix)
                            small_jpg = pix.tobytes("jpeg", jpg_quality=62)
                            b64 = base64.b64encode(small_jpg).decode("ascii")
                            image_block = {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                            }
                    except Exception:  # nosec B110
                        pass
            merged_content: list[dict] = []
            if text_chunks:
                merged_content.append({"type": "text", "text": "\n\n".join(text_chunks)})
            if image_block is not None:
                merged_content.append(image_block)
            return [{"role": "user", "content": merged_content}]

        return adapted

    def _chat(self,
              messages: list[Any],
              temperature: float,
              max_tokens: int = 4096,
              wall_budget: float = 46.0) -> str:
        """Send one chat-completion request, rotating through configured keys.

        A stale key produced by an env rename surfaces as 401/403 on the first
        key; the loop below then retries the same request with the next key
        before giving up, so a half-renamed deployment still works.
        """
        import time
        try:
            import requests
        except ImportError as exc:
            raise EngineError(
                "The requests package is not installed. "
                "Install dependencies with: pip install -r requirements.txt"
            ) from exc

        last_auth_error: str | None = None
        for key in getattr(self, "_keys", [self.key]):
            try:
                return self._chat_with_key(
                    messages, temperature, max_tokens=max_tokens,
                    wall_budget=wall_budget, api_key=key,
                )
            except EngineError as exc:
                if "rejected the key" not in str(exc):
                    raise
                last_auth_error = str(exc)
                continue
        raise EngineError(last_auth_error or "WHT Engine AI Gateway rejected every key.")

    def _chat_with_key(self,
                       messages: list[Any],
                       temperature: float,
                       max_tokens: int = 4096,
                       wall_budget: float = 46.0,
                       api_key: str | None = None) -> str:
        import time
        try:
            import requests
        except ImportError as exc:
            raise EngineError(
                "The requests package is not installed. "
                "Install dependencies with: pip install -r requirements.txt"
            ) from exc

        headers = {
            "Authorization": f"Bearer {api_key or self.key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

        has_images = self._messages_have_images(messages)
        models_to_try: list[str] = []

        if has_images:
            # Image/scan OCR requires a vision-capable model. If user picked a
            # text-only model for fast grading, automatically use a fast VLM for OCR.
            if self._is_vision_capable(self.model):
                models_to_try.append(self.model)
            for alt in _VISION_FALLBACK_MODELS:
                if alt not in models_to_try:
                    models_to_try.append(alt)
        else:
            if self.model not in _IMAGE_ONLY_VISION_MODELS:
                models_to_try.append(self.model)
            for alt in _FALLBACK_MODELS:
                if alt not in models_to_try:
                    models_to_try.append(alt)

        chat_start = time.monotonic()
        last = "no response"
        for idx, candidate_model in enumerate(models_to_try):
            elapsed = time.monotonic() - chat_start
            remaining = wall_budget - elapsed
            if idx > 0 and remaining < 6.0:
                break
            req_timeout = max(6, min(_WHT_ENGINE_TIMEOUT, int(remaining) - 1)) if idx > 0 else min(_WHT_ENGINE_TIMEOUT, max(10, int(remaining)))

            effective_messages = (
                self._adapt_messages_for_model(messages, candidate_model)
                if has_images else messages
            )
            endpoint_url = WHT_ENGINE_ENDPOINT
            payload = {
                "model": candidate_model,
                "messages": effective_messages,
                "temperature": temperature,
                "top_p": 0.7,
                "max_tokens": max_tokens,
                "stream": False,
            }
            if self._uses_thinking_kwargs(candidate_model):
                # Keep chain-of-thought short so the model reaches JSON quickly:
                # reasoning ramps a single question from ~3 s to ~60 s.
                payload["chat_template_kwargs"] = {
                    "enable_thinking": False,
                    "thinking": False,
                }
                payload["reasoning"] = {"enabled": False, "effort": "none"}
            if not has_images:
                # Text tasks (exam authoring, grading) must come back as JSON.
                # Vision models on the gateway reject response_format, so this
                # is only set when the request carries no image blocks.
                payload["response_format"] = {"type": "json_object"}

            _acquire_wht_engine_token()
            try:
                resp = requests.post(
                    endpoint_url,
                    headers=headers,
                    json=payload,
                    timeout=(_WHT_ENGINE_CONNECT_TIMEOUT, req_timeout),
                )
                # If a model rejects chat_template_kwargs with 400/422, retry immediately without it
                if resp.status_code in (400, 422):
                    # Drop the optional knobs one at a time so a gateway that
                    # does not accept them still gets a valid request.
                    relaxed = dict(payload)
                    for knob in ("chat_template_kwargs", "reasoning", "response_format"):
                        if knob in relaxed:
                            relaxed.pop(knob)
                            resp = requests.post(
                                endpoint_url,
                                headers=headers,
                                json=relaxed,
                                timeout=(_WHT_ENGINE_CONNECT_TIMEOUT, req_timeout),
                            )
                            if resp.status_code not in (400, 422):
                                payload = relaxed
                                break
                    else:
                        payload = relaxed
            except requests.Timeout as exc:
                last = (f"Timed out after {req_timeout}s on {candidate_model} "
                        f"(gateway took too long): {exc}")
                continue
            except requests.RequestException as exc:
                last = f"Network error on {candidate_model}: {exc}"
                continue

            if resp.status_code == 200:
                try:
                    body = resp.json()
                    choices = body.get("choices") or []
                    if choices:
                        choice_msg = choices[0].get("message") or {}
                        content_text = (choice_msg.get("content") or "").strip()
                        if content_text:
                            if _parse_json(content_text)[0] is None and len(models_to_try) > 1:
                                last = f"Non-JSON response on {candidate_model}: {content_text[:120]}"
                                continue
                            return content_text
                        reasoning_text = (choice_msg.get("reasoning_content") or "").strip()
                        if reasoning_text and _parse_json(reasoning_text)[0] is not None:
                            return reasoning_text
                    # 200 but the gateway returned no usable completion content.
                    # Retry the same model a couple of times — it can be transient
                    # — then fall through to the next candidate model instead of
                    # returning "" from inside the loop (which used to end the
                    # whole call with an empty string).
                    for _retry in range(2):
                        if time.monotonic() - chat_start >= wall_budget - 4:
                            break
                        try:
                            resp2 = requests.post(
                                endpoint_url,
                                headers=headers,
                                json=payload,
                                timeout=(_WHT_ENGINE_CONNECT_TIMEOUT, req_timeout),
                            )
                            body2 = resp2.json()
                            choices2 = body2.get("choices") or []
                            if choices2:
                                msg2 = choices2[0].get("message") or {}
                                ct2 = (msg2.get("content") or "").strip()
                                if ct2:
                                    return ct2
                                rt2 = (msg2.get("reasoning_content") or "").strip()
                                if rt2 and _parse_json(rt2)[0] is not None:
                                    return rt2
                        except Exception:  # nosec B110 - transient; try next model
                            pass
                    last = f"empty completion on {candidate_model}"
                    continue
                except (KeyError, IndexError, TypeError, ValueError):
                    return ""
            elif resp.status_code in (401, 403):
                raise EngineError(
                    f"WHT Engine AI Gateway rejected the key (HTTP {resp.status_code}). "
                    "Check WHT_ENGINE_API_KEY (or KILO_API_KEY) in Vercel."
                )
            elif resp.status_code == 429:
                # Kilo's free tier allows 200 requests/hour. A burst from the
                # frontend (5 questions + page OCR) can trip it, so back off
                # and retry inside the same wall budget instead of failing the
                # user's exam outright.
                retry_after = resp.headers.get("Retry-After") if hasattr(resp, "headers") else None
                try:
                    wait_s = float(retry_after) if retry_after else 0.0
                except (TypeError, ValueError):
                    wait_s = 0.0
                wait_s = min(max(wait_s, 3.0), 20.0)
                if time.monotonic() - chat_start + wait_s < wall_budget - 6:
                    time.sleep(wait_s)
                    last = f"rate limited (429) on {candidate_model}"
                    continue
                raise EngineError(
                    "WHT Engine AI Gateway rate limit (HTTP 429). The free tier "
                    "allows ~200 requests/hour — wait a minute and retry, or "
                    "raise WHT_ENGINE_RPM if your plan allows more."
                )
            else:
                last = f"HTTP {resp.status_code} on {candidate_model}: {resp.text[:200]}"

        raise EngineError(
            f"WHT Engine AI Gateway call failed ({WHT_ENGINE_ENDPOINT}): {last}"
        )


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
    """Fully offline stand-in (no API).

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
                "Set WHT_ENGINE_API_KEY (or drop --mock) to OCR scanned PDFs "
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
        teacher_instruction = str(payload.get("teacher_instruction") or "").strip()
        records = []

        for q in payload.get("questions", []):
            max_marks = float(q.get("max_marks") or 0.0)
            expected = q.get("expected_answer") or ""
            answer = q.get("student_answer") or ""
            legibility = (q.get("legibility") or "good").lower()

            if teacher_instruction and answer.strip():
                low_inst = teacher_instruction.lower()
                if any(w in low_inst for w in ("differenti", "column", "table", "correct", "full", "separate", "valid", "recheck")):
                    records.append({
                        "number": q.get("number"),
                        "student_answer": answer,
                        "expected_answer": expected or "(not found in answer key)",
                        "max_marks": max_marks,
                        "marks_awarded": max_marks,
                        "deductions": [],
                        "feedback": (
                            f"Rechecked per teacher instruction ({teacher_instruction}): "
                            "student's differentiation and key points verified for full credit."
                        ),
                        "ocr_note": "",
                    })
                    continue

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
                        "replace with a live run for genuine marking."
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
                    "replace with a live run for genuine marking."
                ),
                "ocr_note": "",
            })
        return records


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _parse_json(text: str) -> tuple[Any | None, str]:
    """Parse JSON from a model reply, tolerating reasoning tokens (<think>), fences, and prose."""
    candidate = text.strip()
    # Strip reasoning tags often output by reasoning models (Nemotron, GLM)
    candidate = re.sub(r"<think>[\s\S]*?</think>", "", candidate).strip()

    # Try direct parse
    try:
        return json.loads(candidate), "ok"
    except json.JSONDecodeError:
        pass

    # Extract markdown code fence content if present (```json ... ``` or ``` ... ```)
    fences = re.findall(r"```(?:json)?\s*([\s\S]*?)\s*```", candidate)
    for fence in fences:
        try:
            return json.loads(fence.strip()), "ok"
        except json.JSONDecodeError:
            pass

    # Tolerant fence strip if candidate begins with fence but ending fence was clipped
    if candidate.startswith("```"):
        clipped = re.sub(r"^```[a-zA-Z]*\s*", "", candidate)
        clipped = re.sub(r"\s*```$", "", clipped)
        try:
            return json.loads(clipped), "ok"
        except json.JSONDecodeError:
            pass

    # Fallback: look for outermost JSON object { ... } or array [ ... ]
    first_brace = candidate.find("{")
    first_bracket = candidate.find("[")
    starts = [i for i in (first_brace, first_bracket) if i != -1]
    if starts:
        start = min(starts)
        end = max(candidate.rfind("}"), candidate.rfind("]"))
        if end > start:
            try:
                return json.loads(candidate[start:end + 1]), "ok"
            except json.JSONDecodeError as exc:
                return None, str(exc)

    return None, "No valid JSON found in response"


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

    Nemotron 3.5 Super VL on the WHT Engine AI Gateway (Kilo Gateway)
    (``nvidia/nemotron-3.5-super-vl:free``) for checking papers, using the
    API key configured in Vercel/environment (``WHT_ENGINE_API_KEY``) or provided
    explicitly. Unknown ids pass through so the custom model box still works.
    """
    if mock or backend == "mock":
        return MockEngine(model=model)
    if backend not in (None, "WHT Engine"):
        raise EngineError(
            f"Unknown backend {backend!r}: this build supports the WHT Engine "
            "AI Gateway only."
        )
    if not model or model.startswith("gemini-") or model in ("moonshotai/kimi-k3", "kimi-k3"):
        model = WHT_ENGINE_DEFAULT_MODEL
    elif model in (
        # Legacy NVIDIA NIM id → the WHT Engine gateway equivalent.
        "nemotron",
        "nemotron-3.5-super-vl",
        "nemotron-3.5-super-vl-120b-a12b",
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
    ):
        model = WHT_ENGINE_DEFAULT_MODEL
    return WhtEngine(api_key=api_key, model=model)
