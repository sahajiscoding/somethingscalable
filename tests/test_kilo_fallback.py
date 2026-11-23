"""Free model rotation and the server-side keyed Kilo fallback."""

import json
import os
import re
import unittest
from pathlib import Path
from unittest import mock

import engine
import server


class GatewayResponse:
    def __init__(self, status, content=None, text=""):
        self.status_code = status
        self.text = text
        self.headers = {"Content-Type": "application/json"}
        self._body = {"choices": [{"message": {"content": content}}]} if content is not None else {"error": "failed"}

    def json(self):
        return self._body


class FallbackModelTests(unittest.TestCase):
    def setUp(self):
        self.token_patch = mock.patch.object(engine, "_acquire_wht_engine_token", return_value=True)
        self.token_patch.start()
        self.addCleanup(self.token_patch.stop)

    def test_frontend_and_backend_share_the_same_screenshot_free_models(self):
        source = (Path(__file__).resolve().parents[1] / "frontend/src/lib/kilo.ts").read_text()
        model_block = source.split("export const KILO_FREE_TEXT_MODELS = [", 1)[1].split("] as const;", 1)[0]
        frontend_models = tuple(re.findall(r"'([^']+)'", model_block))
        self.assertEqual(frontend_models, engine.KILO_FREE_TEXT_MODELS)
        self.assertEqual(len(frontend_models), len(set(frontend_models)))
        self.assertEqual(frontend_models[0], "nvidia/nemotron-3.5-super-vl:free")
        self.assertTrue({
            "nvidia/nemotron-3-ultra-550b-a55b:free",
            "baidu/ernie-5.5-flash-preview:free",
            "nvidia/nemotron-3.5-super-vl:free",
            "dots-studio/dots-3-note-preview:free",
            "reflection/beam-free",
            "particle-ai/particle-1:free",
            "nvidia/nemotron-3.5-lightning:free",
            "stealth/glyph-cluster",
        }.issubset(frontend_models))
        self.assertNotIn("deepseek/deepseek-v4.1-flash-1017", frontend_models)
        self.assertNotIn("z-ai/glm-5.3-flash", frontend_models)
        self.assertEqual(engine.KILO_FREE_VISION_MODELS, (
            "nvidia/nemotron-3.5-super-vl:free",
            "particle-ai/particle-1:free",
            "dots-studio/dots-3-note-preview:free",
        ))

    def test_server_moves_to_the_next_model_after_a_429(self):
        seen = []

        def post(_url, *, headers, json, timeout):
            seen.append((json["model"], headers["Authorization"]))
            if len(seen) == 1:
                return GatewayResponse(429)
            return GatewayResponse(200, '{"ok":true}')

        with mock.patch.dict(os.environ, {"KILO_API_KEY": "test-key"}, clear=True), \
                mock.patch("requests.post", side_effect=post), \
                mock.patch("time.sleep") as sleep:
            client = engine.WhtEngine()
            result = client._chat([{"role": "user", "content": "test"}], 0.3, wall_budget=30)
        self.assertEqual(json.loads(result), {"ok": True})
        self.assertEqual([item[0] for item in seen], list(engine.KILO_FREE_TEXT_MODELS[:2]))
        self.assertTrue(all(item[1] == "Bearer test-key" for item in seen))
        self.assertEqual(client.last_model, engine.KILO_FREE_TEXT_MODELS[1])
        sleep.assert_not_called()

    def test_malformed_completion_rotates_instead_of_aborting(self):
        malformed = GatewayResponse(200)
        malformed._body = {"choices": [None]}
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch("requests.post", side_effect=[malformed, GatewayResponse(200, '{"ok":true}')]) as post:
            client = engine.WhtEngine()
            client._chat([{"role": "user", "content": "test"}], 0.3, wall_budget=30)
        self.assertEqual([call.kwargs["json"]["model"] for call in post.call_args_list], list(engine.KILO_FREE_TEXT_MODELS[:2]))
        self.assertEqual(client.last_model, engine.KILO_FREE_TEXT_MODELS[1])

    def test_glyph_retries_without_unsupported_json_mode(self):
        sent = []

        def post(_url, *, headers, json, timeout):
            sent.append(json.copy())
            return GatewayResponse(400) if "response_format" in json else GatewayResponse(200, '{"ok":true}')

        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch("requests.post", side_effect=post):
            client = engine.WhtEngine(model="stealth/glyph-cluster")
            client._chat([{"role": "user", "content": "test"}], 0.3, wall_budget=30)
        self.assertEqual(len(sent), 2)
        self.assertEqual([body["model"] for body in sent], ["stealth/glyph-cluster"] * 2)
        self.assertIn("response_format", sent[0])
        self.assertNotIn("response_format", sent[1])
        self.assertEqual(client.last_model, "stealth/glyph-cluster")

    def test_vision_skips_text_only_models_and_uses_particle_and_dots(self):
        seen = []

        def post(_url, *, headers, json, timeout):
            seen.append(json["model"])
            self.assertTrue(engine.WhtEngine._messages_have_images(json["messages"]))
            if json["model"] == "dots-studio/dots-3-note-preview:free":
                return GatewayResponse(200, '{"ok":true}')
            return GatewayResponse(429)

        messages = [{"role": "user", "content": [{
            "type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="},
        }]}]
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch("requests.post", side_effect=post):
            client = engine.WhtEngine(model="baidu/ernie-5.5-flash-preview:free")
            client._chat(messages, 0.3, wall_budget=30)
        self.assertEqual(seen, list(engine.KILO_FREE_VISION_MODELS))
        self.assertTrue(engine.WhtEngine._is_vision_capable("particle-ai/particle-1:free"))
        self.assertTrue(engine.WhtEngine._is_vision_capable("dots-studio/dots-3-note-preview:free"))
        self.assertFalse(engine.WhtEngine._is_vision_capable("kilo-auto/free"))
        self.assertEqual(client.last_model, "dots-studio/dots-3-note-preview:free")

    def test_all_rate_limits_are_reported_after_trying_every_free_model(self):
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch("requests.post", return_value=GatewayResponse(429)) as post, \
                mock.patch("time.sleep") as sleep:
            with self.assertRaisesRegex(engine.EngineError, "429"):
                engine.WhtEngine()._chat([{"role": "user", "content": "test"}], 0.3, wall_budget=30)
        self.assertEqual([c.kwargs["json"]["model"] for c in post.call_args_list], list(engine.KILO_FREE_TEXT_MODELS))
        sleep.assert_not_called()

    def test_throttle_does_not_wait_past_request_deadline(self):
        with mock.patch.object(engine, "_bucket_tokens", 0.0), \
                mock.patch.object(engine, "_bucket_last", None), \
                mock.patch("time.monotonic", return_value=10.0):
            # Undo the class's fast-token patch for this test.
            self.token_patch.stop()
            try:
                self.assertFalse(engine._acquire_wht_engine_token(deadline=10.0))
            finally:
                self.token_patch.start()


class KeyedProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.body = {
            "model": engine.KILO_FREE_TEXT_MODELS[0],
            "messages": [{"role": "user", "content": "Write a question."}],
            "temperature": 0.6,
            "max_tokens": 1024,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        patches = [
            mock.patch.object(server, "APP_SECRET", ""),
            mock.patch.object(engine, "_acquire_wht_engine_token", return_value=True),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_key_is_only_sent_to_upstream_and_success_reports_actual_backup(self):
        seen = []

        def post(_url, *, headers, json, timeout):
            seen.append((json, headers))
            if len(seen) == 1:
                return GatewayResponse(429)
            return GatewayResponse(200, '{"ok":true}')

        with mock.patch.dict(os.environ, {"KILO_API_KEY": "private-key"}, clear=True), \
                mock.patch("requests.post", side_effect=post):
            response = self.client.post("/api/kilo-keyed", json=self.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["model"], engine.KILO_FREE_TEXT_MODELS[1])
        self.assertEqual(response.get_json()["choices"][0]["message"]["content"], '{"ok":true}')
        self.assertEqual([item[0]["model"] for item in seen], list(engine.KILO_FREE_TEXT_MODELS[:2]))
        self.assertTrue(all(item[1]["Authorization"] == "Bearer private-key" for item in seen))
        self.assertNotIn(b"private-key", response.data)

    def test_legacy_key_and_stale_key_rotation(self):
        authorizations = []

        def post(_url, *, headers, json, timeout):
            authorizations.append(headers["Authorization"])
            return GatewayResponse(401) if headers["Authorization"] == "Bearer stale" else GatewayResponse(200, '{"ok":true}')

        env = {"KILO_API_KEY": "stale", "WHT_ENGINE_API_KEY": "working"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch("requests.post", side_effect=post):
            response = self.client.post("/api/kilo-keyed", json=self.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(authorizations, ["Bearer stale", "Bearer working"])
        self.assertNotIn(b"working", response.data)
        self.assertNotIn(b"stale", response.data)

    def test_no_key_reports_configuration_error_without_upstream_call(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch("requests.post") as post:
            response = self.client.post("/api/kilo-keyed", json=self.body)
        self.assertEqual(response.status_code, 503)
        self.assertIn("KILO_API_KEY", response.get_json()["error"])
        post.assert_not_called()

    def test_unrecognized_suffix_is_not_sent_with_the_server_key(self):
        body = {**self.body, "model": "unknown/potentially-paid:free"}
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "private"}, clear=True), \
                mock.patch("requests.post", return_value=GatewayResponse(200, '{"ok":true}')) as post:
            response = self.client.post("/api/kilo-keyed", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(post.call_args.kwargs["json"]["model"], engine.KILO_FREE_TEXT_MODELS[0])
        self.assertEqual(response.get_json()["model"], engine.KILO_FREE_TEXT_MODELS[0])

    def test_paid_models_and_invalid_requests_are_rejected_before_upstream(self):
        bad_bodies = [
            {**self.body, "model": "provider/paid-model"},
            {**self.body, "model": "stealth/some-other-model"},
            {**self.body, "messages": [{"role": "user", "content": "x" * 100_001}]},
            {**self.body, "messages": [{"role": "user", "content": [{"type": "image_url"}]}]},
            {**self.body, "messages": [{"role": [], "content": "test"}]},
            {**self.body, "max_tokens": 8193},
            {**self.body, "temperature": 3},
        ]
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "private"}, clear=True), mock.patch("requests.post") as post:
            for body in bad_bodies:
                with self.subTest(body=body if len(str(body)) < 400 else "oversized"):
                    response = self.client.post("/api/kilo-keyed", json=body)
                    self.assertIn(response.status_code, (400, 413))
            post.assert_not_called()

    def test_both_relays_respect_the_app_secret(self):
        with mock.patch.object(server, "APP_SECRET", "required"), \
                mock.patch.dict(os.environ, {"KILO_API_KEY": "private"}, clear=True), \
                mock.patch("requests.post") as post:
            for path in ("/api/kilo-free", "/api/kilo-keyed"):
                self.assertEqual(self.client.post(path, json=self.body).status_code, 401)
            post.assert_not_called()

    def test_valid_app_secret_allows_the_keyed_fallback(self):
        with mock.patch.object(server, "APP_SECRET", "required"), \
                mock.patch.dict(os.environ, {"KILO_API_KEY": "private"}, clear=True), \
                mock.patch("requests.post", return_value=GatewayResponse(200, '{"ok":true}')):
            response = self.client.post("/api/kilo-keyed", json=self.body, headers={"X-App-Secret": "required"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"private", response.data)

    def test_upstream_failures_are_sanitized_and_rate_limits_keep_429(self):
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "private-key"}, clear=True):
            with mock.patch("requests.post", return_value=GatewayResponse(500, text="private-key")):
                failed = self.client.post("/api/kilo-keyed", json=self.body)
            with mock.patch("requests.post", return_value=GatewayResponse(429, text="private-key")):
                limited = self.client.post("/api/kilo-keyed", json=self.body)
        self.assertEqual(failed.status_code, 502)
        self.assertEqual(limited.status_code, 429)
        self.assertNotIn(b"private-key", failed.data)
        self.assertNotIn(b"private-key", limited.data)
