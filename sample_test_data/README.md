# sample_test_data

Drop-in directory for **real-world end-to-end tests** of the Exam Checker
pipeline. Each *sub-folder* is one grading session (one student).

```
sample_test_data/
├── 00_synthetic/          # ships ready-to-run (plain text, works offline)
│   ├── question_paper.txt
│   ├── answer_key.txt
│   └── student_sheet.txt
├── 01_real_exam/          # <- drop your real files here
│   └── (question_paper.pdf, answer_key.pdf, student_sheet.jpg, ...)
└── README.md
```

## Adding a real exam

Create a folder (any name, e.g. `02_physics_unit3`) and put **exactly three
documents** in it — one question paper, one answer key, one student sheet.
Supported formats: **PDF (multi-page)**, **JPG / PNG / WEBP / TIFF / BMP**,
and **TXT / MD**.

The runner identifies each file by its name (case-insensitive, first match wins):

| Role | Filenames recognised (must appear in the file name) |
|---|---|
| Question paper | `paper`, `question` |
| Answer key / rubric | `key`, `rubric`, `official` |
| Student answer sheet | `student`, `sheet`, `script`, `answer` |

Examples of valid names: `physics_paper.pdf`, `answer_key.pdf`,
`student_sheet_scan.jpg`. If a folder contains files but none match a role,
the test fails and prints the expected names.

## Running the tests

```bash
export GEMINI_API_KEY=your-key        # real OCR + grading (PDFs/images ok)

python test_real_exam.py                       # all cases in this directory
python test_real_exam.py --case 01_real_exam   # just one case
python test_real_exam.py --mock                # offline, TEXT files only
```

- **Real mode** sends the documents to Gemini for vision transcription
  (handwriting included) and rubric-based marking.
- **`--mock` mode** uses a deterministic offline engine (token-overlap
  scoring) to exercise ingest → extraction → alignment → grading → report
  **without an API key**. It only reads plain-text documents, and its
  marks are meaningless — use it to verify plumbing, not to verify
  marking quality.

Results are written per case:

```
sample_test_data/<case>/output/
├── report.json   # machine-readable grading report
└── report.md     # readable report for teachers
```

The runner validates both files (schema, mark ranges, required columns)
and exits non-zero if any case fails.
