import json
import unittest
from unittest import mock

import book_search


class BookTitleDetectionTests(unittest.TestCase):
    def test_only_explicit_book_references_trigger_automatic_lookup(self):
        self.assertEqual(
            book_search.find_book_title('Use the textbook "Ganita Manjari Part 1" for Class 9'),
            "Ganita Manjari Part 1",
        )
        self.assertEqual(
            book_search.find_book_title('Create slides from "The Hobbit" book'),
            "The Hobbit",
        )
        self.assertIsNone(book_search.find_book_title("Create slides about algebra and geometry"))
        self.assertIsNone(book_search.find_book_title("Create slides using a book about algebra"))


class FreeBookSearchTests(unittest.TestCase):
    @staticmethod
    def response(payload):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(payload).encode("utf-8")
        return response

    def test_google_books_free_catalog_is_used_without_an_api_key(self):
        payload = {
            "items": [{
                "id": "book-id",
                "volumeInfo": {
                    "title": "Ganita Manjari Part 1",
                    "authors": ["A. Teacher"],
                    "publishedDate": "2024",
                    "description": "<p>Mathematics for Class 9.</p>",
                    "categories": ["Mathematics"],
                    "infoLink": "https://books.google.com/books?id=book-id",
                },
            }],
        }
        with mock.patch.object(book_search.urllib.request, "urlopen", return_value=self.response(payload)) as open_url:
            sources = book_search.search_book("Ganita Manjari Part 1")

        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["provider"], "Google Books")
        self.assertEqual(sources[0]["description"], "Mathematics for Class 9.")
        request = open_url.call_args_list[0].args[0]
        self.assertIn("www.googleapis.com/books/v1/volumes", request.full_url)
        self.assertNotIn("key=", request.full_url)

    def test_open_library_is_a_free_fallback_if_google_books_has_no_match(self):
        open_library = {
            "docs": [{
                "key": "/works/OL123W",
                "title": "Ganita Manjari Part 1",
                "author_name": ["A. Teacher"],
                "first_publish_year": 2024,
                "edition_count": 2,
                "subject": ["Mathematics"],
            }],
        }
        with mock.patch.object(book_search, "_google_books", return_value=[]):
            with mock.patch.object(book_search.urllib.request, "urlopen", return_value=self.response(open_library)):
                sources = book_search.search_book("Ganita Manjari Part 1")

        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["provider"], "Open Library")
        self.assertEqual(sources[0]["url"], "https://openlibrary.org/works/OL123W")

    def test_free_web_search_returns_relevant_chapter_snippets(self):
        target = "https://example.org/ganita-manjari/contents"
        encoded = book_search.urllib.parse.quote(target, safe="")
        page = (
            '<div class="result"><a class="result__a" '
            f'href="//duckduckgo.com/l/?uddg={encoded}">Ganita Manjari contents</a>'
            '<a class="result__snippet">Part 1 includes chapters on number systems and algebra.</a></div>'
        )
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = page.encode("utf-8")
        with mock.patch.object(book_search.urllib.request, "urlopen", return_value=response) as open_url:
            sources = book_search._duckduckgo_web("Ganita Manjari Part 1")

        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["provider"], "DuckDuckGo Web Search")
        self.assertIn("number systems and algebra", sources[0]["description"])
        self.assertEqual(sources[0]["url"], target)
        self.assertNotIn("key=", open_url.call_args.args[0].full_url)

    def test_network_failure_is_nonfatal(self):
        with mock.patch.object(book_search.urllib.request, "urlopen", side_effect=TimeoutError):
            self.assertEqual(book_search.search_book("A named textbook"), [])


if __name__ == "__main__":
    unittest.main()
