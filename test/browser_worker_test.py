"""Private worker boundary tests, run with the explicitly installed environment."""
import asyncio
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock, Mock

root = Path(os.environ["OPENCODE_CONNECT_BROWSER_TEST_BUILD"]) if os.environ.get("OPENCODE_CONNECT_BROWSER_TEST_BUILD") else Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("browser_worker", root / "src/browser/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BoundaryTests(unittest.TestCase):
    def test_keyboard_and_scroll_parameters_preserve_bounds_and_supported_key_modes(self):
        common = {"leaseId": "lease", "elementRef": "e", "authorized": True}
        for fields in [
            {"action": "keypress", "key": "Home"},
            {"action": "keypress", "key": "A", "modifiers": ["Control"]},
            {"action": "keypress", "key": "Enter", "modifiers": ["Control", "Shift"]},
            {"action": "scroll", "deltaY": 120},
            {"action": "scroll", "deltaX": -10000, "deltaY": 10000},
        ]:
            with self.subTest(fields=fields):
                worker.validate("action", {**common, **fields})
        for fields in [
            {"action": "keypress", "key": "A"},
            {"action": "keypress", "key": "Home", "modifiers": ["Control"]},
            {"action": "keypress", "key": "A", "modifiers": []},
            {"action": "keypress", "key": "A", "modifiers": ["Control", "Control"]},
            {"action": "keypress", "key": "A", "modifiers": ["Super"]},
            {"action": "scroll", "deltaX": True, "deltaY": 0},
            {"action": "scroll", "deltaX": 10001, "deltaY": 0},
            {"action": "scroll", "deltaX": 0.5, "deltaY": 0},
            {"action": "scroll", "deltaY": -10001},
            {"action": "keyCombo", "key": "A", "modifiers": ["Control"]},
            {"action": "wheel", "deltaX": 0, "deltaY": 120},
        ]:
            with self.subTest(fields=fields), self.assertRaises(worker.Rejected):
                worker.validate("action", {**common, **fields})

    def test_windows_endpoints_require_loopback_browser_websockets_and_linux_keeps_http(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(worker.endpoint("linux"), "http://127.0.0.1:9222")
            for value in ["ws://127.0.0.1:9223/devtools/browser", "ws://[::1]:9223/devtools/browser/chrome-id"]:
                os.environ["OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT"] = value
                self.assertEqual(worker.endpoint("windows"), value)
            for value in ["http://127.0.0.1:9223", "http://[::1]:9223", "https://127.0.0.1:9223",
                          "ws://localhost:9223/devtools/browser", "ws://192.0.2.1:9223/devtools/browser",
                          "ws://127.0.0.1/devtools/browser", "ws://127.0.0.1:9223/devtools/page/page-id",
                          "ws://u:p@127.0.0.1:9223/devtools/browser", "ws://127.0.0.1:9223/devtools/browser?token=private",
                          "ws://127.0.0.1:9223/devtools/browser#private"]:
                os.environ["OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT"] = value
                with self.subTest(value=value), self.assertRaises(worker.Rejected) as caught:
                    worker.endpoint("windows")
                self.assertEqual(caught.exception.code, "invalid_endpoint")
            for value in ["http://127.0.0.1:9333/", "http://[::1]:9333"]:
                os.environ["OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT"] = value
                self.assertEqual(worker.endpoint("linux"), value.rstrip("/"))
            os.environ["OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT"] = "ws://127.0.0.1:9223/devtools/browser"
            with self.assertRaises(worker.Rejected):
                worker.endpoint("linux")

    def test_windows_metadata_is_explicit_bounded_and_never_an_http_fallback(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            os.environ["OPENCODE_CONNECT_BROWSER_WINDOWS_USER_DATA_DIR"] = directory
            metadata = Path(directory) / "DevToolsActivePort"
            with self.assertRaises(worker.Rejected) as caught:
                worker.endpoint("windows")
            self.assertEqual(caught.exception.code, "not_configured")
            metadata.write_text("9223\n/devtools/browser/chrome-id\n")
            self.assertEqual(worker.endpoint("windows"), "ws://127.0.0.1:9223/devtools/browser/chrome-id")
            os.environ["OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT"] = "ws://127.0.0.1:9223/devtools/browser"
            with self.assertRaises(worker.Rejected) as caught:
                worker.endpoint("windows")
            self.assertEqual(caught.exception.code, "invalid_endpoint")
            del os.environ["OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT"]
            for raw in ["0\n/devtools/browser\n", "65536\n/devtools/browser\n", "not-a-port\n/devtools/browser\n",
                        "9223\n/devtools/browser\nextra\n", "9223\n/devtools/page/page-id\n", "x" * 4097]:
                metadata.write_text(raw)
                with self.subTest(raw=raw[:80]), self.assertRaises(worker.Rejected) as caught:
                    worker.endpoint("windows")
                self.assertEqual(caught.exception.code, "invalid_endpoint")

    def test_worker_protocol_requires_connection_handles_only_for_windows(self):
        for method, fields in [("tabs", {}), ("attach", {"targetId": "selected", "controlMode": "observe"})]:
            worker.validate(method, fields)
            worker.validate(method, {**fields, "browser": "windows", "connectionId": "approved"})
            for selection in [{"browser": "windows"}, {"browser": "linux", "connectionId": "unused"}]:
                with self.subTest(method=method, selection=selection), self.assertRaises(worker.Rejected) as caught:
                    worker.validate(method, {**fields, **selection})
                self.assertEqual(caught.exception.code, "invalid_arguments")
        worker.validate("status", {"browser": "windows"})
        worker.validate("status", {"browser": "windows", "connectionId": "approved"})
        with self.assertRaises(worker.Rejected):
            worker.validate("status", {"connectionId": "unused"})

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

    def test_scoped_targets_and_value_assertions_reject_unbounded_or_unknown_fields(self):
        target = {"role": "textbox", "name": "Title", "within": {"role": "dialog", "name": "Rename recording"}}
        worker.validate_condition({"type": "element", "target": target, "value": "界😀", "state": "editable"})
        for condition in [
            {"type": "element", "target": {**target, "within": {"role": "dialog", "name": "x", "within": target}}},
            {"type": "element", "target": target, "state": "guess"},
            {"type": "element", "target": target, "value": "😀" * 64001},
            {"type": "element", "target": target, "value": "x", "script": "1+1"},
        ]:
            with self.subTest(condition=condition), self.assertRaises(worker.Rejected):
                worker.validate_condition(condition)
        with self.assertRaises(worker.Rejected) as caught:
            worker.validate("action", {"leaseId": "lease", "action": "fill", "elementRef": "ref", "authorized": True, "value": "😀" * 64001})
        self.assertIn("64000", caught.exception.message)

    def test_native_failures_have_sanitized_infrastructure_classification(self):
        for error, code, layer in [(ConnectionError("private-url"), "disconnected", "browser"), (worker.ProtocolException({"code": -32602, "message": "private-value"}), "cdp_error", "input"), (RuntimeError("private-value"), "browser_error", "browser")]:
            actual_code, message, actual_layer = worker.operation_error(error)
            self.assertEqual((actual_code, actual_layer), (code, layer))
            self.assertNotIn("private", message)

    def test_unicode_capacity_and_sequential_preflight_are_independent_of_mcp(self):
        action = {"leaseId": "lease", "action": "typeText", "elementRef": "ref", "authorized": True, "value": "😀" * 64000}
        worker.validate("action", action)
        worker.validate_condition({"type": "element", "target": {"role": "textbox", "name": "Text"}, "value": action["value"]})
        worker.validate("action", {**action, "inputMode": "sequential", "value": "😀" * 2000, "keyDelayMs": 1000})
        for fields, code in [
            ({"inputMode": "sequential", "value": "a" * 2001}, "sequential_limit"),
            ({"inputMode": "sequential", "value": "a\tb"}, "unsupported_input"),
            ({"value": "\ud800"}, "unsupported_input"),
            ({"value": "abc", "keyDelayMs": 0}, "invalid_arguments"),
            ({"value": "abc", "inputMode": "sequential", "keyDelayMs": True}, "invalid_arguments"),
        ]:
            with self.subTest(code=code), self.assertRaises(worker.Rejected) as caught:
                worker.validate("action", {**action, **fields})
            self.assertEqual(caught.exception.code, code)

    def test_sensitive_url_and_text_values_are_omitted(self):
        self.assertEqual(worker.safe_url("https://user:password@example.test/path?access_token=secret#token"), "https://example.test/path")
        self.assertNotIn("secret", worker.safe_text("token=secret Bearer secret https://example.test/?secret=secret"))

    def test_unknown_operations_and_action_authority_fail_closed(self):
        for method, args in [("evaluate", {"script": "1+1"}), ("action", {"leaseId": "l", "action": "click", "elementRef": "e", "authorized": False}), ("action", {"leaseId": "l", "action": "click", "elementRef": "e", "authorized": True, "script": "1+1"}), ("snapshot", {"leaseId": "l", "maxNodes": 301}), ("wait", {"leaseId": "l", "condition": {"type": "text", "value": "done", "script": "1+1"}})]:
            with self.subTest(method=method, args=args), self.assertRaises(worker.Rejected):
                worker.validate(method, args)


class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_dead_lease_tabs_and_explicit_attach_reconcile_without_replaying(self):
        identity = "ws://127.0.0.1:9222/devtools/browser/id"
        row = {"id": "selected", "type": "page", "url": "https://example.test/", "title": "Fixture"}
        class Adapter(worker.Adapter):
            async def discover_linux(self):
                return {"webSocketDebuggerUrl": identity, "Browser": "Chrome/155.0"}

            async def open_socket(self, url, timeout):
                self.conn = Mock()
                self.conn.attach = AsyncMock()
                self.conn.send = AsyncMock()
                self.conn.aclose = AsyncMock()
                return self.conn

            async def frames(self):
                return {}
        lease = {"id": "lease", "owner": "owner", "browser": "linux", "target": "selected", "identity": identity, "mode": "control"}
        adapter = Adapter()
        with patch.object(worker, "fetch_json", return_value=[row]), patch.object(worker, "connected", side_effect=lambda conn: conn is not None):
            for changed in [False, True]:
                adapter.lease = {**lease, "identity": "old-browser" if changed else identity}
                adapter.conn = Mock(aclose=AsyncMock()) if changed else None
                tabs = await adapter.run("tabs", {}, "owner")
                self.assertFalse(tabs["targets"][0]["leased"])
                self.assertIsNone(adapter.lease)
            # Explicit attach must also recover a dead socket without a status call.
            adapter.lease = lease.copy()
            attached = await adapter.run("attach", {"targetId": "selected", "controlMode": "control"}, "owner")
            self.assertTrue(attached["target"]["leased"])
            self.assertNotEqual(attached["leaseId"], "lease")
            self.assertFalse(adapter.summary(row, "windows")["leased"])
            with self.assertRaises(worker.Rejected) as caught:
                await adapter.run("attach", {"targetId": "selected", "controlMode": "control"}, "other")
            self.assertEqual(caught.exception.code, "lease_conflict")
            self.assertEqual(adapter.lease["id"], attached["leaseId"])
        await adapter.disconnect()

    async def test_detach_authenticates_owner_without_requiring_a_live_page(self):
        adapter = worker.Adapter()
        adapter.lease = {"id": "lease", "owner": "owner"}
        for args, owner in [({"leaseId": "lease"}, "other"), ({"leaseId": "wrong"}, "owner")]:
            with self.assertRaises(worker.Rejected) as caught:
                await adapter.run("detach", args, owner)
            self.assertEqual(caught.exception.code, "invalid_lease")
            self.assertIsNotNone(adapter.lease)
        result = await adapter.run("detach", {"leaseId": "lease"}, "owner")
        self.assertTrue(result["chromePreserved"])
        self.assertIsNone(adapter.lease)

    async def test_dead_windows_lease_still_requires_new_explicit_approval(self):
        adapter = worker.Adapter()
        adapter.lease = {"id": "lease", "browser": "windows"}
        adapter.approval = {"id": "old-connection"}
        with patch.object(worker, "endpoint", return_value="ws://127.0.0.1:9223/devtools/browser/id"):
            with self.assertRaises(worker.Rejected) as caught:
                await adapter.run("attach", {"browser": "windows", "targetId": "selected", "controlMode": "control", "connectionId": "old-connection"}, "owner")
        self.assertEqual(caught.exception.code, "approval_required")
        self.assertIsNone(adapter.lease)
        self.assertIsNone(adapter.approval)

    async def test_request_expiring_in_worker_queue_preserves_the_active_attachment(self):
        script = f"""import asyncio,sys
sys.path.insert(0,{str(Path(worker.__file__).parent)!r})
import worker
class Adapter(worker.Adapter):
    def __init__(self):
        super().__init__()
        self.lease={{'id':'active'}}
    async def run(self,method,args,owner):
        if method=='wait':
            await asyncio.sleep(.2)
            return {{'verification':'timed_out'}}
        return {{'attached':self.lease is not None}}
worker.Adapter=Adapter
print('ready',flush=True)
asyncio.run(worker.main())
"""
        process = await asyncio.create_subprocess_exec(sys.executable, "-B", "-u", "-c", script, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            self.assertEqual(await asyncio.wait_for(process.stdout.readline(), 30), b"ready\n")
            now = time.time() * 1000
            for request_id, method, params, duration in [
                ("wait", "wait", {"leaseId": "active", "condition": {"type": "text", "value": "pending"}}, 3000),
                ("expired", "status", {}, 100),
                ("check", "status", {}, 3000),
            ]:
                process.stdin.write((json.dumps({"version": 1, "id": request_id, "method": method, "params": params, "owner": "owner", "deadline": now + duration}) + "\n").encode())
            await process.stdin.drain()
            replies = [json.loads(await asyncio.wait_for(process.stdout.readline(), 5)) for _ in range(3)]
            self.assertTrue(replies[0]["ok"])
            self.assertEqual(replies[1]["error"]["code"], "timed_out")
            self.assertFalse(replies[1]["error"]["dispatched"])
            self.assertIn("attachment preserved", replies[1]["error"]["message"])
            self.assertTrue(replies[2]["result"]["attached"])
        finally:
            process.stdin.close()
            await asyncio.wait_for(process.communicate(), 5)

    async def test_outer_workflow_deadline_preserves_earlier_dispatch_evidence(self):
        class Adapter(worker.Adapter):
            async def guard(self, args, owner, control=False):
                if getattr(self, "acted", False):
                    await asyncio.Event().wait()
                return {"url": "https://example.test/"}

            async def resolve_target(self, target):
                return "observed"

            async def action(self, args):
                self.acted = self.dispatched = True
                return {"verification": "confirmed", "url": "https://example.test/", "evidence": "done"}
        adapter = Adapter()
        step = {"action": "click", "target": {"role": "button", "name": "Save"}, "expected": {"type": "text", "value": "done"}}
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(0.05):
                await adapter.workflow({"leaseId": "lease", "steps": [step, step]}, "owner")
        self.assertTrue(adapter.dispatched)

    async def test_socket_loss_is_not_misclassified_as_stale_reference_or_closed_target(self):
        class Connection:
            async def send(self, command):
                raise ConnectionError("private connection diagnostics")
        class Adapter(worker.Adapter):
            async def frames(self):
                return {"top": {"loader": "load"}}
        adapter = Adapter()
        adapter.conn = Connection()
        adapter.lease = {"target": "selected"}
        adapter.refs = {"ref": {"backend": 7, "epoch": 0, "frame": "top", "loader": "load"}}
        for operation in (lambda: adapter.element("ref"), adapter.current):
            with self.assertRaises(ConnectionError):
                await operation()

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

                async def resolve_target(self, target):
                    return "observed"

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
            self.assertFalse(result["stepDispatched"])
            self.assertEqual(result["url"], "https://example.test/")
            self.assertNotIn("private", json.dumps(result))

    async def test_status_does_not_report_a_dead_attachment_as_connected(self):
        class Adapter(worker.Adapter):
            async def discover_linux(self):
                return {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/id", "Browser": "Chrome/155.0"}
        adapter = Adapter()
        adapter.lease = {"browser": "linux", "identity": "ws://127.0.0.1:9222/devtools/browser/id"}
        result = await adapter.status("linux", {}, "owner")
        self.assertTrue(result["reachable"])
        self.assertFalse(result["attached"])
        self.assertIsNone(adapter.lease)
        self.assertIn("Attachment connection lost", result["currentIssue"])
        recovered = await adapter.status("linux", {}, "owner")
        self.assertTrue(recovered["reachable"])
        self.assertFalse(recovered["attached"])
        self.assertIsNone(recovered["currentIssue"])

    async def test_status_clears_an_endpoint_fault_without_requiring_attachment(self):
        class Adapter(worker.Adapter):
            unavailable = True

            async def discover_linux(self):
                if self.unavailable:
                    worker.reject("unreachable", "Chrome debugging endpoint unavailable")
                return {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/id", "Browser": "Chrome/155.0"}
        adapter = Adapter()
        failed = await adapter.status("linux", {}, "owner")
        self.assertFalse(failed["reachable"])
        self.assertEqual(failed["connectionState"], "unreachable")
        self.assertEqual(failed["currentIssue"], "Chrome debugging endpoint unavailable")
        adapter.unavailable = False
        recovered = await adapter.status("linux", {}, "owner")
        self.assertTrue(recovered["reachable"])
        self.assertFalse(recovered["attached"])
        self.assertIsNone(recovered["currentIssue"])

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
