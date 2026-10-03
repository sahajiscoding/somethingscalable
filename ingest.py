"""Ingestion & preprocessing for WeHelpTeachers.

Accepts the three grading inputs as file paths:

1. Question paper    - multi-page PDF, image (JPG/PNG/...) or text file
2. Answer key/rubric - PDF, image or text file
3. Student sheet     - scanned PDF or image with handwriting, or text file

PDFs and images are handed to the vision model as raw page bytes (NVIDIA NIM
reads multi-page PDFs natively), so no rendering stack is required.  PDFs
larger than the inline request limit are split into page chunks.  Text
files are decoded with a UTF-8 -> Latin-1 fallback.

Run `python grade_exam.py --help` for the CLI entry point.
"""

from __future__ import annotations

import io
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path

# Inline-request limit is 20 MB; stay comfortably under it.
MAX_INLINE_BYTES = 19 * 1024 * 1024
# Hard page ceiling for a single request (PDF page-token limit).
MAX_PAGES = 300

PDF_EXTS = {".pdf"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".text", ".rtf"}
SUPPORTED_EXTENSIONS = sorted(PDF_EXTS | IMAGE_EXTS | TEXT_EXTS)

_PDF_MAGIC = b"%PDF-"
_IMAGE_MAGIC = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF8": "image/gif",
    b"BM": "image/bmp",
    b"II*\x00": "image/tiff",
    b"MM\x00*": "image/tiff",
}


class IngestError(ValueError):
    """Raised when a supplied document cannot be read or is unsupported."""


@dataclass
class Page:
    """One unit of content sent to the vision model."""

    index: int                 # 1-based page number within the source file
    mime: str                  # application/pdf | image/jpeg | text/plain
    data: bytes = b""          # raw bytes (empty for text pages)


@dataclass
class Document:
    """A loaded, normalized input document."""

    role: str                  # "paper" | "key" | "student"
    path: str
    kind: str                  # "pdf" | "image" | "text"
    pages: list[Page] = field(default_factory=list)
    text: str | None = None    # decoded content for text documents
    warnings: list[str] = field(default_factory=list)
    pages_total: int | None = None   # real page count (split PDFs)

    @property
    def filename(self) -> str:
        return Path(self.path).name

    @property
    def page_count(self) -> int:
        if self.pages_total is not None:
            return self.pages_total
        if self.kind == "pdf":
            return max((p.index for p in self.pages), default=0)
        return max(len(self.pages), 1)

    @property
    def chunk_count(self) -> int:
        return max(len(self.pages), 1)

    @property
    def size_bytes(self) -> int:
        if self.text is not None:
            return len(self.text.encode("utf-8", "replace"))
        return sum(len(p.data) for p in self.pages)

    def describe(self) -> str:
        unit = "page" if self.page_count == 1 else "pages"
        return f"{self.filename} ({self.kind}, {self.page_count} {unit})"


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_document(path: str | Path, role: str) -> Document:
    """Load one input document from disk, dispatching on file type."""
    p = Path(path)
    if not p.exists():
        raise IngestError(f"[{role}] file not found: {p}")
    if not p.is_file():
        raise IngestError(f"[{role}] not a file: {p}")

    data = p.read_bytes()
    if not data:
        raise IngestError(f"[{role}] file is empty: {p.name}")

    ext = p.suffix.lower()
    kind = _detect_kind(ext, data)

    if kind == "pdf":
        return _load_pdf(p, data, role)
    if kind == "image":
        return _load_image(p, data, role)
    return _load_text(p, data, role)


def load_documents(paper: str | Path, key: str | Path,
                   student: str | Path) -> dict[str, Document]:
    """Load the three grading inputs into a role-keyed dict."""
    return {
        "paper": load_document(paper, "paper"),
        "key": load_document(key, "key"),
        "student": load_document(student, "student"),
    }


def _detect_kind(ext: str, data: bytes) -> str:
    if ext in PDF_EXTS or data[:5] == _PDF_MAGIC:
        return "pdf"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in TEXT_EXTS:
        return "text"
    # Fall back to magic-number sniffing for extension-less drops.
    for magic, _mime in _IMAGE_MAGIC.items():
        if data.startswith(magic):
            return "image"
    if b"\x00" not in data[:1024]:
        return "text"
    raise IngestError(
        f"Unsupported file type '{ext or '<no extension>'}'. "
        f"Supported: {', '.join(SUPPORTED_EXTENSIONS)}"
    )


