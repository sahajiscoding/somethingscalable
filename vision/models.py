"""Data contracts for the vision layer.

Every rectangle is normalized (0..1).  ``Crop.rect`` is relative to its page;
``Span.rect_rel`` is relative to its crop.  The model never sees or emits page
absolute coordinates -- layout owns the page geometry, the model only owns the
relative position of a span inside a crop it was given.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float

    def to_list(self) -> list[float]:
        return [round(self.x, 5), round(self.y, 5),
                round(self.w, 5), round(self.h, 5)]


@dataclass
class Crop:
    page: int
    index: int
    rect: Rect
    image: bytes
    dpi: int = 240
    line_count: int = 1

    @property
    def crop_id(self) -> str:
        return f"p{self.page}c{self.index}"


@dataclass
class Transcription:
    crop_id: str
    latex: str = ""
    plain: str = ""
    provider: str = ""
    confidence: float = 0.0
    note: str = ""
    error: str = ""

    @property
    def ok(self) -> bool:
        return bool(self.latex.strip()) and not self.error


@dataclass
class Span:
    crop_id: str
    rect_rel: Rect
    tag: str = "answer"
    step: int | None = None
    confidence: float = 0.0
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "crop_id": self.crop_id,
            "rect": self.rect_rel.to_list(),
            "tag": self.tag,
            "step": self.step,
            "confidence": round(self.confidence, 3),
            "note": self.note,
        }


@dataclass
class TranscribedPage:
    page: int
    width: int
    height: int
    dpi: int
    crops: list[Crop] = field(default_factory=list)
    transcriptions: dict[str, Transcription] = field(default_factory=dict)
    spans: list[Span] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    fidelity: str = "unreadable"

    @property
    def latex(self) -> str:
        parts = []
        for crop in self.crops:
            t = self.transcriptions.get(crop.crop_id)
            if t and t.ok:
                parts.append(t.latex)
        return "\n".join(parts)

    def to_dict(self) -> dict:
        return {
            "page": self.page,
            "width": self.width,
            "height": self.height,
            "dpi": self.dpi,
            "fidelity": self.fidelity,
            "warnings": self.warnings,
            "crops": [
                {
                    "id": c.crop_id,
                    "rect": c.rect.to_list(),
                    "line_count": c.line_count,
                    "latex": (self.transcriptions.get(c.crop_id).latex
                              if self.transcriptions.get(c.crop_id) else ""),
                    "confidence": round(
                        self.transcriptions[c.crop_id].confidence, 3
                    ) if c.crop_id in self.transcriptions else 0.0,
                }
                for c in self.crops
            ],
            "spans": [s.to_dict() for s in self.spans],
        }
