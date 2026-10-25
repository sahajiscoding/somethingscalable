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

    def test_strips_thinking_tags_before_extracting_json(self):
        raw = '<think>\nLet me read the crop carefully: {"fake": 1}\n</think>\n{"items": [{"id": "p1c0", "plain": "42"}]}'
        self.assertEqual(
            ocr.extract_json(raw),
            {"items": [{"id": "p1c0", "plain": "42"}]},
        )


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

    def test_single_crop_plain_text_fallback(self):
        single = [_crop(1, 0)]
        results = ocr.parse_items("Ans 1: Photosynthesis", single, "nvidia")
        self.assertTrue(results["p1c0"].ok)
        self.assertEqual(results["p1c0"].plain, "Ans 1: Photosynthesis")


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

    def test_paligemma_uses_nvcf_vlm_endpoint_and_single_image_batch(self):
        for alias in ("google/paligemma", "google/google-paligemma", "paligemma"):
            providers = build_providers(
                {"NVIDIA_API_KEY": "test-key"},
                model=alias,
            )
            cfg = providers[0].config
            self.assertEqual(cfg.model, "google/paligemma")
            self.assertEqual(cfg.url, "https://ai.api.nvidia.com/v1/vlm/google/paligemma")
            self.assertEqual(cfg.batch_size, 1)
            self.assertEqual(cfg.max_tokens, 1024)
            self.assertEqual(cfg.extra_payload, {})

    def test_nemotron_3_nano_omni_normalizes_and_disables_thinking_overhead(self):
        for alias in (
            "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
            "nemotron-3-nano-mini-30b-a3b-reasoning",
            "nemotron-3-nano-omni",
        ):
            providers = build_providers(
                {"NVIDIA_API_KEY": "test-key"},
                model=alias,
            )
            cfg = providers[0].config
            self.assertEqual(cfg.model, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")
            self.assertEqual(cfg.batch_size, 4)
            self.assertIn("chat_template_kwargs", cfg.extra_payload)

    def test_engine_make_engine_and_message_adaptation_for_new_models(self):
        import engine

        eng_pali = engine.make_engine(api_key="nvapi-test", model="google/google-paligemma")
        self.assertEqual(eng_pali.model, "google/paligemma")

        eng_omni = engine.make_engine(api_key="nvapi-test", model="nemotron-3-nano-mini-30b-a3b-reasoning")
        self.assertEqual(eng_omni.model, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")

        raw_messages = [
            {"role": "system", "content": "System instruction."},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Transcribe this page."},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                ],
            },
        ]
        adapted = engine.NvidiaEngine._adapt_messages_for_model(raw_messages, "google/paligemma")
        self.assertEqual(len(adapted), 1)
        self.assertEqual(adapted[0]["role"], "user")
        self.assertIn("System instruction.", adapted[0]["content"][0]["text"])
        self.assertEqual(adapted[0]["content"][1]["type"], "image_url")


if __name__ == "__main__":
    unittest.main()
