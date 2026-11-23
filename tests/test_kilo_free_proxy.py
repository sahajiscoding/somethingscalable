"""Anonymous Kilo fallback stays restricted to free models and never sends a key."""

from unittest import TestCase, mock

import server


class AnonymousKiloProxyTests(TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.app_secret_patch = mock.patch.object(server, "APP_SECRET", "")
        self.app_secret_patch.start()

    def tearDown(self):
        self.app_secret_patch.stop()

    def test_proxy_forwards_only_free_model_requests_without_authorization(self):
        upstream = mock.Mock(
            content=b'{"choices":[]}',
            status_code=200,
            headers={"Content-Type": "application/json"},
        )
        body = {
            "model": "nvidia/model:free",
            "messages": [{"role": "user", "content": "Return JSON."}],
            "temperature": 0.3,
            "max_tokens": 1000,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        with mock.patch.object(server.requests, "post", return_value=upstream) as post:
            response = self.client.post("/api/kilo-free", json=body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, upstream.content)
        post.assert_called_once_with(
            server.WHT_ENGINE_DEFAULT_ENDPOINT,
            json=body,
            timeout=90,
        )
        self.assertNotIn("headers", post.call_args.kwargs)
        self.assertNotIn("KILO_API_KEY", str(post.call_args.kwargs))

    def test_known_free_ids_without_the_suffix_are_still_anonymous(self):
        upstream = mock.Mock(content=b'{}', status_code=200, headers={"Content-Type": "application/json"})
        with mock.patch.object(server.requests, "post", return_value=upstream) as post:
            for model in ("reflection/beam-free", "stealth/glyph-cluster", "kilo-auto/free"):
                response = self.client.post("/api/kilo-free", json={
                    "model": model, "messages": [{"role": "user", "content": "test"}],
                })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(post.call_args.kwargs["json"]["model"], model)
                self.assertNotIn("headers", post.call_args.kwargs)

    def test_proxy_rejects_non_free_models_without_contacting_gateway(self):
        with mock.patch.object(server.requests, "post") as post:
            response = self.client.post("/api/kilo-free", json={
                "model": "provider/paid-model",
                "messages": [{"role": "user", "content": "test"}],
            })

        self.assertEqual(response.status_code, 400)
        self.assertIn("ending in :free", response.get_json()["error"])
        post.assert_not_called()

    def test_proxy_preserves_gateway_rate_limit_status(self):
        upstream = mock.Mock(
            content=b'{"error":{"message":"rate limited"}}',
            status_code=429,
            headers={"Content-Type": "application/json"},
        )
        with mock.patch.object(server.requests, "post", return_value=upstream):
            response = self.client.post("/api/kilo-free", json={
                "model": "nvidia/model:free",
                "messages": [{"role": "user", "content": "test"}],
                "max_tokens": 1000,
            })

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.data, upstream.content)
