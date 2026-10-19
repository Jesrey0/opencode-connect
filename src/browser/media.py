"""Bounded observation and retrieval of the selected page's media elements."""
import asyncio
import base64
import contextlib
import hashlib
import math
import os
from pathlib import Path
import secrets
import stat
import tempfile

from nodriver import cdp

MAX_BYTES = 32 * 1024 * 1024
# Base64 plus its JSON envelope remain below 256 KiB per CDP response.
CHUNK_BYTES = 128 * 1024


class MediaError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def fail(code, message):
    raise MediaError(code, message)


async def _result(adapter, command):
    result, error = await adapter.conn.send(command)
    if error:
        fail("media_unavailable", "Media operation failed; inspect the page again")
    return result


async def _call(adapter, object_id, body, values=(), remote=False):
    result = await _result(adapter, cdp.runtime.call_function_on(
        body, object_id=object_id,
        arguments=[cdp.runtime.CallArgument(value=value) for value in values],
        return_by_value=not remote, await_promise=True, silent=True))
    if remote:
        if not result.object_id:
            fail("media_unavailable", "Media object is unavailable")
        return result.object_id
    return result.value


async def _release(adapter, group):
    with contextlib.suppress(Exception):
        await asyncio.wait_for(adapter.conn.send(cdp.runtime.release_object_group(group)), 1)


def _same_documents(before, after):
    return {key: value["loader"] for key, value in before.items()} == {key: value["loader"] for key, value in after.items()}


_STATE = """function(){
  if (!(this instanceof HTMLMediaElement) || !this.isConnected) return null;
  return {kind:this.tagName.toLowerCase(),source:this.currentSrc||'',
    duration:Number.isFinite(this.duration)?this.duration:null,
    readyState:this.readyState,paused:this.paused,ended:this.ended,
    error:this.error?this.error.code:null,encrypted:!!this.mediaKeys};
}"""


async def inspect_media(adapter, args):
    limit = args.get("maxItems", 10)
    if type(limit) is not int or not 1 <= limit <= 20:
        fail("invalid_arguments", "Media maxItems must be between 1 and 20")
    frames = await adapter.frames()
    epoch = adapter.epoch
    group = "browser-media-inspect-" + secrets.token_hex(10)
    items, refs, truncated = [], {}, False
    try:
        for frame_index, (frame_id, frame) in enumerate(frames.items()):
            if frame_index >= 100 or len(items) >= limit:
                truncated = True
                break
            try:
                world = await adapter.conn.send(cdp.page.create_isolated_world(
                    cdp.page.FrameId(frame_id), world_name="opencode-browser-media"))
                remaining = limit - len(items)
                result = await _result(adapter, cdp.runtime.evaluate(
                    "Array.prototype.slice.call(document.querySelectorAll('audio,video'),0," + str(remaining + 1) + ")",
                    context_id=world, object_group=group, return_by_value=False, silent=True))
                if not result.object_id:
                    fail("media_unavailable", "Media observation unavailable")
                props, _, _, error = await adapter.conn.send(cdp.runtime.get_properties(result.object_id, own_properties=True))
                if error:
                    fail("media_unavailable", "Media observation unavailable")
                nodes = [prop.value for prop in props if prop.name.isdigit() and prop.value and prop.value.object_id]
                truncated = truncated or len(nodes) > remaining
                for node in nodes[:remaining]:
                    state = await _call(adapter, node.object_id, _STATE)
                    if not state:
                        continue
                    description = await adapter.conn.send(cdp.dom.describe_node(object_id=node.object_id, depth=0))
                    ref = "m-" + secrets.token_hex(10)
                    refs[ref] = {"backend": int(description.backend_node_id), "frame": frame_id,
                                 "loader": frame["loader"], "epoch": epoch, "media": True}
                    duration = state.get("duration")
                    items.append({"elementRef": ref, "kind": state["kind"],
                                  "sourceUrl": adapter.safe_url(state["source"]) if state["source"] else None,
                                  "duration": duration if type(duration) in (int, float) and math.isfinite(duration) else None,
                                  "readyState": state["readyState"], "paused": state["paused"],
                                  "ended": state["ended"], "error": state["error"]})
            except MediaError:
                truncated = True
            except Exception:
                # Out-of-process or inaccessible frames do not grant a broader target.
                truncated = True
        after = await adapter.frames()
        if epoch != adapter.epoch or not _same_documents(frames, after):
            fail("document_changed", "Page changed during media observation; inspect again")
        # Replace only media observations; ordinary action references stay intact.
        adapter.refs = {ref: data for ref, data in adapter.refs.items() if not data.get("media")}
        adapter.refs.update(refs)
        return {"items": items, "truncated": truncated, "untrustedPageContent": True}
    finally:
        await _release(adapter, group)


