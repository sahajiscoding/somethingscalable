import io
import os
import unittest
from unittest import mock

from extract import _vision_enabled, extract_student
from ingest import Document, Page
from vision.answers import answers_from_transcript
from vision.models import Crop, Rect, TranscribedPage, Transcription


class FakeEngine:
    name = "fake"

    def __init__(self, payload=None, error: Exception | None = None):
        self.payload = payload
        self.error = error
        self.calls: list[dict] = []

    def generate_json(self, task, document=None, data=None, instruction="",
                      temperature=0.15, max_tokens=4096, **_kwargs):
        self.calls.append({"task": task, "data": data})
        if self.error:
            raise self.error
        return self.payload


def _page(blocks: list[tuple[str, str, float]]) -> TranscribedPage:
    page = TranscribedPage(page=1, width=1000, height=1400, dpi=240)
    for index, (crop_id, latex, confidence) in enumerate(blocks):
        crop = Crop(
            page=1, index=index, rect=Rect(0.1, 0.1, 0.2, 0.1),
            image=b"\xff\xd8\xff",
        )
        page.crops.append(crop)
        page.transcriptions[crop_id] = Transcription(
            crop_id=crop_id, latex=latex, provider="fake",
            confidence=confidence,
        )
    return page


class TranscriptMappingTests(unittest.TestCase):
    def test_response_is_rebuilt_from_verbatim_latex(self):
        page = _page([("p1c0", "2+2=4", 0.95), ("p1c1", "=5", 0.30)])
        engine = FakeEngine({"groups": [
            {"number": "Q1", "crop_ids": ["p1c0"],
             "response": "the model must not use this"},
            {"number": "Q2", "crop_ids": ["p1c1"]},
        ]})

        answers = answers_from_transcript(engine, [page])

        self.assertEqual(len(answers), 2)
        self.assertEqual(answers[0].number, "Q1")
        self.assertEqual(answers[0].response, "2+2=4")
        self.assertEqual(answers[0].legibility, "good")
        self.assertEqual(answers[1].response, "=5")
        self.assertEqual(answers[1].legibility, "poor")
        self.assertEqual(answers[1].uncertain_spans, ["=5"])
        self.assertEqual(answers[1].page, 1)
        self.assertEqual(answers[0].crop_ids, ["p1c0"])
        self.assertEqual(answers[0].geometry, [
            {
                "crop_id": "p1c0",
                "page": 1,
                "rect": [0.1, 0.1, 0.2, 0.1],
                "latex": "2+2=4",
                "confidence": 0.95,
            },
        ])

    def test_ungrouped_blocks_are_kept(self):
        page = _page([("p1c0", "a", 0.9), ("p1c1", "b", 0.9)])
        engine = FakeEngine({"groups": [
            {"number": "1", "crop_ids": ["p1c0"]},
        ]})

        answers = answers_from_transcript(engine, [page])

        self.assertEqual([answer.response for answer in answers], ["a", "b"])
        self.assertEqual(answers[1].number, "~1")

    def test_no_readable_blocks_skips_the_model(self):
        page = _page([])
        engine = FakeEngine({"groups": []})
        self.assertEqual(answers_from_transcript(engine, [page]), [])
        self.assertEqual(engine.calls, [])

    def test_engine_failure_returns_empty(self):
        page = _page([("p1c0", "a", 0.9)])
        engine = FakeEngine(error=RuntimeError("boom"))
        self.assertEqual(answers_from_transcript(engine, [page]), [])

    def test_prose_only_block_is_not_dropped(self):
        page = _page([("p1c0", "", 0.9)])
        page.transcriptions["p1c0"].plain = "b) Kala-azar"
        engine = FakeEngine({"groups": [
            {"number": "Q3", "crop_ids": ["p1c0"]},
        ]})

        answers = answers_from_transcript(engine, [page])

        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0].number, "Q3")
        self.assertEqual(answers[0].response, "b) Kala-azar")

    def test_bullet_and_continuation_groups_merge_into_preceding_question(self):
        page = _page([
            ("p1c0", "Ans. 6) Vegetative propagation is practiced as :", 0.95),
            ("p1c1", "* The plants grown by this method are more identical to parent plant.", 0.92),
            ("p1c2", "* The plants like banana which have lost their capability to produce seeds can also be grown.", 0.91),
            ("p1c3", "The plant of bryophyllum reproduces with buds on its leaves.", 0.93),
            ("p1c4", "vivo X50 ZEISS Optics", 0.99),
        ])
        engine = FakeEngine({"groups": [
            {"number": "Ans. 6)", "crop_ids": ["p1c0"]},
            {"number": "#1", "crop_ids": ["p1c1"]},
            {"number": "#2", "crop_ids": ["p1c2"]},
            {"number": "#3", "crop_ids": ["p1c3"]},
        ]})

        answers = answers_from_transcript(engine, [page])

        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0].number, "Ans. 6)")
        self.assertEqual(answers[0].crop_ids, ["p1c0", "p1c1", "p1c2", "p1c3"])
        self.assertIn("Vegetative propagation is practiced as :", answers[0].response)
        self.assertIn("identical to parent plant", answers[0].response)
        self.assertIn("banana", answers[0].response)
        self.assertIn("bryophyllum", answers[0].response)
        self.assertNotIn("vivo X50", answers[0].response)

    def test_splits_crop_containing_two_explicit_question_numbers(self):
        page = _page([
            ("p1c0", "Ans. 3) b) Kala-azar\nAns. 4) d) Variations", 0.94),
        ])
        engine = FakeEngine({"groups": [
            {"number": "3", "crop_ids": ["p1c0", "p1c0_2"]},
        ]})

        answers = answers_from_transcript(engine, [page])

        self.assertEqual(len(answers), 2)
        self.assertEqual(answers[0].number, "3")
        self.assertEqual(answers[0].response, "Ans. 3) b) Kala-azar")
        self.assertEqual(answers[1].number, "4")
        self.assertEqual(answers[1].response, "Ans. 4) d) Variations")


