# Dual-Pane Review & Step-by-Step Annotation UI Design (M3)

## Overview

Builds the M3 Dual-Pane Review workspace for **WeHelpTeachers** (`somethingscalable`), transforming the post-grading view into an interactive split-screen workspace inspired by modern AI grading interfaces while keeping the app's signature dark-mode palette (`bg-canvas` `#000000`, `mint` `#81c784`, `crimson` `#e57373`, `sand` `#e0b56c`).

Teachers can inspect the student's scanned submission on the left with crimson bounding boxes, dashed leader lines, and floating error-type callouts (`Concept Error`, `Calculation Error`, `Result Error`, `Missing Root`), while reviewing and editing a collapsible **Step-by-Step Breakdown** and **Teacher Feedback** in the **AI Transcript** pane on the right.

---

## Goals & Scope

### In Scope (Single-Submission Dual-Pane Review)
1. **Enriched Backend Geometry & Single-Pass Step Grading**:
   - Include `latex` and `confidence` inside each `geometry` crop entry (`{ crop_id, page, rect, latex, confidence }`).
   - Return rasterized `page_images` (JPEG data URLs) from `/api/extract` when `role="student"` so multi-page PDFs and images render in the browser with 1:1 coordinate alignment without adding `pdfjs-dist`.
   - Extend `grade.py` (`PROMPT_TEMPLATE` and `normalise_record()`) so each graded question includes `geometry` and a `steps` array (`title`, `status`, `lines: [{ crop_id, text, ok, error_tag }]`, `explanation`), with a deterministic fallback when fast-grading runs or the LLM omits `steps`.
2. **Left Pane — Student Submission & On-Page Callout Overlay**:
   - Header bar with `Q1..Qn` score pills (`mint` for full marks, `crimson` for deductions, active ring on selected question), `Page <n>` selector, and `Fixes` toggle switch.
   - Responsive page image viewport with a synchronized SVG + HTML overlay rendering crimson bounding boxes (`rect: [x, y, w, h]`), dashed leader lines, and floating error-tag pills (`Concept Error`, `Calculation Error`, `Result Error`, `Missing Root`).
3. **Right Pane — AI Transcript, Summary Toggle & Teacher Controls**:
   - `Summary` ↔ `Transcript` mode switch and overall accuracy pill (`X/Y correct · Z%`).
   - Question header with inline mark override (`awarded / max_marks`), `✓ Accept` and `⚑ Flag` state buttons, and the question prompt card.
   - Collapsible **Step-by-Step Breakdown** accordion with green/crimson status dots, per-line `✓`/`✕` status rows, `🔗` crop-focus button, and amber/sand explanation banners.
   - Sticky **Teacher Feedback** textarea per question.
   - All teacher edits (mark overrides, `Accept`/`Flag` state, custom teacher feedback) update the live/demo report in memory and flow into exported `report.pdf`, `report.md`, and `report.json` files.
4. **Demo Mode Interactive Sample**:
   - Upgrade `frontend/src/lib/sim.ts` with a realistic rendered handwritten math sheet (`Q1`–`Q4`, including the polynomial questions `5x^3 + 2x - 7`, `p(x) = x^2 - 4` at `x=2`, and `x^2 - 9 = 0`), complete with normalized bounding boxes, step breakdowns, and error callouts so Demo Mode demonstrates the full Dual-Pane UI immediately.

### Out of Scope
- Multi-student classroom roster / batch queue (`Prev / Next` student switcher across multiple uploaded student scripts).
- Second-pass VLM token-level sub-cropping (to preserve the 39 RPM budget and sub-60s Vercel execution limit).
- Server-side database persistence for teacher overrides (exports via PDF/MD/JSON carry all teacher edits).

---

## Architecture & Data Flow

```
[Student File (PDF/Image)]
       │
       ├──► /api/extract (role=student)
       │      ├─► vision.transcribe_document() -> crops + normalized rects + LaTeX
       │      ├─► vision.answers.answers_from_transcript() -> geometry[{crop_id, page, rect, latex, confidence}]
       │      └─► page_images: ["data:image/jpeg;base64,..."] (from doc.pages)
       │
       ├──► /api/align
       │      └─► copies geometry onto AlignedQuestion
       │
       └──► /api/grade-batch (or /api/grade-one)
              ├─► LLM grades questions + emits steps[{title, status, lines, explanation}]
              └─► normalise_record() validates/synthesizes steps & preserves geometry
                        │
                        ▼
         [Frontend DualPaneReview.tsx]
           ├─► Left Pane: Page Image + SVG Boxes + Dashed Leader Lines + Error Badges
           └─► Right Pane: Summary/Transcript Toggle + Step Accordion + Teacher Overrides
```

