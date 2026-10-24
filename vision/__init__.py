"""Vision layer: crop handwritten answer blocks and transcribe them.

    from ingest import load_document
    from vision import transcribe_document

    pages = transcribe_document(load_document("sheet.pdf", "student"))

The heavy imports (NumPy, Pillow, PyMuPDF) stay behind ``transcribe_document``
so the grader can import ``vision.arbiter`` without paying for them.
"""

from __future__ import annotations

from .models import Crop, Rect, Span, TranscribedPage, Transcription

__all__ = [
    "Crop", "Rect", "Span", "TranscribedPage", "Transcription",
    "build_providers", "transcribe_document",
]


def __getattr__(name: str):
    if name == "transcribe_document":
        from .facade import transcribe_document

        return transcribe_document
    if name == "build_providers":
        from .providers import build_providers

        return build_providers
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