_TRANSFER = """function(){
  return {node:this,source:this.currentSrc,controller:new AbortController(),
    reader:null,pending:null,offset:0,received:0,limit:0};
}"""

_OPEN = r"""async function(limit){
  this.limit=limit;
  if (!this.node.isConnected || this.node.currentSrc!==this.source)
    return {error:'media_changed'};
  if (this.node.mediaKeys) return {error:'encrypted_media'};
  let url;
  try { url=new URL(this.source); } catch(e) { return {error:'unsupported_media'}; }
  if (!['blob:','http:','https:'].includes(url.protocol) || url.username || url.password)
    return {error:'unsupported_media'};
  let response;
  try { response=await fetch(this.source,{mode:'cors',credentials:'same-origin',signal:this.controller.signal}); }
  catch(e) { return {error:'media_fetch_failed'}; }
  if (!this.node.isConnected || this.node.currentSrc!==this.source) return {error:'media_changed'};
  if (this.node.mediaKeys) return {error:'encrypted_media'};
  if (!response.ok || !response.body || response.type==='opaque') return {error:'media_fetch_failed'};
  const mime=(response.headers.get('Content-Type')||'').split(';',1)[0].trim().toLowerCase();
  if (!/^(audio|video)\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return {error:'unsupported_media'};
  const length=response.headers.get('Content-Length');
  if (length && /^\d+$/.test(length) && Number(length)>limit) return {error:'media_too_large'};
  this.reader=response.body.getReader();
  return {mimeType:mime};
}"""

_READ = """async function(size){
  if (!this.node.isConnected || this.node.currentSrc!==this.source) return {error:'media_changed'};
  if (this.node.mediaKeys) return {error:'encrypted_media'};
  if (!this.pending) {
    let part;
    try { part=await this.reader.read(); } catch(e) { return {error:'media_fetch_failed'}; }
    if (!this.node.isConnected || this.node.currentSrc!==this.source) return {error:'media_changed'};
    if (this.node.mediaKeys) return {error:'encrypted_media'};
    if (part.done) return {done:true};
    this.received+=part.value.byteLength;
    if (this.received>this.limit) { this.controller.abort(); return {error:'media_too_large'}; }
    this.pending=part.value; this.offset=0;
  }
  const bytes=this.pending.subarray(this.offset,this.offset+size);
  this.offset+=bytes.byteLength;
  if (this.offset>=this.pending.byteLength) this.pending=null;
  let binary='';
  for(let at=0;at<bytes.byteLength;at+=8192) binary+=String.fromCharCode(...bytes.subarray(at,at+8192));
  return {done:false,data:btoa(binary)};
}"""

_CANCEL = """async function(){
  this.controller.abort();
  if(this.reader) { try { await this.reader.cancel(); } catch(e) {} }
  this.pending=null;
}"""

_CURRENT = """function(){return this.node.isConnected && this.node.currentSrc===this.source && !this.node.mediaKeys;}"""


def _check_transfer(value):
    if not isinstance(value, dict):
        fail("media_unavailable", "Media response is unavailable")
    code = value.get("error")
    if code:
        messages = {
            "media_changed": "Media source changed; inspect the page again",
            "encrypted_media": "Encrypted media cannot be retrieved",
            "unsupported_media": "Media must expose an audio/video HTTP or Blob resource",
            "media_fetch_failed": "Media retrieval failed; CORS, MediaSource or the site may prevent access",
            "media_too_large": "Media exceeds the requested byte limit",
        }
        fail(code if code in messages else "media_unavailable", messages.get(code, "Media response is unavailable"))