---

## Backend Specification

### 1. `vision/answers.py`
Update `_geometry(crop_ids, blocks)` to include the transcribed `latex` and `confidence` already present in `blocks`:

```python
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
```

### 2. `server.py` (`/api/extract`)
When `role == "student"` and `doc.pages` contains rasterized page images (`PageImage.data`), encode each page as a `data:image/jpeg;base64,...` string in a top-level `page_images: list[str]` field on the `/api/extract` response.

### 3. `extract.py` (`AlignedQuestion.to_payload()`)
Include `"geometry": list(self.geometry)` in `AlignedQuestion.to_payload()` so `grade_answers()` can show the model the ordered `crop_id`s and line transcriptions for each question.

### 4. `grade.py` (`PROMPT_TEMPLATE` & `normalise_record()`)
Extend `PROMPT_TEMPLATE` to request an optional `steps` array on each question object:
- `title`: concise step name (e.g., `"Step 1: Substitute x=2"`, `"Step 2: Calculate value"`, `"Step 3: Conclusion"`).
- `status`: `"correct"` or `"error"`.
- `lines`: array of `{ "crop_id": str, "text": str, "ok": bool, "error_tag": str }` where `error_tag` is `""` for correct/secondary lines and a 2–3 word label (`"Concept Error"`, `"Calculation Error"`, `"Result Error"`, `"Missing Root"`, `"Sign Error"`, `"Unit Error"`, `"Incomplete Step"`) on the primary erred line of a step.
- `explanation`: 1-sentence explanation when `status == "error"` (e.g., `"Arithmetic error: calculated 2^2 as 22."`), or `""` when `status == "correct"`.

In `normalise_record(item, q, params)`:
- Preserve `"geometry": list(q.geometry)` on the returned record.
- Normalize `item.get("steps")` into validated step dicts.
- **Deterministic Fallback**: If `item.get("steps")` is missing or empty:
  - Group `q.geometry` crops (or non-empty lines of `student_answer` if `q.geometry` is empty) into sequential steps (`Step 1`, `Step 2`, ...).
  - If `marks_deducted == 0`, mark all steps `"correct"` (`ok: True`).
  - If `marks_deducted > 0`, mark earlier steps `"correct"` and attach the deduction reason(s) and a derived `error_tag` (`"Concept Error"` / `"Calculation Error"` / `"Result Error"`) to the final step(s) so the UI always renders both the Step-by-Step Breakdown and on-page callouts.

---

## Frontend Specification

### 1. Data Contracts (`frontend/src/lib/api.ts`)
Extend `GradeRecord` and `LiveReport`:
```ts
export interface CropGeometry {
  crop_id: string;
  page: number;
  rect: [number, number, number, number]; // [x, y, w, h] normalized 0..1
  latex?: string;
  confidence?: number;
}

export interface StepLine {
  crop_id?: string;
  text: string;
  ok: boolean;
  error_tag?: string;
}

export interface GradeStep {
  title: string;
  status: 'correct' | 'error';
  lines: StepLine[];
  explanation?: string;
}
```
Add `geometry?: CropGeometry[]` and `steps?: GradeStep[]` to `GradeRecord`, and `pageImages?: string[]` to the live evaluation result.

### 2. Dual-Pane Review Component (`frontend/src/views/DualPaneReview.tsx`)
- **Top Action Bar**:
  - Left: Student submission file badge, checking mode badge (`Standard` / `Strict`), and active model label.
  - Right: `Page <n> ▾` dropdown (when `pageCount > 1`), global `✓ Accept` button, `⚑ Flag` button, and export buttons (`Download PDF`, `MD`, `JSON`).
