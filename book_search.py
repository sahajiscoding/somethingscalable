"""Free, optional book-reference lookup for book-specific lesson decks.

This module uses public Google Books and Open Library catalog endpoints only.
Neither needs an API key or paid search subscription. It deliberately does not
use SERPER_API_KEY or any paid search provider. Search failures are non-fatal:
lesson generation can continue using the teacher's prompt alone.
"""

from __future__ import annotations

import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any

SEARCH_TIMEOUT = 4
MAX_TITLE_LENGTH = 200
MAX_RESULTS = 3

_BOOK_TITLE_PATTERNS = (
    re.compile(
        r"\b(?:book|textbook|novel)\s+(?:(?:called|named|titled)\s+)?[\"“']"
        r"(?P<title>[^\"”']{3,200})[\"”']",
        re.IGNORECASE,
    ),
    re.compile(
        r"[\"“'](?P<title>[^\"”']{3,200})[\"”']\s+"
        r"(?:book|textbook|novel)\b",
        re.IGNORECASE,
    ),
)


def find_book_title(topic: str) -> str | None:
    """Find only an explicitly quoted book title; vague mentions do not search."""
    if not isinstance(topic, str):
        return None
    for pattern in _BOOK_TITLE_PATTERNS:
        match = pattern.search(topic)
        if match:
            title = " ".join(match.group("title").split()).strip(" .,:;-")
            if len(title) >= 3:
                return title[:MAX_TITLE_LENGTH]
    return None


def _text(value: Any, limit: int = 1600) -> str:
    if not isinstance(value, str):
        return ""
    value = re.sub(r"<[^>]*>", " ", html.unescape(value))
    return " ".join(value.split())[:limit]


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def _relevant(query: str, title: str) -> bool:
    query_tokens = _tokens(query)
    result_tokens = _tokens(title)
    if not query_tokens or not result_tokens:
        return False
    return len(query_tokens & result_tokens) / len(query_tokens) >= 0.5


