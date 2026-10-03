"""Vercel Serverless Function entry (classic api/ directory pattern).

Vercel builds every .py in api/ as a Serverless Function; this one re-exports
the Flask app from the project root so all routes (/ , /api/*) are served
through it — the same proven layout as the reference AI project.
"""

from server import app  # noqa: F401  (Vercel serves this WSGI app)
