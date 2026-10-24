import unittest

from extract import (AlignedQuestion, KeyEntry, QuestionSpec, StudentAnswer,
                     align_questions, normalize_number)


class AlignmentGeometryTests(unittest.TestCase):
    def test_student_geometry_reaches_the_aligned_question(self):
        geometry = [
            {"crop_id": "p1c0", "page": 1, "rect": [0.1, 0.2, 0.3, 0.1]},
            {"crop_id": "p1c1", "page": 1, "rect": [0.1, 0.32, 0.2, 0.1]},
        ]
        aligned = align_questions(
            [QuestionSpec(number="1", text="2+2", max_marks=2)],
            [KeyEntry(number="1", expected_answer="4")],
            [StudentAnswer(
                number="Q1",
                response="4",
                page=1,
                crop_ids=["p1c0", "p1c1"],
                geometry=geometry,
            )],
        )

        self.assertEqual(len(aligned), 1)
        self.assertIsInstance(aligned[0], AlignedQuestion)
        self.assertEqual(aligned[0].geometry, geometry)
        self.assertEqual(aligned[0].to_payload()["geometry"], geometry)

    def test_missing_geometry_stays_empty(self):
        aligned = align_questions(
            [QuestionSpec(number="1", text="2+2", max_marks=2)],
            [KeyEntry(number="1", expected_answer="4")],
            [StudentAnswer(number="1", response="4")],
        )
        self.assertEqual(aligned[0].geometry, [])


class NumberNormalisationTests(unittest.TestCase):
    def test_strips_answer_and_section_prefixes(self):
        self.assertEqual(normalize_number("a.3)"), "3")
        self.assertEqual(normalize_number("Ans 4"), "4")
        self.assertEqual(normalize_number("answer-5"), "5")
        self.assertEqual(normalize_number("Q.3"), "3")

    def test_keeps_sub_part_suffixes(self):
        self.assertEqual(normalize_number("3a"), "3a")
        self.assertEqual(normalize_number("(iii)"), "3")


if __name__ == "__main__":
    unittest.main()
