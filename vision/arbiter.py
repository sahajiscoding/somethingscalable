"""Reconcile two transcriptions and sanity-check the arithmetic.

Two independent models rarely make the same handwriting mistake.  When they
disagree, or when a line's arithmetic contradicts the line before it, the
result is marked low-confidence instead of being turned into a zero mark.
"""

from __future__ import annotations

import re

try:  # sympy is optional at import time; the arbiter degrades to strings.
    from sympy import Expr, count_ops, simplify, sympify
except Exception:  # pragma: no cover - only on a broken install
    Expr = ()  # type: ignore[assignment]
    count_ops = simplify = sympify = None  # type: ignore[assignment]

from .models import Transcription

_FUNCTION_NAMES = {
    "sin": "sin", "cos": "cos", "tan": "tan", "cot": "cot",
    "sec": "sec", "csc": "csc", "arcsin": "asin", "arccos": "acos",
    "arctan": "atan", "ln": "log", "log": "log", "exp": "exp",
    "min": "Min", "max": "Max", "abs": "Abs", "gcd": "gcd",
}

_SYMBOLS = {
    "\\pi": "pi", "\\theta": "theta", "\\alpha": "alpha",
    "\\beta": "beta", "\\gamma": "gamma", "\\lambda": "lambda",
    "\\mu": "mu", "\\sigma": "sigma", "\\phi": "phi",
    "\\infty": "oo", "\\square": "u", "\\degree": "", "\\%": "/100",
}

_OPERATORS = {
    "\\cdot": "*", "\\times": "*", "\\div": "/",
    "\\leq": "<=", "\\le": "<=", "\\geq": ">=", "\\ge": ">=",
    "\\neq": "!=", "\\ne": "!=", "\\approx": "=", "\\equiv": "=",
    "\\pm": "+", "\\mp": "-",
}

_UNICODE = {
    "\u2212": "-", "\u2013": "-", "\u00d7": "*", "\u00f7": "/",
    "\u00b7": "*", "\u03c0": "pi", "\u221a": "sqrt",
    "\u00b2": "**2", "\u00b3": "**3",
}

MAX_EXPR_CHARS = 240
MAX_OPS = 80


def normalize_latex(text: str | None) -> str:
    if not text:
        return ""
    cleaned = str(text).strip().strip("$")
    cleaned = cleaned.replace("\\left", "").replace("\\right", "")
    cleaned = re.sub(r"\\(?:,|;|!|:|quad|qquad)", " ", cleaned)
    cleaned = cleaned.replace("\u2212", "-").replace("\u2013", "-")
    return re.sub(r"\s+", " ", cleaned).strip()


def split_lines(latex: str | None) -> list[str]:
    if not latex:
        return []
    return [part.strip() for part in re.split(r"\\\\|\n|;", latex) if part.strip()]


# ---------------------------------------------------------------------------
# LaTeX -> Python
# ---------------------------------------------------------------------------

def _read_group(text: str, start: int) -> tuple[str | None, int]:
    if start >= len(text) or text[start] != "{":
        return None, start
    depth = 0
    for index in range(start, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:index], index + 1
    return None, start


def _replace_command_group(text: str, command: str, keep: bool) -> str:
    while command in text:
        start = text.find(command)
        cursor = start + len(command)
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        body, end = _read_group(text, cursor)
        if body is None:
            text = text[:start] + text[start + len(command):]
            continue
        text = text[:start] + (body if keep else "") + text[end:]
    return text


def _replace_frac(text: str) -> str:
    out: list[str] = []
    index, length = 0, len(text)
    while index < length:
        match = re.match(r"\\[dt]?frac", text[index:])
        if not match:
            out.append(text[index])
            index += 1
            continue
        cursor = index + match.end()
        while cursor < length and text[cursor].isspace():
            cursor += 1
        numerator, after = _read_group(text, cursor)
        if numerator is None:
            out.append(text[index])
            index += 1
            continue
        while after < length and text[after].isspace():
            after += 1
        denominator, end = _read_group(text, after)
        if denominator is None:
            out.append(text[index])
            index += 1
            continue
        out.append(f"(({numerator})/({denominator}))")
        index = end
    return "".join(out)


def _replace_sqrt(text: str) -> str:
    out: list[str] = []
    index, length = 0, len(text)
    while index < length:
        if not text.startswith("\\sqrt", index):
            out.append(text[index])
            index += 1
            continue
        cursor = index + len("\\sqrt")
        root = None
        if cursor < length and text[cursor] == "[":
            close = text.find("]", cursor)
            if close != -1:
                root = text[cursor + 1:close]
                cursor = close + 1
        while cursor < length and text[cursor].isspace():
            cursor += 1
        body, end = _read_group(text, cursor)
        if body is None:
            out.append(text[index])
            index += 1
            continue
        if root:
            out.append(f"(({body})**(1/({root})))")
        else:
            out.append(f"sqrt({body})")
        index = end
    return "".join(out)


