"""Provider clients for crop transcription.

Both NVIDIA NIM and Groq expose an OpenAI-compatible chat-completions endpoint,
so one client covers both.  A provider is optional: with no Groq key the arbiter
simply runs with a single opinion.
"""

from __future__ import annotations

import base64
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import requests

from .models import Crop, Transcription
from .ocr import build_prompt, parse_items

NVIDIA_DEFAULT_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
PALIGEMMA_DEFAULT_URL = "https://ai.api.nvidia.com/v1/vlm/google/paligemma"
NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b"
GROQ_DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions"

# These NIM vision models accept at most one image_url per message, so crops
# must be sent one at a time instead of in a 4-image batch.
_SINGLE_IMAGE_MODELS = frozenset({
    "google/paligemma",
    "google/google-paligemma",
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-11b-vision-instruct",
    "microsoft/phi-3-vision-128k-instruct",
    "nvidia/neva-22b",
})

# NVCF VLM endpoints that accept only a single user message with an image and
# forbid extra top-level keys such as "model" or "chat_template_kwargs".
_VLM_ENDPOINT_MODELS = frozenset({
    "google/paligemma",
    "google/google-paligemma",
})

CONNECT_TIMEOUT = 6.0


@dataclass
class ProviderConfig:
    name: str
    url: str
    model: str
    api_key: str
    timeout: float = 22.0
    max_tokens: int = 1600
    batch_size: int = 4
    max_workers: int = 6
    extra_payload: dict = field(default_factory=dict)


def _uses_thinking_kwargs(model: str) -> bool:
    low = (model or "").lower()
    return any(k in low for k in ("nemotron", "deepseek", "glm", "kimi", "minimax"))


class ProviderError(RuntimeError):
    pass


