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


class NoteGenerationTests(unittest.TestCase):
    """AI note generation validates real model output and never fakes drafts."""

    def setUp(self):
        self.client = server.app.test_client()
        self.env = mock.patch.dict(os.environ, {"KILO_API_KEY": "test-key"}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_note_endpoint_returns_the_written_note_and_passes_request_context(self):
        generated = {"title": "Photosynthesis", "content": "Plants turn light into chemical energy."}
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=generated) as generate:
            response = self.client.post("/api/generate-note", json={
                "prompt": "Explain photosynthesis", "audience": "Grade 8",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["note"], generated)
        self.assertEqual(generate.call_args.args[0], "generate_note")
        self.assertIn("Explain photosynthesis", generate.call_args.kwargs["instruction"])
        self.assertIn("Grade 8", generate.call_args.kwargs["instruction"])

    def test_note_endpoint_surfaces_gateway_failure_without_fabricating_content(self):
        with mock.patch.object(
            engine.WhtEngine, "generate_json",
            side_effect=engine.EngineError("gateway unavailable"),
        ):
            response = self.client.post("/api/generate-note", json={"prompt": "Make revision notes"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("note", response.get_json())
        self.assertIn("gateway unavailable", response.get_json()["error"])

    def test_note_endpoint_rejects_empty_or_oversized_prompts_before_calling_model(self):
        with mock.patch.object(server, "make_engine") as make:
            empty = self.client.post("/api/generate-note", json={"prompt": "  "})
            oversized = self.client.post("/api/generate-note", json={"prompt": "x" * 2001})
            non_object = self.client.post("/api/generate-note", json=["not a request object"])
        self.assertEqual(empty.status_code, 400)
        self.assertEqual(oversized.status_code, 400)
        self.assertEqual(non_object.status_code, 400)
        make.assert_not_called()

    def test_note_endpoint_rejects_empty_model_output(self):
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value={"title": "", "content": ""}):
            response = self.client.post("/api/generate-note", json={"prompt": "Make revision notes"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("note", response.get_json())


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


class OcrNoiseRefundTests(unittest.TestCase):
    """Recognition artefacts must never cost the student a mark."""

    def _normalise(self, record, **kwargs):
        import grade
        aligned = grade.aligned_from_dict({
            "number": "1", "question": "Differentiate x^3.",
            "max_marks": 5, "expected_answer": "3x^2",
            "student_answer": "wrong prose", "marking_scheme": ["5m"],
        })
        return grade.normalise_record(record, aligned, grade.GradeParams(**kwargs))

    def test_ocr_only_deduction_is_refunded(self):
        out = self._normalise({
            "number": "1", "marks_awarded": 4,
            "deductions": [{"category": "ocr", "marks": 1, "reason": "blur"}],
            "feedback": "scan noise",
        })
        self.assertEqual(out["marks_awarded"], 5.0)
        self.assertEqual(out["marks_deducted"], 0.0)

    def test_ocr_noise_does_not_cancel_real_content_loss(self):
        out = self._normalise({
            "number": "1", "marks_awarded": 3,
            "deductions": [
                {"category": "ocr", "marks": 1, "reason": "blur"},
                {"category": "content", "marks": 1, "reason": "wrong sign"},
            ],
            "feedback": "one real error",
        })
        self.assertEqual(out["marks_awarded"], 4.0)
        self.assertEqual(out["marks_deducted"], 1.0)

    def test_award_is_clamped_to_the_maximum(self):
        out = self._normalise({"number": "1", "marks_awarded": 99})
        self.assertEqual(out["marks_awarded"], 5.0)

    def test_negative_award_becomes_zero(self):
        out = self._normalise({"number": "1", "marks_awarded": -5})
        self.assertEqual(out["marks_awarded"], 0.0)

    def test_disabled_criterion_is_reclassified_as_content(self):
        out = self._normalise({
            "number": "1", "marks_awarded": 4,
            "deductions": [{"category": "handwriting", "marks": 1}],
        })
        self.assertEqual(out["deductions"][0]["category"], "content")


class SubtopicPromptTests(unittest.TestCase):
    """A teacher-supplied subtopic has to reach the model."""

    def test_subtopic_appears_in_the_instruction(self):
        sent: list[str] = []

        class _Resp:
            status_code = 200
            text = ""

            def json(self):
                return {"choices": [{"message": {"content": json.dumps({
                    "number": "Q1", "text": "State Snell's law.",
                    "max_marks": 5, "expected_answer": "n1 sin i = n2 sin r",
                    "marking_scheme": "5m", "keywords": ["snell"],
                })}}]}

        def fake_post(url, headers=None, json=None, timeout=None, **_kw):
            for message in json["messages"]:
                content = message.get("content")
                if isinstance(content, str):
                    sent.append(content)
            return _Resp()

        client = server.app.test_client()
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch.object(engine, "WHT_ENGINE_RPM", 100_000), \
                mock.patch("requests.post", side_effect=fake_post):
            resp = client.post("/api/generate-exam-question", json={
                "topic": "Optics", "subtopic": "Snell's law",
                "index": 1, "total": 3, "marks": 5,
            })
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(any("Snell's law" in text for text in sent))

    def test_blank_subtopic_still_generates(self):
        answer = {"number": "Q1", "text": "Define optics.", "max_marks": 5,
                  "expected_answer": "study of light", "marking_scheme": "5m",
                  "keywords": ["light"]}
        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch.object(engine.WhtEngine, "generate_json",
                                  return_value=answer):
            resp = server.app.test_client().post(
                "/api/generate-exam-question",
                json={"topic": "Optics", "subtopic": "", "index": 1},
            )
        self.assertEqual(resp.status_code, 200)