- **Left Pane (`Student Submission`)**:
  - **Subheader**: Horizontally scrollable question pills (`Q1 3/3`, `Q2 0/2`, `Q3 1/3`, `Q4 1/2`) styled in `mint` (`awarded === total`), `sand` (`awarded > 0`), or `crimson` (`awarded === 0` or has errors), plus the `Fixes` toggle switch on the right.
  - **Annotated Page Canvas**:
    - Displays the current page image (`pageImages[page - 1]` or object URL fallback, or the generated SVG math worksheet in Demo Mode).
    - When `Fixes` is ON, renders an overlay for all crops on `currentPage`:
      - Subtle dashed border on crops belonging to the active question.
      - Solid `crimson` rectangle (`rect: [x, y, w, h]`) around every crop with an `error_tag` (or `ok === false`).
      - Dashed `crimson` leader line from the box's top-center or right-middle anchor to a floating callout badge (`Concept Error`, `Calculation Error`, `Result Error`, `Missing Root`) with a crimson indicator dot.
      - Clicking any box or callout badge selects that question and highlights/expands the corresponding step on the right pane.
- **Right Pane (`AI Transcript` / `Summary`)**:
  - **Subheader**: `AI Transcript` label, `Summary` ↔ `Transcript` toggle switch, and `<fullMarksCount>/<totalQuestions> correct · <pct>%` badge.
  - **When `Transcript` is active**:
    - **Question Header**: `QUESTION <no>`, editable score badge (`awarded / total` — click to edit numeric value between `0` and `total` in `0.5` increments), `✓ Accept` button (toggles accepted state in `mint`), and `⚑ Flag` button (toggles flagged state in `crimson`).
    - **Question Prompt Card**: Shows the question text (`q.question` / `q.target`) in a subtle dark card (`bg-white/[0.03] border-white/10`).
    - **Step-by-Step Breakdown**:
      - Lists each `GradeStep` as a collapsible card.
      - Correct steps default to collapsed (or single-line preview) with a `mint` dot; error steps default to expanded with a `crimson` dot and `🔗` link icon.
      - Inside an expanded step: each `StepLine` renders in a monospace row with `✓` (`text-mint`) or `✕` (`text-crimson`), followed by the amber/sand explanation callout (`border-sand/45 bg-sand/15 text-[#ffe6c0]`) when `step.explanation` is non-empty.
    - **Teacher Feedback**:
      - Textarea at the bottom of the pane (`Add feedback for the student...`) bound to `teacherFeedback[q.no]`, initialized from or appended to the question's feedback and included in all exported reports.
  - **When `Summary` is active**:
    - Renders the overall score card, grade badge, penalty impact breakdown, and all-questions summary list inside the right pane while keeping the student script visible on the left.

---

## Error Handling & Edge Cases

| Scenario | Handling |
|---|---|
| Whole-document OCR fallback (empty `geometry`) | Left pane renders the uploaded page image with an info pill: *"Page preview — line coordinates unavailable for this answer."* Right pane still shows synthesized steps from `student_answer` lines. |
| Callout badge near right edge (`x + w > 0.72`) | Leader line angles upward-left or places the badge above the box (`clamp(x, 0.04, 0.74)`) so badges never overflow the page container. |
| Teacher overrides marks (`0 <= newMarks <= max_marks`) | Recomputes `marks_deducted`, overall `awarded`, `pct`, and `gradeLetter(pct)` immediately across both panes and export generators. |
| Streaming / Batched live grading in progress | Questions appear in the pill bar as batches complete; clicking any completed question lets the teacher inspect its boxes and steps while remaining batches finish. |

---

## Verification & Testing Plan

1. **Backend Unit Tests (`tests/test_step_grading.py`)**:
   - Verify `vision/answers.py:_geometry()` includes `latex` and `confidence`.
   - Verify `grade.py:normalise_record()` preserves `geometry`, normalizes LLM-provided `steps`, and synthesizes fallback `steps` with appropriate `error_tag`s when `steps` is omitted.
   - Verify `/api/extract` with `role=student` includes `page_images` alongside `answers`.
2. **Frontend Build & Type Check**:
   - Run `npm --prefix frontend run build` (`tsc -b && vite build`) and `npm --prefix frontend run lint` (`oxlint`) with zero errors.
3. **Interactive Verification**:
   - Verify Demo Mode renders the multi-question handwritten polynomial worksheet with `Concept Error`, `Calculation Error`, `Result Error`, and `Missing Root` callouts, `Fixes` toggle, `Summary`/`Transcript` toggle, collapsible steps, mark override, `Accept`/`Flag`, and `Teacher Feedback`.
