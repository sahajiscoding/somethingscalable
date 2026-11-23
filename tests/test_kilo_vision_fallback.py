"""Crop OCR must only retry image-capable models and preserve good crops."""

import os
import unittest
from types import SimpleNamespace
from unittest import mock

from engine import KILO_FREE_VISION_MODELS, WhtEngine
from extract import _vision_student_answers
from ingest import Document
from vision.models import Crop, Rect
from vision.ocr import build_prompt
from vision.providers import wht_engine_provider


def crop(index):
    return Crop(page=1, index=index, rect=Rect(0, 0, 0.2, 0.2), image=b"\xff\xd8\xff")


def response(status, content=None):
    result = mock.Mock(status_code=status, text="upstream error")
    result.json.return_value = {"choices": [{"message": {"content": content}}]}
    return result


class VisionFallbackTests(unittest.TestCase):
    def test_crop_ocr_rotates_to_a_vision_model_on_rate_limit(self):
        provider = wht_engine_provider(api_key="k", env={})
        session = mock.Mock()
        session.post.side_effect = [
            response(429),
            response(200, '{"items":[{"id":"p1c0","plain":"Written answer"}]}'),
        ]
        provider._local.session = session
        result = provider.transcribe([crop(0)])

        self.assertEqual(result["p1c0"].text, "Written answer")
        payloads = [call.kwargs["json"] for call in session.post.call_args_list]
        self.assertEqual([payload["model"] for payload in payloads], list(KILO_FREE_VISION_MODELS[:2]))
        self.assertTrue(all(payload["messages"][1]["content"][1]["type"] == "image_url" for payload in payloads))
        self.assertNotIn("chat_template_kwargs", payloads[1])

    def test_only_failed_crops_are_retried_with_a_backup(self):
        provider = wht_engine_provider(api_key="k", env={})
        session = mock.Mock()
        session.post.side_effect = [
            response(200, '{"items":[{"id":"p1c0","plain":"First answer"}]}'),
            response(200, '{"items":[{"id":"p1c1","plain":"Second answer"}]}'),
        ]
        provider._local.session = session
        crops = [crop(0), crop(1)]
        results = provider._call(crops, "IMPORTANT\n\n" + build_prompt(crops))

        self.assertEqual(results["p1c0"].text, "First answer")
        self.assertEqual(results["p1c1"].text, "Second answer")
        first = session.post.call_args_list[0].kwargs["json"]
        second = session.post.call_args_list[1].kwargs["json"]
        self.assertEqual(first["model"], KILO_FREE_VISION_MODELS[0])
        self.assertEqual(second["model"], KILO_FREE_VISION_MODELS[1])
        self.assertEqual(len(second["messages"][1]["content"]), 2)  # prompt + one crop
        prompt = second["messages"][1]["content"][0]["text"]
        self.assertTrue(prompt.startswith("IMPORTANT"))
        self.assertNotIn("id=p1c0", prompt)
        self.assertIn("id=p1c1", prompt)

    def test_crop_retry_stops_at_the_wall_budget(self):
        provider = wht_engine_provider(api_key="k", env={})
        session = mock.Mock()
        provider._local.session = session
        with mock.patch("vision.providers.time.monotonic", side_effect=[0, 151, 151, 151]):
            result = provider.transcribe([crop(0)])
        self.assertFalse(result["p1c0"].ok)
        session.post.assert_not_called()

    def test_text_only_selection_uses_a_vision_model_for_crop_ocr(self):
        doc = Document(role="student", path="sheet.png", kind="image")
        client = SimpleNamespace(model="baidu/ernie-5.5-flash-preview:free", _is_vision_capable=WhtEngine._is_vision_capable)
        for configured, expected in (
            ("baidu/ernie-5.5-flash-preview:free", KILO_FREE_VISION_MODELS[0]),
            ("custom/vision-model", "custom/vision-model"),
        ):
            with self.subTest(configured=configured), \
                    mock.patch.dict(os.environ, {"WHT_ENGINE_MODEL": configured}, clear=True), \
                    mock.patch("vision.providers.build_providers", return_value=[]) as build, \
                    mock.patch("vision.transcribe_document", return_value=[]):
                self.assertEqual(_vision_student_answers(client, doc), [])
                build.assert_called_once_with(model=expected)

    def test_canonical_key_is_preferred_for_crop_ocr(self):
        provider = wht_engine_provider(env={"KILO_API_KEY": "new", "WHT_ENGINE_API_KEY": "old"})
        self.assertEqual(provider.config.api_key, "new")