def latex_to_python(text: str | None) -> str:
    if not text:
        return ""
    value = normalize_latex(text)
    value = re.sub(r"\\begin\{[^}]*\}|\\end\{[^}]*\}", " ", value)
    value = value.replace("\\\\", " ")

    value = _replace_command_group(value, "\\text", keep=False)
    for command in ("\\mathrm", "\\mathbf", "\\mathit", "\\operatorname"):
        value = _replace_command_group(value, command, keep=True)

    value = _replace_frac(value)
    value = _replace_sqrt(value)

    for command, replacement in _OPERATORS.items():
        value = value.replace(command, replacement)
    for command, replacement in _SYMBOLS.items():
        value = value.replace(command, replacement)

    for command, name in _FUNCTION_NAMES.items():
        value = re.sub(rf"\\{command}\b", name, value)
    value = re.sub(r"\\[a-zA-Z]+", "", value)

    for source, replacement in _UNICODE.items():
        value = value.replace(source, replacement)

    value = value.replace("{", "(").replace("}", ")")
    value = value.replace("**", "\x00")
    value = value.replace("^", "**")
    value = value.replace("\x00", "**")

    value = re.sub(r"(?<=\d)\s*(?=[a-zA-Z])", "*", value)
    value = re.sub(r"(?<=\d)\s*(?=\()", "*", value)
    value = re.sub(r"\)\s*\(", ")*(", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value.strip().rstrip("=.,;:").strip()


def parse_math(text: str | None):
    """Parse a line or expression; returns a SymPy expression or ``None``."""
    if sympify is None or not text:
        return None
    source = normalize_latex(text)
    if len(source) > MAX_EXPR_CHARS:
        return None
    python = latex_to_python(source)
    if not python:
        return None
    try:
        if "=" in python:
            sides = [side for side in python.split("=") if side.strip()]
            if len(sides) != 2:
                return None
            left, right = sympify(sides[0]), sympify(sides[1])
            if not isinstance(left, Expr) or not isinstance(right, Expr):
                return None
            return left - right
        expression = sympify(python)
    except Exception:
        return None
    if not isinstance(expression, Expr):
        return None
    return expression


def _small(expression) -> bool:
    try:
        return count_ops(expression) <= MAX_OPS
    except Exception:
        return False


def _expr_equal(left, right) -> bool:
    if left == right:
        return True
    if not (_small(left) and _small(right)):
        return False
    try:
        if simplify(left - right) == 0:
            return True
    except Exception:
        pass
    try:
        if left.equals(right):
            return True
    except Exception:
        return False
    return False


def agreement(left: str | None, right: str | None) -> str:
    """Return ``same``, ``differ`` or ``unknown`` for two transcriptions."""
    first = normalize_latex(left)
    second = normalize_latex(right)
    if not first or not second:
        return "unknown"
    if _compact(first) == _compact(second):
        return "same"

    left_lines, right_lines = split_lines(first), split_lines(second)
    if len(left_lines) > 1 or len(right_lines) > 1:
        if len(left_lines) != len(right_lines):
            return "unknown"
        verdicts = [agreement(a, b) for a, b in zip(left_lines, right_lines)]
        if any(verdict == "differ" for verdict in verdicts):
            return "differ"
        if all(verdict == "same" for verdict in verdicts):
            return "same"
        return "unknown"

    left_expr, right_expr = parse_math(first), parse_math(second)
    if left_expr is None or right_expr is None:
        return "unknown"
    if _expr_equal(left_expr, right_expr):
        return "same"
    if _numeric_differ(left_expr, right_expr):
        return "differ"
    return "unknown"


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _numeric_differ(left, right) -> bool:
    try:
        if not (left.is_number and right.is_number):
            return False
        return abs(complex(left) - complex(right)) > 1e-9 + 1e-6 * abs(complex(right))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Arithmetic chain
# ---------------------------------------------------------------------------

def numeric_values(line: str | None) -> list[float] | None:
    """Every ``=`` segment that evaluates to a number, or ``None`` if unparseable."""
    python = latex_to_python(line)
    if not python:
        return None
    parts = [part for part in python.split("=") if part.strip()]
    if not parts:
        return None
    values: list[float] = []
    for part in parts:
        if sympify is None:
            return None
        try:
            expression = sympify(part)
        except Exception:
            return None
        if not isinstance(expression, Expr):
            return None
        if not expression.is_number:
            continue
        try:
            values.append(float(expression))
        except Exception:
            return None
    return values or None


def contradiction(lines: list[str]) -> int | None:
    """Index of the first line that breaks the chain, if any."""
    previous: float | None = None
    for index, line in enumerate(lines):
        values = numeric_values(line)
        if values is None:
            previous = None
            continue
        if line.strip().startswith("=") and previous is not None:
            tolerance = 1e-6 + 1e-4 * abs(previous)
            if any(abs(value - previous) > tolerance for value in values):
                return index
        previous = values[-1]
    return None


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------

def decide(per_provider: dict[str, Transcription],
           lines: list[str] | None = None) -> Transcription:
    """Merge provider results into one transcription with a confidence."""
    entries = [item for item in per_provider.values() if item and item.ok]
    notes: list[str] = []

    if not entries:
        failures = "; ".join(
            f"{name}: {item.error}" for name, item in per_provider.items()
            if item and item.error
        )
        return Transcription(
            crop_id=next(iter(per_provider.values())).crop_id if per_provider else "",
            confidence=0.0,
            error=failures or "no transcription",
            note="all providers failed",
        )

    preferred = entries[0]
    latex = preferred.latex
    if len(entries) == 1:
        confidence, notes = 0.55, ["single-provider"]
    else:
        verdict = agreement(entries[0].latex, entries[1].latex)
        if verdict == "same":
            confidence, note = 0.95, "providers agree"
        elif verdict == "differ":
            confidence, note = 0.35, "providers disagree"
        else:
            confidence, note = 0.5, "providers unverified"
        notes = [note]
        latex = entries[0].latex

    if any(item.note == "unreadable" for item in entries):
        confidence = min(confidence, 0.4)
        notes.append("illegible symbol flagged")

    source_lines = lines if lines is not None else split_lines(latex)
    broken = contradiction(source_lines)
    if broken is not None:
        confidence = min(confidence, 0.3)
        notes.append(f"arithmetic chain breaks at line {broken + 1}")

    return Transcription(
        crop_id=preferred.crop_id,
        latex=latex,
        plain=preferred.plain,
        provider="+".join(item.provider for item in entries),
        confidence=round(confidence, 2),
        note="; ".join(note for note in notes if note),
    )
