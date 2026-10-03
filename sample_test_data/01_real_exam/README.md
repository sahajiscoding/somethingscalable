# 01_real_exam — drop your real documents here

Place **exactly three files** in this folder (any supported type:
multi-page PDF, JPG/PNG/TIFF image, or TXT):

1. **Question paper** — file name must contain `paper` or `question`
   e.g. `physics_unit3_paper.pdf`
2. **Answer key / rubric** — must contain `key`, `rubric` or `official`
   e.g. `physics_unit3_answer_key.pdf`
3. **Student answer sheet** — must contain `student`, `sheet`, `script`
   or `answer` e.g. `student_sheet_scan.jpg`

Then run:

```bash
export GEMINI_API_KEY=your-key
python test_real_exam.py --case 01_real_exam
```

The graded output lands in `output/report.json` and `output/report.md`
inside this folder.
