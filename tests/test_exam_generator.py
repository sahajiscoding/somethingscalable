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
from io import BytesIO
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
    def test_empty_completion_does_not_switch_models(self):
        tried: list[str] = []

        def fake_post(url, headers=None, json=None, timeout=None, **_kw):
            tried.append(json["model"])
            return _completion("")

        with mock.patch.dict(os.environ, {"KILO_API_KEY": "k"}, clear=True), \
                mock.patch("requests.post", side_effect=fake_post):
            eng = engine.make_engine()
            with self.assertRaisesRegex(engine.EngineError, "Empty completion"):
                eng.generate_json("q", instruction="x", max_attempts=1)

        self.assertTrue(tried)
        self.assertEqual(set(tried), {engine.WHT_ENGINE_DEFAULT_MODEL})


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


class TaskSystemPromptTests(unittest.TestCase):
    def test_task_system_prompt_is_sent_as_a_system_message(self):
        client = engine.WhtEngine(api_key="test-key")
        messages = client._build_messages(
            "write notes", None, None, "Reject vague prompts; never write clarification notes."
        )
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("Reject vague prompts", messages[0]["content"])
        self.assertIn("never write clarification notes", messages[0]["content"])
        self.assertEqual(messages[1], {"role": "user", "content": "write notes"})

    def test_task_system_prompt_is_in_the_actual_gateway_request(self):
        captured = []

        def fake_post(_url, json=None, **_kwargs):
            captured.append(json)
            return _completion('{"status":"rejected","reason":"prompt too vague"}')

        with mock.patch.object(engine, "WHT_ENGINE_RPM", 100_000), \
                mock.patch("requests.post", side_effect=fake_post):
            client = engine.WhtEngine(api_key="test-key")
            client.generate_json(
                "generate_note",
                instruction="Teacher request: poop.",
                system_prompt="Reject vague single-word note requests.",
                max_attempts=1,
            )

        messages = captured[0]["messages"]
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("Reject vague single-word note requests.", messages[0]["content"])
        self.assertEqual(messages[1], {"role": "user", "content": "Teacher request: poop."})


