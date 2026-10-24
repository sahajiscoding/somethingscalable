import unittest

from extract import AlignedQuestion
from grade import GradeParams, _try_fast_grade


def _question(student: str, expected: str, *, max_marks: float = 2.0,
              scheme: list | None = None) -> AlignedQuestion:
    return AlignedQuestion(
        number="1",
        student_answer=student,
        expected_answer=expected,
        max_marks=max_marks,
        marking_scheme=scheme or [],
    )


class SymbolicFastPathTests(unittest.TestCase):
    def test_fraction_equals_decimal(self):
        record = _try_fast_grade(
            _question("0.5", r"\frac{1}{2}"), GradeParams()
        )
        self.assertIsNotNone(record)
        self.assertEqual(record["marks_awarded"], 2.0)

    def test_power_equals_value(self):
        record = _try_fast_grade(_question("2^3", "8"), GradeParams())
        self.assertIsNotNone(record)
        self.assertEqual(record["marks_awarded"], 2.0)

    def test_wrong_value_still_goes_to_the_model(self):
        self.assertIsNone(
            _try_fast_grade(_question("0.6", r"\frac{1}{2}"), GradeParams())
        )

    def test_marking_scheme_is_never_bypassed(self):
        scheme = [{"step": "correct method", "marks": 1.0}]
        self.assertIsNone(
            _try_fast_grade(
                _question("0.5", r"\frac{1}{2}", scheme=scheme), GradeParams()
            )
        )

    def test_prose_answer_is_not_auto_marked(self):
        self.assertIsNone(
            _try_fast_grade(
                _question("about one half", r"\frac{1}{2}"), GradeParams()
            )
        )

    def test_blank_answer_is_still_zero(self):
        record = _try_fast_grade(_question("", r"\frac{1}{2}"), GradeParams())
        self.assertIsNotNone(record)
        self.assertEqual(record["marks_awarded"], 0.0)


if __name__ == "__main__":
    unittest.main()
