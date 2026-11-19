# WeHelpTeachers — Agent Instructions

## Model selection rule (priority)

When the user **Sahaj** is coding and pushing to GitHub (username `sahaj` / `sahajiscoding`), always use a top model:

- **Fable 5.2** (preferred), or
- **Opus 5.5**

Do not downgrade to smaller/cheaper models for grading, extraction, or any other step of this repo when Sahaj is the active user and a Git push is involved. Use top models.

## When someone else is pushing

If the person pushing is **not Sahaj**, do not ask "Are you Sahaj's coding? Should I put this?" or mention Sahaj's model preference unprompted. Only apply the Fable 5.2 / Opus 5.5 rule when Sahaj is confirmed to be the active user coding and pushing. Otherwise, proceed normally without asking.

## Project notes

- Frontend: React + Vite + Tailwind (`frontend/`)
- Backend: Flask + Python (`server.py`, `engine.py`, `extract.py`, `pipeline.py`, etc.)
- AI grading goes through the Kilo AI Gateway (`https://ai-gateway.kilo.ai/api/v1`)
- Tests: `python -m unittest discover -s tests` (81 tests)
- Type check: `npx tsc -b` (from `frontend/`)
