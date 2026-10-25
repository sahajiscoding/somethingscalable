"""LLM engines for WeHelpTeachers.

Two engines expose the same interface:

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

# (Model default lives below as NVIDIA_DEFAULT_MODEL.)

# NVIDIA NIM (OpenAI-compatible chat-completions endpoint) —
# Nemotron 3.5 Super VL (nvidia/nemotron-3.5-super-vl-120b-a12b) reads the
# pages (native OCR/vision) and grades. It answers far faster than the
# previous GLM/DeepSeek flash models, which hit the read timeout on real
# exam papers. Override the model with NVIDIA_MODEL; any vision-capable
# NIM id works.
NIM_ENDPOINT = os.environ.get(
    "NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
PALIGEMMA_VLM_ENDPOINT = os.environ.get(
    "NVIDIA_PALIGEMMA_URL", "https://ai.api.nvidia.com/v1/vlm/google/paligemma")
NVIDIA_DEFAULT_MODEL = os.environ.get(
    "NVIDIA_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b")

# Vision-capable models on build.nvidia.com (accept image_url blocks natively).
_VISION_MODELS = frozenset({
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

# Vision models on NVIDIA NIM that accept at most 1 image_url per message.
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

# Dedicated NVCF VLM endpoints that accept only a single user message with an
# image and do not accept text-only grading requests or extra top-level keys.
_IMAGE_ONLY_VISION_MODELS = frozenset({
    "google/paligemma",
    "google/google-paligemma",
})

# Fast vision fallbacks (used when messages include images/scans).
_VISION_FALLBACK_MODELS = (
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "google/gemma-4-31b-it",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-11b-vision-instruct",
    "google/gemma-3-12b-it",
    "google/paligemma",
)

# Fast text/grading fallbacks (used for grading batches, exam generation, and
# digital text extraction).
_FALLBACK_MODELS = (
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "google/gemma-4-31b-it",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "deepseek-ai/deepseek-v4.1-flash",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "meta/llama-3.2-90b-vision-instruct",
    "z-ai/glm-5.3-flash",
)

# Per-request HTTP timeout (seconds): kept tight (24 s default) so a slow
# model fails over quickly to a fast alternate instead of hanging past
# Vercel's 60 s serverless function ceiling (which causes browser "Failed to fetch").
try:
    _NIM_TIMEOUT = int(float(str(os.environ.get("NVIDIA_TIMEOUT", "24"))))
except ValueError:
    _NIM_TIMEOUT = 24
_NIM_CONNECT_TIMEOUT = 8
_NIM_WALL_BUDGET = int(float(str(os.environ.get("NVIDIA_WALL_BUDGET", "46"))))
# Rendered-PDF page cap — supports real-world exam papers with 20, 30, 50+ pages.
_NVIDIA_MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "80"))

_NVIDIA_KEY_NAMES = (
    "NVIDIA_API_KEY",
    "NVIDIA_KEY",
    "NIM_API_KEY",
    "NV_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
)


def get_nvidia_key(explicit_key: str | None = None) -> str:
    """Return explicit key or first discovered NVIDIA/Moonshot env var."""
    if explicit_key and explicit_key.strip():
        return explicit_key.strip()
    for name in _NVIDIA_KEY_NAMES:
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return ""

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
# NVIDIA NIM engine: OpenAI-compatible chat-completions, stdlib only
# ---------------------------------------------------------------------------

class NvidiaEngine:
    """Vision + grading through NVIDIA NIM (api.nvidia.com).

    Nemotron 3.5 Super VL (nvidia/nemotron-3.5-super-vl-120b-a12b) reads the
    pages and grades (native vision + JSON), HTTP via ``requests``. The key
    comes from ``NVIDIA_API_KEY`` (or aliases like NIM_API_KEY / NV_API_KEY)
    configured in Vercel or environment.

    Images go over as base64 data-URL blocks. PDF pages are rendered to PNG
    with PyMuPDF (digital pages with enough embedded text ride along as
    text instead), so scanned handwriting works — the case a text-layer
    fallback could never handle.
    """

    name = "nvidia"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        key = get_nvidia_key(api_key)
        if not key:
            raise EngineError(
                "No NVIDIA API key found. Set NVIDIA_API_KEY in Vercel Environment "
                "Variables (or pass --api-key)."
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
                      max_tokens: int = 4096,
                      max_attempts: int = 2) -> Any:
        import time
        messages = self._build_messages(instruction, document, data)
        start_t = time.monotonic()

        last_error = "unknown parse error"
        for attempt in range(max_attempts):
            elapsed = time.monotonic() - start_t
            if attempt > 0 and elapsed >= _NIM_WALL_BUDGET - 6:
                break
            remaining_budget = max(10.0, _NIM_WALL_BUDGET - elapsed)
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
                except Exception:
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
                        if page_no > _NVIDIA_MAX_PDF_PAGES:
                            raise EngineError(
                                f"{document.filename} has more than "
                                f"{_NVIDIA_MAX_PDF_PAGES} pages — split it and "
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
                            blocks.append(NvidiaEngine._image_block(
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
                        stitched_block = NvidiaEngine._image_block("stitched_pages.jpg", "image/jpeg", stitched_jpg)
                        new_parts = [p for p in parts if not (isinstance(p, dict) and p.get("type") == "image_url")]
                        new_parts.append(stitched_block)
                        adapted.append({**msg, "content": new_parts})
                        continue
                except Exception:
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
                    except Exception:
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
        import time
        try:
            import requests
        except ImportError as exc:
            raise EngineError(
                "The requests package is not installed. "
                "Install dependencies with: pip install -r requirements.txt"
            ) from exc

        headers = {
            "Authorization": f"Bearer {self.key}",
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
            req_timeout = max(6, min(_NIM_TIMEOUT, int(remaining) - 1)) if idx > 0 else min(_NIM_TIMEOUT, max(10, int(remaining)))

            effective_messages = (
                self._adapt_messages_for_model(messages, candidate_model)
                if has_images else messages
            )
            is_vlm_endpoint = candidate_model in _IMAGE_ONLY_VISION_MODELS
            endpoint_url = PALIGEMMA_VLM_ENDPOINT if is_vlm_endpoint else NIM_ENDPOINT
            if is_vlm_endpoint:
                payload: dict[str, Any] = {
                    "messages": effective_messages,
                    "temperature": max(0.2, min(float(temperature or 0.2), 1.0)),
                    "top_p": 0.7,
                    "max_tokens": min(int(max_tokens or 1024), 1024),
                    "stream": False,
                }
            else:
                payload = {
                    "model": candidate_model,
                    "messages": effective_messages,
                    "temperature": temperature,
                    "top_p": 0.7,
                    "max_tokens": max_tokens,
                    "stream": False,
                }
                if self._uses_thinking_kwargs(candidate_model):
                    # Disable chain-of-thought reasoning trace so the model outputs
                    # JSON immediately (~2-4s) instead of spending 40-60s on <think>.
                    payload["chat_template_kwargs"] = {
                        "enable_thinking": False,
                        "thinking": False,
                    }

            _acquire_nvidia_token()
            try:
                resp = requests.post(
                    endpoint_url,
                    headers=headers,
                    json=payload,
                    timeout=(_NIM_CONNECT_TIMEOUT, req_timeout),
                )
                # If a model rejects chat_template_kwargs with 400/422, retry immediately without it
                if resp.status_code in (400, 422) and "chat_template_kwargs" in payload:
                    payload.pop("chat_template_kwargs", None)
                    resp = requests.post(
                        endpoint_url,
                        headers=headers,
                        json=payload,
                        timeout=(_NIM_CONNECT_TIMEOUT, req_timeout),
                    )
            except requests.Timeout as exc:
                last = (f"Timed out after {req_timeout}s on {candidate_model} "
                        f"(NVIDIA took too long): {exc}")
                continue
            except requests.RequestException as exc:
                last = f"Network error on {candidate_model}: {exc}"
                continue

            if resp.status_code == 200:
                try:
                    choice_msg = resp.json()["choices"][0]["message"]
                    content_text = (choice_msg.get("content") or "").strip()
                    if content_text:
                        if is_vlm_endpoint and _parse_json(content_text)[0] is None and len(models_to_try) > 1:
                            last = f"Non-JSON response on {candidate_model}: {content_text[:120]}"
                            continue
                        return content_text
                    reasoning_text = (choice_msg.get("reasoning_content") or "").strip()
                    if reasoning_text and _parse_json(reasoning_text)[0] is not None:
                        return reasoning_text
                except (KeyError, IndexError, TypeError, ValueError):
                    pass
            elif resp.status_code in (401, 403):
                raise EngineError(
                    f"NVIDIA API rejected the key (HTTP {resp.status_code}). "
                    "Check NVIDIA_API_KEY."
                )
            elif resp.status_code == 429:
                raise EngineError(
                    "NVIDIA API rate limit (HTTP 429) — the free tier allows "
                    "~40 req/min. Wait a moment and retry."
                )
            last = f"HTTP {resp.status_code} on {candidate_model}: {resp.text[:200]}"

        raise EngineError(f"NVIDIA API call failed: {last}")


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
                "Set NVIDIA_API_KEY (or drop --mock) to OCR scanned PDFs "
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
                        "replace with a real NVIDIA run for genuine marking."
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
                    "replace with a real NVIDIA run for genuine marking."
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

    NVIDIA NIM only (``nvidia/nemotron-3.5-super-vl-120b-a12b``) for checking
    papers, using the API key configured in Vercel/environment
    (``NVIDIA_API_KEY``) or provided explicitly.
    """
    if mock or backend == "mock":
        return MockEngine(model=model)
    if backend not in (None, "nvidia"):
        raise EngineError(
            f"Unknown backend {backend!r}: this build supports NVIDIA NIM only."
        )
    if not model or model.startswith("gemini-") or model in ("moonshotai/kimi-k3", "kimi-k3"):
        model = NVIDIA_DEFAULT_MODEL
    elif model in ("nemotron", "nemotron-3.5-super-vl", "nemotron-3.5-super-vl-120b-a12b",
                   "nvidia/nemotron-3.5-super-vl-120b-a12b"):
        model = "nvidia/nemotron-3.5-super-vl-120b-a12b"
    elif model in ("nemotron-lightning", "nemotron-3.5-lightning", "nemotron-3.5-lightning-30b-a3b",
                   "nvidia/nemotron-3.5-lightning-30b-a3b"):
        model = "nvidia/nemotron-3.5-lightning-30b-a3b"
    elif model in (
        "nemotron-omni",
        "nemotron-3-nano-omni",
        "nemotron-3-nano-omni-30b",
        "nemotron-3-nano-omni-30b-a3b",
        "nemotron-3-nano-omni-30b-a3b-reasoning",
        "nemotron-3-nano-mini-30b-a3b-reasoning",
        "nvidia/nemotron-3-nano-mini-30b-a3b-reasoning",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    ):
        model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    elif model in ("paligemma", "google-paligemma", "google/paligemma", "google/google-paligemma"):
        model = "google/paligemma"
    elif model in ("gemma-4", "gemma-4-31b", "gemma-4-31b-it", "google/gemma-4-31b-it"):
        model = "google/gemma-4-31b-it"
    elif model in ("gemma-3", "gemma-3-12b", "gemma-3-12b-it", "google/gemma-3-12b-it"):
        model = "google/gemma-3-12b-it"
    elif model in ("llama-90b-vision", "llama-3.2-90b-vision", "llama-3.2-90b-vision-instruct",
                   "meta/llama-3.2-90b-vision-instruct"):
        model = "meta/llama-3.2-90b-vision-instruct"
    elif model in ("llama-11b-vision", "llama-3.2-11b-vision", "llama-3.2-11b-vision-instruct",
                   "meta/llama-3.2-11b-vision-instruct"):
        model = "meta/llama-3.2-11b-vision-instruct"
    elif model in ("glm-5.3-flash", "z-ai/glm-5-3-flash", "glm-5-3-flash"):
        model = "z-ai/glm-5.3-flash"
    elif model in ("deepseek-v4.1-flash", "deepseek-v4.1", "deepseek-flash", "deepseek", "deepseek-ai/deepseek-v4.1-flash"):
        model = "deepseek-ai/deepseek-v4.1-flash"
    elif model in ("minimax", "minimax-m3.1", "minimax-m3.1-flash",
                   "minimaxai/minimax-m3.1-flash"):
        model = "minimaxai/minimax-m3.1-flash"
    return NvidiaEngine(api_key=api_key, model=model)