# ---------------------------------------------------------------------------
# Per-kind loaders
# ---------------------------------------------------------------------------

def _load_pdf(path: Path, data: bytes, role: str) -> Document:
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise IngestError(
            "pypdf is required for PDF input. Install with: pip install pypdf"
        ) from exc

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            # Many scanners "encrypt" with an empty password; try that first.
            try:
                reader.decrypt("")
            except Exception as exc:
                raise IngestError(
                    f"[{role}] {path.name} is password-protected and cannot be read."
                ) from exc
        page_count = len(reader.pages)
    except IngestError:
        raise
    except Exception as exc:
        raise IngestError(f"[{role}] could not parse PDF {path.name}: {exc}") from exc

    if page_count == 0:
        raise IngestError(f"[{role}] PDF has no pages: {path.name}")
    if page_count > MAX_PAGES:
        raise IngestError(
            f"[{role}] {path.name} has {page_count} pages (limit {MAX_PAGES}). "
            "Split the document and grade the parts separately."
        )

    warnings: list[str] = []
    if len(data) <= MAX_INLINE_BYTES:
        # Whole document fits in one request - the vision model reads all pages.
        pages = [Page(index=1, mime="application/pdf", data=data)]
    else:
        pages = _split_pdf(data, page_count, PdfReader, PdfWriter)
        warnings.append(
            f"{path.name} is {len(data) // (1024 * 1024)} MB; split into "
            f"{len(pages)} PDF chunks for processing."
        )

    return Document(role=role, path=str(path), kind="pdf", pages=pages,
                    warnings=warnings, pages_total=page_count)


def _split_pdf(data: bytes, page_count: int, reader_cls, writer_cls) -> list[Page]:
    """Split an oversized PDF into page chunks under the inline size limit."""
    reader = reader_cls(io.BytesIO(data))
    pages_per_chunk = max(
        1,
        int(page_count * (MAX_INLINE_BYTES * 0.9) / max(len(data), 1)),
    )
    pages: list[Page] = []
    for start in range(0, page_count, pages_per_chunk):
        writer = writer_cls()
        for index in range(start, min(start + pages_per_chunk, page_count)):
            writer.add_page(reader.pages[index])
        buf = io.BytesIO()
        writer.write(buf)
        pages.append(Page(index=start + 1, mime="application/pdf",
                          data=buf.getvalue()))
    return pages


def _load_image(path: Path, data: bytes, role: str) -> Document:
    mime, _ = mimetypes.guess_type(path.name)
    if not mime or not mime.startswith("image/"):
        mime = _sniff_image_mime(data) or "image/jpeg"
    warnings: list[str] = []
    if len(data) > MAX_INLINE_BYTES:
        try:
            import pymupdf
            img_doc = pymupdf.open(stream=data)
            page = img_doc[0]
            w, h = page.rect.width, page.rect.height
            scale = min(1.0, 2048 / max(w, h))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
            if pix.alpha:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            compressed = pix.tobytes("jpeg", jpg_quality=82)
            if len(compressed) < len(data):
                warnings.append(
                    f"{path.name} was auto-compressed from {len(data) // (1024 * 1024)} MB "
                    f"to {len(compressed) // (1024 * 1024)} MB for AI ingestion."
                )
                data = compressed
                mime = "image/jpeg"
        except Exception:
            pass

    if len(data) > MAX_INLINE_BYTES:
        raise IngestError(
            f"[{role}] {path.name} is {len(data) // (1024 * 1024)} MB - larger than "
            "the 19 MB inline limit. Please downscale the scan and retry."
        )
    return Document(role=role, path=str(path), kind="image",
                    pages=[Page(index=1, mime=mime, data=data)],
                    warnings=warnings)


def _sniff_image_mime(data: bytes) -> str | None:
    for magic, mime in _IMAGE_MAGIC.items():
        if data.startswith(magic):
            return mime
    return None


def _load_text(path: Path, data: bytes, role: str) -> Document:
    text = None
    used_encoding = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            used_encoding = encoding
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        raise IngestError(f"[{role}] could not decode text file {path.name}")

    if not text.strip():
        raise IngestError(f"[{role}] text file has no content: {path.name}")

    warnings: list[str] = []
    if used_encoding not in ("utf-8", "utf-8-sig"):
        warnings.append(f"{path.name} decoded as {used_encoding}.")

    return Document(role=role, path=str(path), kind="text", text=text,
                    pages=[Page(index=1, mime="text/plain")],
                    warnings=warnings)
