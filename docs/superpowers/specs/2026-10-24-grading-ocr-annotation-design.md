# Vision-Grounded Grading (OCR + Annotation)

## Problem

Grading a scanned sheet currently sends whole pages to one VLM and waits for a
single large JSON response. Three consequences: latency is dominated by the
slowest call, transcription errors are indistinguishable from student errors,
and the result carries no geometry, so the dual-pane review UI cannot be built
from it.

## Users

- **Primary**: a teacher reviewing a graded sheet, who must trust each mark and
  correct it in seconds.
- **Not for**: fully automated gradebooks with no human review; batch reporting.

## Hypothesis

We believe **crop-first transcription with a two-provider arbiter and SymPy
consistency checks** will **make grades trustworthy and review fast** for
**teachers checking scanned math**. We'll know we're right when transcription
errors are flagged as uncertain instead of marked wrong, and a single question
re-check completes in under 2s at p50.

## Approach

`vision/` package, three layers, no new vendors.

1. **Vision** — rasterize, deskew, binarize, projection-profile crops, then
   transcribe each crop with NVIDIA (and Groq when its key exists), arbitrate
   with SymPy, and emit normalized geometry.
2. **Grading** — compile the exam key once into canonical LaTeX, resolve what
   SymPy can prove, send only the remainder to the reasoning model.
3. **Presentation** — SVG overlay in a CSS-transformed container, linked to a
   step list through one `activeId`.

## Components

| Unit | Purpose | Depends on |
|---|---|---|
| `vision/models.py` | Crop, Transcription, Span, TranscribedPage | stdlib |
| `vision/layout.py` | pixels → crops with absolute page rects | pymupdf, PIL, numpy |
| `vision/providers.py` | NVIDIA/Groq clients behind one interface | requests |
| `vision/ocr.py` | prompt, batching, JSON extraction | providers |
| `vision/arbiter.py` | agreement, SymPy equivalence, chain check | sympy |
| `vision/__init__.py` | façade `transcribe_document()` | all of the above |
| `vision/__main__.py` | CLI: layout-only or full transcription | façade |

## Data flow

```
document → layout.crop_document → Crop[] (absolute page rect, JPEG bytes)
        → providers.transcribe (NVIDIA, optionally Groq)
        → arbiter.decide → Transcription (latex, confidence)
        → arbiter.contradiction → fidelity
        → TranscribedPage[]
```

`Span.rect_rel` is normalized inside its crop; the crop carries the absolute
page rect. The model never emits page-absolute coordinates.

## Error Handling

| Condition | Behaviour |
|---|---|
| One provider unavailable | Single-provider result, confidence capped at 0.55 |
| All providers unavailable | `fidelity: unreadable`, grading blocked, explicit UI state |
| Providers disagree | `confidence <= 0.4`, surfaced as "may be misread" |
| SymPy cannot parse | String-normalized comparison, `confidence <= 0.5` |
| Arithmetic chain contradicts | Confidence capped at 0.3, tagged `transcription`, not `calculation` |

No path converts a low-confidence transcription into a zero mark.

## Testing

- Unit: synthetic page → expected crop count and bounds; deskew recovers a known
  rotation; arbiter decision matrix; chain contradiction detection.
- Contract: recorded provider payloads, no live calls.
- Golden set: digit CER, box IoU, teacher agreement (later milestone).

## Milestones

| # | Milestone | Outcome |
|---|---|---|
| M1 | `vision/` package + CLI | Crop and transcription quality measurable offline |
| M2 | Pipeline wiring + SymPy fast path | Grading uses crops; key compiled once |
| M3 | Annotation UI | Dual-pane review with linked boxes |

## Out of Scope

- Per-step streaming (explicitly rejected: adds wall-clock time).
- Local model hosting, Hugging Face Spaces, separate workers.
- Database persistence for teacher overrides in v1.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Vercel bundle grows past 500 MB | Deploy fails | numpy+sympy only (~90 MB); no OpenCV |
| Groq key absent | No second opinion | Arbiter degrades to single provider |
| Projection crops split a formula | Wrong transcription | Conservative gap thresholds; crop cap merges neighbours |
| SymPy hangs on hostile input | Request timeout | Length cap and guarded parse |

## Annotation Contract (implemented)

`/api/extract` with `role=student` returns, per answer:

- `crop_ids` — the OCR blocks that make up the answer
- `geometry` — `[{crop_id, page, rect: [x, y, w, h]}]`, normalized to the page

`/api/align` copies `geometry` onto the aligned question and `/api/grade-batch`
round-trips it. The UI renders the student's original file (object URL for
images, pdf.js for PDFs) and overlays SVG rectangles from the normalized
coordinates, so no server-side page storage is required.

When the whole-document fallback ran, `geometry` is empty; the UI must show an
explicit "no page mapping for this answer" state instead of an empty pane.

## Status

| Milestone | State |
|---|---|
| M1 `vision/` package + CLI | done — 59 tests; 9/9 blocks on a 1700x2200 scan; 3/3 on a PDF page |
| M2 pipeline wiring + SymPy fast path | done — `VISION_STUDENT=auto`, fallback, geometry contract |
| M3 annotation UI | next — page renderer, SVG overlay, linked question list |

Provider calls are contract-tested only: no NVIDIA/Groq key and no real scanned
sheet were available, so accuracy and live latency still need a golden-set run.

---
*Status: M1 and M2 complete. M3 pending.*
