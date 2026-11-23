"""Provider clients for crop transcription.

The WHT Engine AI Gateway (powered by the Kilo Gateway) and Groq both expose an
OpenAI-compatible chat-completions endpoint, so one client covers both.  A
provider is optional: with no Groq key the arbiter simply runs with a single
opinion.
"""

from __future__ import annotations

import base64
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import requests

from engine import KILO_FREE_VISION_MODELS
from .models import Crop, Transcription
from .ocr import build_prompt, parse_items

WHT_ENGINE_DEFAULT_URL = "https://api.kilo.ai/api/gateway/chat/completions"
WHT_ENGINE_DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free"
GROQ_DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions"

CONNECT_TIMEOUT = 6.0
# Leave time for the rest of the extraction pipeline within Vercel's limit.
VISION_FALLBACK_WALL_BUDGET = 150.0


@dataclass
class ProviderConfig:
    name: str
    url: str
    model: str
    api_key: str
    timeout: float = 45.0
    max_tokens: int = 1600
    batch_size: int = 4
    max_workers: int = 6
    extra_payload: dict = field(default_factory=dict)
    fallback_models: tuple[str, ...] = ()


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
        # Preserve successful crops and only retry missing ones. Fallbacks are
        # configured for Kilo's vision models, never for text-only routes.
        results: dict[str, Transcription] = {}
        remaining = list(crops)
        deadline = time.monotonic() + VISION_FALLBACK_WALL_BUDGET
        original_prompt = build_prompt(crops)
        prefix = prompt[:-len(original_prompt)] if prompt.endswith(original_prompt) else None
        for model in dict.fromkeys((self.config.model, *self.config.fallback_models)):
            candidate_prompt = (prefix + build_prompt(remaining)) if prefix is not None else prompt
            candidate_results = self._call_model(remaining, candidate_prompt, model, deadline)
            for crop in remaining:
                results[crop.crop_id] = candidate_results[crop.crop_id]
            remaining = [crop for crop in remaining if not results[crop.crop_id].ok]
            if not remaining or time.monotonic() >= deadline:
                break
        return results

    def _call_model(self, crops: list[Crop], prompt: str, model: str,
                    deadline: float) -> dict[str, Transcription]:
        response = None
        last_err = ""

        def post(include_extra: bool = True) -> requests.Response:
            remaining = deadline - time.monotonic()
            if remaining <= 1:
                raise requests.Timeout("vision request time budget exhausted")
            connect_timeout = min(CONNECT_TIMEOUT, max(0.5, remaining / 4))
            read_timeout = max(0.5, min(self.config.timeout, remaining - connect_timeout))
            # Keep per-thread timeouts separate when several batches run at once.
            self._local.request_timeouts = (connect_timeout, read_timeout)
            try:
                # Preserve the existing _post(crops, prompt) contract for
                # custom providers when using their configured model.
                if model == self.config.model:
                    return self._post(crops, prompt) if include_extra else self._post(crops, prompt, include_extra=False)
                return self._post(crops, prompt, include_extra=include_extra, model=model)
            finally:
                del self._local.request_timeouts

        for _attempt in range(2):
            try:
                response = post()
                if response.status_code == 429:
                    break  # a different model may have its own quota
                if response.status_code not in (500, 502, 503, 504):
                    break
                last_err = f"HTTP {response.status_code}: {response.text[:160]}"
            except requests.Timeout:
                response = None
                last_err = "timeout"
            except requests.RequestException as exc:
                response = None
                last_err = f"network error: {exc}"
        if response is None:
            return self._fail(crops, last_err or "timeout")

        extra = self._extra_for_model(model)
        if response.status_code in (400, 422) and extra:
            try:
                response = post(include_extra=False)
            except requests.RequestException:
                pass

        if response.status_code in (400, 422) and len(crops) > 1:
            # Provider cannot take several images in one message; retry singly.
            merged: dict[str, Transcription] = {}
            for crop in crops:
                merged.update(self._call_model([crop], build_prompt([crop]), model, deadline))
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

        if not isinstance(message, dict):
            return self._fail(crops, "malformed response message")
        content = message.get("content") or message.get("reasoning_content") or ""
        if not isinstance(content, str):
            return self._fail(crops, "malformed response content")
        parsed = parse_items(content.strip(), crops, self.name)
        for crop_id, transcription in parsed.items():
            if transcription.plain:
                transcription.note = transcription.note or ""
            if not transcription.ok:
                transcription.confidence = 0.0
        return parsed

    def _extra_for_model(self, model: str) -> dict:
        if model == self.config.model:
            return self.config.extra_payload
        return (
            {"chat_template_kwargs": {"enable_thinking": False, "thinking": False}}
            if _uses_thinking_kwargs(model) else {}
        )

    def _post(self, crops: list[Crop], prompt: str,
              *, include_extra: bool = True, model: str | None = None) -> requests.Response:
        content: list[dict] = [{"type": "text", "text": prompt}]
        for crop in crops:
            content.append({
                "type": "image_url",
                "image_url": {"url": _data_url(crop.image)},
            })

        chosen = model or self.config.model
        extra = self._extra_for_model(chosen) if include_extra else {}
        payload = {
            "model": chosen,
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
            timeout=getattr(self._local, "request_timeouts", (CONNECT_TIMEOUT, self.config.timeout)),
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


def _normalize_wht_engine_model(model_id: str) -> str:
    return (model_id or "").strip()


def wht_engine_provider(api_key: str | None = None,
                        model: str | None = None,
                        url: str | None = None,
                        timeout: float = 45.0,
                        env: dict | None = None) -> VisionProvider | None:
    source = env if env is not None else os.environ
    key = (
        api_key
        or source.get("KILO_API_KEY")
        or source.get("WHT_ENGINE_API_KEY")
        or source.get("WHT_ENGINE_KEY")
        or ""
    ).strip()
    if not key and env is None:
        try:
            import engine as _engine
            key = (_engine.get_wht_engine_key() or "").strip()
        except Exception:
            key = ""
    if not key:
        return None
    raw_chosen = (
        model
        or source.get("WHT_ENGINE_MODEL")
        or WHT_ENGINE_DEFAULT_MODEL
    ).strip()
    chosen = _normalize_wht_engine_model(raw_chosen)
    default_url = (
        source.get("WHT_ENGINE_API_URL")
        or source.get("KILO_API_URL")
        or WHT_ENGINE_DEFAULT_URL
    )
    extra = (
        {"chat_template_kwargs": {"enable_thinking": False, "thinking": False}}
        if _uses_thinking_kwargs(chosen)
        else {}
    )
    return VisionProvider(ProviderConfig(
        name="WHT Engine",
        url=url or default_url,
        model=chosen,
        api_key=key,
        timeout=timeout,
        max_tokens=1600,
        batch_size=4,
        extra_payload=extra,
        fallback_models=KILO_FREE_VISION_MODELS,
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
    """WHT Engine first (accuracy), Groq second (speed). Missing keys are skipped.

    ``model`` lets the caller reuse the model selected in the UI for crop OCR;
    when omitted the WHT Engine provider falls back to ``WHT_ENGINE_MODEL``.
    """
    if env is not None:
        merged_env = dict(os.environ)
        merged_env.update({k: str(v) for k, v in env.items()})
    else:
        merged_env = None
    providers = [
        wht_engine_provider(model=model, env=merged_env),
        groq_provider(env=merged_env),
    ]
    return [provider for provider in providers if provider is not None]
