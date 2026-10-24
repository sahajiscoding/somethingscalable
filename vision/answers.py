"""Turn transcribed crops into per-question student answers.

The mapping model is deliberately given a narrow job: group block ids under the
question number written on the sheet.  The answer text itself is rebuilt from
the arbiter's verbatim LaTeX here, so a second model cannot rewrite the
student's mathematics.
"""

from __future__ import annotations

from .models import TranscribedPage

PROMPT = """\
MAPPING TASK: group OCR blocks from one student's answer sheet into questions.

Each line is one block:
[<block id>] page <n> conf <0..1>: <latex>

Return JSON only:
{"groups":[{"number":"3","crop_ids":["p1c4","p1c5"],"legibility":"good"}]}

Rules:
- Every block id must appear exactly once, in the order it was written.
- "number" is the question number written on the sheet (Q3, 3., (iii)). If no
  number is visible, use "#1", "#2", ... in reading order.
- Never merge two different question numbers into one group.
- Do not translate, solve, simplify or rewrite the mathematics. You only group
  blocks; the text is copied elsewhere.
- legibility is "good", "fair" or "poor". Use "poor" when a block is flagged
  below 0.45 confidence or contains \\square.
"""

LOW_CONFIDENCE = 0.45
FAIR_CONFIDENCE = 0.70


def transcript_text(pages: list[TranscribedPage]) -> str:
    rows: list[str] = []
    for page in pages:
        for crop in page.crops:
            transcription = page.transcriptions.get(crop.crop_id)
            if transcription is None or not transcription.ok:
                continue
            rows.append(
                f"[{crop.crop_id}] page {page.page} "
                f"conf {transcription.confidence:.2f}: {transcription.latex}"
            )
    return "\n".join(rows)


def answers_from_transcript(engine, pages: list[TranscribedPage]) -> list:
    """Return ``StudentAnswer`` objects, or ``[]`` when nothing was read."""
    from extract import StudentAnswer  # local import avoids a module cycle

    text = transcript_text(pages)
    if not text.strip():
        return []

    try:
        raw = engine.generate_json(
            "extract_student_vision",
            data={"transcript": text},
            instruction=PROMPT,
            temperature=0.0,
            max_tokens=2000,
        )
    except Exception:
        return []

    groups = raw.get("groups") if isinstance(raw, dict) else raw
    if not isinstance(groups, list):
        return []

    blocks = _block_index(pages)
    answers: list = []
    used: set[str] = set()

    for position, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        crop_ids = _valid_ids(group.get("crop_ids"), blocks)
        response, confidence, uncertain = _compose(crop_ids, blocks)
        if not response:
            continue
        used.update(crop_ids)
        answers.append(StudentAnswer(
            number=str(group.get("number") or f"#{position + 1}").strip(),
            response=response,
            page=blocks[crop_ids[0]][0],
            legibility=_legibility(group.get("legibility"), confidence),
            uncertain_spans=uncertain,
            crop_ids=crop_ids,
            geometry=_geometry(crop_ids, blocks),
        ))

    # Defensive: never silently drop a block the model forgot to group.
    leftovers = [crop_id for crop_id in blocks if crop_id not in used]
    for position, crop_id in enumerate(leftovers, start=1):
        response, confidence, uncertain = _compose([crop_id], blocks)
        if not response:
            continue
        answers.append(StudentAnswer(
            number=f"~{position}",
            response=response,
            page=blocks[crop_id][0],
            legibility=_legibility("", confidence),
            uncertain_spans=uncertain,
            crop_ids=[crop_id],
            geometry=_geometry([crop_id], blocks),
        ))
    return answers


def _block_index(pages: list[TranscribedPage]):
    """crop id -> (page, confidence, latex, normalized page rect)."""
    index: dict[str, tuple[int, float, str, list[float]]] = {}
    for page in pages:
        for crop in page.crops:
            transcription = page.transcriptions.get(crop.crop_id)
            if transcription is None or not transcription.ok:
                continue
            index[crop.crop_id] = (
                page.page,
                transcription.confidence,
                transcription.latex,
                crop.rect.to_list(),
            )
    return index


def _geometry(crop_ids: list[str], blocks) -> list[dict]:
    return [
        {"crop_id": crop_id, "page": blocks[crop_id][0],
         "rect": blocks[crop_id][3]}
        for crop_id in crop_ids
    ]


def _valid_ids(raw, blocks) -> list[str]:
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    ordered: list[str] = []
    for value in raw:
        crop_id = str(value)
        if crop_id in blocks and crop_id not in seen:
            seen.add(crop_id)
            ordered.append(crop_id)
    return ordered


def _compose(crop_ids: list[str], blocks):
    parts = [blocks[crop_id][2] for crop_id in crop_ids]
    response = "\n".join(part for part in parts if part)
    if not crop_ids:
        return "", 0.0, []
    confidence = min(blocks[crop_id][1] for crop_id in crop_ids)
    uncertain = [
        blocks[crop_id][2][:80]
        for crop_id in crop_ids
        if blocks[crop_id][1] < LOW_CONFIDENCE
    ]
    return response, confidence, uncertain


def _legibility(model_value, confidence: float) -> str:
    reported = str(model_value or "").strip().lower()
    if reported not in {"good", "fair", "poor"}:
        reported = "good"
    if confidence < LOW_CONFIDENCE:
        return "poor"
    if confidence < FAIR_CONFIDENCE and reported == "good":
        return "fair"
    return reported
