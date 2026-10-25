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

    def test_continuation_and_leftover_blocks_merge_into_question_6(self):
        paper = [
            QuestionSpec(
                number="6",
                text="State two advantages of vegetative propagation and name a plant reproducing by leaf buds.",
                max_marks=2,
            ),
        ]
        key = [
            KeyEntry(
                number="6",
                expected_answer="Identical to parent; seedless plants like banana can be grown; Bryophyllum.",
            ),
        ]
        student = [
            StudentAnswer(
                number="Ans. 6)",
                response="Vegetative propagation is practiced as :",
                page=1,
                crop_ids=["p1c4"],
                geometry=[{"crop_id": "p1c4", "page": 1, "rect": [0.1, 0.4, 0.5, 0.05], "latex": "Vegetative propagation is practiced as :"}],
            ),
            StudentAnswer(
                number="~1",
                response="* The plants grown by this method are more identical to parent plant and carry almost all characteristics.",
                page=1,
                crop_ids=["p1c5"],
                geometry=[{"crop_id": "p1c5", "page": 1, "rect": [0.1, 0.48, 0.8, 0.08], "latex": "* The plants grown by this method are more identical to parent plant and carry almost all characteristics."}],
            ),
            StudentAnswer(
                number="6a",
                response="* The plants like banana which have lost their capability to produce seeds can also be grown by this method efficiently.",
                page=1,
                crop_ids=["p1c6"],
                geometry=[{"crop_id": "p1c6", "page": 1, "rect": [0.1, 0.58, 0.8, 0.08], "latex": "* The plants like banana which have lost their capability to produce seeds can also be grown by this method efficiently."}],
            ),
            StudentAnswer(
                number="#1",
                response="The plant of bryophyllum reproduces with buds on its leaves.",
                page=1,
                crop_ids=["p1c7"],
                geometry=[{"crop_id": "p1c7", "page": 1, "rect": [0.1, 0.68, 0.8, 0.06], "latex": "The plant of bryophyllum reproduces with buds on its leaves."}],
            ),
        ]

        aligned = align_questions(paper, key, student)

        self.assertEqual(len(aligned), 1)
        self.assertEqual(aligned[0].number, "6")
        self.assertEqual(len(aligned[0].geometry), 4)
        self.assertIn("Vegetative propagation is practiced as :", aligned[0].student_answer)
        self.assertIn("identical to parent plant", aligned[0].student_answer)
        self.assertIn("banana", aligned[0].student_answer)
        self.assertIn("bryophyllum", aligned[0].student_answer)


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
