import io
import unittest

from PIL import Image

from engine import MockEngine
from extract import AlignedQuestion
from grade import GradeParams, normalise_record, recheck_one_record
from server import _student_page_previews, app


class StepGradingTests(unittest.TestCase):
    def _sample_question(self) -> AlignedQuestion:
        return AlignedQuestion(
            number="3",
            question="Check whether x=2 is a zero of p(x) = x^2 - 4",
            max_marks=3.0,
            expected_answer="p(2) = 2^2 - 4 = 4 - 4 = 0, hence x=2 is a zero.",
            student_answer="p(2) = 2^2 - 4\n= 22 - 4\n= 18\np(2) = 18 != 0\nhence x=2 not a zero",
            page=2,
            geometry=[
                {"crop_id": "p2c1", "page": 2, "rect": [0.2, 0.42, 0.25, 0.04], "latex": "p(2) = 2^2 - 4", "confidence": 0.95},
                {"crop_id": "p2c2", "page": 2, "rect": [0.25, 0.49, 0.14, 0.04], "latex": "= 22 - 4", "confidence": 0.91},
                {"crop_id": "p2c3", "page": 2, "rect": [0.25, 0.55, 0.12, 0.04], "latex": "= 18", "confidence": 0.94},
                {"crop_id": "p2c4", "page": 2, "rect": [0.21, 0.61, 0.22, 0.04], "latex": "p(2) = 18 != 0", "confidence": 0.89},
            ],
        )

    def test_preserves_geometry_and_normalises_model_steps(self):
        q = self._sample_question()
        raw_item = {
            "number": "3",
            "max_marks": 3.0,
            "marks_awarded": 1.0,
            "deductions": [
                {"category": "content", "marks": 2.0, "reason": "Arithmetic error: calculated 2^2 as 22."}
            ],
            "feedback": "Substituted x=2 correctly (1 mark), but calculated 2^2 as 22 leading to wrong conclusion.",
            "steps": [
                {
                    "title": "Step 1: Substitute x=2",
                    "status": "correct",
                    "lines": [{"crop_id": "p2c1", "text": "p(2) = 2^2 - 4", "ok": True}],
                },
                {
                    "title": "Step 2: Calculate value",
                    "status": "error",
                    "lines": [
                        {"crop_id": "p2c2", "text": "= 22 - 4", "ok": False, "error_tag": "Calculation Error"},
                        {"crop_id": "p2c3", "text": "= 18", "ok": False},
                    ],
                    "explanation": "Arithmetic error: calculated 2^2 as 22.",
                },
                {
                    "title": "Step 3: Conclusion",
                    "status": "error",
                    "lines": [
                        {"text": "p(2) = 18 != 0", "ok": False, "error_tag": "Result Error"},
                    ],
                    "explanation": "Conclusion is incorrect because the calculation was wrong.",
                },
            ],
        }
        rec = normalise_record(raw_item, q, GradeParams())
        self.assertEqual(len(rec["geometry"]), 4)
        self.assertEqual(len(rec["steps"]), 3)
        self.assertEqual(rec["steps"][0]["status"], "correct")
        self.assertEqual(rec["steps"][1]["lines"][0]["error_tag"], "Calculation Error")
        # Step 3 line had no crop_id; matcher should resolve it to p2c4 by latex match
        self.assertEqual(rec["steps"][2]["lines"][0]["crop_id"], "p2c4")
        self.assertEqual(rec["steps"][2]["lines"][0]["error_tag"], "Result Error")

    def test_synthesizes_fallback_steps_when_model_omits_steps(self):
        q = self._sample_question()
        raw_item = {
            "number": "3",
            "max_marks": 3.0,
            "marks_awarded": 1.0,
            "deductions": [
                {"category": "content", "marks": 2.0, "reason": "Arithmetic calculation error in 2^2."}
            ],
            "feedback": "Calculation error after substitution.",
        }
        rec = normalise_record(raw_item, q, GradeParams())
        self.assertGreaterEqual(len(rec["steps"]), 2)
        self.assertEqual(rec["steps"][0]["status"], "correct")
        self.assertEqual(rec["steps"][-1]["status"], "error")
        self.assertTrue(any(
            ln.get("error_tag")
            for step in rec["steps"]
            for ln in step["lines"]
        ))

    def test_student_page_previews_renders_image_to_jpeg_data_url(self):
        buf = io.BytesIO()
        Image.new("RGB", (400, 600), (240, 240, 240)).save(buf, "PNG")
        previews = _student_page_previews(buf.getvalue(), "image")
        self.assertEqual(len(previews), 1)
        self.assertTrue(previews[0].startswith("data:image/jpeg;base64,"))

    def test_splits_single_line_bullet_points_into_steps(self):
        flattened_answer = (
            "Self Pollination Cross Pollination "
            "* When pollen grains of one flower travels to the stigma of same flower, it's called Self pollination "
            "* Even if they pollinate from one flower to another of the same plant, it is called Self Pollination "
            "* When pollen grains from anther of one flower strikes to the stigma of another flower of another plant, it is called Cross pollination."
        )
        q = AlignedQuestion(
            number="9",
            question="Differentiate between self-pollination and cross-pollination.",
            max_marks=2.0,
            expected_answer="Self-pollination occurs within the same flower/plant; cross-pollination occurs between different plants.",
            student_answer=flattened_answer,
            page=1,
        )
        raw_item = {
            "number": "9",
            "max_marks": 2.0,
            "marks_awarded": 1.0,
            "deductions": [{"category": "content", "marks": 1.0, "reason": "Distinction unclear."}],
            "feedback": "Distinction between the two processes is unclear.",
        }
        rec = normalise_record(raw_item, q, GradeParams())
        self.assertGreaterEqual(len(rec["steps"]), 3)
        self.assertEqual(rec["steps"][0]["status"], "correct")

    def test_recheck_one_record_with_teacher_instruction(self):
        flattened_answer = (
            "Self Pollination Cross Pollination "
            "* When pollen grains of one flower travels to the stigma of same flower, it's called Self pollination "
            "* When pollen grains from anther of one flower strikes to the stigma of another flower of another plant, it is called Cross pollination."
        )
        aligned_dict = {
            "number": "Q9",
            "question": "Differentiate between self-pollination and cross-pollination.",
            "max_marks": 2.0,
            "expected_answer": "Self-pollination transfers pollen on the same plant; cross-pollination transfers pollen between two different plants.",
            "student_answer": flattened_answer,
            "page": 1,
        }
        rec = recheck_one_record(
            MockEngine(),
            aligned_dict,
            GradeParams(),
            teacher_instruction="The student differentiated between the two topics in two side-by-side columns.",
        )
        self.assertEqual(rec["marks_awarded"], 2.0)
        self.assertEqual(rec["marks_deducted"], 0.0)
        self.assertTrue(all(s["status"] == "correct" for s in rec["steps"]))

    def test_api_recheck_question_endpoint(self):
        client = app.test_client()
        resp = client.post(
            "/api/recheck-question",
            json={
                "backend": "mock",
                "question": {
                    "number": "Q9",
                    "question": "Differentiate between self-pollination and cross-pollination.",
                    "max_marks": 2.0,
                    "expected_answer": "Self-pollination vs Cross-pollination.",
                    "student_answer": (
                        "Self Pollination Cross Pollination "
                        "* When pollen grains travel to the stigma of same flower "
                        "* When pollen grains travel to another plant"
                    ),
                },
                "teacher_instruction": "The student differentiated between the two topics in two columns, recheck again.",
            },
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("record", data)
        self.assertEqual(data["record"]["marks_awarded"], 2.0)


if __name__ == "__main__":
    unittest.main()
