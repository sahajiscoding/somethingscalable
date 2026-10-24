import io
import unittest

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from vision import layout


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def make_page(lines: int = 4, angle: float = 0.0) -> Image.Image:
    image = Image.new("L", (1000, 1400), 255)
    draw = ImageDraw.Draw(image)
    font = _font(30)
    for index in range(lines):
        draw.text(
            (100, 120 + index * 90),
            f"x = {index} + 2^2 - 4",
            fill=0,
            font=font,
        )
    if angle:
        image = image.rotate(angle, resample=Image.BILINEAR, fillcolor=255)
    return image


class LayoutTests(unittest.TestCase):
    def test_finds_one_block_per_line(self):
        page = layout._crop_page(np.asarray(make_page(4)), 1, 240, 32)
        self.assertEqual(page.width, 1000)
        self.assertEqual(page.height, 1400)
        self.assertGreaterEqual(len(page.crops), 3)
        self.assertLessEqual(len(page.crops), 5)

        for crop in page.crops:
            self.assertGreater(crop.rect.w, 0.0)
            self.assertGreater(crop.rect.h, 0.0)
            self.assertLessEqual(crop.rect.x + crop.rect.w, 1.0001)
            self.assertLessEqual(crop.rect.y + crop.rect.h, 1.0001)
            self.assertTrue(crop.image)
            with Image.open(io.BytesIO(crop.image)) as patch:
                patch.load()
                self.assertEqual(patch.mode, "L")
            self.assertGreaterEqual(crop.line_count, 1)

    def test_crops_do_not_overlap_vertically(self):
        page = layout._crop_page(np.asarray(make_page(5)), 1, 240, 32)
        ordered = sorted(page.crops, key=lambda crop: crop.rect.y)
        for previous, current in zip(ordered, ordered[1:]):
            previous_bottom = previous.rect.y + previous.rect.h
            # Crops may only overlap by the layout padding (6 px of 1400).
            self.assertGreaterEqual(current.rect.y, previous_bottom - 0.012)

    def test_deskew_recovers_rotation(self):
        tilted = np.asarray(make_page(3, angle=3.0))
        _corrected, angle = layout.deskew(tilted)
        self.assertGreater(abs(angle), 1.5)
        self.assertLess(abs(abs(angle) - 3.0), 1.3)

    def test_blank_page_has_no_crops(self):
        blank = np.full((400, 400), 255, dtype=np.uint8)
        page = layout._crop_page(blank, 1, 240, 32)
        self.assertEqual(page.crops, [])

    def test_block_cap_merges_instead_of_dropping(self):
        page = layout._crop_page(np.asarray(make_page(6)), 1, 240, 2)
        self.assertLessEqual(len(page.crops), 2)
        self.assertGreaterEqual(len(page.crops), 1)


if __name__ == "__main__":
    unittest.main()
