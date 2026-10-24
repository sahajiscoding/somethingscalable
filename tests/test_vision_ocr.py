import unittest

from vision import ocr
from vision.models import Crop, Rect
from vision.providers import build_providers


def _crop(page: int, index: int) -> Crop:
    return Crop(
        page=page,
        index=index,
        rect=Rect(0.1, 0.1, 0.2, 0.1),
        image=b"\xff\xd8\xff",
    )


class JsonExtractionTests(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(ocr.extract_json('{"items": []}'), {"items": []})

    def test_fenced_json(self):
        raw = '```json\n{"items": []}\n```'
        self.assertEqual(ocr.extract_json(raw), {"items": []})

    def test_json_surrounded_by_prose(self):
        raw = 'Here you go:\n{"items": [{"id": "p1c0"}]}\nDone.'
        self.assertEqual(
            ocr.extract_json(raw)["items"][0]["id"], "p1c0"
        )

    def test_unparseable_returns_none(self):
        self.assertIsNone(ocr.extract_json("not json at all"))


class ParseItemsTests(unittest.TestCase):
    def setUp(self):
        self.crops = [_crop(1, 0), _crop(1, 1)]

    def test_maps_by_explicit_id(self):
        raw = (
            '{"items": ['
            '{"id": "p1c1", "latex": "b"},'
            '{"id": "p1c0", "latex": "a"}'
            ']}'
        )
        results = ocr.parse_items(raw, self.crops, "nvidia")
        self.assertEqual(results["p1c0"].latex, "a")
        self.assertEqual(results["p1c1"].latex, "b")
        self.assertEqual(results["p1c0"].provider, "nvidia")

    def test_falls_back_to_positional_order(self):
        raw = '{"items": [{"latex": "first"}, {"latex": "second"}]}'
        results = ocr.parse_items(raw, self.crops, "groq")
        self.assertEqual(results["p1c0"].latex, "first")
        self.assertEqual(results["p1c1"].latex, "second")

    def test_missing_item_becomes_an_error(self):
        raw = '{"items": [{"id": "p1c0", "latex": "a"}]}'
        results = ocr.parse_items(raw, self.crops, "nvidia")
        self.assertTrue(results["p1c0"].ok)
        self.assertFalse(results["p1c1"].ok)
        self.assertIn("no transcription", results["p1c1"].error)

    def test_unreadable_flag_lowers_confidence(self):
        raw = (
            '{"items": [{"id": "p1c0", "latex": "\\\\square"}],'
            '"unreadable": ["p1c0"]}'
        )
        results = ocr.parse_items(raw, self.crops, "nvidia")
        self.assertAlmostEqual(results["p1c0"].confidence, 0.2)
        self.assertEqual(results["p1c0"].note, "unreadable")

    def test_accepts_plain_text_for_prose(self):
        raw = '{"items": [{"id": "p1c0", "text": "b) Kala-azar"}]}'
        results = ocr.parse_items(raw, self.crops, "nvidia")
        self.assertTrue(results["p1c0"].ok)
        self.assertEqual(results["p1c0"].text, "b) Kala-azar")


class ProviderConfigTests(unittest.TestCase):
    def test_no_keys_means_no_providers(self):
        providers = build_providers({
            "NVIDIA_API_KEY": "",
            "GROQ_API_KEY": "",
            "GROQ_MODEL": "",
        })
        self.assertEqual(providers, [])

    def test_groq_needs_an_explicit_model(self):
        providers = build_providers({
            "NVIDIA_API_KEY": "",
            "GROQ_API_KEY": "test-key",
            "GROQ_MODEL": "",
        })
        self.assertEqual(providers, [])

    def test_groq_is_added_when_configured(self):
        providers = build_providers({
            "NVIDIA_API_KEY": "",
            "GROQ_API_KEY": "test-key",
            "GROQ_MODEL": "some-vision-model",
        })
        self.assertEqual([provider.name for provider in providers], ["groq"])

    def test_nvidia_is_preferred_first(self):
        providers = build_providers({
            "NVIDIA_API_KEY": "test-key",
            "GROQ_API_KEY": "test-key",
            "GROQ_MODEL": "some-vision-model",
        })
        self.assertEqual(
            [provider.name for provider in providers], ["nvidia", "groq"]
        )

    def test_nvidia_uses_the_selected_model(self):
        providers = build_providers(
            {"NVIDIA_API_KEY": "test-key"},
            model="google/gemma-4-31b-it",
        )
        self.assertEqual(providers[0].config.model, "google/gemma-4-31b-it")
        self.assertEqual(providers[0].config.batch_size, 4)

    def test_single_image_model_sends_one_crop_per_call(self):
        providers = build_providers(
            {"NVIDIA_API_KEY": "test-key"},
            model="meta/llama-3.2-90b-vision-instruct",
        )
        self.assertEqual(providers[0].config.batch_size, 1)


if __name__ == "__main__":
    unittest.main()
