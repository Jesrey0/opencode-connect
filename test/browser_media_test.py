"""Media transfer boundaries using pinned CDP types and executable browser functions."""
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("browser_media", Path(__file__).resolve().parents[1] / "src/browser/media.py")
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


def remote(value=None, object_id=None):
    return {"result": {"type": "object", **({"objectId": object_id} if object_id else {"value": value})}}


class Connection:
    def __init__(self, payload=b"generated audio", failure=None):
        self.payload = payload
        self.failure = failure
        self.calls = []
        self.reads = 0
        self.current = True
        self.state = {"kind": "audio", "source": "https://example.test/audio?token=secret", "duration": 3.5,
                      "readyState": 4, "paused": True, "ended": False, "error": None, "encrypted": False}

    async def send(self, command):
        request = next(command)
        self.calls.append(request)
        name, params = request["method"], request.get("params", {})
        if name == "Page.createIsolatedWorld":
            result = {"executionContextId": 7}
        elif name == "Runtime.evaluate":
            result = remote(object_id="list")
        elif name == "Runtime.getProperties":
            result = {"result": [{"name": str(index), "configurable": True, "enumerable": True,
                                  "value": {"type": "object", "objectId": "media-" + str(index)}} for index in range(2)]}
        elif name == "DOM.describeNode":
            result = {"node": {"nodeId": 0, "backendNodeId": 101 + int(params["objectId"].rsplit("-", 1)[1]),
                               "nodeType": 1, "nodeName": "AUDIO", "localName": "audio", "nodeValue": ""}}
        elif name == "DOM.resolveNode":
            result = {"object": {"type": "object", "objectId": "node"}}
        elif name == "Runtime.callFunctionOn":
            body = params["functionDeclaration"]
            if body == media._STATE:
                result = remote(self.state)
            elif body == media._TRANSFER:
                result = remote(object_id="transfer")
            elif body == media._OPEN:
                result = remote({"error": self.failure} if self.failure else {"mimeType": "audio/mpeg"})
            elif body == media._READ:
                self.reads += 1
                result = remote({"done": True} if self.reads > 1 else {"done": False, "data": base64.b64encode(self.payload).decode()})
            elif body == media._CANCEL:
                result = remote()
            elif body == media._CURRENT:
                result = remote(self.current)
            else:
                raise AssertionError("Unexpected media function")
        elif name == "Runtime.releaseObjectGroup":
            result = {}
        else:
            raise AssertionError("Unexpected CDP command: " + name)
        try:
            command.send(result)
        except StopIteration as stop:
            return stop.value
        raise AssertionError("CDP command did not finish")


class Adapter:
    def __init__(self, conn=None):
        self.conn = conn or Connection()
        self.epoch = 5
        self.refs = {"m-current": {"backend": 101, "frame": "top", "loader": "load", "epoch": 5, "media": True},
                     "e-existing": {"backend": 999, "frame": "top", "loader": "load", "epoch": 5}}
        self.frame_reads = 0
        self.change_after = None

    async def frames(self):
        self.frame_reads += 1
        return {"top": {"loader": "new" if self.change_after and self.frame_reads >= self.change_after else "load"}}

    def safe_url(self, value):
        return value.split("?", 1)[0].split("#", 1)[0]


