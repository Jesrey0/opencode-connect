"""Private worker boundary tests, run with the explicitly installed environment."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("browser_worker", Path(__file__).resolve().parents[1] / "src/browser/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BoundaryTests(unittest.TestCase):
    def test_upload_preflight_rejects_escapes_missing_files_and_protected_suffixes(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS": directory}):
            root = Path(directory)
            ordinary = root / "report.pdf"
            ordinary.write_bytes(b"fixture")
            (root / "private.KEY").write_bytes(b"fixture")
            (root / "escape.pdf").symlink_to("/etc/passwd")
            self.assertEqual(worker.upload_files([str(ordinary)], "linux"), [str(ordinary)])
            for name in ["relative.pdf", str(root / "missing.pdf"), str(root / "private.KEY"), str(root / "escape.pdf"), str(root)]:
                with self.subTest(name=name), self.assertRaises(worker.Rejected) as caught:
                    worker.upload_files([name], "linux")
                self.assertEqual(caught.exception.code, "upload_denied")
            with self.assertRaises(worker.Rejected):
                worker.upload_files([str(ordinary)], "windows")
        with patch.dict(os.environ, {"OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS": "/mnt/c/Authorized"}), patch.object(Path, "resolve", lambda path, **kwargs: path), patch.object(Path, "is_file", return_value=True):
            self.assertEqual(worker.upload_files(["/mnt/c/Authorized/report.pdf"], "windows"), ["C:\\Authorized\\report.pdf"])

    def test_workflow_validates_every_step_before_execution(self):
        step = {"action": "click", "target": {"role": "button", "name": "Add"}, "expected": {"type": "text", "value": "Editor"}}
        worker.validate("workflow", {"leaseId": "lease", "authorized": True, "steps": [step]})
        for malformed in [{**step, "elementRef": "old"}, {**step, "expected": None}, {**step, "target": {"selector": "button"}}, {**step, "script": "1+1"}]:
            with self.subTest(step=malformed), self.assertRaises(worker.Rejected):
                worker.validate("workflow", {"leaseId": "lease", "authorized": True, "steps": [step, malformed]})

    def test_sensitive_url_and_text_values_are_omitted(self):
        self.assertEqual(worker.safe_url("https://user:password@example.test/path?access_token=secret#token"), "https://example.test/path")
        self.assertNotIn("secret", worker.safe_text("token=secret Bearer secret https://example.test/?secret=secret"))

    def test_unknown_operations_and_action_authority_fail_closed(self):
        for method, args in [("evaluate", {"script": "1+1"}), ("action", {"leaseId": "l", "action": "click", "elementRef": "e", "authorized": False}), ("action", {"leaseId": "l", "action": "click", "elementRef": "e", "authorized": True, "script": "1+1"}), ("snapshot", {"leaseId": "l", "maxNodes": 301}), ("wait", {"leaseId": "l", "condition": {"type": "text", "value": "done", "script": "1+1"}})]:
            with self.subTest(method=method, args=args), self.assertRaises(worker.Rejected):
                worker.validate(method, args)


class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_workflow_keeps_partial_progress_when_connection_disappears(self):
        for native_error in (False, True):
            class Adapter(worker.Adapter):
                async def guard(self, args, owner, control=False):
                    if getattr(self, "acted", False):
                        self.conn = None
                        if native_error:
                            raise RuntimeError("private protocol diagnostics")
                        worker.reject("disconnected", "Connection expired")
                    return {"url": "https://example.test/?token=secret"}

                async def snapshot(self, args):
                    return {"nodes": [{"role": "button", "name": "Add", "ref": "observed"}], "truncated": False, "observationErrors": []}

                async def action(self, args):
                    self.acted = self.dispatched = True
                    return {"verification": "confirmed", "url": "https://example.test/", "evidence": "done"}

                async def current(self):
                    raise AssertionError("Failure reporting must not require a live browser")

            adapter = Adapter()
            step = {"action": "click", "target": {"role": "button", "name": "Add"}, "expected": {"type": "text", "value": "done"}}
            result = await adapter.workflow({"leaseId": "lease", "steps": [step, step]}, "owner")
            self.assertEqual(result["completedSteps"], 1)
            self.assertEqual(result["failedStep"], 1)
            self.assertTrue(result["mutationMayHaveOccurred"])
            self.assertEqual(result["url"], "https://example.test/")
            self.assertNotIn("private", json.dumps(result))

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
