"""A tiny stand-in for the Kilo Gateway, for local end-to-end verification.

It speaks the same OpenAI-compatible ``POST /chat/completions`` shape as
``https://api.kilo.ai/api/gateway/chat/completions`` and answers the tasks
WeHelpTeachers sends (exam authoring, extraction, grading) with plausible
JSON. Point ``WHT_ENGINE_API_URL`` at it to exercise the real pipeline
without spending gateway quota::

    python -m tests.mock_gateway 5099
    WHT_ENGINE_API_URL=http://127.0.0.1:5099/chat/completions \
    KILO_API_KEY=test python server.py
"""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _question(index: int, marks: float) -> dict:
    bank = [
        ("Differentiate $f(x)=x^3-3x$ with respect to $x$ and evaluate it at $x=2$.",
         "$f'(x)=3x^2-3$, so $f'(2)=9$.",
         "1m for the derivative, 1m for substituting x=2, 1m for the final value."),
        ("Find the roots of $x^2-3x-10=0$ by factorisation.",
         "$(x-5)(x+2)=0$, so $x=5$ or $x=-2$.",
         "1m for factorising, 1m for each root."),
        ("Evaluate $\\int_0^1 3x^2\\,dx$ showing each step.",
         "$[x^3]_0^1 = 1$.",
         "1m for the antiderivative, 1m for the limits, 1m for the result."),
        ("State the product rule and use it on $y=x^2\\sin x$.",
         "$y'=2x\\sin x + x^2\\cos x$.",
         "1m for stating the rule, 1m for applying it correctly."),
        ("Sketch $y=x^2-4$ and label its intercepts.",
         "Upward parabola, vertex $(0,-4)$, roots at $x=\\pm 2$.",
         "1m for the shape, 1m for vertex, 1m for intercepts."),
    ]
    text, answer, scheme = bank[(index - 1) % len(bank)]
    return {
        "number": f"Q{index}",
        "text": text,
        "max_marks": marks,
        "expected_answer": answer,
        "marking_scheme": scheme,
        "keywords": ["differentiate", "integrate", "factorise"],
    }


def _answer(prompt: str) -> dict:
    if "Generate Question" in prompt or "Generate a high-quality exam" in prompt:
        match = re.search(r"Question (\d+) of (\d+)", prompt)
        index = int(match.group(1)) if match else 1
        marks_match = re.search(r"Marks:\s*([\d.]+)", prompt)
        marks = float(marks_match.group(1)) if marks_match else 5.0
        if "questions" in prompt and "total_marks" in prompt:
            count_match = re.search(r"Total questions:\s*(\d+)", prompt)
            count = int(count_match.group(1)) if count_match else 3
            return {
                "title": "Mock Calculus Examination",
                "topic": "Calculus",
                "instructions": "Answer all questions.",
                "total_marks": marks * count,
                "questions": [_question(i, marks) for i in range(1, count + 1)],
            }
        return _question(index, marks)

    if "grade" in prompt.lower() and "marks_awarded" in prompt:
        numbers = re.findall(r'"number"\s*:\s*"([^"]+)"', prompt) or ["1"]
        # Mirror the real prompt contract: a bare array of question objects.
        return [
                {
                    "number": number,
                    "marks_awarded": 2.5,
                    "marks_deducted": 0.5,
                    "expected_answer": "2x",
                    "student_answer": "2x",
                    "feedback": "Correct method, one algebraic slip.",
                    "deductions": [
                        {"category": "content", "marks": 0.5,
                         "reason": "Missing final simplification."}
                    ],
                    "steps": [],
                }
            for number in numbers
        ]

    if "questions" in prompt:
        return {"questions": [
            {"number": "1", "text": "Differentiate x^3.", "max_marks": 5},
        ]}
    if "entries" in prompt:
        return {"entries": [
            {"number": "1", "expected_answer": "3x^2",
             "marking_scheme": ["5m for 3x^2"], "keywords": ["power rule"]},
        ]}
    if "answers" in prompt:
        return {"answers": [
            {"number": "1", "response": "3x^2", "page": 1},
        ]}
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # keep the harness output clean
        return

    def do_GET(self):
        body = json.dumps({"data": [{"id": "nvidia/nemotron-3.5-super-vl:free"}]})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        messages = payload.get("messages") or []
        prompt_parts: list[str] = []
        for message in messages:
            content = message.get("content")
            if isinstance(content, str):
                prompt_parts.append(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        prompt_parts.append(str(part.get("text") or ""))
        prompt = "\n".join(prompt_parts)
        content = json.dumps(_answer(prompt))
        body = json.dumps({
            "id": "mock",
            "model": payload.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant",
                                                 "content": content}}],
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5099
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
