"""Transcription prompt and response parsing.

The single most important instruction is *do not correct the student*.  Every
downstream signal -- disagreement, arithmetic contradiction, error tagging --
depends on the transcription being a faithful copy of what was written.
"""

from __future__ import annotations

import json
import re

from .models import Crop, Transcription

SYSTEM_PROMPT = (
    "You are an OCR engine for handwritten exam answers. "
    "You transcribe exactly what is written and you never solve, correct, "
    "simplify, or complete the work."
)

USER_PROMPT = """Transcribe each image exactly as written.

Rules:
- Copy the answer verbatim, including spelling, grammar and mistakes.
- Always include any written question number, "Ans." prefix, option letter ((a), (b), (c), (d)), or bullet marker (*, -, •) at the start of a line.
- Write prose and one-word answers as plain text in "plain" (leave "latex" empty for prose).
- Write mathematics as LaTeX: \\frac{{a}}{{b}}, \\sqrt{{x}}, ^{{}} for powers, \\cdot for multiplication.
- One image may contain several lines; separate distinct mathematical steps or distinct numbered answers with \\\\ , and join wrapped lines of a single prose sentence with spaces.
- If a symbol cannot be read, write \\square for it and list the image id.
- Do not add commentary, units that were not written, or your own answer.

Images are attached in the same order as the ids below:
{listing}

Return JSON only, no markdown:
{{"items":[{{"id":"<id>","text":"<verbatim transcription>","latex":"<latex when mathematical, else empty>","plain":"<plain text when prose>"}}],"unreadable":["<id>"]}}
"""


def build_prompt(crops: list[Crop]) -> str:
    listing = "\n".join(
        f"{position}. id={crop.crop_id}"
        for position, crop in enumerate(crops, start=1)
    )
    return USER_PROMPT.format(listing=listing)


def extract_json(text: str):
    """Pull the first JSON object out of a model response."""
    if not text:
        return None
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        return json.loads(cleaned)
    except (ValueError, TypeError):
        pass

    start = cleaned.find("{")
    while start != -1:
        end = cleaned.rfind("}")
        if end > start:
            try:
                return json.loads(cleaned[start:end + 1])
            except (ValueError, TypeError):
                pass
        start = cleaned.find("{", start + 1)
    return None


_NEW_BLOCK_RE = re.compile(
    r"^\s*(?:(?:Q(?:ues(?:tion)?)?|Ans(?:wer)?)\s*[.:\-]?\s*\d+|\d+\s*[.):\-]|[*•\-]\s+)",
    re.I,
)


def _clean_plain(plain: str) -> str:
    if "\\\\" not in plain:
        return plain
    parts = [p.strip() for p in re.split(r"\s*\\\\\s*", plain) if p.strip()]
    if not parts:
        return plain
    out = parts[0]
    for part in parts[1:]:
        if _NEW_BLOCK_RE.match(part):
            out += "\n" + part
        else:
            out += " " + part
    return out


def parse_items(raw: str, crops: list[Crop], provider: str) -> dict[str, Transcription]:
    payload = extract_json(raw)
    results: dict[str, Transcription] = {}

    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        items = payload["items"]
    elif isinstance(payload, list):
        items = payload
    elif payload is None and len(crops) == 1 and (raw or "").strip():
        fallback_text = re.sub(r"<think>[\s\S]*?</think>", "", raw).strip()
        if fallback_text.startswith("```"):
            fallback_text = re.sub(r"^```[a-zA-Z]*\s*", "", fallback_text)
            fallback_text = re.sub(r"\s*```$", "", fallback_text).strip()
        items = (
            [{"id": crops[0].crop_id, "plain": fallback_text}]
            if fallback_text
            else []
        )
    else:
        items = []

    unreadable = set()
    if isinstance(payload, dict) and isinstance(payload.get("unreadable"), list):
        unreadable = {str(value) for value in payload["unreadable"]}

    by_id = {crop.crop_id: crop for crop in crops}
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        crop_id = str(item.get("id") or "").strip()
        if crop_id not in by_id:
            crop_id = crops[position].crop_id if position < len(crops) else ""
        if not crop_id:
            continue
        latex_val = str(item.get("latex") or "").strip()
        plain_val = str(item.get("plain") or item.get("text") or "").strip()
        if plain_val and not latex_val:
            plain_val = _clean_plain(plain_val)
        results[crop_id] = Transcription(
            crop_id=crop_id,
            latex=latex_val,
            plain=plain_val,
            provider=provider,
            confidence=0.0,
            note="unreadable" if crop_id in unreadable else "",
        )

    for crop in crops:
        results.setdefault(
            crop.crop_id,
            Transcription(crop_id=crop.crop_id, provider=provider,
                          error="no transcription returned"),
        )
        if crop.crop_id in unreadable and results[crop.crop_id].ok:
            results[crop.crop_id].confidence = 0.2
    return results
