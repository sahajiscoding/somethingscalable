"""Turn transcribed crops into per-question student answers.

The mapping model is deliberately given a narrow job: group block ids under the
question number written on the sheet.  The answer text itself is rebuilt from
the arbiter's verbatim LaTeX here, so a second model cannot rewrite the
student's mathematics.
"""

from __future__ import annotations

import re

from .models import TranscribedPage

PROMPT = """\
MAPPING TASK: group OCR blocks from one student's answer sheet into questions.

Each line is one block:
[<block id>] page <n> conf <0..1>: <text>

Return JSON only:
{"groups":[{"number":"3","crop_ids":["p1c4","p1c5"],"legibility":"good"}]}

Rules:
- Every block id must appear exactly once, in the order it was written.
- "number" is the question number written on the sheet (Q3, Ans. 3), 3., (iii)).
- MULTI-BLOCK ANSWERS & BULLET POINTS (critical): Students frequently write an
  introductory line with the question number (e.g. "Ans. 6) Vegetative
  propagation is practiced as :") followed by one or more separate blocks
  containing bullet points ("*", "-", "•"), sub-points, working steps, or
  concluding paragraphs that do NOT repeat the question number. You MUST include
  all such continuation blocks in that same question's "crop_ids" list until the
  next explicit question number appears!
- Never assign "#1", "#2", or a separate group to a bullet point ("*", "-", "•")
  or continuation paragraph that belongs to the preceding numbered question.
  Only use "#1", "#2", ... if a block appears BEFORE any question number has
  been written on the sheet.
- Ignore camera watermarks (e.g. "vivo X50", "Shot on ...", device/date stamps).
- Never merge two different question numbers into one group.
- Do not translate, solve, simplify or rewrite the mathematics. You only group
  blocks; the text is copied elsewhere.
- legibility is "good", "fair" or "poor". Use "poor" when a block is flagged
  below 0.45 confidence or contains \\square.
"""

LOW_CONFIDENCE = 0.45
FAIR_CONFIDENCE = 0.70

_WATERMARK_RE = re.compile(
    r"^\s*(?:shot\s+on\b|vivo\s+[a-z0-9]+|redmi\s+note\b|poco\s+[a-z0-9]+|"
    r"realme\s+[a-z0-9]+|oppo\s+[a-z0-9]+|oneplus\b|samsung\s+galaxy\b|"
    r"zeiss\b|leica\b|hasselblad\b|ai\s+(?:quad|triple|dual)\s+camera\b)",
    re.I,
)

_LEADING_QNUM_RE = re.compile(
    r"^\s*(?:"
    r"(?:q(?:ues(?:tion)?)?|ans(?:wer)?)\s*[.:\-]?\s*\(?(\d{1,3})\s*[.):\-]"
    r"|"
    r"(?:q(?:ues(?:tion)?)?|ans(?:wer)?)\s*[.:\-]?\s*\(?(\d{1,3})\)?\b"
    r"|"
    r"\(?(\d{1,3})\s*[.):]\s+(?=[A-Za-z(\[\\*•\-])"
    r")",
    re.I,
)

_PLACEHOLDER_NUM_RE = re.compile(
    r"^(?:[#!~*?•\-]+\d*|unknown|unnumbered|none|null|bullet|cont(?:inuation)?)$",
    re.I,
)


def _is_watermark(text: str) -> bool:
    cleaned = (text or "").strip()
    if not cleaned or len(cleaned) > 90:
        return False
    return bool(_WATERMARK_RE.search(cleaned))


def _leading_question_number(text: str) -> str | None:
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    match = _LEADING_QNUM_RE.match(cleaned)
    if not match:
        return None
    num = match.group(1) or match.group(2) or match.group(3)
    return str(int(num)) if num and num.isdigit() else num


def _is_placeholder_number(num: str) -> bool:
    s = (num or "").strip()
    if not s:
        return True
    return bool(_PLACEHOLDER_NUM_RE.match(s))


def _split_multi_question_text(text: str) -> list[str]:
    """Split a single crop's text if it contains multiple lines with distinct explicit question numbers."""
    raw_lines = [
        ln.strip()
        for part in re.split(r"\s*\\\\\s*|\n+", text or "")
        for ln in [part]
        if ln.strip()
    ]
    if len(raw_lines) <= 1:
        return [text] if text else []

    segments: list[list[str]] = []
    current: list[str] = []
    current_q: str | None = None
    explicit_count = 0

    for ln in raw_lines:
        qnum = _leading_question_number(ln)
        if qnum is not None:
            explicit_count += 1
            if current and current_q is not None and qnum != current_q:
                segments.append(current)
                current = [ln]
                current_q = qnum
                continue
            if current_q is None:
                current_q = qnum
        current.append(ln)
    if current:
        segments.append(current)

    if explicit_count < 2 or len(segments) <= 1:
        return [text]
    return ["\n".join(seg) for seg in segments]


def transcript_text(pages: list[TranscribedPage]) -> str:
    blocks = _block_index(pages)
    rows: list[str] = []
    for crop_id, (page_num, confidence, text, _rect) in blocks.items():
        rows.append(
            f"[{crop_id}] page {page_num} "
            f"conf {confidence:.2f}: {text}"
        )
    return "\n".join(rows)