class VisionFlagTests(unittest.TestCase):
    def _document(self, kind: str = "image") -> Document:
        return Document(role="student", path="sheet.png", kind=kind)

    def test_off_without_any_provider(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(_vision_enabled(self._document()))

    def test_auto_on_with_nvidia_key(self):
        with mock.patch.dict(os.environ, {"NVIDIA_API_KEY": "k"}, clear=True):
            self.assertTrue(_vision_enabled(self._document()))

    def test_groq_needs_a_model_too(self):
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": "k"}, clear=True):
            self.assertFalse(_vision_enabled(self._document()))
        with mock.patch.dict(
            os.environ, {"GROQ_API_KEY": "k", "GROQ_MODEL": "m"}, clear=True
        ):
            self.assertTrue(_vision_enabled(self._document()))

    def test_explicit_off_wins_over_a_key(self):
        with mock.patch.dict(
            os.environ,
            {"NVIDIA_API_KEY": "k", "VISION_STUDENT": "0"},
            clear=True,
        ):
            self.assertFalse(_vision_enabled(self._document()))

    def test_text_documents_never_use_vision(self):
        with mock.patch.dict(os.environ, {"NVIDIA_API_KEY": "k"}, clear=True):
            self.assertFalse(_vision_enabled(self._document("text")))

    def test_override_can_force_either_way(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(_vision_enabled(self._document(), override=True))
        with mock.patch.dict(os.environ, {"NVIDIA_API_KEY": "k"}, clear=True):
            self.assertFalse(_vision_enabled(self._document(), override=False))


class ExtractStudentWiringTests(unittest.TestCase):
    def _document(self) -> Document:
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("L", (600, 400), 255).save(buffer, "PNG")
        return Document(
            role="student",
            path="sheet.png",
            kind="image",
            pages=[Page(index=1, mime="image/png", data=buffer.getvalue())],
        )

    def test_falls_back_to_the_existing_path_without_a_provider(self):
        engine = FakeEngine({"answers": [
            {"number": "1", "response": "fallback", "page": 1},
        ]})
        with mock.patch.dict(os.environ, {"VISION_STUDENT": "1"}, clear=True):
            answers = extract_student(engine, self._document())

        self.assertEqual([answer.response for answer in answers], ["fallback"])
        self.assertEqual(engine.calls[0]["task"], "extract_student")

    def test_uses_the_vision_mapping_when_transcriptions_exist(self):
        pages = [_page([("p1c0", r"\frac{1}{2}", 0.95)])]

        class GroupingEngine(FakeEngine):
            def generate_json(self, task, document=None, data=None,
                              instruction="", **kwargs):
                self.calls.append({"task": task, "data": data})
                if task == "extract_student_vision":
                    return {"groups": [
                        {"number": "1", "crop_ids": ["p1c0"]},
                    ]}
                return {"answers": []}

        engine = GroupingEngine()
        with mock.patch.dict(os.environ, {"VISION_STUDENT": "1"}, clear=True):
            with mock.patch(
                "vision.facade.transcribe_document", return_value=pages
            ):
                answers = extract_student(engine, self._document())

        self.assertEqual(answers[0].number, "1")
        self.assertEqual(answers[0].response, r"\frac{1}{2}")
        self.assertEqual([call["task"] for call in engine.calls],
                         ["extract_student_vision"])


if __name__ == "__main__":
    unittest.main()