class MediaTests(unittest.IsolatedAsyncioTestCase):
    async def test_observes_hidden_players_with_redacted_sources_and_bounded_fresh_references(self):
        adapter = Adapter()
        result = await media.inspect_media(adapter, {"maxItems": 1})
        self.assertEqual(len(result["items"]), 1)
        self.assertTrue(result["truncated"])
        item = result["items"][0]
        self.assertEqual(item["sourceUrl"], "https://example.test/audio")
        self.assertEqual(item["duration"], 3.5)
        self.assertEqual(adapter.refs[item["elementRef"]]["backend"], 101)
        self.assertIn("e-existing", adapter.refs)
        self.assertNotIn("m-current", adapter.refs)
        self.assertNotIn("secret", json.dumps(result))
        self.assertTrue(any(call["method"] == "Runtime.releaseObjectGroup" for call in adapter.conn.calls))
        self.assertFalse(any("getBoundingClientRect" in str(call) for call in adapter.conn.calls))

    async def test_observation_rejects_navigation_without_publishing_references(self):
        adapter = Adapter()
        adapter.change_after = 2
        with self.assertRaises(media.MediaError) as caught:
            await media.inspect_media(adapter, {})
        self.assertEqual(caught.exception.code, "document_changed")
        self.assertEqual(set(adapter.refs), {"m-current", "e-existing"})

    async def test_download_preserves_bytes_hash_and_private_permissions(self):
        adapter = Adapter()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_DATA_HOME": directory}):
            result = await media.download_media(adapter, {"elementRef": "m-current", "maxBytes": len(adapter.conn.payload)})
            path = Path(result["path"])
            self.assertEqual(path.read_bytes(), adapter.conn.payload)
            self.assertEqual(result["bytes"], len(adapter.conn.payload))
            self.assertEqual(result["sha256"], hashlib.sha256(adapter.conn.payload).hexdigest())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(result["mimeType"], "audio/mpeg")
            self.assertNotIn("secret", json.dumps(result))
        calls = adapter.conn.calls
        resolve = next(call for call in calls if call["method"] == "DOM.resolveNode")
        self.assertEqual(resolve["params"]["executionContextId"], 7)
        self.assertTrue(any(call.get("params", {}).get("functionDeclaration") == media._CANCEL for call in calls))
        self.assertTrue(any(call["method"] == "Runtime.releaseObjectGroup" for call in calls))

    async def test_stale_or_nonmedia_reference_rejects_before_node_resolution(self):
        for ref, epoch, loader in (("unknown", 5, "load"), ("e-existing", 5, "load"), ("m-current", 6, "load"), ("m-current", 5, "new")):
            with self.subTest(ref=ref, epoch=epoch, loader=loader):
                adapter = Adapter()
                adapter.epoch = epoch
                adapter.refs["m-current"]["loader"] = loader
                with self.assertRaises(media.MediaError) as caught:
                    await media.download_media(adapter, {"elementRef": ref})
                self.assertEqual(caught.exception.code, "stale_reference")
                self.assertFalse(adapter.conn.calls)

    async def test_overflow_navigation_and_read_failure_remove_partial_artifacts(self):
        for kind in ("overflow", "navigation", "empty", "cancelled", "source_changed"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_DATA_HOME": directory}):
                adapter = Adapter(Connection(payload=b"" if kind == "empty" else b"abcdef"))
                if kind == "navigation":
                    adapter.change_after = 2
                if kind == "source_changed":
                    adapter.conn.current = False
                if kind == "cancelled":
                    original = adapter.conn.send
                    async def cancelled(command):
                        request = next(command)
                        if request.get("params", {}).get("functionDeclaration") == media._READ:
                            raise asyncio.CancelledError()
                        def wrapped():
                            response = yield request
                            try:
                                command.send(response)
                            except StopIteration as stop:
                                return stop.value
                        return await original(wrapped())
                    adapter.conn.send = cancelled
                with self.assertRaises((media.MediaError, asyncio.CancelledError)):
                    await media.download_media(adapter, {"elementRef": "m-current", "maxBytes": 5 if kind == "overflow" else 6})
                self.assertEqual(list(Path(directory).rglob("media-*")), [])
                self.assertTrue(any(call.get("params", {}).get("functionDeclaration") == media._CANCEL for call in adapter.conn.calls))

    async def test_unsupported_encrypted_and_fetch_failures_create_no_files(self):
        for code in ("unsupported_media", "encrypted_media", "media_fetch_failed", "media_too_large"):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_DATA_HOME": directory}):
                adapter = Adapter(Connection(failure=code))
                with self.assertRaises(media.MediaError) as caught:
                    await media.download_media(adapter, {"elementRef": "m-current"})
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(list(Path(directory).rglob("media-*")), [])

    async def test_encrypted_or_missing_source_rejects_before_fetch(self):
        for state, code in (({"encrypted": True}, "encrypted_media"), ({"source": ""}, "unsupported_media"), (None, "stale_reference")):
            with self.subTest(state=state):
                adapter = Adapter()
                if state is None:
                    adapter.conn.state = None
                else:
                    adapter.conn.state.update(state)
                with self.assertRaises(media.MediaError) as caught:
                    await media.download_media(adapter, {"elementRef": "m-current"})
                self.assertEqual(caught.exception.code, code)
                self.assertFalse(any(call.get("params", {}).get("functionDeclaration") == media._OPEN for call in adapter.conn.calls))

    async def test_existing_public_artifact_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_DATA_HOME": directory}):
            target = Path(directory) / "opencode-connect/browser-media"
            target.mkdir(parents=True)
            target.chmod(0o755)
            with self.assertRaises(media.MediaError) as caught:
                await media.download_media(Adapter(), {"elementRef": "m-current"})
            self.assertEqual(caught.exception.code, "artifact_unavailable")
            self.assertEqual(list(target.iterdir()), [])

    async def test_invalid_bounds_reject_before_any_cdp_call(self):
        for func, field, values in ((media.inspect_media, "maxItems", (0, 21, True)), (media.download_media, "maxBytes", (0, media.MAX_BYTES + 1, True))):
            for value in values:
                with self.subTest(field=field, value=value):
                    adapter = Adapter()
                    with self.assertRaises(media.MediaError) as caught:
                        await func(adapter, {"elementRef": "m-current", field: value})
                    self.assertEqual(caught.exception.code, "invalid_arguments")
                    self.assertFalse(adapter.conn.calls)


class BrowserFunctionTests(unittest.TestCase):
    def run_functions(self, fixture):
        node = shutil.which("node")
        if not node:
            self.fail("Node is required by this repository")
        script = """
          import fs from 'node:fs';
          const input=JSON.parse(fs.readFileSync(0,'utf8'));
          const open=eval('('+input.open+')'),read=eval('('+input.read+')'),cancel=eval('('+input.cancel+')');
          const node={isConnected:true,currentSrc:'blob:https://example.test/generated',mediaKeys:null};
          const state={node,source:node.currentSrc,controller:new AbortController(),reader:null,pending:null,offset:0,received:0};
          const parts=input.parts.map(size=>new Uint8Array(size).fill(137));
          let options,cancelled=false;
          globalThis.fetch=async(url,opts)=>{options=opts;return {ok:true,type:'basic',headers:{get:name=>name==='Content-Type'?input.mime:null},body:{getReader:()=>({read:async()=>parts.length?{done:false,value:parts.shift()}:{done:true},cancel:async()=>{cancelled=true}})}}};
          const opened=await open.call(state,input.limit),chunks=[];
          if(!opened.error) for(let i=0;i<20;i++){
            if(input.change && i===1) node.currentSrc='https://example.test/replaced';
            const part=await read.call(state,input.chunk);chunks.push(part);
            if(part.error||part.done) break;
          }
          await cancel.call(state);
          process.stdout.write(JSON.stringify({opened,chunks,cancelled,aborted:state.controller.signal.aborted,mode:options.mode,credentials:options.credentials}));
        """
        result = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps({"open": media._OPEN, "read": media._READ, "cancel": media._CANCEL, "chunk": media.CHUNK_BYTES, **fixture}), text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def test_large_browser_chunks_split_below_ipc_limit_with_exact_contents(self):
        result = self.run_functions({"parts": [media.CHUNK_BYTES * 2 + 3], "limit": media.CHUNK_BYTES * 3, "mime": "audio/mpeg; codec=mp3"})
        chunks = result["chunks"]
        self.assertTrue(chunks[-1]["done"])
        self.assertEqual(b"".join(base64.b64decode(part["data"]) for part in chunks[:-1]), bytes([137]) * (media.CHUNK_BYTES * 2 + 3))
        self.assertTrue(all(len(json.dumps(part)) < 256 * 1024 for part in chunks))
        self.assertEqual(result["mode"], "cors")
        self.assertEqual(result["credentials"], "same-origin")
        self.assertTrue(result["cancelled"])
        self.assertTrue(result["aborted"])

    def test_browser_rejects_cumulative_overflow_and_changed_source(self):
        overflow = self.run_functions({"parts": [4, 4], "limit": 7, "mime": "audio/ogg"})
        self.assertEqual(overflow["chunks"][-1]["error"], "media_too_large")
        changed = self.run_functions({"parts": [4, 4], "limit": 8, "mime": "audio/ogg", "change": True})
        self.assertEqual(changed["chunks"][-1]["error"], "media_changed")

    def test_browser_rejects_nonmedia_mime(self):
        result = self.run_functions({"parts": [4], "limit": 4, "mime": "text/html"})
        self.assertEqual(result["opened"]["error"], "unsupported_media")
        self.assertEqual(result["chunks"], [])


if __name__ == "__main__":
    unittest.main()