def _google_books(title: str) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({
        "q": f'intitle:"{title}"',
        "maxResults": "5",
        "printType": "books",
        "fields": "items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,description,categories,pageCount,infoLink))",
    })
    url = f"https://www.googleapis.com/books/v1/volumes?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": "WeHelpTeachers/1.0 (free public catalog lookup)"})
    try:
        with urllib.request.urlopen(request, timeout=SEARCH_TIMEOUT) as response:  # nosec B310
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError):
        return []

    results: list[dict[str, Any]] = []
    for item in payload.get("items", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        info = item.get("volumeInfo")
        if not isinstance(info, dict):
            continue
        work_title = _text(info.get("title"), 240)
        if not work_title or not _relevant(title, work_title):
            continue
        subtitle = _text(info.get("subtitle"), 180)
        authors = info.get("authors") if isinstance(info.get("authors"), list) else []
        categories = info.get("categories") if isinstance(info.get("categories"), list) else []
        volume_id = _text(item.get("id"), 100)
        link = info.get("infoLink")
        if not isinstance(link, str) or not link.startswith("https://books.google.com/"):
            link = f"https://books.google.com/books?id={urllib.parse.quote(volume_id)}" if volume_id else "https://books.google.com/"
        result: dict[str, Any] = {
            "provider": "Google Books",
            "title": work_title,
            "authors": [_text(author, 120) for author in authors[:5] if isinstance(author, str)],
            "published_date": _text(info.get("publishedDate"), 40),
            "description": _text(info.get("description")),
            "categories": [_text(category, 120) for category in categories[:8] if isinstance(category, str)],
            "url": link,
        }
        if subtitle:
            result["subtitle"] = subtitle
        if isinstance(info.get("publisher"), str):
            result["publisher"] = _text(info["publisher"], 160)
        if isinstance(info.get("pageCount"), int) and not isinstance(info.get("pageCount"), bool):
            result["page_count"] = info["pageCount"]
        results.append(result)
    return results


class _DuckDuckGoResults(HTMLParser):
    """Read only the visible title/snippet text from DDG's free HTML results."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._active_title: dict[str, str] | None = None
        self._snippet_index: int | None = None
        self._capture_title = False
        self._capture_snippet = False

    def handle_starttag(self, tag: str, attrs):
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if tag == "a" and "result__a" in classes:
            self._active_title = {"title": "", "url": attributes.get("href", ""), "description": ""}
            self._capture_title = True
        elif "result__snippet" in classes and self.results:
            self._snippet_index = len(self.results) - 1
            self._capture_snippet = True

    def handle_data(self, data: str):
        if self._capture_title and self._active_title is not None:
            self._active_title["title"] += data
        if self._capture_snippet and self._snippet_index is not None:
            self.results[self._snippet_index]["description"] += data

    def handle_endtag(self, tag: str):
        if tag == "a" and self._active_title is not None:
            self._active_title["title"] = _text(self._active_title["title"], 240)
            self.results.append(self._active_title)
            self._active_title = None
            self._capture_title = False
        if self._capture_snippet and tag in {"a", "div", "td"}:
            self._capture_snippet = False
            self._snippet_index = None


def _duckduckgo_web(title: str) -> list[dict[str, Any]]:
    """Search free web snippets, without a key, paid API, or SERPER fallback."""
    query = f'"{title}" book chapters contents textbook'
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; WeHelpTeachers/1.0; free book lookup)",
        "Accept": "text/html",
    })
    try:
        with urllib.request.urlopen(request, timeout=SEARCH_TIMEOUT) as response:  # nosec B310
            source_html = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError):
        return []

    parser = _DuckDuckGoResults()
    parser.feed(source_html)
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in parser.results:
        result_title = item["title"]
        description = _text(item["description"], 1000)
        raw_url = item["url"]
        parsed = urllib.parse.urlsplit(raw_url if ":" in raw_url[:8] else f"https:{raw_url}")
        if parsed.hostname in {"duckduckgo.com", "www.duckduckgo.com"} and parsed.path == "/l/":
            raw_url = urllib.parse.parse_qs(parsed.query).get("uddg", [""])[0]
            parsed = urllib.parse.urlsplit(raw_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            continue
        normalized_url = urllib.parse.urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))
        if normalized_url in seen or not _relevant(title, f"{result_title} {description}"):
            continue
        seen.add(normalized_url)
        results.append({
            "provider": "DuckDuckGo Web Search",
            "title": result_title or "Web result",
            "description": description,
            "url": normalized_url,
        })
        if len(results) >= MAX_RESULTS:
            break
    return results


def _open_library(title: str) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({
        "title": title,
        "limit": "5",
        "fields": "key,title,author_name,first_publish_year,edition_count,subject",
    })
    url = f"https://openlibrary.org/search.json?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": "WeHelpTeachers/1.0 (free public catalog lookup)"})
    try:
        with urllib.request.urlopen(request, timeout=SEARCH_TIMEOUT) as response:  # nosec B310
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError):
        return []

    results: list[dict[str, Any]] = []
    docs = payload.get("docs", []) if isinstance(payload, dict) else []
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        work_title = _text(doc.get("title"), 240)
        if not work_title or not _relevant(title, work_title):
            continue
        key = doc.get("key")
        if not isinstance(key, str) or not re.fullmatch(r"/works/[A-Z0-9]+", key):
            continue
        authors = doc.get("author_name") if isinstance(doc.get("author_name"), list) else []
        subjects = doc.get("subject") if isinstance(doc.get("subject"), list) else []
        result = {
            "provider": "Open Library",
            "title": work_title,
            "authors": [_text(author, 120) for author in authors[:5] if isinstance(author, str)],
            "published_date": str(doc.get("first_publish_year", ""))[:40],
            "categories": [_text(subject, 120) for subject in subjects[:8] if isinstance(subject, str)],
            "url": f"https://openlibrary.org{key}",
        }
        if isinstance(doc.get("edition_count"), int):
            result["edition_count"] = doc["edition_count"]
        results.append(result)
    return results


def search_book(title: str) -> list[dict[str, Any]]:
    """Use free book catalogs plus free web search, with no paid API fallback."""
    query = " ".join(title.split())[:MAX_TITLE_LENGTH] if isinstance(title, str) else ""
    if len(query) < 3:
        return []

    # Search the book catalogs for reliable identity/description metadata, and
    # a free web search for useful public chapter/contents references.
    catalog_results = _google_books(query)
    web_results = _duckduckgo_web(query)
    if catalog_results:
        return catalog_results[:2] + web_results

    # Open Library is a no-key, free catalog fallback when Google Books has no
    # match or is unavailable. Web search remains useful when neither catalog
    # knows the requested book.
    return _open_library(query)[:1] + web_results