def _artifact(mime):
    root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "opencode-connect/browser-media"
    if not root.is_absolute():
        fail("artifact_unavailable", "Media artifact directory requires an absolute data path")
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        fail("artifact_unavailable", "Media artifact directory must be private to the current user")
    extensions = {"audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm", "video/mp4": ".mp4", "video/webm": ".webm"}
    descriptor, name = tempfile.mkstemp(prefix="media-", suffix=extensions.get(mime, ".bin"), dir=root)
    return os.fdopen(descriptor, "wb"), Path(name)


async def download_media(adapter, args):
    limit = args.get("maxBytes", MAX_BYTES)
    if type(limit) is not int or not 1 <= limit <= MAX_BYTES:
        fail("invalid_arguments", "Media maxBytes must be between 1 and 33554432")
    data = adapter.refs.get(args.get("elementRef"))
    if not data or not data.get("media"):
        fail("stale_reference", "Media reference expired; inspect media again")
    frames = await adapter.frames()
    current = frames.get(data["frame"])
    if data["epoch"] != adapter.epoch or not current or current["loader"] != data["loader"]:
        fail("stale_reference", "Media document changed; inspect media again")
    group = "browser-media-transfer-" + secrets.token_hex(10)
    transfer, path, complete = None, None, False
    try:
        world = await adapter.conn.send(cdp.page.create_isolated_world(cdp.page.FrameId(data["frame"]), world_name="opencode-browser-media"))
        obj = await adapter.conn.send(cdp.dom.resolve_node(backend_node_id=cdp.dom.BackendNodeId(data["backend"]), object_group=group, execution_context_id=world))
        state = await _call(adapter, obj.object_id, _STATE)
        if not state:
            fail("stale_reference", "Media node was removed; inspect media again")
        if state.get("encrypted"):
            fail("encrypted_media", "Encrypted media cannot be retrieved")
        if not state.get("source"):
            fail("unsupported_media", "Media has no current source")
        transfer = await _call(adapter, obj.object_id, _TRANSFER, remote=True)
        opened = await _call(adapter, transfer, _OPEN, [limit])
        _check_transfer(opened)
        mime = opened.get("mimeType", "")
        if not isinstance(mime, str) or len(mime) > 200 or not mime.startswith(("audio/", "video/")):
            fail("unsupported_media", "Resource is not an audio/video type")
        writer, path = _artifact(mime)
        total, digest = 0, hashlib.sha256()
        with writer:
            while True:
                chunk = await _call(adapter, transfer, _READ, [CHUNK_BYTES])
                _check_transfer(chunk)
                if chunk.get("done") is True:
                    break
                encoded = chunk.get("data")
                if not isinstance(encoded, str) or len(encoded) > 4 * ((CHUNK_BYTES + 2) // 3):
                    fail("media_unavailable", "Media chunk exceeds the transfer bound")
                try:
                    raw = base64.b64decode(encoded, validate=True)
                except ValueError:
                    fail("media_unavailable", "Media chunk is invalid")
                total += len(raw)
                if total > limit:
                    fail("media_too_large", "Media exceeds the requested byte limit")
                writer.write(raw)
                digest.update(raw)
        if not total:
            fail("media_unavailable", "Media resource was empty")
        after = await adapter.frames()
        if data["epoch"] != adapter.epoch or not _same_documents(frames, after):
            fail("media_changed", "Page changed during retrieval; inspect media again")
        if not await _call(adapter, transfer, _CURRENT):
            fail("media_changed", "Media source changed during retrieval; inspect media again")
        complete = True
        return {"path": str(path), "mimeType": mime, "bytes": total, "sha256": digest.hexdigest(), "untrustedPageContent": True}
    finally:
        if path and not complete:
            path.unlink(missing_ok=True)
        if transfer:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(_call(adapter, transfer, _CANCEL), 1)
        await _release(adapter, group)