def _deterministic_groups_from_blocks(blocks: dict) -> list[dict]:
    """Fallback grouping when the LLM call fails but blocks carry explicit question numbers."""
    explicit_any = any(
        _leading_question_number(info[2]) is not None
        for info in blocks.values()
    )
    if not explicit_any:
        return []

    groups: list[dict] = []
    for crop_id, (_page, _conf, text, _rect) in blocks.items():
        qnum = _leading_question_number(text)
        if qnum is not None:
            if groups and groups[-1]["number"] == qnum:
                groups[-1]["crop_ids"].append(crop_id)
            else:
                groups.append({"number": qnum, "crop_ids": [crop_id], "legibility": "good"})
        elif groups:
            groups[-1]["crop_ids"].append(crop_id)
        else:
            groups.append({"number": "#1", "crop_ids": [crop_id], "legibility": "good"})
    return groups


def _normalize_groups(groups: list, blocks: dict) -> list[dict]:
    """Repair split continuation blocks, placeholder numbers, and merged multi-question groups."""
    from extract import normalize_number

    # Step 1: split any group that accidentally combined two different explicit question numbers
    expanded: list[dict] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        crop_ids = _valid_ids(group.get("crop_ids"), blocks)
        if not crop_ids:
            continue
        raw_num = str(group.get("number") or "").strip()
        legibility = group.get("legibility")

        sub_ids: list[str] = []
        sub_num = raw_num
        active_explicit: str | None = None
        for cid in crop_ids:
            cid_qnum = _leading_question_number(blocks[cid][2])
            if cid_qnum is not None:
                if sub_ids and active_explicit is not None and cid_qnum != active_explicit:
                    expanded.append({
                        "number": sub_num or active_explicit,
                        "crop_ids": sub_ids,
                        "legibility": legibility,
                    })
                    sub_ids = [cid]
                    sub_num = cid_qnum
                    active_explicit = cid_qnum
                    continue
                active_explicit = cid_qnum
                if _is_placeholder_number(sub_num):
                    sub_num = cid_qnum
            sub_ids.append(cid)
        if sub_ids:
            expanded.append({
                "number": sub_num,
                "crop_ids": sub_ids,
                "legibility": legibility,
            })

    # Step 2: merge placeholder/unnumbered continuation groups into the preceding numbered question
    # and combine consecutive groups that share the same normalized question number.
    merged: list[dict] = []
    for group in expanded:
        crop_ids = group["crop_ids"]
        raw_num = str(group.get("number") or "").strip()
        first_explicit = _leading_question_number(blocks[crop_ids[0]][2])

        if _is_placeholder_number(raw_num) and first_explicit is not None:
            raw_num = first_explicit

        norm_num = normalize_number(raw_num) if not _is_placeholder_number(raw_num) else ""

        if _is_placeholder_number(raw_num) and first_explicit is None and merged:
            prev_raw = str(merged[-1].get("number") or "").strip()
            if not _is_placeholder_number(prev_raw):
                for cid in crop_ids:
                    if cid not in merged[-1]["crop_ids"]:
                        merged[-1]["crop_ids"].append(cid)
                continue

        if norm_num and merged:
            prev_raw = str(merged[-1].get("number") or "").strip()
            prev_norm = normalize_number(prev_raw) if not _is_placeholder_number(prev_raw) else ""
            if prev_norm and prev_norm == norm_num:
                for cid in crop_ids:
                    if cid not in merged[-1]["crop_ids"]:
                        merged[-1]["crop_ids"].append(cid)
                continue

        merged.append({
            "number": raw_num,
            "crop_ids": list(crop_ids),
            "legibility": group.get("legibility"),
        })

    return merged


def answers_from_transcript(engine, pages: list[TranscribedPage]) -> list:
    """Return ``StudentAnswer`` objects, or ``[]`` when nothing was read."""
    from extract import StudentAnswer  # local import avoids a module cycle

    blocks = _block_index(pages)
    if not blocks:
        return []

    text = "\n".join(
        f"[{crop_id}] page {page_num} conf {confidence:.2f}: {block_text}"
        for crop_id, (page_num, confidence, block_text, _rect) in blocks.items()
    )
    if not text.strip():
        return []

    groups = None
    try:
        raw = engine.generate_json(
            "extract_student_vision",
            data={"transcript": text},
            instruction=PROMPT,
            temperature=0.0,
            max_tokens=2000,
        )
        groups = raw.get("groups") if isinstance(raw, dict) else raw
    except Exception:
        groups = None

    if not isinstance(groups, list) or not groups:
        groups = _deterministic_groups_from_blocks(blocks)
        if not groups:
            return []

    groups = _normalize_groups(groups, blocks)

    answers: list = []
    used: set[str] = set()

    for position, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        crop_ids = [
            cid for cid in _valid_ids(group.get("crop_ids"), blocks)
            if cid not in used
        ]
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
            full_text = transcription.text
            if _is_watermark(full_text):
                continue
            segments = _split_multi_question_text(full_text)
            if len(segments) <= 1:
                index[crop.crop_id] = (
                    page.page,
                    transcription.confidence,
                    full_text,
                    crop.rect.to_list(),
                )
            else:
                rect_list = crop.rect.to_list()
                x, y, w, h = rect_list
                seg_h = h / len(segments)
                for seg_idx, seg_text in enumerate(segments):
                    seg_id = crop.crop_id if seg_idx == 0 else f"{crop.crop_id}_{seg_idx + 1}"
                    seg_rect = [
                        round(x, 4),
                        round(y + seg_idx * seg_h, 4),
                        round(w, 4),
                        round(seg_h, 4),
                    ]
                    index[seg_id] = (
                        page.page,
                        transcription.confidence,
                        seg_text,
                        seg_rect,
                    )
    return index


def _geometry(crop_ids: list[str], blocks) -> list[dict]:
    return [
        {
            "crop_id": crop_id,
            "page": blocks[crop_id][0],
            "rect": blocks[crop_id][3],
            "latex": blocks[crop_id][2],
            "confidence": round(blocks[crop_id][1], 3),
        }
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
