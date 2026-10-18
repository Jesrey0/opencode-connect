"""Private worker boundary tests, run with the explicitly installed environment."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("browser_worker", Path(__file__).resolve().parents[1] / "src/browser/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BoundaryTests(unittest.TestCase):
    def test_sensitive_url_and_text_values_are_omitted(self):
        self.assertEqual(worker.safe_url("https://user:password@example.test/path?access_token=secret#token"), "https://example.test/path")
        self.assertNotIn("secret", worker.safe_text("token=secret Bearer secret https://example.test/?secret=secret"))

    def test_unknown_operations_and_action_authority_fail_closed(self):
        for method, args in [("evaluate", {"script": "1+1"}), ("action", {"leaseId": "l", "action": "click", "elementRef": "e", "authorized": False}), ("action", {"leaseId": "l", "action": "click", "elementRef": "e", "authorized": True, "script": "1+1"}), ("snapshot", {"leaseId": "l", "maxNodes": 301}), ("wait", {"leaseId": "l", "condition": {"type": "text", "value": "done", "script": "1+1"}})]:
            with self.subTest(method=method, args=args), self.assertRaises(worker.Rejected):
                worker.validate(method, args)


class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_tab_lists_truncate_by_bytes_and_can_be_narrowed(self):
        class Adapter(worker.Adapter):
            async def targets(self, browser, *args):
                return [{"id": str(index), "title": "target-" + str(index) + "界" * 190, "url": "https://example.test/" + "界" * 2048} for index in range(100)]
        adapter = Adapter()
        result = await adapter.run("tabs", {"maxTabs": 100}, "owner")
        self.assertTrue(result["truncated"])
        self.assertLess(len(json.dumps(result)), 105000)
        narrowed = await adapter.run("tabs", {"filter": "target-99", "maxTabs": 100}, "owner")
        self.assertEqual([item["targetId"] for item in narrowed["targets"]], ["99"])
        self.assertFalse(narrowed["truncated"])


if __name__ == "__main__":
    unittest.main()