class NoteGenerationTests(unittest.TestCase):
    """AI note generation validates real model output and never fakes drafts."""

    def setUp(self):
        self.client = server.app.test_client()
        self.env = mock.patch.dict(os.environ, {"KILO_API_KEY": "test-key"}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_note_endpoint_returns_the_written_note_and_passes_request_context(self):
        generated = {"status": "ok", "title": "Photosynthesis", "content": "Plants turn light into chemical energy."}
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=generated) as generate:
            response = self.client.post("/api/generate-note", json={
                "prompt": "Explain photosynthesis to Grade 8", "audience": "Grade 8",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["note"], {
            "title": generated["title"], "content": generated["content"],
        })
        self.assertEqual(generate.call_args.args[0], "generate_note")
        self.assertIn("Explain photosynthesis to Grade 8", generate.call_args.kwargs["instruction"])
        self.assertIn("Grade 8", generate.call_args.kwargs["instruction"])
        self.assertIn("QUALITY GATE", generate.call_args.kwargs["system_prompt"])
        self.assertIn("clarification/refusal as a note", generate.call_args.kwargs["system_prompt"])

    def test_note_endpoint_returns_model_rejection_as_validation_error(self):
        rejected = {
            "status": "rejected",
            "reason": "Please specify a subject and what the notes should cover.",
        }
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=rejected):
            response = self.client.post("/api/generate-note", json={
                "prompt": "Please make notes about poop for biology grade 7",
            })
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("note", response.get_json())
        self.assertIn("specify a subject", response.get_json()["error"])

    def test_note_endpoint_rejects_a_clarification_message_masquerading_as_a_note(self):
        clarification = {
            "status": "ok",
            "title": "Teacher Request Note",
            "content": "The teacher provided a single-word request. Please clarify the topic.",
        }
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=clarification):
            response = self.client.post("/api/generate-note", json={
                "prompt": "Create study notes about photosynthesis for Grade 8 students",
            })
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("note", response.get_json())
        self.assertIn("did not produce study notes", response.get_json()["error"])

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
            too_vague = self.client.post("/api/generate-note", json={"prompt": "poop."})
            oversized = self.client.post("/api/generate-note", json={"prompt": "x" * 2001})
            non_object = self.client.post("/api/generate-note", json=["not a request object"])
        self.assertEqual(empty.status_code, 400)
        self.assertEqual(too_vague.status_code, 400)
        self.assertIn("specific educational topic", too_vague.get_json()["error"])
        self.assertEqual(oversized.status_code, 400)
        self.assertEqual(non_object.status_code, 400)
        make.assert_not_called()

    def test_note_endpoint_rejects_empty_model_output(self):
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value={"title": "", "content": ""}):
            response = self.client.post("/api/generate-note", json={"prompt": "Make revision notes"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("note", response.get_json())


class PresentationGenerationTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.env = mock.patch.dict(os.environ, {"KILO_API_KEY": "test-key"}, clear=True)
        self.env.start()
        self.payload = {
            "topic": "Explain the water cycle and its stages",
            "audience": "Grade 8",
            "slide_count": 3,
        }
        self.generated = {
            "status": "ok",
            "title": "The Water Cycle",
            "subtitle": "A journey through Earth's water",
            "slides": [
                {
                    "title": f"Lesson part {index}",
                    "key_points": ["First useful fact", "Another useful fact", "A final useful fact"],
                    "explanation": "Explain this idea with a concrete classroom example.",
                    "speaker_notes": "Ask learners to explain this idea in their own words.",
                }
                for index in range(1, 4)
            ],
        }

    def tearDown(self):
        self.env.stop()

    def test_endpoint_returns_validated_slides_and_passes_instructional_context(self):
        with mock.patch.object(server, "search_book") as lookup:
            with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
                response = self.client.post("/api/generate-presentation", json=self.payload)
        self.assertEqual(response.status_code, 200)
        lookup.assert_not_called()
        body = response.get_json()
        self.assertEqual(body["presentation"]["title"], "The Water Cycle")
        self.assertEqual(len(body["presentation"]["slides"]), 3)
        self.assertEqual(body["presentation"]["audience"], "Grade 8")
        self.assertEqual(generate.call_args.args[0], "generate_presentation")
        self.assertIn("aim for 3 complete slides", generate.call_args.kwargs["instruction"])
        self.assertIn("instructional designer", generate.call_args.kwargs["system_prompt"])
        self.assertEqual(generate.call_args.kwargs["temperature"], 0.35)
        self.assertIsNone(generate.call_args.kwargs["data"])

    def test_presentation_purpose_controls_prompt_and_rejects_unknown_values(self):
        invalid = self.client.post(
            "/api/generate-presentation", json={**self.payload, "purpose": "worksheet"}
        )
        self.assertEqual(invalid.status_code, 400)
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
            response = self.client.post(
                "/api/generate-presentation", json={**self.payload, "purpose": "mixed"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("at least one third", generate.call_args.kwargs["instruction"])
        self.assertIn("answers and marking guidance", generate.call_args.kwargs["instruction"])
        self.assertIn("question slides", generate.call_args.kwargs["system_prompt"])
        question_only_deck = {**self.generated, "slides": [dict(slide) for slide in self.generated["slides"]]}
        for slide in question_only_deck["slides"]:
            slide["key_points"] = [
                "Read the question carefully", "Attempt the question independently",
                "Show your working clearly", "Use the time provided",
                "Do not discuss answers with classmates",
            ]
            slide["explanation"] = "Find five rational numbers between 3/4 and 4/5."
            slide["speaker_notes"] = "Answer: this must never appear in a question-only deck."
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=question_only_deck) as generate:
            response = self.client.post(
                "/api/generate-presentation", json={**self.payload, "purpose": "question-only"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("absolutely no answers", generate.call_args.kwargs["instruction"])
        self.assertIn("must not include answers, solutions, hints", generate.call_args.kwargs["system_prompt"])
        self.assertIn("include questions when required", generate.call_args.kwargs["system_prompt"])
        result_slide = response.get_json()["presentation"]["slides"][0]
        self.assertEqual(result_slide["key_points"], ["Find five rational numbers between 3/4 and 4/5."])
        self.assertEqual(result_slide["explanation"], "")
        self.assertIn("do not reveal a solution", result_slide["speaker_notes"])
        self.assertNotIn("Answer:", result_slide["speaker_notes"])
        self.assertEqual(response.get_json()["presentation"]["purpose"], "question-only")

    def test_teacher_pdf_and_text_resources_are_extracted_without_storage(self):
        import pymupdf

        pdf = pymupdf.open()
        page = pdf.new_page()
        page.insert_text((72, 72), "The water cycle includes evaporation and condensation.")
        pdf_bytes = pdf.tobytes()
        pdf.close()
        response = self.client.post(
            "/api/presentation-resources",
            data={"files": [
                (BytesIO(pdf_bytes), "lesson-source.pdf"),
                (BytesIO(b"Teacher notes about precipitation."), "notes.txt"),
            ]},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        resources = response.get_json()["resources"]
        self.assertEqual([item["name"] for item in resources], ["lesson-source.pdf", "notes.txt"])
        self.assertEqual(resources[0]["page_count"], 1)
        self.assertIn("evaporation", resources[0]["text"].lower())
        self.assertIn("precipitation", resources[1]["text"])

    def test_resource_extraction_accepts_more_than_five_files_and_over_sixty_thousand_chars(self):
        files = [
            (BytesIO((f"Resource {index} " + "x" * 9990).encode()), f"source-{index}.txt")
            for index in range(7)
        ]
        response = self.client.post(
            "/api/presentation-resources",
            data={"files": files},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        resources = response.get_json()["resources"]
        self.assertEqual(len(resources), 7)
        self.assertGreater(sum(len(resource["text"]) for resource in resources), 60_000)

    def test_many_large_extracted_resources_are_accepted_without_aggregate_cap(self):
        resources = [
            {"name": f"source-{index}.txt", "text": (f"resource {index} " + "x" * 9990)}
            for index in range(7)
        ]
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
            response = self.client.post(
                "/api/generate-presentation", json={**self.payload, "resources": resources}
            )
        self.assertEqual(response.status_code, 200)
        passed_resources = generate.call_args.kwargs["data"]["source_resources"]
        self.assertEqual(len(passed_resources), 7)
        self.assertGreater(sum(len(resource["text"]) for resource in passed_resources), 60_000)

    def test_uploaded_resources_are_passed_as_untrusted_source_data_to_slide_model(self):
        resources = [{"name": "notes.txt", "text": "Plants use light energy to make glucose."}]
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
            response = self.client.post(
                "/api/generate-presentation", json={**self.payload, "resources": resources}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(generate.call_args.kwargs["data"]["source_resources"][0]["name"], "notes.txt")
        self.assertEqual(generate.call_args.kwargs["data"]["source_resources"][0]["text"], resources[0]["text"])
        self.assertIn("untrusted reference material", generate.call_args.kwargs["instruction"])

    def test_free_book_research_route_never_calls_the_model_and_skips_generic_topics(self):
        with mock.patch.object(server, "search_book", return_value=[]) as lookup, mock.patch.object(server, "make_engine") as make:
            generic = self.client.post(
                "/api/research-book", json={"topic": "Teach algebra and geometry"}
            )
            named = self.client.post(
                "/api/research-book", json={"book_title": "Ganita Manjari Part 1"}
            )
        self.assertEqual(generic.status_code, 200)
        self.assertIsNone(generic.get_json()["book_research"])
        self.assertEqual(named.status_code, 200)
        lookup.assert_called_once_with("Ganita Manjari Part 1")
        make.assert_not_called()

    def test_book_search_runs_only_for_a_named_book_and_passes_free_catalog_details_to_model(self):
        sources = [{
            "provider": "Google Books",
            "title": "Ganita Manjari Part 1",
            "authors": ["A. Teacher"],
            "published_date": "2024",
            "description": "A mathematics textbook for Class 9.",
            "categories": ["Mathematics"],
            "url": "https://books.google.com/books?id=example",
        }]
        with mock.patch.object(server, "search_book", return_value=sources) as lookup:
            with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
                response = self.client.post(
                    "/api/generate-presentation",
                    json={**self.payload, "book_title": "Ganita Manjari Part 1"},
                )

        self.assertEqual(response.status_code, 200)
        lookup.assert_called_once_with("Ganita Manjari Part 1")
        self.assertEqual(generate.call_args.kwargs["data"]["book_reference"]["sources"], sources)
        self.assertIn("specific book", generate.call_args.kwargs["instruction"])
        self.assertEqual(response.get_json()["book_research"]["sources"], sources)

    def test_quoted_book_title_in_topic_triggers_the_same_free_lookup(self):
        with mock.patch.object(server, "search_book", return_value=[]) as lookup:
            with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
                response = self.client.post(
                    "/api/generate-presentation",
                    json={**self.payload, "topic": 'Create slides from the textbook "Ganita Manjari Part 1" for Class 9'},
                )
        self.assertEqual(response.status_code, 200)
        lookup.assert_called_once_with("Ganita Manjari Part 1")
        self.assertEqual(generate.call_args.kwargs["data"]["book_reference"]["query"], "Ganita Manjari Part 1")

    def test_endpoint_accepts_a_shorter_complete_deck_without_requiring_exact_count(self):
        shorter = {**self.generated, "slides": self.generated["slides"][:2]}
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=shorter) as generate:
            response = self.client.post("/api/generate-presentation", json=self.payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.get_json()["presentation"]["slides"]), 2)
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(generate.call_args.kwargs["max_tokens"], 3900)

    def test_endpoint_rejects_invalid_requests_before_calling_model(self):
        with mock.patch.object(server, "make_engine") as make:
            vague = self.client.post("/api/generate-presentation", json={**self.payload, "topic": "water"})
            invalid_count = self.client.post("/api/generate-presentation", json={**self.payload, "slide_count": 2})
            fractional_count = self.client.post("/api/generate-presentation", json={**self.payload, "slide_count": 3.5})
            boolean_count = self.client.post("/api/generate-presentation", json={**self.payload, "slide_count": True})
            no_audience = self.client.post("/api/generate-presentation", json={**self.payload, "audience": " "})
            non_object = self.client.post("/api/generate-presentation", json=["not a request"])
        self.assertTrue(all(item.status_code == 400 for item in (
            vague, invalid_count, fractional_count, boolean_count, no_audience, non_object,
        )))
        make.assert_not_called()

    def test_endpoint_accepts_shorter_deck_when_many_slides_are_requested(self):
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
            response = self.client.post(
                "/api/generate-presentation", json={**self.payload, "slide_count": 25}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.get_json()["presentation"]["slides"]), 3)
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(generate.call_args.kwargs["max_tokens"], 16384)
        self.assertIn("aim for 25 complete slides", generate.call_args.kwargs["instruction"])

    def test_additional_slide_endpoint_generates_one_slide_with_existing_deck_context(self):
        new_slide = {
            "status": "ok",
            "slide": {
                "title": "Saving Water at Home",
                "key_points": ["Read the question carefully", "Attempt the question", "Show your working"],
                "explanation": "Find the amount of water saved by fixing a leaking tap for one week.",
                "speaker_notes": "Answer: 10 litres.",
            },
        }
        payload = {
            "topic": "Explain the water cycle and its stages",
            "audience": "Class 9",
            "deck_title": "The Water Cycle",
            "deck_subtitle": "A connected system",
            "description": "Explain how families can conserve clean water.",
            "purpose": "question-only",
            "resources": [{"name": "source.txt", "text": "Communities can reuse rainwater safely."}],
            "existing_slides": [
                {"title": "Evaporation", "key_points": ["Sun warms water", "Liquid becomes vapor", "Vapor rises"]},
                *[{
                    "title": f"Existing slide {index}",
                    "key_points": ["A key point", "Another point", "A final point"],
                } for index in range(2, 19)],
            ],
        }
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=new_slide) as generate:
            response = self.client.post("/api/generate-presentation-slide", json=payload)

        self.assertEqual(response.status_code, 200)
        result_slide = response.get_json()["slide"]
        self.assertEqual(result_slide["title"], "Saving Water at Home")
        self.assertEqual(result_slide["key_points"], ["Find the amount of water saved by fixing a leaking tap for one week."])
        self.assertEqual(result_slide["explanation"], "")
        self.assertIn("do not reveal a solution", result_slide["speaker_notes"])
        self.assertNotIn("10 litres", result_slide["speaker_notes"])
        self.assertEqual(generate.call_args.args[0], "generate_presentation_slide")
        instruction = generate.call_args.kwargs["instruction"]
        self.assertIn("Explain how families can conserve clean water", instruction)
        self.assertIn("Evaporation", instruction)
        self.assertIn("exactly one", instruction)
        self.assertIn("absolutely no answers", instruction)
        self.assertIn("absolutely no answers", generate.call_args.kwargs["system_prompt"])
        self.assertIn("source_resources", instruction)
        self.assertEqual(generate.call_args.kwargs["data"]["source_resources"][0]["name"], "source.txt")

    def test_additional_slide_endpoint_rejects_vague_descriptions_before_model_call(self):
        with mock.patch.object(server, "make_engine") as make:
            response = self.client.post("/api/generate-presentation-slide", json={
                "topic": "Explain the water cycle and its stages",
                "audience": "Class 9",
                "description": "Water map",
            })
        self.assertEqual(response.status_code, 400)
        make.assert_not_called()

    def test_endpoint_returns_model_rejection_without_a_deck(self):
        rejected = {"status": "rejected", "reason": "Please specify a focused lesson topic."}
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=rejected):
            response = self.client.post("/api/generate-presentation", json=self.payload)
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("presentation", response.get_json())

    def test_endpoint_recovers_missing_and_oversized_teacher_speaker_notes(self):
        generated = {**self.generated, "slides": [dict(slide) for slide in self.generated["slides"]]}
        generated["slides"][0].pop("speaker_notes")
        generated["slides"][1]["speaker_notes"] = "Too much detail. " * 300
        generated["slides"][2]["speaker_notes"] = None
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=generated):
            response = self.client.post("/api/generate-presentation", json=self.payload)
        self.assertEqual(response.status_code, 200)
        slides = response.get_json()["presentation"]["slides"]
        self.assertIn("Teaching prompt", slides[0]["speaker_notes"])
        self.assertLessEqual(len(slides[1]["speaker_notes"]), 1800)
        self.assertTrue(slides[1]["speaker_notes"].endswith("..."))
        self.assertIn("Teaching prompt", slides[2]["speaker_notes"])


class PracticeSetGenerationTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.env = mock.patch.dict(os.environ, {"KILO_API_KEY": "test-key"}, clear=True)
        self.env.start()
        self.payload = {
            "topic": "Explain photosynthesis in plants",
            "grade": "Class 9",
            "difficulty": "Medium",
            "count": 3,
            "marks": 6,
        }
        self.generated = {
            "status": "ok",
            "title": "Photosynthesis Practice",
            "topic": "Photosynthesis in plants",
            "instructions": "Answer all questions.",
            "total_marks": 6,
            "questions": [
                {
                    "number": f"Q{index}",
                    "text": f"Question {index} about photosynthesis",
                    "max_marks": 2,
                    "expected_answer": "A complete model answer.",
                    "marking_scheme": "One mark for each key fact.",
                    "keywords": ["chlorophyll", "light"],
                }
                for index in range(1, 4)
            ],
        }

    def tearDown(self):
        self.env.stop()

    def test_endpoint_generates_a_whole_set_in_one_model_request(self):
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=self.generated) as generate:
            response = self.client.post("/api/generate-practice-set", json=self.payload)
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(len(result["exam"]["questions"]), 3)
        self.assertEqual([q["number"] for q in result["exam"]["questions"]], ["Q1", "Q2", "Q3"])
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(generate.call_args.args[0], "generate_practice_set")
        self.assertIn("Class 9", generate.call_args.kwargs["instruction"])
        self.assertIn("exactly 3", generate.call_args.kwargs["instruction"])
        self.assertEqual(generate.call_args.kwargs["max_attempts"], 2)

    def test_endpoint_rejects_bad_inputs_before_calling_the_model(self):
        with mock.patch.object(server, "make_engine") as make:
            vague = self.client.post("/api/generate-practice-set", json={**self.payload, "topic": "plants"})
            too_many = self.client.post("/api/generate-practice-set", json={**self.payload, "count": 13})
            fractional = self.client.post("/api/generate-practice-set", json={**self.payload, "count": 3.5})
            bad_difficulty = self.client.post("/api/generate-practice-set", json={**self.payload, "difficulty": "Impossible"})
            non_object = self.client.post("/api/generate-practice-set", json=["not a request"])
        self.assertTrue(all(response.status_code == 400 for response in (vague, too_many, fractional, bad_difficulty, non_object)))
        make.assert_not_called()

    def test_endpoint_rejects_partial_or_unusable_model_output(self):
        partial = {**self.generated, "questions": self.generated["questions"][:2]}
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=partial):
            response = self.client.post("/api/generate-practice-set", json=self.payload)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("exam", response.get_json())

    def test_endpoint_surfaces_model_rejection_and_gateway_errors_without_fabricating_questions(self):
        rejected = {"status": "rejected", "reason": "Please give an educational topic."}
        with mock.patch.object(engine.WhtEngine, "generate_json", return_value=rejected):
            rejected_response = self.client.post("/api/generate-practice-set", json=self.payload)
        self.assertEqual(rejected_response.status_code, 400)
        self.assertNotIn("exam", rejected_response.get_json())
        with mock.patch.object(engine.WhtEngine, "generate_json", side_effect=engine.EngineError("gateway timeout")):
            failed_response = self.client.post("/api/generate-practice-set", json=self.payload)
        self.assertEqual(failed_response.status_code, 502)
        self.assertNotIn("exam", failed_response.get_json())


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
                "book_title": "Physics for Class 9", "index": 1, "total": 3, "marks": 5,
            })
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(any("Snell's law" in text for text in sent))
        self.assertTrue(any("Physics for Class 9" in text for text in sent))

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
