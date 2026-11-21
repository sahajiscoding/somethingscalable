import unittest
from unittest.mock import Mock

from vision import ocr
from vision.models import Crop, Rect
from vision.providers import (
    WHT_ENGINE_DEFAULT_MODEL,
    VisionProvider,
    ProviderConfig,
    build_providers,
)


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
        results = ocr.parse_items(raw, self.crops, "WHT Engine")
        self.assertEqual(results["p1c0"].latex, "a")
        self.assertEqual(results["p1c1"].latex, "b")
        self.assertEqual(results["p1c0"].provider, "WHT Engine")

    def test_falls_back_to_positional_order(self):
        raw = '{"items": [{"latex": "first"}, {"latex": "second"}]}'
        results = ocr.parse_items(raw, self.crops, "groq")
        self.assertEqual(results["p1c0"].latex, "first")
        self.assertEqual(results["p1c1"].latex, "second")

    def test_missing_item_becomes_an_error(self):
        raw = '{"items": [{"id": "p1c0", "latex": "a"}]}'
        results = ocr.parse_items(raw, self.crops, "WHT Engine")
        self.assertTrue(results["p1c0"].ok)
        self.assertFalse(results["p1c1"].ok)
        self.assertIn("no transcription", results["p1c1"].error)

    def test_unreadable_flag_lowers_confidence(self):
        raw = (
            '{"items": [{"id": "p1c0", "latex": "\\\\square"}],'
            '"unreadable": ["p1c0"]}'
        )
        results = ocr.parse_items(raw, self.crops, "WHT Engine")
        self.assertAlmostEqual(results["p1c0"].confidence, 0.2)
        self.assertEqual(results["p1c0"].note, "unreadable")

    def test_accepts_plain_text_for_prose(self):
        raw = '{"items": [{"id": "p1c0", "text": "b) Kala-azar"}]}'
        results = ocr.parse_items(raw, self.crops, "WHT Engine")
        self.assertTrue(results["p1c0"].ok)
        self.assertEqual(results["p1c0"].text, "b) Kala-azar")

    def test_single_crop_plain_text_fallback(self):
        single = [_crop(1, 0)]
        results = ocr.parse_items("Ans 1: Photosynthesis", single, "WHT Engine")
        self.assertTrue(results["p1c0"].ok)
        self.assertEqual(results["p1c0"].plain, "Ans 1: Photosynthesis")


class ProviderConfigTests(unittest.TestCase):
    def test_no_keys_means_no_providers(self):
        providers = build_providers({
            "WHT_ENGINE_API_KEY": "",
            "GROQ_API_KEY": "",
            "GROQ_MODEL": "",
        })
        self.assertEqual(providers, [])

    def test_groq_needs_an_explicit_model(self):
        providers = build_providers({
            "WHT_ENGINE_API_KEY": "",
            "GROQ_API_KEY": "test-key",
            "GROQ_MODEL": "",
        })
        self.assertEqual(providers, [])

    def test_groq_is_added_when_configured(self):
        providers = build_providers({
            "WHT_ENGINE_API_KEY": "",
            "GROQ_API_KEY": "test-key",
            "GROQ_MODEL": "some-vision-model",
        })
        self.assertEqual([provider.name for provider in providers], ["groq"])

    def test_wht_engine_is_preferred_first(self):
        providers = build_providers({
            "WHT_ENGINE_API_KEY": "test-key",
            "GROQ_API_KEY": "test-key",
            "GROQ_MODEL": "some-vision-model",
        })
        self.assertEqual(
            [provider.name for provider in providers], ["WHT Engine", "groq"]
        )

    def test_wht_engine_uses_the_selected_model(self):
        providers = build_providers(
            {"WHT_ENGINE_API_KEY": "test-key"},
            model="google/gemma-4-31b-it",
        )
        self.assertEqual(providers[0].config.model, "google/gemma-4-31b-it")
        self.assertEqual(providers[0].config.batch_size, 4)

    def test_every_vision_model_uses_standard_batch_and_token_limits(self):
        providers = build_providers(
            {"WHT_ENGINE_API_KEY": "test-key"},
            model="vendor/vision-model",
        )
        self.assertEqual(providers[0].config.batch_size, 4)
        self.assertEqual(providers[0].config.max_tokens, 1600)

    def test_model_ids_are_trimmed_without_provider_specific_aliases(self):
        for model in ("custom/vision-model", "nvidia/nemotron-3.5-super-vl:free"):
            with self.subTest(model=model):
                providers = build_providers(
                    {"WHT_ENGINE_API_KEY": "test-key"},
                    model=f" {model} ",
                )
                cfg = providers[0].config
                self.assertEqual(cfg.model, model)
                self.assertEqual(cfg.url, "https://api.kilo.ai/api/gateway/chat/completions")
                self.assertEqual(cfg.batch_size, 4)
                self.assertEqual(cfg.max_tokens, 1600)
                expected_extra = (
                    {"chat_template_kwargs": {"enable_thinking": False, "thinking": False}}
                    if "nemotron" in model
                    else {}
                )
                self.assertEqual(cfg.extra_payload, expected_extra)

    def test_free_nemotron_is_the_default_gateway_model(self):
        providers = build_providers({"WHT_ENGINE_API_KEY": "test-key"})
        self.assertEqual(
            providers[0].config.model,
            "nvidia/nemotron-3.5-super-vl:free",
        )
        self.assertEqual(providers[0].config.batch_size, 4)
        self.assertEqual(providers[0].config.max_tokens, 1600)

    def test_vision_request_always_uses_plain_chat_completions_shape(self):
        provider = VisionProvider(ProviderConfig(
            name="WHT Engine",
            url="https://api.kilo.ai/api/gateway/chat/completions",
            model=WHT_ENGINE_DEFAULT_MODEL,
            api_key="test-key",
        ))
        response = Mock()
        session = Mock()
        session.post.return_value = response
        provider._local.session = session

        crop = _crop(1, 0)
        self.assertIs(provider._post([crop], "Read this crop."), response)
        payload = session.post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], WHT_ENGINE_DEFAULT_MODEL)
        self.assertEqual([m["role"] for m in payload["messages"]], ["system", "user"])
        self.assertEqual(payload["messages"][0]["content"], "You are a precise OCR engine.")
        self.assertEqual(payload["messages"][1]["content"][0]["text"], "Read this crop.")
        self.assertEqual(payload["temperature"], 0.0)
        self.assertEqual(payload["max_tokens"], 1600)
        self.assertIs(payload["stream"], False)
        self.assertEqual(set(payload), {"model", "messages", "temperature", "max_tokens", "stream"})

    def test_engine_default_and_custom_model_passthrough(self):
        import engine

        eng_custom = engine.make_engine(api_key="wht-engine-test", model="custom/vision-model")
        self.assertEqual(eng_custom.model, "custom/vision-model")

        eng_default = engine.make_engine(api_key="wht-engine-test")
        self.assertEqual(eng_default.model, WHT_ENGINE_DEFAULT_MODEL)


if __name__ == "__main__":
    unittest.main()
