"""Guard rails for exam generation.

The exam generator used to hide every gateway failure behind a "random
template", so a broken key or endpoint produced a printable-looking exam the
AI never wrote. These tests lock in the replacement behaviour:

* the gateway is the real Kilo Gateway (not an invented host),
* both key names are honoured, and a stale key rotates to a working one,
* a failure surfaces as an error instead of a fabricated question.
"""

import json
import os
import unittest
from unittest import mock

import engine
import server


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def _completion(content: str) -> _FakeResponse:
    return _FakeResponse(
        200, {"choices": [{"message": {"content": content}}]}
    )


class GatewayConfigTests(unittest.TestCase):
    def test_endpoint_is_the_kilo_gateway(self):
        self.assertEqual(
            engine.WHT_ENGINE_DEFAULT_ENDPOINT,
            "https://api.kilo.ai/api/gateway/chat/completions",
        )

    def test_invented_host_is_gone(self):
        self.assertNotIn("wht-engine.ai", engine.WHT_ENGINE_DEFAULT_ENDPOINT)

    def test_kilo_key_is_read(self):
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "kilo-key"}, clear=True):
            self.assertEqual(engine.get_wht_engine_key(), "kilo-key")

    def test_legacy_engine_key_still_read(self):
        with mock.patch.dict(os.environ, {"WHT_ENGINE_API_KEY": "old-key"}, clear=True):
            self.assertEqual(engine.get_wht_engine_key(), "old-key")

    def test_both_keys_are_offered_kilo_first(self):
        env = {"KILO_API_KEY": "kilo-key", "WHT_ENGINE_API_KEY": "old-key"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(
                engine.get_wht_engine_keys(), ["kilo-key", "old-key"]
            )


class _FastBucket(unittest.TestCase):
    """Keep the real per-minute throttle out of unit tests."""

    def setUp(self):
        self._rpm = mock.patch.object(engine, "WHT_ENGINE_RPM", 100_000)
        self._rpm.start()

    def tearDown(self):
        self._rpm.stop()


class KeyRotationTests(_FastBucket):
    def test_stale_key_rotates_to_the_good_one(self):
        env = {"KILO_API_KEY": "good-key", "WHT_ENGINE_API_KEY": "stale-key"}
        seen: list[str] = []

        def fake_post(url, headers=None, json=None, timeout=None, **_kw):
            seen.append(headers["Authorization"])
            if headers["Authorization"] == "Bearer stale-key":
                return _FakeResponse(401, {"error": "bad key"})
            return _completion('{"number": "Q1", "text": "Solve 2x = 4"}')

        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("requests.post", side_effect=fake_post):
            eng = engine.make_engine()
            out = eng.generate_json("q", instruction="write", max_attempts=1)

        self.assertEqual(out["text"], "Solve 2x = 4")
        self.assertNotIn("Bearer stale-key", seen)

    def test_all_keys_rejected_raises(self):
        env = {"KILO_API_KEY": "bad-key"}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("requests.post",
                           side_effect=lambda *a, **k: _FakeResponse(401, {})):
            eng = engine.make_engine()
            with self.assertRaises(engine.EngineError) as ctx:
                eng.generate_json("q", instruction="write", max_attempts=1)
        self.assertIn("rejected the key", str(ctx.exception))


class EmptyCompletionTests(_FastBucket):
    def test_empty_completion_falls_through_to_next_model(self):
        tried: list[str] = []

        def fake_post(url, headers=None, json=None, timeout=None, **_kw):
            tried.append(json["model"])
            if json["model"] == engine.WHT_ENGINE_DEFAULT_MODEL:
                return _completion("")
            return _completion('{"ok": true}')

        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch("requests.post", side_effect=fake_post):
            eng = engine.make_engine()
            out = eng.generate_json("q", instruction="x", max_attempts=1)

        self.assertEqual(out, {"ok": True})
        self.assertGreater(len(set(tried)), 1)


class NoFakeExamTests(unittest.TestCase):
    """A gateway failure must never produce a question the AI did not write."""

    def setUp(self):
        self.client = server.app.test_client()
        self.env = mock.patch.dict(
            os.environ, {"KILO_API_KEY": "test-key"}, clear=True
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_question_endpoint_returns_an_error_not_a_template(self):
        with mock.patch.object(
            engine.WhtEngine, "generate_json",
            side_effect=engine.EngineError("gateway down"),
        ):
            resp = self.client.post(
                "/api/generate-exam-question",
                json={"topic": "Calculus", "index": 1, "total": 5},
            )
        self.assertGreaterEqual(resp.status_code, 400)
        body = resp.get_json()
        self.assertNotIn("question", body)
        self.assertIn("gateway down", body["error"])

    def test_exam_endpoint_returns_an_error_not_a_template(self):
        with mock.patch.object(
            engine.WhtEngine, "generate_json",
            side_effect=engine.EngineError("gateway down"),
        ):
            resp = self.client.post(
                "/api/generate-exam",
                json={"topic": "Calculus", "count": 3, "marks": 15},
            )
        self.assertGreaterEqual(resp.status_code, 400)
        body = resp.get_json()
        self.assertNotIn("exam", body)

    def test_question_endpoint_accepts_a_real_model_answer(self):
        answer = {
            "number": "Q1",
            "text": "Differentiate x^2 with respect to x.",
            "max_marks": 5,
            "expected_answer": "2x",
            "marking_scheme": "5m for 2x",
            "keywords": ["derivative"],
        }
        with mock.patch.object(
            engine.WhtEngine, "generate_json", return_value=answer
        ):
            resp = self.client.post(
                "/api/generate-exam-question",
                json={"topic": "Calculus", "index": 1, "total": 5},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["question"]["text"], answer["text"])


if __name__ == "__main__":
    unittest.main()


class GradingWrapperTests(unittest.TestCase):
    """Models wrap their JSON in many shapes; none may zero a whole paper."""

    def test_array(self):
        import grade
        self.assertEqual(
            len(grade._coerce_records([{"number": "1"}])), 1
        )

    def test_records_wrapper(self):
        import grade
        self.assertEqual(
            grade._coerce_records({"records": [{"number": "1"}]}),
            [{"number": "1"}],
        )

    def test_questions_wrapper(self):
        import grade
        self.assertEqual(
            grade._coerce_records({"questions": [{"number": "2"}]}),
            [{"number": "2"}],
        )

    def test_single_record_object(self):
        import grade
        self.assertEqual(
            grade._coerce_records({"result": {"number": "3"}}),
            [{"number": "3"}],
        )

    def test_bare_record(self):
        import grade
        self.assertEqual(
            grade._coerce_records({"number": "4", "marks_awarded": 2}),
            [{"number": "4", "marks_awarded": 2}],
        )

    def test_garbage_is_empty_not_an_exception(self):
        import grade
        self.assertEqual(grade._coerce_records("nope"), [])
        self.assertEqual(grade._coerce_records(None), [])

    def test_grade_one_endpoint_survives_a_wrapped_reply(self):
        """A {"records": [...]} reply must still mark the question."""
        client = server.app.test_client()
        question = {
            "number": "1", "question": "Differentiate x^3.",
            "max_marks": 5, "expected_answer": "3x^2",
            "student_answer": "nonsense", "marking_scheme": ["5m for 3x^2"],
        }
        wrapped = {"records": [{
            "number": "1", "marks_awarded": 1.0, "deductions": [],
            "feedback": "Wrong.", "steps": [],
        }]}
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch.object(engine.WhtEngine, "generate_json",
                                  return_value=wrapped):
            resp = client.post("/api/grade-one", json={"question": question})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["record"]["marks_awarded"], 1.0)
