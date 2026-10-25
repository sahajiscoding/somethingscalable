"""Page rasterisation and answer-block cropping.

No model runs here.  The pipeline is deliberately classical: render at a
legible DPI, flatten uneven lighting, deskew by maximising the variance of the
horizontal ink projection, then cut blocks out of the row/column profiles.

Every returned crop carries a normalized page rectangle, so the UI can place it
without knowing the render DPI.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from .models import Crop, Rect

MAX_PAGE_DIM = 2600
DEFAULT_DPI = 240
JPEG_QUALITY = 88
MAX_BLOCKS_PER_PAGE = 32


@dataclass
class PageLayout:
    page: int
    width: int
    height: int
    dpi: int
    crops: list[Crop]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render_pages(data: bytes, kind: str, dpi: int = DEFAULT_DPI) -> list[np.ndarray]:
    """Return one grayscale ``uint8`` array per page."""
    if kind == "pdf":
        return _render_pdf(data, dpi)
    if kind == "image":
        return [_render_image(data)]
    return []


def _render_pdf(data: bytes, dpi: int) -> list[np.ndarray]:
    import pymupdf

    pages: list[np.ndarray] = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            w, h = page.rect.width, page.rect.height
            scale = dpi / 72.0
            if max(w, h) * scale > MAX_PAGE_DIM:
                scale = MAX_PAGE_DIM / max(w, h)
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(scale, scale),
                colorspace=pymupdf.csGRAY,
                alpha=False,
            )
            arr = np.frombuffer(pix.samples, dtype=np.uint8)
            pages.append(arr.reshape(pix.height, pix.width).copy())
    return pages


def _render_image(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im).convert("L")
        if max(im.size) > MAX_PAGE_DIM:
            ratio = MAX_PAGE_DIM / max(im.size)
            im = im.resize(
                (max(1, int(im.width * ratio)), max(1, int(im.height * ratio))),
                Image.LANCZOS,
            )
        return np.asarray(im).copy()


# ---------------------------------------------------------------------------
# Deskew
# ---------------------------------------------------------------------------

def deskew(gray: np.ndarray) -> tuple[np.ndarray, float]:
    """Rotate so text lines are horizontal; returns (image, angle_degrees)."""
    if gray.size == 0:
        return gray, 0.0

    small = _downscale(gray, 900)
    coarse = _best_angle(small, np.arange(-4.0, 4.01, 1.0))
    fine = _best_angle(small, np.arange(coarse - 0.9, coarse + 0.91, 0.3))

    if abs(fine) < 0.15:
        return gray, 0.0
    return _rotate(gray, fine), fine


def _best_angle(small: np.ndarray, candidates: np.ndarray) -> float:
    best_angle, best_score = 0.0, -1.0
    for angle in candidates:
        score = _alignment_score(_rotate(small, float(angle)))
        if score > best_score:
            best_angle, best_score = float(angle), score
    return best_angle


def _alignment_score(arr: np.ndarray) -> float:
    ink = arr < 128
    profile = ink.sum(axis=1).astype(np.float64)
    if profile.sum() < 20:
        return 0.0
    return float(profile.var() / (profile.mean() ** 2 + 1e-9))


def _rotate(gray: np.ndarray, angle: float) -> np.ndarray:
    img = Image.fromarray(gray)
    return np.asarray(img.rotate(angle, resample=Image.BILINEAR, fillcolor=255))


def _downscale(gray: np.ndarray, target: int) -> np.ndarray:
    longest = max(gray.shape)
    if longest <= target:
        return gray
    ratio = target / longest
    img = Image.fromarray(gray)
    img = img.resize(
        (max(1, int(img.width * ratio)), max(1, int(img.height * ratio))),
        Image.LANCZOS,
    )
    return np.asarray(img)


# ---------------------------------------------------------------------------
# Ink detection
# ---------------------------------------------------------------------------

def flatten_illumination(gray: np.ndarray) -> np.ndarray:
    """Divide out a heavy blur so shadows do not become ink."""
    background = np.asarray(
        Image.fromarray(gray).filter(ImageFilter.GaussianBlur(radius=25))
    ).astype(np.float32)
    norm = gray.astype(np.float32) / np.maximum(background, 1.0) * 255.0
    return np.clip(norm, 0, 255).astype(np.uint8)


def otsu_threshold(gray: np.ndarray) -> int:
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if total <= 0:
        return 127
    sum_all = float(np.dot(np.arange(256), hist))
    sum_b = 0.0
    weight_b = 0.0
    best, threshold = -1.0, 127
    for value in range(256):
        weight_b += hist[value]
        if weight_b <= 0:
            continue
        weight_f = total - weight_b
        if weight_f <= 0:
            break
        sum_b += value * hist[value]
        mean_b = sum_b / weight_b
        mean_f = (sum_all - sum_b) / weight_f
        between = weight_b * weight_f * (mean_b - mean_f) ** 2
        if between > best:
            best, threshold = between, value
    return threshold


def binarize(gray: np.ndarray) -> np.ndarray:
    # Cap at 182 so faint notebook ruled lines after flatten_illumination
    # (~185..235) are not misclassified as handwriting ink.
    return gray < min(otsu_threshold(gray), 182)


# ---------------------------------------------------------------------------
# Cropping
# ---------------------------------------------------------------------------

def crop_document(document, dpi: int = DEFAULT_DPI,
                  max_blocks: int = MAX_BLOCKS_PER_PAGE) -> list[PageLayout]:
    """Crop answer blocks out of a loaded ``Document``.

    ``document`` is duck-typed: ``.kind`` plus ``.pages[i].data``.
    """
    layouts: list[PageLayout] = []
    for offset, page in enumerate(getattr(document, "pages", []), start=1):
        for gray in render_pages(page.data, document.kind, dpi=dpi):
            page_number = getattr(page, "index", offset) or offset
            layouts.append(_crop_page(gray, page_number, dpi, max_blocks))
    return layouts


def _crop_page(gray: np.ndarray, page: int, dpi: int,
               max_blocks: int) -> PageLayout:
    height, width = gray.shape
    deskewed, _angle = deskew(gray)
    normalized = flatten_illumination(deskewed)
    binary = binarize(normalized)

    row_ink = binary.sum(axis=1)
    # Ruled notebook paper: a near-full-width horizontal line is stationery,
    # not an answer. Treat it as a separator so the answers above and below
    # become separate bands instead of one page-sized block.
    rule_rows = row_ink > width * 0.6
    if rule_rows.any():
        row_ink = row_ink.copy()
        row_ink[rule_rows] = 0
    row_threshold = max(2, int(width * 0.0015))
    bands = _runs(row_ink > row_threshold, min_len=max(8, int(height * 0.006)))
    bands = _merge_gaps(bands, max_gap=max(4, int(height * 0.006)))

    blocks: list[tuple[int, int, int, int]] = []
    column_gap = max(16, int(width * 0.04))
    for top, bottom in bands:
        column_ink = binary[top:bottom].sum(axis=0)
        # Keep every ink run here: single letters are often narrower than the
        # noise floor, and dropping them before merging shreds the block.
        segments = _runs(column_ink > 0, min_len=1)
        segments = _merge_gaps(segments, max_gap=column_gap)
        kept = [
            (left, right)
            for left, right in segments
            if right - left >= width * 0.015
        ]
        if not kept:
            continue
        # Span the full horizontal extent of the band so margin question
        # numbers ("Ans. 6)") and multi-line prose paragraphs with aligned
        # word gaps are kept intact in one crop rather than sliced vertically.
        blocks.append((kept[0][0], top, kept[-1][1], bottom))

    blocks = _limit_blocks(blocks, max_blocks)

    pad = max(6, int(width * 0.006))
    crops: list[Crop] = []
    for index, (left, top, right, bottom) in enumerate(blocks):
        x0, y0 = max(0, left - pad), max(0, top - pad)
        x1, y1 = min(width, right + pad), min(height, bottom + pad)
        if x1 <= x0 or y1 <= y0:
            continue
        patch = normalized[y0:y1, x0:x1]
        buffer = io.BytesIO()
        Image.fromarray(patch).save(buffer, "JPEG", quality=JPEG_QUALITY)
        crops.append(
            Crop(
                page=page,
                index=index,
                rect=Rect(x0 / width, y0 / height,
                          (x1 - x0) / width, (y1 - y0) / height),
                image=buffer.getvalue(),
                dpi=dpi,
                line_count=_line_count(patch),
            )
        )

    return PageLayout(page=page, width=width, height=height, dpi=dpi, crops=crops)


def _line_count(patch: np.ndarray) -> int:
    if patch.size == 0:
        return 0
    rows = (patch < 128).sum(axis=1)
    runs = _runs(rows > max(2, int(patch.shape[1] * 0.01)),
                 min_len=max(4, int(patch.shape[0] * 0.01)))
    return max(1, len(runs))


def _runs(mask: np.ndarray, min_len: int = 1) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(mask):
        if value and start is None:
            start = index
        elif not value and start is not None:
            if index - start >= min_len:
                runs.append((start, index))
            start = None
    if start is not None and len(mask) - start >= min_len:
        runs.append((start, len(mask)))
    return runs


def _merge_gaps(spans: list[tuple[int, int]],
                max_gap: int) -> list[tuple[int, int]]:
    if not spans:
        return []
    merged = [list(spans[0])]
    for start, end in spans[1:]:
        if start - merged[-1][1] <= max_gap:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _limit_blocks(blocks: list[tuple[int, int, int, int]],
                  cap: int) -> list[tuple[int, int, int, int]]:
    work = [list(block) for block in blocks]
    while len(work) > cap:
        work.sort(key=lambda block: (block[1], block[0]))
        best_index, best_gap = 0, None
        for index in range(len(work) - 1):
            gap = work[index + 1][1] - work[index][3]
            if best_gap is None or gap < best_gap:
                best_gap, best_index = gap, index
        first, second = work[best_index], work[best_index + 1]
        work[best_index:best_index + 2] = [[
            min(first[0], second[0]), min(first[1], second[1]),
            max(first[2], second[2]), max(first[3], second[3]),
        ]]
    return [tuple(block) for block in work]
