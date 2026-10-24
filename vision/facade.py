"""Façade: document in, transcribed pages out.

Kept out of ``vision/__init__.py`` so importing the arbiter (for SymPy checks in
the grader) does not also import NumPy, Pillow and the renderer.
"""

from __future__ import annotations

from . import arbiter, layout
from .models import Rect, Span, TranscribedPage, Transcription
from .providers import build_providers

__all__ = ["transcribe_document"]


def transcribe_document(document, providers=None, dpi: int = layout.DEFAULT_DPI,
                        max_blocks: int = layout.MAX_BLOCKS_PER_PAGE,
                        ) -> list[TranscribedPage]:
    """Crop every page of ``document`` and transcribe each block.

    ``providers=None`` builds the providers from the environment.
    Pass ``providers=[]`` for a layout-only run.
    """
    if providers is None:
        providers = build_providers()

    try:
        page_layouts = layout.crop_document(
            document, dpi=dpi, max_blocks=max_blocks
        )
    except Exception as exc:  # keep the caller's request alive
        return [TranscribedPage(
            page=1, width=0, height=0, dpi=dpi,
            warnings=[f"layout failed: {exc}"], fidelity="unreadable",
        )]

    return [_transcribe_page(page_layout, providers) for page_layout in page_layouts]


def _transcribe_page(page_layout: layout.PageLayout,
                     providers: list) -> TranscribedPage:
    page = TranscribedPage(
        page=page_layout.page,
        width=page_layout.width,
        height=page_layout.height,
        dpi=page_layout.dpi,
        crops=page_layout.crops,
    )

    if not page_layout.crops:
        page.warnings.append("no ink blocks found")
        return page

    merged: dict[str, dict[str, Transcription]] = {}
    for provider in providers:
        try:
            results = provider.transcribe(page_layout.crops)
        except Exception as exc:
            page.warnings.append(f"{provider.name}: {exc}")
            continue
        for crop_id, transcription in results.items():
            merged.setdefault(crop_id, {})[provider.name] = transcription

    if not providers:
        page.warnings.append("no vision provider configured")

    for crop in page_layout.crops:
        per_provider = merged.get(crop.crop_id, {})
        if per_provider:
            final = arbiter.decide(per_provider)
        else:
            final = Transcription(
                crop_id=crop.crop_id,
                error="not transcribed",
                note="no provider result",
            )
        final.crop_id = crop.crop_id
        page.transcriptions[crop.crop_id] = final

        # M1 emits one full-crop span per block; finer spans arrive with the
        # annotation UI.  The rectangle is normalized inside the crop.
        page.spans.append(Span(
            crop_id=crop.crop_id,
            rect_rel=Rect(0.0, 0.0, 1.0, 1.0),
            tag="answer",
            confidence=final.confidence,
            note=final.note,
        ))

    page.fidelity = _fidelity(page)
    return page


def _fidelity(page: TranscribedPage) -> str:
    confidences = [
        transcription.confidence
        for transcription in page.transcriptions.values()
        if transcription.ok
    ]
    if not confidences:
        return "unreadable"
    mean = sum(confidences) / len(confidences)
    if mean >= 0.85:
        return "high"
    if mean >= 0.55:
        return "medium"
    if mean > 0:
        return "low"
    return "unreadable"
