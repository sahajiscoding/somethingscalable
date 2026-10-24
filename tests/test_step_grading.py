import io
import unittest

from PIL import Image

from extract import AlignedQuestion
from grade import GradeParams, normalise_record
from server import _student_page_previews


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


if __name__ == "__main__":
    unittest.main()
