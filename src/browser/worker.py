"""Private Nodriver worker. No Browser object, process owner, or public server."""
import asyncio
import base64
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import time
import urllib.parse
import urllib.request

with contextlib.redirect_stdout(sys.stderr):
    from nodriver import cdp
    from nodriver.core.connection import Connection

MAX_FRAME = 2 * 1024 * 1024
MAX_SCREENSHOT = 1024 * 1024
METHODS = {
    "hello": set(), "status": {"browser"}, "tabs": {"browser", "filter", "maxTabs"},
    "attach": {"browser", "targetId", "controlMode"},
    "snapshot": {"leaseId", "maxNodes", "frameId", "filter"},
    "screenshot": {"leaseId", "width", "height"}, "detach": {"leaseId"},
    "wait": {"leaseId", "condition", "timeoutMs"},
    "action": {"leaseId", "action", "authorized", "expected", "timeoutMs", "elementRef", "value", "key", "url", "files", "deltaY"},
}


class Rejected(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def reject(code, message):
    raise Rejected(code, message)


def safe_url(value):
    try:
        p = urllib.parse.urlsplit(value)
        host = p.hostname or ""
        if ":" in host:
            host = "[" + host + "]"
        netloc = host + (":" + str(p.port) if p.port else "")
        # Query values and fragments can carry passwords, tokens and document IDs.
        return urllib.parse.urlunsplit((p.scheme, netloc, p.path[:2048], "", ""))[:4096]
    except (ValueError, TypeError):
        return "[redacted URL]"


def safe_text(value, limit=200):
    text = str(value or "")
    text = re.sub(r"https?://[^\s<>]+", lambda m: safe_url(m.group()), text)
    text = re.sub(r"(?i)(bearer\s+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*)\S+", r"\1[redacted]", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[redacted]", text)
    return text[:limit]


def endpoint(browser):
    if browser not in ("linux", "windows"):
        reject("invalid_browser", "Select linux or windows")
    value = os.environ.get("OPENCODE_CONNECT_BROWSER_" + browser.upper() + "_ENDPOINT")
    if not value and browser == "linux":
        value = "http://127.0.0.1:9222"
    if not value:
        reject("not_configured", "Optional Windows Chrome endpoint is not configured")
    p = urllib.parse.urlsplit(value)
    if p.scheme != "http" or p.hostname not in ("127.0.0.1", "::1") or not p.port or p.username or p.password or p.query or p.fragment or p.path not in ("", "/"):
        reject("invalid_endpoint", "CDP endpoint must be a configured loopback IP and explicit port")
    return value.rstrip("/")


def fetch_json(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=2) as response:
        raw = response.read(MAX_FRAME + 1)
        if len(raw) > MAX_FRAME:
            reject("too_large", "Chrome discovery exceeds the response limit")
        return json.loads(raw)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        reject("invalid_endpoint", "CDP discovery redirects are forbidden")


def validate_condition(condition):
    if not isinstance(condition, dict):
        reject("invalid_arguments", "Expected condition must be an object")
    kind = condition.get("type")
    fields = {"url": {"type", "value"}, "text": {"type", "value"}, "elementAppears": {"type", "selector", "frameId"}, "elementDisappears": {"type", "selector", "frameId"}, "readyState": {"type", "value"}, "navigation": {"type", "fromUrl"}}
    if kind not in fields or set(condition) - fields[kind]:
        reject("invalid_arguments", "Unsupported expected condition")
    field = "selector" if kind.startswith("element") else "fromUrl" if kind == "navigation" else "value"
    if not isinstance(condition.get(field), str) or not 0 < len(condition[field]) <= 4096:
        reject("invalid_arguments", "Expected condition requires a bounded value")
    if kind == "readyState" and condition[field] not in ("interactive", "complete"):
        reject("invalid_arguments", "Invalid ready state")


class Adapter:
    def __init__(self):
        self.lease = None
        self.conn = None
        self.refs = {}
        self.epoch = 0
        self.dispatched = False

    async def disconnect(self):
        conn, self.conn = self.conn, None
        self.lease = None
        self.refs.clear()
        if conn:
            # Pinned Connection.aclose only closes the websocket/listener. Never
            # instantiate Browser: its destructor/atexit paths own process cleanup.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(conn.aclose(), 2)

    async def discover(self, browser):
        base = endpoint(browser)
        try:
            info = await asyncio.to_thread(fetch_json, base + "/json/version")
            ws = info.get("webSocketDebuggerUrl", "")
            p, b = urllib.parse.urlsplit(ws), urllib.parse.urlsplit(base)
            if not re.match(r"^(Chrome|Chromium)/", info.get("Browser", "")) or p.scheme != "ws" or p.hostname != b.hostname or p.port != b.port or not p.path.startswith("/devtools/browser/") or p.query or p.fragment or p.username or p.password:
                reject("invalid_endpoint", "Endpoint is not a supported loopback Chrome browser")
            return info
        except Rejected:
            raise
        except Exception:
            reject("unreachable", "Chrome debugging endpoint unavailable; inspect browser status or launch Linux Chrome")

    async def targets(self, browser):
        await self.discover(browser)
        try:
            rows = await asyncio.to_thread(fetch_json, endpoint(browser) + "/json/list")
            if not isinstance(rows, list):
                raise ValueError()
            return [row for row in rows if row.get("type") == "page"]
        except Exception:
            reject("unreachable", "Chrome target discovery unavailable")

    def summary(self, row):
        return {"targetId": row["id"], "title": safe_text(row.get("title")), "url": safe_url(row.get("url", "")), "type": "page", "leased": bool(self.lease and row["id"] == self.lease["target"])}

    def invalidate(self, *_):
        self.epoch += 1
        self.refs.clear()

    async def guard(self, args, owner, control=False):
        lease = self.lease
        if not lease or not secrets.compare_digest(str(args.get("leaseId", "")), lease["id"]) or owner != lease["owner"]:
            reject("invalid_lease", "Lease unavailable or owned by another caller; attach explicitly")
        if control and lease["mode"] != "control":
            reject("observe_only", "Observe lease does not permit browser actions")
        try:
            info = await self.discover(lease["browser"])
            if info["webSocketDebuggerUrl"] != lease["identity"] or not self.conn or not self.conn.socket or self.conn.socket.close_code is not None:
                reject("disconnected", "Browser identity or connection changed; attach again")
            row = await self.current()
            if urllib.parse.urlsplit(row.get("url", "")).scheme not in ("http", "https", "about"):
                reject("unsupported_page", "Only web pages and about:blank are supported")
            return row
        except Rejected:
            await self.disconnect()
            raise

    async def frames(self):
        tree = await self.conn.send(cdp.page.get_frame_tree())
        result = {}
        def visit(item):
            result[str(item.frame.id_)] = {"frame": item.frame, "loader": str(item.frame.loader_id)}
            for child in item.child_frames or []:
                visit(child)
        visit(tree)
        return result

    async def evaluate(self, expression):
        obj, error = await self.conn.send(cdp.runtime.evaluate(expression, return_by_value=True, silent=True))
        if error:
            reject("observation_failed", "Page observation unavailable")
        return obj.value

    async def function(self, object_id, body, args=None):
        obj, error = await self.conn.send(cdp.runtime.call_function_on(body, object_id=object_id, arguments=[cdp.runtime.CallArgument(value=value) for value in args or []], return_by_value=True, silent=True))
        if error:
            reject("element_unavailable", "Element operation failed; take a new snapshot")
        return obj.value

    async def element(self, ref):
        data = self.refs.get(ref)
        if not data:
            reject("stale_reference", "Element reference expired; request a new snapshot")
        frames = await self.frames()
        current = frames.get(data["frame"])
        if data["epoch"] != self.epoch or not current or current["loader"] != data["loader"]:
            self.refs.pop(ref, None)
            reject("stale_reference", "Element document or frame changed; request a new snapshot")
        try:
            obj = await self.conn.send(cdp.dom.resolve_node(backend_node_id=cdp.dom.BackendNodeId(data["backend"]), object_group="browser-action"))
            state = await self.function(obj.object_id, "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',enabled:!this.matches(':disabled')&&this.getAttribute('aria-disabled')!=='true',readonly:!!this.readOnly||this.getAttribute('aria-readonly')==='true',password:this.type==='password',tag:this.tagName,type:this.type};}")
            if not state or not state["connected"]:
                reject("stale_reference", "Element removed; request a new snapshot")
            if not state["visible"] or not state["enabled"]:
                reject("not_actionable", "Element is hidden or disabled")
            if state["password"]:
                reject("protected_input", "Password controls are outside the browser tool interface")
            return obj.object_id, state
        except Rejected:
            raise
        except Exception:
            reject("stale_reference", "Element identity lost; request a new snapshot")

    async def snapshot(self, args):
        frames = await self.frames()
        epoch = self.epoch
        selected = args.get("frameId")
        if selected and selected not in frames:
            reject("invalid_frame", "Frame is not part of the selected tab")
        nodes, errors, total, budget = [], [], 0, 0
        limit = args.get("maxNodes", 100)
        # Every snapshot rotates reference IDs; an old ID is never reused.
        self.refs.clear()
        scoped_frames = {selected: frames[selected]} if selected else frames
        for frame_index, (frame_id, frame) in enumerate(scoped_frames.items()):
            if frame_index >= 100:
                errors.append("Frame observation limit reached; request an exact frameId")
                break
            if selected and selected != frame_id:
                continue
            try:
                tree = await self.conn.send(cdp.accessibility.get_full_ax_tree(frame_id=cdp.page.FrameId(frame_id)))
                for node in tree:
                    if node.ignored:
                        continue
                    role = str(node.role.value if node.role else "")
                    name = safe_text(node.name.value if node.name else "")
                    if role in ("none", "generic", "InlineTextBox") or not name and not node.backend_dom_node_id:
                        continue
                    props = {prop.name.value: prop.value.value for prop in node.properties or []}
                    # All AX values are deliberately omitted, including passwords.
                    if args.get("filter") and args["filter"].casefold() not in (role + " " + name).casefold():
                        continue
                    total += 1
                    if len(nodes) >= limit or budget >= 100000:
                        continue
                    item = {"role": role, "name": name, "frameId": frame_id, "states": [key for key in ("disabled", "expanded", "checked", "selected", "required", "focused") if props.get(key) is True or props.get(key) == "true"]}
                    if node.backend_dom_node_id and role not in ("StaticText", "RootWebArea", "Iframe"):
                        ref = "e-" + secrets.token_hex(10)
                        self.refs[ref] = {"backend": int(node.backend_dom_node_id), "frame": frame_id, "loader": frame["loader"], "epoch": epoch}
                        item["ref"] = ref
                    nodes.append(item)
                    budget += len(json.dumps(item, ensure_ascii=True))
            except Exception:
                errors.append("Frame " + frame_id + " accessibility unavailable (possibly an out-of-process frame)")
        after = await self.frames()
        if epoch != self.epoch or {key: val["loader"] for key, val in frames.items()} != {key: val["loader"] for key, val in after.items()}:
            self.invalidate()
            reject("document_changed", "Page changed during observation; request a fresh snapshot")
        row = await self.current()
        summaries, frame_budget = [], 0
        for key, val in frames.items():
            item = {"frameId": key, "url": safe_url(val["frame"].url)}
            cost = len(json.dumps(item, ensure_ascii=True))
            if frame_budget + cost > 40000 or len(summaries) >= 100:
                break
            summaries.append(item)
            frame_budget += cost
        return {"targetId": self.lease["target"], "generation": self.generation(frames), "url": safe_url(row["url"]), "title": safe_text(row.get("title")), "nodes": nodes, "frames": summaries, "truncated": total > len(nodes) or len(frames) > len(summaries), "totalNodes": total, "observationErrors": errors, "untrustedPageContent": True}

    def generation(self, frames):
        return hashlib.sha256((self.lease["id"] + str(self.epoch) + repr([(key, val["loader"]) for key, val in frames.items()])).encode()).hexdigest()[:24]

    async def current(self):
        try:
            info = await self.conn.send(cdp.target.get_target_info(cdp.target.TargetID(self.lease["target"])))
        except Exception:
            reject("target_closed", "Selected tab closed")
        if str(info.target_id) != self.lease["target"] or info.type_ != "page":
            reject("target_closed", "Selected tab identity changed")
        return {"id": str(info.target_id), "url": info.url, "title": info.title, "type": info.type_}

    async def condition(self, condition, navigation_before=None):
        kind = condition["type"]
        row = await self.current()
        if kind == "url":
            return row["url"] == condition["value"]
        if kind == "navigation":
            frames = await self.frames()
            top = next(iter(frames))
            loaders = (top, frames[top]["loader"])
            changed = safe_url(row["url"]) != safe_url(condition["fromUrl"]) or navigation_before is not None and loaders != navigation_before
            return changed and await self.evaluate("document.readyState") == "complete"
        if kind == "readyState":
            state = await self.evaluate("document.readyState")
            return state == condition["value"] or condition["value"] == "interactive" and state == "complete"
        if kind == "text":
            return bool(await self.evaluate("(document.body?.innerText||'').includes(" + json.dumps(condition["value"]) + ")"))
        frames = await self.frames()
        frame_id = condition.get("frameId") or next(iter(frames))
        if frame_id not in frames:
            reject("invalid_frame", "Wait frame is outside the selected tab")
        world = await self.conn.send(cdp.page.create_isolated_world(cdp.page.FrameId(frame_id), world_name="opencode-browser-observe"))
        expression = "(()=>{const e=document.querySelector(" + json.dumps(condition["selector"]) + ");return !!e&&!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';})()"
        obj, error = await self.conn.send(cdp.runtime.evaluate(expression, context_id=world, return_by_value=True, silent=True))
        if error:
            reject("invalid_selector", "Wait selector could not be evaluated")
        return bool(obj.value) if kind == "elementAppears" else not bool(obj.value)

    async def wait(self, condition, navigation_before=None):
        validate_condition(condition)
        if condition["type"] == "navigation" and navigation_before is None:
            frames = await self.frames()
            top = next(iter(frames))
            navigation_before = (top, frames[top]["loader"])
        while True:
            if await self.condition(condition, navigation_before):
                return {"verification": "confirmed", "url": safe_url((await self.current())["url"]), "evidence": "Requested observable condition met"}
            # Deadline-bounded adaptive observation; no action retries.
            await asyncio.sleep(0.1)

    async def action(self, args):
        kind = args["action"]
        navigation_before = None
        if args.get("expected", {}).get("type") == "navigation":
            frames = await self.frames()
            top = next(iter(frames))
            navigation_before = (top, frames[top]["loader"])
        try:
            if kind == "navigate":
                p = urllib.parse.urlsplit(args["url"])
                if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
                    reject("unsafe_url", "Navigation requires HTTP/HTTPS without embedded credentials")
                self.dispatched = True
                if (await self.current())["url"] == args["url"]:
                    await self.conn.send(cdp.page.reload(ignore_cache=False))
                    error = None
                else:
                    _, _, error, *_ = await self.conn.send(cdp.page.navigate(args["url"]))
                self.invalidate()
                if error:
                    return {"dispatched": True, "completed": False, "verification": "failed", "url": safe_url((await self.current())["url"]), "evidence": "Chrome reported navigation failure", "mutationMayHaveOccurred": True}
            else:
                obj, state = await self.element(args["elementRef"])
                if kind == "upload":
                    if state["tag"] != "INPUT" or state["type"] != "file":
                        reject("invalid_upload", "Reference is not a file input")
                    roots = [Path(root).resolve() for root in os.environ.get("OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS", "").split(os.pathsep) if root]
                    files = []
                    for name in args["files"]:
                        file = Path(name)
                        if not file.is_absolute():
                            reject("upload_denied", "Upload paths must be absolute")
                        file = file.resolve(strict=True)
                        if not any(file.is_relative_to(root) for root in roots) or not file.is_file() or any(part.startswith(".") for part in file.parts[1:]) or file.suffix in (".pem", ".key", ".p12", ".pfx"):
                            reject("upload_denied", "File is outside authorized upload roots or is protected")
                        files.append(str(file))
                    self.dispatched = True
                    await self.conn.send(cdp.dom.set_file_input_files(files, object_id=obj))
                else:
                    if kind == "fill" and (state["readonly"] or state["tag"] not in ("INPUT", "TEXTAREA") or state["type"] in ("file", "hidden", "submit", "button", "checkbox", "radio")):
                        reject("invalid_element", "Fill requires an editable text control")
                    if kind == "select" and state["tag"] != "SELECT":
                        reject("invalid_element", "Select requires a native select element")
                    self.dispatched = True
                    if kind == "click":
                        clicked = await self.function(obj, "function(){this.scrollIntoView({block:'center'});const r=this.getBoundingClientRect();const hit=this.ownerDocument.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!hit||!(hit===this||this.contains(hit)))return false;this.click();return true;}")
                        if not clicked:
                            reject("not_actionable", "Element is covered; no click was dispatched")
                    elif kind == "fill":
                        await self.function(obj, "function(value){this.focus();const proto=this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(this,value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}", [args["value"]])
                    elif kind == "select":
                        result = await self.function(obj, "function(value){if(!Array.from(this.options).some(o=>o.value===value&&!o.disabled))return false;this.value=value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;}", [args["value"]])
                        if not result:
                            reject("invalid_option", "Requested select option unavailable")
                    elif kind == "scroll":
                        await self.function(obj, "function(delta){this.scrollBy({top:delta,behavior:'instant'});}", [args["deltaY"]])
                    elif kind == "keypress":
                        await self.function(obj, "function(){this.focus();}")
                        key = args["key"]
                        codes = {"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46, "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40, "Home": 36, "End": 35, "Space": 32}
                        await self.conn.send(cdp.input_.dispatch_key_event("keyDown", key=" " if key == "Space" else key, windows_virtual_key_code=codes[key], text="\r" if key == "Enter" else " " if key == "Space" else None))
                        await self.conn.send(cdp.input_.dispatch_key_event("keyUp", key=key, windows_virtual_key_code=codes[key]))
            if args.get("expected"):
                result = await self.wait(args["expected"], navigation_before)
                return {**result, "dispatched": True, "completed": True, "mutationMayHaveOccurred": True}
            return {"dispatched": True, "completed": True, "verification": "inconclusive", "url": safe_url((await self.current())["url"]), "evidence": "Command completed; application outcome requires an expected condition", "mutationMayHaveOccurred": True}
        finally:
            if self.conn:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.conn.send(cdp.runtime.release_object_group("browser-action")), 1)

    async def run(self, method, args, owner):
        if method == "hello":
            return {"protocol": 1, "nodriver": importlib.metadata.version("nodriver")}
        browser = args.get("browser", "linux")
        if method == "status":
            try:
                info = await self.discover(browser)
                if self.lease and self.lease["browser"] == browser and self.lease["identity"] != info["webSocketDebuggerUrl"]:
                    await self.disconnect()
                return {"browser": browser, "reachable": True, "attached": bool(self.lease and self.lease["browser"] == browser), "version": info["Browser"], "linuxProcesses": [], "lastError": None}
            except Rejected as error:
                if self.lease and self.lease["browser"] == browser:
                    await self.disconnect()
                return {"browser": browser, "reachable": False, "attached": False, "version": None, "linuxProcesses": [], "lastError": error.message}
        if method == "tabs":
            rows = await self.targets(browser)
            summaries, budget, matched = [], 0, 0
            for row in rows:
                item = self.summary(row)
                if args.get("filter") and args["filter"].casefold() not in (item["title"] + " " + item["url"]).casefold():
                    continue
                matched += 1
                cost = len(json.dumps(item, ensure_ascii=True))
                if len(summaries) >= args.get("maxTabs", 50) or budget + cost > 100000:
                    continue
                summaries.append(item)
                budget += cost
            return {"browser": browser, "targets": summaries, "truncated": matched > len(summaries)}
        if method == "attach":
            if self.lease:
                reject("lease_conflict", "An active lease already owns this adapter; detach it before attaching")
            info = await self.discover(browser)
            rows = await self.targets(browser)
            row = next((row for row in rows if row["id"] == args["targetId"]), None)
            if not row:
                reject("target_missing", "Exact page target ID unavailable")
            if row.get("url") != "about:blank" and urllib.parse.urlsplit(row.get("url", "")).scheme not in ("http", "https"):
                reject("unsupported_page", "Attach supports HTTP/HTTPS pages and about:blank")
            self.conn = Connection(target=cdp.target.TargetID(args["targetId"]))
            self.conn.websocket_url = info["webSocketDebuggerUrl"]
            try:
                await self.conn.attach()
                await self.conn.send(cdp.page.enable())
                await self.conn.send(cdp.dom.enable())
                self.conn.add_handler(cdp.dom.DocumentUpdated, self.invalidate)
                self.conn.add_handler(cdp.page.FrameNavigated, self.invalidate)
                self.lease = {"id": secrets.token_urlsafe(32), "owner": owner, "browser": browser, "target": args["targetId"], "identity": info["webSocketDebuggerUrl"], "mode": args["controlMode"]}
                return {"leaseId": self.lease["id"], "browser": browser, "generation": self.generation(await self.frames()), "controlMode": args["controlMode"], "target": self.summary(row), "ownership": "external"}
            except Exception:
                await self.disconnect()
                raise
        await self.guard(args, owner, method == "action")
        if method == "detach":
            await self.disconnect()
            return {"detached": True, "chromePreserved": True}
        if method == "snapshot":
            return await self.snapshot(args)
        if method == "wait":
            return await self.wait(args["condition"])
        if method == "action":
            return await self.action(args)
        if method == "screenshot":
            width, height = args.get("width", 1280), args.get("height", 720)
            data = await self.conn.send(cdp.page.capture_screenshot(format_="jpeg", quality=65, clip=cdp.page.Viewport(x=0, y=0, width=width, height=height, scale=1), capture_beyond_viewport=False))
            size = len(base64.b64decode(data, validate=True))
            if size > MAX_SCREENSHOT:
                reject("screenshot_too_large", "Screenshot exceeds 1 MiB; request smaller dimensions")
            return {"targetId": self.lease["target"], "image": data, "mimeType": "image/jpeg", "bytes": size, "width": width, "height": height}
        reject("invalid_operation", "Unknown browser operation")


def validate(method, args):
    if method not in METHODS or not isinstance(args, dict) or set(args) - METHODS[method]:
        reject("invalid_arguments", "Unknown browser operation or argument")
    if "browser" in args:
        endpoint(args["browser"])
    for field, minimum, maximum in (("maxNodes", 1, 300), ("maxTabs", 1, 100), ("width", 100, 1920), ("height", 100, 1080), ("timeoutMs", 100, 30000)):
        if field in args and (type(args[field]) is not int or not minimum <= args[field] <= maximum):
            reject("invalid_arguments", "Invalid browser argument bound")
    if "filter" in args and (not isinstance(args["filter"], str) or len(args["filter"]) > 200):
        reject("invalid_arguments", "Invalid observation filter")
    for field in ("leaseId", "targetId", "elementRef", "frameId"):
        if field in args and (not isinstance(args[field], str) or not 0 < len(args[field]) <= 256):
            reject("invalid_arguments", "Invalid browser identity")
    required = {"attach": ("targetId", "controlMode"), "snapshot": ("leaseId",), "detach": ("leaseId",), "wait": ("leaseId", "condition"), "screenshot": ("leaseId",), "action": ("leaseId", "action", "authorized")}
    if any(field not in args for field in required.get(method, ())):
        reject("invalid_arguments", "Missing required browser argument")
    if method == "attach" and args["controlMode"] not in ("observe", "control"):
        reject("invalid_arguments", "Invalid browser control mode")
    if method == "wait":
        validate_condition(args["condition"])
    if method == "action":
        kind = args["action"]
        variants = {"navigate": {"url"}, "click": {"elementRef"}, "fill": {"elementRef", "value"}, "select": {"elementRef", "value"}, "upload": {"elementRef", "files"}, "keypress": {"elementRef", "key"}, "scroll": {"elementRef", "deltaY"}}
        common = {"leaseId", "action", "authorized", "expected", "timeoutMs"}
        if args["authorized"] is not True or kind not in variants or set(args) - common - variants[kind] or variants[kind] - set(args):
            reject("invalid_arguments", "Invalid or unauthorized browser action")
        for field in ("value", "url", "key"):
            if field in args and (not isinstance(args[field], str) or len(args[field]) > 12000):
                reject("invalid_arguments", "Invalid action value")
        if kind == "upload" and (not isinstance(args["files"], list) or not 1 <= len(args["files"]) <= 10 or any(not isinstance(file, str) or len(file) > 4096 for file in args["files"])):
            reject("invalid_arguments", "Invalid upload files")
        if kind == "scroll" and (type(args["deltaY"]) is not int or abs(args["deltaY"]) > 10000):
            reject("invalid_arguments", "Invalid scroll amount")
        if kind == "keypress" and args["key"] not in ("Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Space"):
            reject("invalid_arguments", "Unsupported key")
        if "expected" in args:
            validate_condition(args["expected"])


async def main():
    adapter, lock, tasks = Adapter(), asyncio.Lock(), set()
    async def respond(request):
        request_id = request.get("id", "invalid")
        async with lock:
            adapter.dispatched = False
            try:
                if set(request) != {"version", "id", "method", "params", "owner", "deadline"} or request.get("version") != 1 or not isinstance(request_id, str) or len(request_id) > 256 or not isinstance(request.get("owner"), str) or not 0 < len(request["owner"]) <= 256:
                    reject("invalid_protocol", "Invalid browser protocol envelope")
                method, args = request.get("method"), request.get("params")
                validate(method, args)
                deadline = request.get("deadline")
                if type(deadline) not in (int, float):
                    reject("invalid_protocol", "Browser deadline required")
                remaining = min(30, deadline / 1000 - time.time())
                if remaining <= 0:
                    raise TimeoutError()
                async with asyncio.timeout(remaining):
                    result = await adapter.run(method, args, request["owner"])
                reply = {"id": request_id, "ok": True, "result": result}
            except Rejected as error:
                reply = {"id": request_id, "ok": False, "error": {"code": error.code, "message": error.message, "dispatched": adapter.dispatched, "verification": "inconclusive" if adapter.dispatched else "rejected"}}
            except TimeoutError:
                dispatched = adapter.dispatched
                await adapter.disconnect()
                reply = {"id": request_id, "ok": False, "error": {"code": "timed_out", "message": "Browser deadline reached; leases invalidated; inspect before retrying", "dispatched": dispatched, "verification": "timed_out"}}
            except asyncio.CancelledError:
                raise
            except Exception:
                dispatched = adapter.dispatched
                await adapter.disconnect()
                reply = {"id": request_id, "ok": False, "error": {"code": "browser_error", "message": "Browser operation failed; connection released; attach again", "dispatched": dispatched, "verification": "inconclusive" if dispatched else "failed"}}
            wire = json.dumps(reply, separators=(",", ":"), ensure_ascii=True)
            if len(wire) > MAX_FRAME:
                wire = json.dumps({"id": request_id, "ok": False, "error": {"code": "too_large", "message": "Browser response exceeds IPC limit"}})
            sys.stdout.write(wire + "\n")
            sys.stdout.flush()
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_FRAME + 1)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    try:
        while True:
            try:
                line = await reader.readline()
            except ValueError:
                break
            if not line:
                break
            if len(line) > MAX_FRAME or not line.endswith(b"\n") or len(tasks) >= 16:
                break
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    break
            except (ValueError, UnicodeError):
                break
            pending = asyncio.create_task(respond(request))
            tasks.add(pending)
            pending.add_done_callback(tasks.discard)
    finally:
        for pending in tasks:
            pending.cancel()
        await adapter.disconnect()
        await asyncio.gather(*tasks, return_exceptions=True)
        transport.close()


if __name__ == "__main__":
    with contextlib.suppress(asyncio.CancelledError, KeyboardInterrupt):
        asyncio.run(main())
