import unittest

from vision import arbiter
from vision.models import Transcription


class LatexConversionTests(unittest.TestCase):
    def test_power(self):
        self.assertEqual(arbiter.latex_to_python("2^2 - 4"), "2**2 - 4")

    def test_fraction(self):
        self.assertEqual(
            arbiter.latex_to_python(r"\frac{1}{2}"), "((1)/(2))"
        )

    def test_sqrt(self):
        self.assertEqual(arbiter.latex_to_python(r"\sqrt{9}"), "sqrt(9)")

    def test_text_is_dropped(self):
        self.assertEqual(arbiter.latex_to_python(r"x \text{ cm}"), "x")

    def test_unicode_minus(self):
        self.assertEqual(arbiter.latex_to_python("\u22123"), "-3")


class AgreementTests(unittest.TestCase):
    def test_same_value_different_forms(self):
        self.assertEqual(arbiter.agreement("2^2 - 4", "0"), "same")

    def test_fraction_equals_decimal(self):
        self.assertEqual(arbiter.agreement(r"\frac{1}{2}", "0.5"), "same")

    def test_arithmetic_mismatch(self):
        self.assertEqual(arbiter.agreement("2+2", "5"), "differ")

    def test_unreadable_placeholder_is_unknown(self):
        self.assertEqual(arbiter.agreement(r"\square", "x"), "unknown")

    def test_multiline_comparison(self):
        left = r"2+2=4 \\ 4-1=3"
        right = r"2+2=4 \\ 4-1=3"
        self.assertEqual(arbiter.agreement(left, right), "same")


class ChainTests(unittest.TestCase):
    def test_clean_chain(self):
        lines = ["p(2) = 2^2 - 4", "= 4 - 4", "= 0"]
        self.assertIsNone(arbiter.contradiction(lines))

    def test_misread_square_is_a_contradiction(self):
        lines = ["p(2) = 2^2 - 4", "= 22 - 4", "= 18"]
        self.assertEqual(arbiter.contradiction(lines), 1)

    def test_numeric_values_skips_symbolic_segments(self):
        self.assertEqual(
            arbiter.numeric_values("p(2) = 2^2 - 4"), [0.0]
        )


class DecisionTests(unittest.TestCase):
    def _transcription(self, latex: str, provider: str = "nvidia"):
        return Transcription(crop_id="p1c0", latex=latex, provider=provider)

    def test_single_provider_is_medium_confidence(self):
        result = arbiter.decide({"nvidia": self._transcription("2+2=4")})
        self.assertEqual(result.confidence, 0.55)
        self.assertIn("single-provider", result.note)

    def test_two_agreeing_providers_are_high_confidence(self):
        result = arbiter.decide({
            "nvidia": self._transcription("2+2=4"),
            "groq": self._transcription("2+2=4", "groq"),
        })
        self.assertEqual(result.confidence, 0.95)

    def test_two_disagreeing_providers_are_low_confidence(self):
        result = arbiter.decide({
            "nvidia": self._transcription("2+2"),
            "groq": self._transcription("2+3", "groq"),
        })
        self.assertEqual(result.confidence, 0.35)

    def test_chain_contradiction_caps_confidence(self):
        result = arbiter.decide({
            "nvidia": self._transcription(r"p(2) = 2^2 - 4 \\ = 22 - 4"),
        })
        self.assertEqual(result.confidence, 0.3)
        self.assertIn("chain", result.note)

    def test_all_failed_is_an_error_not_a_zero_mark(self):
        failed = Transcription(crop_id="p1c0", provider="nvidia", error="timeout")
        result = arbiter.decide({"nvidia": failed})
        self.assertEqual(result.confidence, 0.0)
        self.assertTrue(result.error)
        self.assertFalse(result.ok)


if __name__ == "__main__":
    unittest.main()
