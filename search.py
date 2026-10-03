"""Web answer-key retrieval for Exam Checker.

When no answer key is uploaded, the pipeline can instead fetch expected
answers from the web.  For each question it:

1. Builds a search query from the question text.
2. Searches the web via a pluggable backend.
3. Extracts the expected answer (and key concepts/keywords) from the
   search snippets — using the LLM engine when one is available, or
   falling back to heuristics for the offline mock path.

Search backends (tried in priority order):

* **Serper**  – Google search via serper.dev.  Requires the
  ``SERPER_API_KEY`` environment variable.  Best quality.
* **DuckDuckGo** – free Instant Answer API, no key required.
* **Mock**    – offline fallback: the question text itself supplies
  the expected answer and keywords (plumbing tests only).

No third-party packages are required — only the standard-library
``urllib`` is used for HTTP.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from extract import QuestionSpec, KeyEntry

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SEARCH_TIMEOUT = 10          # seconds per HTTP request
SEARCH_RESULT_COUNT = 5      # results pulled per question
MAX_KEYWORDS = 10            # keywords extracted per question

# Keywords that carry little meaning for grading.
_SEARCH_STOPWORDS = {
    "the", "a", "an", "of", "and", "or", "to", "in", "is", "it", "that",
    "for", "on", "with", "as", "at", "by", "be", "this", "are", "was",
    "were", "has", "have", "had", "will", "would", "could", "should",
    "can", "may", "might", "must", "do", "does", "did", "show", "state",
    "solve", "calculate", "explain", "describe", "define", "name",
    "what", "when", "where", "which", "who", "whom", "whose", "both",
    "and", "the", "a", "an", "of", "in", "on", "at", "to", "for",
    "with", "by", "from", "as", "is", "was", "are", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "dare", "ought", "very", "each", "every", "all", "some", "any",
    "how", "why", "given", "consider", "considering", "identify",
    "determine", "find", "write", "draw", "sketch", "label", "brief",
}


# ---------------------------------------------------------------------------
# Search result + backend abstractions
# ---------------------------------------------------------------------------

@dataclass
class SearchResult:
    """One result returned by a search backend."""
    title: str
    snippet: str
    url: str = ""


class SearchBackend:
    """Interface every backend implements."""

    name: str = "base"

    def search(self, query: str) -> list[SearchResult]:
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Serper.dev  (Google search)  — best quality, requires API key
# ---------------------------------------------------------------------------

class SerperBackend(SearchBackend):
    """Google search via the Serper.dev API.

    Requires ``SERPER_API_KEY`` in the environment (or passed explicitly).
    """

    name = "serper"
    _endpoint = "https://google.serper.dev/search"

    def __init__(self, api_key: str | None = None):
        key = api_key or os.environ.get("SERPER_API_KEY")
        if not key:
            raise ValueError(
                "SerperBackend requires SERPER_API_KEY env var or an explicit "
                "api_key argument."
            )
        self._api_key = key

    def search(self, query: str) -> list[SearchResult]:
        payload = json.dumps({"q": query, "num": SEARCH_RESULT_COUNT,
                              "type": "search"}).encode()
        req = urllib.request.Request(
            self._endpoint,
            data=payload,
            headers={"X-API-KEY": self._api_key,
                     "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=SEARCH_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            return []

        results: list[SearchResult] = []
        for item in data.get("organic", [])[:SEARCH_RESULT_COUNT]:
            results.append(SearchResult(
                title=item.get("title", ""),
                snippet=item.get("snippet", ""),
                url=item.get("link", ""),
            ))
        # Include answer box if present (often the canonical answer).
        answer_box = data.get("answerBox") or {}
        if answer_box.get("answer"):
            results.insert(0, SearchResult(
                title=answer_box.get("title", "Answer"),
                snippet=str(answer_box["answer"]),
                url=answer_box.get("url", ""),
            ))
        return results


# ---------------------------------------------------------------------------
# DuckDuckGo Instant Answer  — free, no API key
# ---------------------------------------------------------------------------

class DuckDuckGoBackend(SearchBackend):
    """Free DuckDuckGo Instant Answer API (no key required)."""

    name = "duckduckgo"
    _endpoint = "https://api.duckduckgo.com/"

    def search(self, query: str) -> list[SearchResult]:
        params = urllib.parse.urlencode({
            "q": query,
            "format": "json",
            "no_html": "1",
            "no_redirect": "1",
            "skip_disambig": "1",
        })
        url = f"{self._endpoint}?{params}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "exam-checker/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=SEARCH_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            return []

        results: list[SearchResult] = []
        abstract = (data.get("AbstractText") or "").strip()
        if abstract:
            results.append(SearchResult(
                title=data.get("Heading", "Answer"),
                snippet=abstract,
                url=data.get("AbstractURL", ""),
            ))
        for topic in data.get("RelatedTopics", []):
            if isinstance(topic, dict) and topic.get("Text"):
                results.append(SearchResult(
                    title=topic.get("FirstURL", "Related"),
                    snippet=topic["Text"],
                    url=topic.get("FirstURL", ""),
                ))
        return results[:SEARCH_RESULT_COUNT]


# ---------------------------------------------------------------------------
# Mock backend  — offline fallback, no network
# ---------------------------------------------------------------------------

class MockSearchBackend(SearchBackend):
    """Offline fallback — uses the question text itself.

    Returns the question as the sole "search result" so downstream keyword
    extraction can proceed without network access.  Produces meaningful
    plumbing coverage but not genuine marks (consistent with the other
    ``MockEngine`` behaviour).
    """

    name = "mock"

    def search(self, query: str) -> list[SearchResult]:
        return [SearchResult(title="Question text", snippet=query, url="")]


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------

def select_backend(*, mock: bool = False,
                   api_key: str | None = None) -> SearchBackend:
    """Choose a search backend based on environment and flags."""
    if mock:
        return MockSearchBackend()
    try:
        key = api_key or os.environ.get("SERPER_API_KEY")
        if key:
            return SerperBackend(api_key=key)
    except ValueError:
        pass
    return DuckDuckGoBackend()


# ---------------------------------------------------------------------------
# Keyword extraction
# ---------------------------------------------------------------------------

def heuristic_keywords(text: str, max_keywords: int = MAX_KEYWORDS) -> list[str]:
    """Extract keywords from *text* using basic NLP heuristics.

    Pulls out significant words (length > 2, not in stopwords), numbers
    and short formula-like fragments, preserving first-seen order.
    """
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()

    # Significant words
    for match in re.finditer(r"[A-Za-z]+", text):
        word = match.group().lower()
        if len(word) > 2 and word not in _SEARCH_STOPWORDS and word not in seen:
            found.append(word)
            seen.add(word)

    # Number / formula fragments (e.g. "x = 5", "40 g/mol")
    for match in re.finditer(r"\b\d+(?:\.\d+)?\b", text):
        num = match.group()
        if num not in seen:
            found.append(num)
            seen.add(num)

    # Symbol-heavy fragments like "x^2", "b²", "√"
    for match in re.finditer(r"[a-zA-Z][^ ]{2,8}", text):
        frag = match.group()
        if frag not in seen:
            found.append(frag)
            seen.add(frag)

    return found[:max_keywords]


def extract_keywords(text: str, engine=None,
                     max_keywords: int = MAX_KEYWORDS) -> list[str]:
    """Extract key concepts from *text*.

    Uses the LLM engine when available and not a mock; otherwise falls
    back to :func:`heuristic_keywords`.
    """
    if engine is not None and not _is_mock_engine(engine):
        prompt = (
            "Extract the most important keywords or concepts from the "
            "following text.  These will be used to check whether a "
            "student's answer contains the required ideas.  Return ONLY "
            "a JSON object: {\"keywords\": [\"concept 1\", \"concept 2\", "
            "...]}"
        )
        try:
            result = engine.generate_json(
                "extract_keywords",
                data={"text": text},
                instruction=prompt,
                temperature=0.1,
            )
            if isinstance(result, dict) and result.get("keywords"):
                kws = [str(k).strip() for k in result["keywords"] if str(k).strip()]
                if kws:
                    return kws[:max_keywords]
        except Exception:
            pass  # fall through to heuristic

    return heuristic_keywords(text, max_keywords)


def expected_answer_from_snippets(snippets: list[SearchResult],
                                  engine=None) -> str:
    """Distil search results into a concise expected answer.

    Uses the LLM when available; otherwise concatenates the snippets with
    the longest first (a cheap relevance proxy).
    """
    if not snippets:
        return ""

    text_blob = "\n".join(r.snippet for r in snippets if r.snippet)

    if engine is not None and not _is_mock_engine(engine):
        prompt = (
            "You are an exam-marking assistant.  A student answered an "
            "exam question.  Here are web search results for that question.  "
            "Extract the EXPECTED (model) answer as a concise string of "
            "key facts, steps or values.  Do not include URLs, source titles "
            "or boilerplate.  Return ONLY JSON: {\"expected_answer\": \"...\"}."
        )
        try:
            result = engine.generate_json(
                "extract_expected_answer",
                data={"search_results": text_blob},
                instruction=prompt,
                temperature=0.1,
            )
            if isinstance(result, dict) and result.get("expected_answer"):
                return str(result["expected_answer"]).strip()
        except Exception:
            pass

    # Heuristic fallback: keep the snippet with the most substantive text.
    best = max(snippets, key=lambda r: len(r.snippet))
    return best.snippet.strip()[:500]


def _is_mock_engine(engine) -> bool:
    """True when *engine* is the offline MockEngine."""
    return getattr(engine, "name", "") == "mock"


# ---------------------------------------------------------------------------
# Query construction
# ---------------------------------------------------------------------------

_QUERY_STRIP_RE = re.compile(r"^\d+\s*[\).\)]?\s*")
_MARKS_RE = re.compile(r"\(\s*\d+(?:\.\d+)?\s*marks?\s*\)", re.I)


def build_search_query(question_text: str) -> str:
    """Turn a question's text into a web-search query string."""
    text = _QUERY_STRIP_RE.sub("", question_text.strip())
    text = _MARKS_RE.sub("", text).strip()
    # Collapse internal whitespace
    text = re.sub(r"\s+", " ", text)
    return text[:200]


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def build_key_entries(questions: list["QuestionSpec"], engine=None, *,
                      mock: bool = False, api_key: str | None = None,
                      max_keywords: int = MAX_KEYWORDS,
                      progress=None) -> list["KeyEntry"]:
    """Build ``KeyEntry`` objects by searching the web for each question.

    Parameters
    ----------
    questions:
        Parsed question specs from :func:`extract.extract_paper`.
    engine:
        Vision/LLM engine (for distilling answers + keywords).  May be
        ``None`` when *mock* is True.
    mock:
        Force the offline mock search backend (no network).
    api_key:
        Optional Serper API key override.
    max_keywords:
        Maximum keywords to extract per question.
    progress:
        Optional ``Callable[[str], None]`` progress callback.

    Returns
    -------
    list of :class:`~extract.KeyEntry` with ``keywords`` populated.
    """
    # Local import to avoid circular dependency at module load time.
    from extract import KeyEntry

    backend = select_backend(mock=mock, api_key=api_key)

    entries: list[KeyEntry] = []
    for q in questions:
        if progress:
            progress(f"Searching web for expected answer to Q{q.number}")

        query = build_search_query(q.text)
        results = backend.search(query)

        expected = expected_answer_from_snippets(results, engine)
        if not expected:
            # Fall back to the question text itself for the mock path.
            expected = q.text

        keywords = extract_keywords(expected, engine, max_keywords)

        entries.append(KeyEntry(
            number=q.number,
            expected_answer=expected,
            marking_scheme=[],
            page=q.page,
            keywords=keywords,
        ))

    return entries
