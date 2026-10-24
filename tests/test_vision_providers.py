import json
import re
import threading
import unittest

from vision.models import Crop, Rect
from vision.providers import ProviderConfig, VisionProvider


class FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, content: str):
        self._content = content

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


class CapturingProvider(VisionProvider):
    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.prompts: list[str] = []
        self._lock = threading.Lock()

    def _post(self, crops, prompt):
        with self._lock:
            self.prompts.append(prompt)
        content = json.dumps({
            "items": [
                {"id": crop.crop_id, "latex": f"L{crop.index}"}
                for crop in crops
            ]
        })
        return FakeResponse(content)


def _crop(index: int) -> Crop:
    return Crop(
        page=1,
        index=index,
        rect=Rect(0.1, 0.1, 0.2, 0.1),
        image=b"\xff\xd8\xff",
    )


class BatchTests(unittest.TestCase):
    def _provider(self, batch_size: int, workers: int) -> CapturingProvider:
        return CapturingProvider(ProviderConfig(
            name="fake",
            url="http://example.invalid",
            model="fake-model",
            api_key="test",
            batch_size=batch_size,
            max_workers=workers,
        ))

    def test_each_batch_lists_only_its_own_ids(self):
        provider = self._provider(batch_size=2, workers=3)
        crops = [_crop(index) for index in range(5)]

        results = provider.transcribe(crops)

        self.assertEqual(set(results), {crop.crop_id for crop in crops})
        self.assertEqual(len(provider.prompts), 3)

        listed = []
        for prompt in provider.prompts:
            ids = re.findall(r"id=(\S+)", prompt)
            self.assertLessEqual(len(ids), 2)
            listed.extend(ids)
        self.assertEqual(sorted(listed), sorted(crop.crop_id for crop in crops))

    def test_single_batch_makes_one_call(self):
        provider = self._provider(batch_size=10, workers=6)
        crops = [_crop(index) for index in range(3)]

        results = provider.transcribe(crops)

        self.assertEqual(len(provider.prompts), 1)
        self.assertEqual([t.latex for t in results.values()], ["L0", "L1", "L2"])

    def test_empty_input_does_not_call_provider(self):
        provider = self._provider(batch_size=2, workers=3)
        self.assertEqual(provider.transcribe([]), {})
        self.assertEqual(provider.prompts, [])

    def test_custom_prefix_is_preserved(self):
        provider = self._provider(batch_size=10, workers=1)
        provider.transcribe([_crop(0)], prompt="EXTRA INSTRUCTION")
        self.assertTrue(provider.prompts[0].startswith("EXTRA INSTRUCTION"))


if __name__ == "__main__":
    unittest.main()