class VisionProvider:
    """One model that can look at crops and return LaTeX."""

    def __init__(self, config: ProviderConfig):
        self.config = config
        self._local = threading.local()

    @property
    def name(self) -> str:
        return self.config.name

    @property
    def session(self) -> requests.Session:
        """One session per worker thread; ``requests.Session`` is not shared."""
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            self._local.session = session
        return session

    def transcribe(self, crops: list[Crop],
                   prompt: str | None = None) -> dict[str, Transcription]:
        if not crops:
            return {}

        batch_size = max(1, self.config.batch_size)
        batches = list(_chunks(crops, batch_size))
        jobs = [
            (batch, self._prompt_for(prompt, batch))
            for batch in batches
        ]

        results: dict[str, Transcription] = {}
        if len(jobs) == 1 or self.config.max_workers <= 1:
            for batch, batch_prompt in jobs:
                results.update(self._call(batch, batch_prompt))
            return results

        workers = min(self.config.max_workers, len(jobs))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(self._call, batch, batch_prompt): batch
                for batch, batch_prompt in jobs
            }
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    results.update(future.result())
                except Exception as exc:  # defensive: one batch must not sink the page
                    results.update(self._fail(batch, f"worker error: {exc}"))
        return results

    @staticmethod
    def _prompt_for(prefix: str | None, crops: list[Crop]) -> str:
        listing = build_prompt(crops)
        return f"{prefix}\n\n{listing}" if prefix else listing

    # -- internals ---------------------------------------------------------

    def _call(self, crops: list[Crop], prompt: str) -> dict[str, Transcription]:
        response = None
        last_err = ""
        for attempt in range(2):
            try:
                response = self._post(crops, prompt)
                if response.status_code not in (429, 500, 502, 503, 504):
                    break
                last_err = f"HTTP {response.status_code}: {response.text[:160]}"
            except requests.Timeout:
                last_err = "timeout"
            except requests.RequestException as exc:
                last_err = f"network error: {exc}"
        if response is None:
            return self._fail(crops, last_err or "timeout")

        if response.status_code in (400, 422) and self.config.extra_payload:
            try:
                response = self._post(crops, prompt, include_extra=False)
            except requests.RequestException:
                pass

        if response.status_code in (400, 422) and len(crops) > 1:
            # Provider cannot take several images in one message; retry singly.
            merged: dict[str, Transcription] = {}
            for crop in crops:
                merged.update(self._call([crop], build_prompt([crop])))
            return merged

        if response.status_code != 200:
            return self._fail(
                crops, f"HTTP {response.status_code}: {response.text[:160]}"
            )

        try:
            payload = response.json()
            message = payload["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError):
            return self._fail(crops, "malformed response envelope")

        content = (message.get("content") or "").strip()
        if not content:
            content = (message.get("reasoning_content") or "").strip()
        parsed = parse_items(content, crops, self.name)
        for crop_id, transcription in parsed.items():
            if transcription.plain:
                transcription.note = transcription.note or ""
            if not transcription.ok:
                transcription.confidence = 0.0
        return parsed

    def _post(self, crops: list[Crop], prompt: str,
              *, include_extra: bool = True) -> requests.Response:
        is_vlm = (
            self.config.model in _VLM_ENDPOINT_MODELS
            or "/v1/vlm/" in (self.config.url or "")
        )
        text_prompt = (
            f"You are a precise OCR engine.\n\n{prompt}" if is_vlm else prompt
        )
        content: list[dict] = [{"type": "text", "text": text_prompt}]
        for crop in crops:
            content.append({
                "type": "image_url",
                "image_url": {"url": _data_url(crop.image)},
            })

        if is_vlm:
            payload = {
                "messages": [
                    {"role": "user", "content": content},
                ],
                "temperature": 0.2,
                "top_p": 0.7,
                "max_tokens": min(self.config.max_tokens, 1024),
                "stream": False,
            }
        else:
            extra = self.config.extra_payload if include_extra else {}
            payload = {
                "model": self.config.model,
                "messages": [
                    {"role": "system", "content": "You are a precise OCR engine."},
                    {"role": "user", "content": content},
                ],
                "temperature": 0.0,
                "max_tokens": self.config.max_tokens,
                "stream": False,
                **extra,
            }
        return self.session.post(
            self.config.url,
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=payload,
            timeout=(CONNECT_TIMEOUT, self.config.timeout),
        )

    def _fail(self, crops: list[Crop], reason: str) -> dict[str, Transcription]:
        return {
            crop.crop_id: Transcription(
                crop_id=crop.crop_id, provider=self.name, error=reason
            )
            for crop in crops
        }


def _data_url(image: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")


def _chunks(items: list, size: int):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _normalize_nvidia_model(model_id: str) -> str:
    low = (model_id or "").strip().lower()
    if low in ("paligemma", "google-paligemma", "google/paligemma", "google/google-paligemma"):
        return "google/paligemma"
    if low in (
        "nemotron-omni",
        "nemotron-3-nano-omni",
        "nemotron-3-nano-omni-30b",
        "nemotron-3-nano-omni-30b-a3b",
        "nemotron-3-nano-omni-30b-a3b-reasoning",
        "nemotron-3-nano-mini-30b-a3b-reasoning",
        "nvidia/nemotron-3-nano-mini-30b-a3b-reasoning",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    ):
        return "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    return (model_id or "").strip()


def nvidia_provider(api_key: str | None = None,
                    model: str | None = None,
                    url: str | None = None,
                    timeout: float = 22.0,
                    env: dict | None = None) -> VisionProvider | None:
    source = env if env is not None else os.environ
    key = (api_key or source.get("NVIDIA_API_KEY") or "").strip()
    if not key and env is None:
        try:
            import engine as _engine
            key = (_engine.get_nvidia_key() or "").strip()
        except Exception:
            key = ""
    if not key:
        return None
    raw_chosen = (model or source.get("NVIDIA_MODEL") or NVIDIA_DEFAULT_MODEL).strip()
    chosen = _normalize_nvidia_model(raw_chosen)
    is_vlm = chosen in _VLM_ENDPOINT_MODELS
    default_url = (
        source.get("NVIDIA_PALIGEMMA_URL", PALIGEMMA_DEFAULT_URL)
        if is_vlm
        else source.get("NVIDIA_API_URL", NVIDIA_DEFAULT_URL)
    )
    extra = (
        {"chat_template_kwargs": {"enable_thinking": False, "thinking": False}}
        if (not is_vlm and _uses_thinking_kwargs(chosen))
        else {}
    )
    return VisionProvider(ProviderConfig(
        name="nvidia",
        url=url or default_url,
        model=chosen,
        api_key=key,
        timeout=timeout,
        max_tokens=1024 if is_vlm else 1600,
        batch_size=1 if chosen in _SINGLE_IMAGE_MODELS else 4,
        extra_payload=extra,
    ))


def groq_provider(api_key: str | None = None,
                  model: str | None = None,
                  url: str | None = None,
                  timeout: float = 14.0,
                  env: dict | None = None) -> VisionProvider | None:
    source = env if env is not None else os.environ
    key = (api_key or source.get("GROQ_API_KEY") or "").strip()
    chosen = (model or source.get("GROQ_MODEL") or "").strip()
    if not key or not chosen:
        # Without an explicit vision model id we cannot guess safely.
        return None
    return VisionProvider(ProviderConfig(
        name="groq",
        url=url or source.get("GROQ_API_URL", GROQ_DEFAULT_URL),
        model=chosen,
        api_key=key,
        timeout=timeout,
        batch_size=3,
    ))


def build_providers(env: dict | None = None,
                    model: str | None = None) -> list[VisionProvider]:
    """NVIDIA first (accuracy), Groq second (speed). Missing keys are skipped.

    ``model`` lets the caller reuse the model selected in the UI for crop OCR;
    when omitted the NVIDIA provider falls back to ``NVIDIA_MODEL``.
    """
    if env is not None:
        merged_env = dict(os.environ)
        merged_env.update({k: str(v) for k, v in env.items()})
    else:
        merged_env = None
    providers = [
        nvidia_provider(model=model, env=merged_env),
        groq_provider(env=merged_env),
    ]
    return [provider for provider in providers if provider is not None]
