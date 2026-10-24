# Dual-Pane Review & Step-by-Step Annotation UI Implementation Plan

> **For agentic workers:** Follow these tasks sequentially and verify each with `pytest` and `npm --prefix frontend run build`.

**Goal:** Deliver the M3 Dual-Pane Review UI with linked on-page error callouts (`Concept Error`, `Calculation Error`, `Result Error`, `Missing Root`), collapsible `Step-by-Step Breakdown`, `Summary` ↔ `Transcript` switch, mark overrides, `Accept`/`Flag`, and `Teacher Feedback` in the app's dark-mode theme.

**Spec:** `docs/superpowers/specs/2026-10-24-dual-pane-review-ui-design.md`

---

### Task 1: Enrich Backend Geometry & Page Previews (`vision/answers.py`, `server.py`)
- **Files**:
  - Modify: `vision/answers.py`
  - Modify: `server.py`
- **Steps**:
  1. In `vision/answers.py:_geometry()`, add `"latex": blocks[crop_id][2]` and `"confidence": round(blocks[crop_id][1], 3)` to each geometry entry.
  2. In `server.py`, add `_render_page_previews(data: bytes, kind: str) -> list[str]` and include `"page_images"` in `/api/extract` when `role == "student"`.

### Task 2: Single-Pass Step Breakdown & Fallback in `grade.py`
- **Files**:
  - Modify: `grade.py`
  - Create: `tests/test_step_grading.py`
- **Steps**:
  1. Extend `PROMPT_TEMPLATE` in `grade.py` so the grader returns `steps: [{ title, status, lines: [{ crop_id, text, ok, error_tag }], explanation }]`.
  2. Update `normalise_record()` in `grade.py` to preserve `"geometry": list(q.geometry)` and validate/synthesize `"steps": _normalise_steps(item.get("steps"), q, deductions, awarded, max_marks)`.
  3. Add unit tests in `tests/test_step_grading.py` covering enriched `_geometry`, LLM-provided `steps` normalization, deterministic `steps` synthesis on fast/fallback grading, and `/api/extract` `page_images`.

### Task 3: Frontend Types, Live API Wiring & Demo Polynomial Worksheet (`api.ts`, `sim.ts`)
- **Files**:
  - Modify: `frontend/src/lib/api.ts`
  - Modify: `frontend/src/lib/sim.ts`
- **Steps**:
  1. Add `CropGeometry`, `StepLine`, and `GradeStep` interfaces to `frontend/src/lib/api.ts`; extend `GradeRecord` (`geometry`, `steps`) and `LiveReport` (`pageImages`).
  2. Capture `page_images` from the student `/api/extract` call in `runLiveEvaluation` (with `URL.createObjectURL(input.student)` fallback for image uploads) and attach to `report.pageImages`.
  3. Update `frontend/src/lib/sim.ts` with rich `geometry`, `steps`, and a realistic SVG data-URL handwritten polynomial worksheet (`DEMO_SHEET_PAGES`) featuring `Q1`–`Q4` (including the polynomial questions `5x^3 + 2x - 7`, `p(x) = x^2 - 4` at `x=2`, and `x^2 - 9 = 0` with `Concept Error`, `Calculation Error`, `Result Error`, and `Missing Root` callouts).

### Task 4: Dual-Pane Review Component & Grading View Integration (`DualPaneReview.tsx`, `Grading.tsx`)
- **Files**:
  - Create: `frontend/src/views/DualPaneReview.tsx`
  - Modify: `frontend/src/views/Grading.tsx`
- **Steps**:
  1. Build `DualPaneReview.tsx` implementing:
     - Top bar with student submission info, `Page` selector, global `✓ Accept`, `⚑ Flag`, and export actions (`PDF`, `MD`, `JSON`).
     - Left pane (`Student Submission`): `Q1..Qn` score pills, `Fixes` toggle, responsive page image + SVG bounding boxes + dashed leader lines + floating error-tag badges (`Concept Error`, `Calculation Error`, `Result Error`, `Missing Root`).
     - Right pane (`AI Transcript`): `Summary` ↔ `Transcript` switch, accuracy pill (`1/4 correct · 50%`), active question header with inline mark editor (`awarded / total`), per-question `Accept` & `Flag` buttons, question prompt card, collapsible `Step-by-Step Breakdown` with `✓`/`✕` lines, `🔗` box-focus button, sand/amber explanation callouts, and sticky `Teacher Feedback` textarea.
     - Bi-directional click/hover synchronization between canvas boxes/badges and transcript steps/lines.
  2. Integrate `DualPaneReview` into `Grading.tsx` so both Demo Mode and Live AI Mode render the Dual-Pane Review workspace and propagate teacher edits (mark overrides, accepted/flagged status, custom feedback) to exported PDF, Markdown, and JSON reports.
  3. Verify with `pytest`, `npm --prefix frontend run lint`, and `npm --prefix frontend run build`.
