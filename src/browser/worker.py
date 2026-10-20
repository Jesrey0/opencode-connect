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
from websockets.asyncio.client import connect as WebSocketConnect
from websockets.exceptions import InvalidStatus, ConnectionClosed
from websockets.protocol import State
sys.path.insert(0, str(Path(__file__).resolve().parent))

with contextlib.redirect_stdout(sys.stderr):
    from nodriver import cdp
    from nodriver.core.connection import Connection, ProtocolException
    from media import MediaError, inspect_media, download_media

MAX_FRAME = 2 * 1024 * 1024
# Chrome AX messages can include many layout nodes for a 64k multiline editor.
# Keep this internal transport separate from the smaller public IPC/result caps.
MAX_CDP_FRAME = 16 * 1024 * 1024
MAX_SCREENSHOT = 1024 * 1024
MAX_TEXT = 64000  # Match Zod/JSON Schema: Unicode code points.
MAX_SEQUENTIAL = 2000
METHODS = {
    "hello": set(), "status": {"browser", "connectionId"}, "tabs": {"browser", "connectionId", "filter", "maxTabs"},
    "connect": {"browser", "authorized", "timeoutMs"},
    "attach": {"browser", "connectionId", "targetId", "controlMode"},
    "snapshot": {"leaseId", "maxNodes", "frameId", "scopeRef", "filter"},
    "screenshot": {"leaseId", "width", "height"}, "detach": {"leaseId", "connectionId"},
    "wait": {"leaseId", "condition", "timeoutMs"},
    "workflow": {"leaseId", "authorized", "steps", "timeoutMs"},
    "media": {"leaseId", "maxItems"},
    "media_download": {"leaseId", "elementRef", "authorized", "maxBytes", "timeoutMs"},
    "action": {"leaseId", "action", "authorized", "expected", "timeoutMs", "elementRef", "sourceRef", "targetRef", "value", "inputMode", "keyDelayMs", "key", "modifiers", "url", "files", "deltaX", "deltaY"},
}


class Rejected(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def reject(code, message):
    raise Rejected(code, message)


def operation_error(error):
    # Classify only known infrastructure failures. Never expose CDP exception
    # text: it can contain URLs, page content or submitted values.
    if isinstance(error, (ConnectionClosed, ConnectionError, OSError)):
        return "disconnected", "Chrome connection lost; attach and inspect before continuing", "browser"
    if isinstance(error, ProtocolException):
        return "cdp_error", "Chrome rejected a protocol operation; inspect the target before continuing", "input"
    return "browser_error", "Browser operation failed; connection released; attach and inspect before continuing", "browser"


def ax_identity(node):
    return hashlib.sha256(json.dumps([node.role.value if node.role else "", node.name.value if node.name else ""], ensure_ascii=True).encode()).hexdigest()


def ax_ancestors(node, by_id):
    ancestors, seen = [], set()
    while node.parent_id and str(node.parent_id) not in seen:
        seen.add(str(node.parent_id))
        node = by_id.get(str(node.parent_id))
        if node is None:
            break
        ancestors.append(node)
    return ancestors


def validate_target(target):
    if not isinstance(target, dict) or set(target) - {"role", "name", "frameId", "within"} or any(not isinstance(target.get(key), str) or not 0 < len(target[key]) <= bound for key, bound in (("role", 100), ("name", 200))):
        reject("invalid_arguments", "Target requires a bounded exact role/name")
    if "frameId" in target and (not isinstance(target["frameId"], str) or not 0 < len(target["frameId"]) <= 256):
        reject("invalid_arguments", "Invalid target frame")
    if "within" in target:
        scope = target["within"]
        if not isinstance(scope, dict) or set(scope) != {"role", "name"}:
            reject("invalid_arguments", "Target within requires an exact ancestor role/name")
        validate_target(scope)


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
    directory = os.environ.get("OPENCODE_CONNECT_BROWSER_WINDOWS_USER_DATA_DIR") if browser == "windows" else None
    if directory:
        if value or not Path(directory).is_absolute():
            reject("invalid_endpoint", "Configure one Windows endpoint or an absolute Chrome user data directory")
        try:
            with (Path(directory) / "DevToolsActivePort").open() as file:
                raw = file.read(4097)
            lines = raw.splitlines()
            if len(raw) > 4096 or len(lines) != 2 or not lines[0].isdigit() or not 0 < int(lines[0]) < 65536:
                raise ValueError()
            value = "ws://127.0.0.1:" + lines[0] + lines[1]
        except OSError:
            reject("not_configured", "Chrome debugging metadata unavailable; enable remote debugging in the selected Windows profile")
        except ValueError:
            reject("invalid_endpoint", "Chrome debugging metadata is invalid")
    if not value and browser == "linux":
        value = "http://127.0.0.1:9222"
    if not value:
        reject("not_configured", "Optional Windows Chrome endpoint is not configured")
    try:
        p = urllib.parse.urlsplit(value)
        path_ok = p.path in ("", "/") if p.scheme == "http" else browser == "windows" and bool(re.fullmatch(r"/devtools/browser(?:/[A-Za-z0-9-]*)?", p.path))
        if p.scheme not in ("http", "ws") or p.hostname not in ("127.0.0.1", "::1") or not p.port or p.username or p.password or p.query or p.fragment or not path_ok:
            raise ValueError()
    except ValueError:
        reject("invalid_endpoint", "CDP endpoint must be configured loopback HTTP or a Windows browser WebSocket without credentials")
    return value.rstrip("/") if p.scheme == "http" else value


def connected(conn):
    return bool(conn and conn.socket and conn.socket.state == State.OPEN)


def same_token(candidate, token):
    # Generated capabilities are ASCII. Malformed caller input must reject
    # without raising into the connection-cleanup exception path.
    return isinstance(candidate, str) and candidate.isascii() and secrets.compare_digest(candidate, token)


class BrowserConnection(Connection):
    async def aopen(self):
        # Only explicit connect/attach may open a socket. Nodriver send must
        # never silently request consent or reconnect an expired lease.
        if not connected(self):
            reject("disconnected", "Chrome connection expired; connect or attach again")


class NoRedirectConnect(WebSocketConnect):
    def process_redirect(self, error):
        # Validate before any outbound connection, including redirects. The
        # configured loopback endpoint is the only permitted destination.
        return error


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
    fields = {"url": {"type", "value"}, "text": {"type", "value"}, "elementAppears": {"type", "selector", "frameId"}, "elementDisappears": {"type", "selector", "frameId"}, "mediaReady": {"type", "selector", "frameId"}, "readyState": {"type", "value"}, "navigation": {"type", "fromUrl"}, "element": {"type", "target", "value", "state"}}
    if kind not in fields or set(condition) - fields[kind]:
        reject("invalid_arguments", "Unsupported expected condition")
    if kind == "element":
        validate_target(condition.get("target"))
        if "value" in condition and (not isinstance(condition["value"], str) or len(condition["value"]) > MAX_TEXT):
            reject("invalid_arguments", "Element value limit is 64000 Unicode characters")
        if "state" in condition and condition["state"] not in ("enabled", "disabled", "focused", "checked", "unchecked", "expanded", "collapsed", "selected", "editable"):
            reject("invalid_arguments", "Unsupported element state")
        return
    field = "selector" if kind.startswith("element") or kind == "mediaReady" else "fromUrl" if kind == "navigation" else "value"
    if not isinstance(condition.get(field), str) or not 0 < len(condition[field]) <= 4096:
        reject("invalid_arguments", "Expected condition requires a bounded value")
    if kind == "readyState" and condition[field] not in ("interactive", "complete"):
        reject("invalid_arguments", "Invalid ready state")


def upload_files(names, browser):
    roots = []
    for name in os.environ.get("OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS", "").split(os.pathsep):
        if name:
            if not Path(name).is_absolute():
                reject("upload_denied", "Upload roots must be absolute")
            roots.append(Path(name).resolve())
    files = []
    for name in names:
        file = Path(name)
        try:
            if not file.is_absolute():
                raise ValueError()
            file = file.resolve(strict=True)
            if not any(file.is_relative_to(root) for root in roots) or not file.is_file() or any(part.startswith(".") for part in file.parts[1:]) or file.suffix.lower() in (".pem", ".key", ".p12", ".pfx"):
                raise ValueError()
        except (OSError, ValueError, RuntimeError):
            reject("upload_denied", "File is unavailable, outside authorized upload roots, or protected")
        if browser == "windows":
            # CDP opens paths on Chrome's host, not on the connector host.
            match = re.fullmatch(r"/mnt/([a-zA-Z])/(.+)", str(file))
            if not match:
                reject("upload_denied", "Windows Chrome requires an authorized file on a mounted Windows drive")
            files.append(match[1].upper() + ":\\" + match[2].replace("/", "\\"))
        else:
            files.append(str(file))
    return files


class Adapter:
    safe_url = staticmethod(safe_url)

    def __init__(self):
        self.lease = None
        self.conn = None
        self.refs = {}
        self.epoch = 0
        self.dispatched = False
        self.approval = None
        self.deadline = float("inf")

    async def disconnect(self):
        conn, self.conn = self.conn, None
        self.approval = None
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
        except urllib.error.HTTPError as error:
            if browser == "windows" and error.code == 404:
                reject("unsupported_discovery", "Chrome permission mode omits HTTP discovery; configure its browser WebSocket or user data directory")
            reject("unreachable", "Chrome HTTP debugging endpoint is unavailable")
        except Exception:
            reject("unreachable", "Chrome debugging endpoint unavailable; inspect the selected browser connection")

    async def approved(self, args, owner, browser=None, check=True):
        approval = self.approval
        if not approval:
            reject("approval_required", "Call browser.connect explicitly before Windows tab discovery")
        if not same_token(args.get("connectionId"), approval["id"]) or owner != approval["owner"] or (browser and browser != approval["browser"]):
            reject("invalid_connection", "Connection unavailable or owned by another caller")
        if check:
            try:
                valid = connected(self.conn) and endpoint(approval["browser"]) == approval["endpoint"]
            except Rejected:
                valid = False
            if not valid:
                await self.disconnect()
                reject("disconnected", "Approved Chrome connection changed; connect and attach again")
        return approval

    async def open_socket(self, url, timeout):
        conn = BrowserConnection()
        conn.websocket_url = url
        self.conn = conn
        conn.socket = await NoRedirectConnect(url, open_timeout=timeout, proxy=None, max_size=MAX_CDP_FRAME, ping_timeout=20)
        # Reuse the pinned Nodriver listener/transactions with our bounded,
        # non-redirecting socket. Its normal aopen also reconnects implicitly.
        conn._listener_task = asyncio.create_task(conn._listener())
        return conn

    async def connect(self, args, owner):
        if self.approval and not connected(self.conn):
            await self.disconnect()
        if self.lease or self.approval:
            reject("lease_conflict", "Release the active browser lease or connection before connecting")
        url = endpoint(args["browser"])
        if urllib.parse.urlsplit(url).scheme != "ws":
            reject("approval_unavailable", "Explicit connect requires a configured Windows permission-mode browser WebSocket")
        try:
            conn = await self.open_socket(url, args.get("timeoutMs", 60000) / 1000)
            version = await conn.send(cdp.browser.get_version(), _attach=True)
            product = str(version[1])
            if not re.fullmatch(r"(?:Chrome|Chromium)/[0-9.]+", product):
                reject("invalid_endpoint", "Endpoint is not a supported Chrome browser")
            self.approval = {"id": secrets.token_urlsafe(32), "owner": owner, "browser": args["browser"], "endpoint": url, "version": product}
            return {"browser": args["browser"], "connectionId": self.approval["id"], "version": product}
        except InvalidStatus as error:
            await self.disconnect()
            reject("approval_denied" if error.response.status_code == 403 else "connection_failed", "Chrome rejected the connection; verify the browser approval dialog and selected profile")
        except TimeoutError:
            await self.disconnect()
            reject("approval_timeout", "Chrome approval timed out; request a new explicit connection")
        except BaseException:
            await self.disconnect()
            raise

    async def status(self, browser, args, owner):
        base = {"browser": browser, "attached": False, "version": None, "linuxProcesses": [], "lastError": None}
        try:
            url = endpoint(browser)
            if urllib.parse.urlsplit(url).scheme == "ws":
                if self.approval and self.approval["browser"] == browser and (not connected(self.conn) or self.approval["endpoint"] != url):
                    await self.disconnect()
                if self.approval and owner == self.approval["owner"] and same_token(args.get("connectionId"), self.approval["id"]):
                    return {**base, "reachable": True, "attached": bool(self.lease), "version": self.approval["version"], "connectionState": "connected"}
                parsed = urllib.parse.urlsplit(url)
                try:
                    _, writer = await asyncio.wait_for(asyncio.open_connection(parsed.hostname, parsed.port), 2)
                    writer.close()
                    await asyncio.wait_for(writer.wait_closed(), 1)
                except (OSError, TimeoutError):
                    reject("unreachable", "Windows Chrome loopback endpoint is unavailable")
                return {**base, "reachable": True, "connectionState": "approval_required", "lastError": "Explicit browser.connect approval is required before tab discovery"}
            info = await self.discover(browser)
            if self.lease and self.lease["browser"] == browser and (self.lease["identity"] != info["webSocketDebuggerUrl"] or not connected(self.conn)):
                await self.disconnect()
                base["lastError"] = "Attachment connection lost; attach explicitly. Endpoint readiness does not verify the MCP action path."
            return {**base, "reachable": True, "attached": bool(self.lease and self.lease["browser"] == browser), "version": info["Browser"], "connectionState": "ready"}
        except Rejected as error:
            if (self.lease and self.lease["browser"] == browser) or (self.approval and self.approval["browser"] == browser):
                await self.disconnect()
            return {**base, "reachable": False, "connectionState": "not_configured" if error.code == "not_configured" else "unreachable", "lastError": error.message}

    async def targets(self, browser, args=None, owner=None):
        if urllib.parse.urlsplit(endpoint(browser)).scheme == "ws":
            await self.approved(args or {}, owner, browser)
            targets = await self.conn.send(cdp.target.get_targets(), _attach=True)
            return [{"id": str(row.target_id), "type": row.type_, "title": row.title, "url": row.url} for row in targets if row.type_ == "page"]
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
        if not lease or not same_token(args.get("leaseId"), lease["id"]) or owner != lease["owner"]:
            reject("invalid_lease", "Lease unavailable or owned by another caller; attach explicitly")
        if control and lease["mode"] != "control":
            reject("observe_only", "Observe lease does not permit browser actions")
        try:
            if self.approval:
                approval = await self.approved({"connectionId": lease["connection"]}, owner, lease["browser"])
                if approval["id"] != lease["identity"]:
                    reject("disconnected", "Browser connection changed; attach again")
            else:
                info = await self.discover(lease["browser"])
                if info["webSocketDebuggerUrl"] != lease["identity"] or not connected(self.conn):
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

    async def release_objects(self):
        if self.conn:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.conn.send(cdp.runtime.release_object_group("browser-action")), 1)

    async def ancestry(self, backend):
        # This native query requires AX enabled. Keep subscriptions scoped to
        # observation so text edits do not stream unbounded AX update events.
        await self.conn.send(cdp.accessibility.enable())
        try:
            return await self.conn.send(cdp.accessibility.get_ax_node_and_ancestors(backend_node_id=cdp.dom.BackendNodeId(backend)))
        finally:
            await self.conn.send(cdp.accessibility.disable())

    async def element(self, ref, actionable=True):
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
            if "identity" in data:
                tree = await self.ancestry(data["backend"])
                node = next((node for node in tree if node.backend_dom_node_id == data["backend"]), None)
                by_id = {str(node.node_id): node for node in tree}
                ancestors = [(int(parent.backend_dom_node_id), ax_identity(parent)) for parent in ax_ancestors(node, by_id) if parent.backend_dom_node_id and parent.name and parent.name.value and parent.role and parent.role.value not in ("RootWebArea", "WebArea")] if node else []
                if not node or ax_identity(node) != data["identity"] or ancestors != data["ancestors"]:
                    reject("stale_reference", "Element role, name or named container changed; request a new snapshot")
            state = await self.function(obj.object_id, "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',enabled:!this.matches(':disabled')&&this.getAttribute('aria-disabled')!=='true',readonly:!!this.readOnly||this.getAttribute('aria-readonly')==='true',password:this.type==='password',tag:this.tagName,type:this.type};}")
            if not state or not state["connected"]:
                reject("stale_reference", "Element removed; request a new snapshot")
            if actionable and (not state["visible"] or not state["enabled"]):
                reject("not_actionable", "Element is hidden or disabled")
            if state["password"]:
                reject("protected_input", "Password controls are outside the browser tool interface")
            return obj.object_id, state
        except Rejected:
            raise
        except ProtocolException as error:
            if any(message in str(error).lower() for message in ("no node with given", "could not find node", "could not find object", "cannot find context", "no node found")):
                reject("stale_reference", "Element identity lost; request a new snapshot")
            raise

    async def focus(self, ref, obj, editable=False):
        focused = await self.function(obj, "function(){this.focus();return this.isConnected&&this.getRootNode().activeElement===this;}")
        if not focused:
            reject("focus_changed", "Focus moved or the editor was replaced; inspect before editing")
        # Focus handlers can repurpose the same node or its container.
        obj, state = await self.element(ref)
        if editable and state["readonly"]:
            reject("invalid_element", "Focus handler made the editor read-only; inspect before editing")
        if not await self.function(obj, "function(){return this.isConnected&&this.getRootNode().activeElement===this;}"):
            reject("focus_changed", "Focus moved before input; inspect before editing")
        return obj

    async def text_guard(self, ref):
        # Do not refocus: a handler moving focus must stop the sequence. Check
        # the full reference identity between keys, including named ancestors.
        obj, state = await self.element(ref)
        if state["readonly"] or not await self.function(obj, "function(){return this.getRootNode().activeElement===this&&(this.isContentEditable||this.tagName==='TEXTAREA'||this.tagName==='INPUT'&&!['file','hidden','submit','button','checkbox','radio','password','image','reset'].includes(this.type));}"):
            reject("focus_changed", "Editor focus or editability changed; input stopped without replay")
        return obj

    async def text_plan(self, obj, value, replace):
        plan = await self.function(obj, """function(value,replace){
          if(this.isContentEditable) return {control:false};
          const before=this.value, start=this.selectionStart, end=this.selectionEnd;
          if(!replace && before.length>128000) return {unverifiable:true};
          if(!replace && (start===null||end===null)) return {control:false,singleLine:true,limited:this.maxLength>=0&&value.length>this.maxLength};
          const expected=replace?value:before.slice(0,start)+value+before.slice(end);
          return {control:true,expected,prefix:replace?'':before.slice(0,start),suffix:replace?'':before.slice(end),limited:this.maxLength>=0&&expected.length>this.maxLength,
            multiline:this.tagName==='TEXTAREA'};
        }""", [value, replace])
        if plan.get("unverifiable"):
            reject("input_unverifiable", "Existing control exceeds the bounded exact read-back limit; no text dispatched")
        if plan.get("limited"):
            reject("site_limit", "Requested text exceeds the control's maxlength; no text dispatched")
        if (plan.get("singleLine") or plan.get("control") and not plan["multiline"]) and any(c in value for c in "\r\n"):
            reject("unsupported_input", "Single-line controls cannot preserve line breaks; no text dispatched")
        return plan

    async def sequential_text(self, args):
        value, delay = args["value"], args.get("keyDelayMs", 0) / 1000
        # Split Unicode code points, never UTF-16 surrogate halves. A char
        # event supplies text; rawKeyDown is separate so focus/identity changes
        # in keyboard handlers are detected before insertion.
        for index, char in enumerate(value):
            if index and delay:
                await asyncio.sleep(delay)
            await self.text_guard(args["elementRef"])
            key = "Enter" if char == "\n" else char
            vk = 13 if char == "\n" else ord(char.upper()) if char.isascii() and char.isalnum() else 32 if char == " " else 0
            self.dispatched = True
            await self.conn.send(cdp.input_.dispatch_key_event("rawKeyDown", key=key, windows_virtual_key_code=vk))
            await self.text_guard(args["elementRef"])
            await self.conn.send(cdp.input_.dispatch_key_event("char", key=key, text="\r" if char == "\n" else char, windows_virtual_key_code=vk))
            await self.text_guard(args["elementRef"])
            await self.conn.send(cdp.input_.dispatch_key_event("keyUp", key=key, windows_virtual_key_code=vk))
        return await self.text_guard(args["elementRef"])

    async def point(self, ref):
        obj, state = await self.element(ref)
        # The returned point is in the top frame's CSS viewport, which is the
        # coordinate space required by Input.dispatchMouseEvent.
        await self.function(obj, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}")
        obj, _ = await self.element(ref)
        pos = await self.function(obj, """function(){
          if(!this.isConnected) return null;
          const r=this.getBoundingClientRect(), w=this.ownerDocument.defaultView;
          const hit=this.ownerDocument.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          if(!hit || !(hit===this || this.contains(hit))) return null;
          let x=r.left+r.width/2,y=r.top+r.height/2,v=w;
          try {
            while(v!==v.top){
              const f=v.frameElement;
              if(!f) return null;
              const q=f.getBoundingClientRect();
              x+=q.left+f.clientLeft;y+=q.top+f.clientTop;v=v.parent;
            }
            if(x<0 || y<0 || x>=v.innerWidth || y>=v.innerHeight) return null;
            return {x,y};
          } catch(e){return null;}
        }""")
        if not pos or not all(isinstance(pos.get(k), (int,float)) for k in ("x","y")):
            reject("not_actionable", "Element is covered, outside the viewport, or in an unsupported frame")
        return pos

    async def mouse(self, event, x, y, button=cdp.input_.MouseButton.NONE, buttons=0, click_count=0, delta_x=None, delta_y=None):
        await self.conn.send(cdp.input_.dispatch_mouse_event(event, x, y, button=button, buttons=buttons, click_count=click_count, delta_x=delta_x, delta_y=delta_y))

    async def native_click(self, pos, kind):
        button = cdp.input_.MouseButton.RIGHT if kind == "rightClick" else cdp.input_.MouseButton.LEFT
        pressed = 2 if kind == "rightClick" else 1
        x,y=pos["x"],pos["y"]
        # A native press is located at its coordinates; no standalone
        # mouse move is required (Nodriver's mouse_click uses this sequence).
        for count in range(1, 3 if kind=="doubleClick" else 2):
            down=False
            try:
                down=True
                await self.mouse("mousePressed",x,y,button,pressed,count)
            finally:
                if down:
                    await self.mouse("mouseReleased",x,y,button,0,count)

    async def native_drag(self, start, end):
        sx,sy=start["x"],start["y"]
        tx,ty=end["x"],end["y"]
        pressed=False
        moves=[]
        try:
            pressed=True
            await self.mouse("mousePressed",sx,sy,cdp.input_.MouseButton.LEFT,1,1)
            # The renderer can hold a move response while the HTML5 drag is in
            # progress; queue the bounded pointer path, then release to complete it.
            for step in range(1, 13):
                f=step/12
                moves.append(asyncio.create_task(self.mouse("mouseMoved",sx+(tx-sx)*f,sy+(ty-sy)*f,cdp.input_.MouseButton.LEFT,1)))
                await asyncio.sleep(0.02)
        finally:
            if pressed:
                await self.mouse("mouseReleased",tx,ty,cdp.input_.MouseButton.LEFT,0,1)
            if moves:
                results=await asyncio.gather(*moves,return_exceptions=True)
                for result in results:
                    if isinstance(result,BaseException):
                        raise result

    async def target_tree(self, frame_id, target):
        # Query native AX by exact role/name instead of transferring every
        # text/layout node merely to verify a large editor.
        world = await self.conn.send(cdp.page.create_isolated_world(cdp.page.FrameId(frame_id), world_name="opencode-browser-observe"))
        doc, error = await self.conn.send(cdp.runtime.evaluate("document", context_id=world, object_group="browser-action", silent=True))
        if error or not doc.object_id:
            reject("observation_failed", "Target document unavailable")
        await self.conn.send(cdp.accessibility.enable())
        try:
            tree = await self.conn.send(cdp.accessibility.query_ax_tree(object_id=doc.object_id, accessible_name=target["name"], role=target["role"]))
            by_id = {}
            for node in tree:
                if node.backend_dom_node_id:
                    parents = await self.conn.send(cdp.accessibility.get_ax_node_and_ancestors(backend_node_id=node.backend_dom_node_id))
                    by_id.update((str(parent.node_id), parent) for parent in parents)
            containers = await self.conn.send(cdp.accessibility.query_ax_tree(object_id=doc.object_id, accessible_name=target["within"]["name"], role=target["within"]["role"])) if target.get("within") else []
            return tree, by_id, containers
        finally:
            await self.conn.send(cdp.accessibility.disable())
            await self.conn.send(cdp.runtime.release_object(doc.object_id))

    async def snapshot(self, args, target=None, rotate=True):
        scope = None
        if args.get("scopeRef"):
            try:
                await self.element(args["scopeRef"], actionable=False)
            finally:
                await self.release_objects()
            scope = dict(self.refs[args["scopeRef"]])
            if args.get("frameId") and args["frameId"] != scope["frame"]:
                reject("invalid_frame", "Scope reference belongs to a different frame")
        frames = await self.frames()
        epoch = self.epoch
        selected = scope["frame"] if scope else args.get("frameId")
        if selected and selected not in frames:
            reject("invalid_frame", "Frame is not part of the selected tab")
        nodes, errors, total, budget = [], [], 0, 0
        limit = args.get("maxNodes", 100)
        # Every snapshot rotates reference IDs; an old ID is never reused.
        if rotate:
            self.refs.clear()
        scope_count = 0
        scoped_frames = {selected: frames[selected]} if selected else frames
        for frame_index, (frame_id, frame) in enumerate(scoped_frames.items()):
            if frame_index >= 100:
                errors.append("Frame observation limit reached; request an exact frameId")
                break
            if selected and selected != frame_id:
                continue
            try:
                if target:
                    tree, by_id, container_tree = await self.target_tree(frame_id, target)
                else:
                    tree = await self.conn.send(cdp.accessibility.get_full_ax_tree(frame_id=cdp.page.FrameId(frame_id)))
                    by_id = {str(node.node_id): node for node in tree}
                scopes = {scope["backend"]} if scope else set()
                if target and target.get("within"):
                    within = target["within"]
                    containers = [node for node in container_tree if not node.ignored and node.backend_dom_node_id and node.role and node.role.value == within["role"] and node.name and node.name.value == within["name"]]
                    scope_count += len(containers)
                    scopes = {int(node.backend_dom_node_id) for node in containers}
                for node in tree:
                    if node.ignored:
                        continue
                    role = str(node.role.value if node.role else "")
                    name = safe_text(node.name.value if node.name else "")
                    ancestors = ax_ancestors(node, by_id)
                    if (scope or target and target.get("within")) and not any(int(parent.backend_dom_node_id) in scopes for parent in ancestors if parent.backend_dom_node_id):
                        continue
                    if target and (role != target["role"] or (node.name.value if node.name else "") != target["name"]):
                        continue
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
                        self.refs[ref] = {"backend": int(node.backend_dom_node_id), "frame": frame_id, "loader": frame["loader"], "epoch": epoch, "identity": ax_identity(node), "ancestors": [(int(parent.backend_dom_node_id), ax_identity(parent)) for parent in ancestors if parent.backend_dom_node_id and parent.name and parent.name.value and parent.role and parent.role.value not in ("RootWebArea", "WebArea")]}
                        item["ref"] = ref
                    nodes.append(item)
                    budget += len(json.dumps(item, ensure_ascii=True))
            except (ConnectionClosed, ConnectionError, OSError):
                raise
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
        if target and target.get("within") and scope_count > 1:
            reject("ambiguous_target", "Named ancestor matched " + str(scope_count) + " containers; use a unique ancestor name or exact frameId")
        return {"targetId": self.lease["target"], "generation": self.generation(frames), "url": safe_url(row["url"]), "title": safe_text(row.get("title")), "nodes": nodes, "frames": summaries, "truncated": total > len(nodes) or len(frames) > len(summaries), "totalNodes": total, "observationErrors": errors, "untrustedPageContent": True}

    async def resolve_target(self, target):
        before = set(self.refs)
        try:
            snap = await self.snapshot({"maxNodes": 300, **({"frameId": target["frameId"]} if "frameId" in target else {})}, target=target, rotate=False)
            matches = [node for node in snap["nodes"] if "ref" in node]
            if snap["truncated"] or snap["observationErrors"]:
                reject("incomplete_observation", "Target observation incomplete; narrow the named ancestor or frame")
            if len(matches) > 1:
                frames = sorted({node["frameId"] for node in matches})
                reject("ambiguous_target", "Target matched " + str(len(matches)) + " elements across " + str(len(frames)) + " frame(s); specify within or frameId, or inspect a scoped snapshot")
            return matches[0]["ref"] if matches else None
        except BaseException:
            for ref in set(self.refs) - before:
                self.refs.pop(ref, None)
            raise

    def generation(self, frames):
        return hashlib.sha256((self.lease["id"] + str(self.epoch) + repr([(key, val["loader"]) for key, val in frames.items()])).encode()).hexdigest()[:24]

    async def current(self):
        try:
            info = await self.conn.send(cdp.target.get_target_info(cdp.target.TargetID(self.lease["target"])))
        except ProtocolException as error:
            if any(message in str(error).lower() for message in ("no target with given", "target closed", "session with given id not found")):
                reject("target_closed", "Selected tab closed; select and attach explicitly")
            raise
        if str(info.target_id) != self.lease["target"] or info.type_ != "page":
            reject("target_closed", "Selected tab identity changed")
        return {"id": str(info.target_id), "url": info.url, "title": info.title, "type": info.type_}

    async def condition(self, condition, navigation_before=None):
        kind = condition["type"]
        if kind == "element":
            ref = await self.resolve_target(condition["target"])
            if ref is None:
                return False
            try:
                obj, state = await self.element(ref, actionable=False)
                if not state["visible"]:
                    return False
                return bool(await self.function(obj, """function(value,state,checkValue){
                  if(checkValue && (this.isContentEditable?this.innerText:this.value)!==value) return false;
                  const attr=n=>this.getAttribute('aria-'+n), enabled=!this.matches(':disabled')&&attr('disabled')!=='true';
                  const checked=attr('checked')??(('checked' in this)?String(this.checked):null);
                  const states={enabled,disabled:!enabled,focused:this.getRootNode().activeElement===this,
                    checked:checked==='true',unchecked:checked==='false',expanded:attr('expanded')==='true',collapsed:attr('expanded')==='false',
                    selected:attr('selected')==='true'||this.selected===true,
                    editable:enabled&&!this.readOnly&&attr('readonly')!=='true'&&(this.isContentEditable||this.tagName==='TEXTAREA'||this.tagName==='INPUT'&&!['button','submit','file','hidden','checkbox','radio'].includes(this.type))};
                  return !state||states[state]===true;
                }""", [condition.get("value", ""), condition.get("state", ""), "value" in condition]))
            finally:
                self.refs.pop(ref, None)
                await self.release_objects()
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
        predicate = "['AUDIO','VIDEO'].includes(e.tagName)&&e.readyState>=2&&!e.error" if kind == "mediaReady" else "!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'"
        expression = "(()=>{const e=document.querySelector(" + json.dumps(condition["selector"]) + ");return !!e&&(" + predicate + ");})()"
        obj, error = await self.conn.send(cdp.runtime.evaluate(expression, context_id=world, return_by_value=True, silent=True))
        if error:
            reject("invalid_selector", "Wait selector could not be evaluated")
        return bool(obj.value) if kind in ("elementAppears", "mediaReady") else not bool(obj.value)

    async def wait(self, condition, navigation_before=None, timeout_ms=10000):
        validate_condition(condition)
        if condition["type"] == "navigation" and navigation_before is None:
            frames = await self.frames()
            top = next(iter(frames))
            navigation_before = (top, frames[top]["loader"])
        url = safe_url((await self.current())["url"])
        try:
            async with asyncio.timeout_at(min(self.deadline, asyncio.get_running_loop().time() + timeout_ms / 1000)):
                while True:
                    if await self.condition(condition, navigation_before):
                        return {"verification": "confirmed", "url": safe_url((await self.current())["url"]), "evidence": "Requested observable condition met"}
                    # Observation continues within this call; mutations are never retried.
                    await asyncio.sleep(0.1)
        except TimeoutError:
            return {"verification": "timed_out", "url": url, "evidence": "Condition not observed before deadline; lease preserved; observation may continue"}

    async def upload(self, args, obj, state, files):
        if state["tag"] == "INPUT" and state["type"] == "file":
            settings = await self.function(obj, "function(){return {multiple:this.multiple,directory:this.webkitdirectory};}")
            if settings["directory"]:
                reject("unsupported_chooser", "Directory uploads are unsupported")
            if len(files) > 1 and not settings["multiple"]:
                reject("invalid_upload", "This input accepts only one file")
            self.dispatched = True
            await self.conn.send(cdp.dom.set_file_input_files(files, object_id=obj))
            return
        ref_data = dict(self.refs[args["elementRef"]])
        pos = await self.point(args["elementRef"])
        chooser = asyncio.get_running_loop().create_future()
        def opened(event):
            if not chooser.done():
                chooser.set_result(event)
        self.conn.add_handler(cdp.page.FileChooserOpened, opened)
        try:
            await self.conn.send(cdp.page.set_intercept_file_chooser_dialog(True))
            self.dispatched = True
            await self.native_click(pos, "click")
            try:
                event = await asyncio.wait_for(chooser, 3)
            except TimeoutError:
                reject("file_chooser_timeout", "No file chooser observed after the authorized click; inspect before retrying")
            frames = await self.frames()
            frame = frames.get(ref_data["frame"])
            if str(event.frame_id) != ref_data["frame"] or not frame or frame["loader"] != ref_data["loader"] or ref_data["epoch"] != self.epoch:
                reject("invalid_upload", "File chooser belongs to a different frame or document")
            if event.backend_node_id is None:
                reject("unsupported_chooser", "This chooser has no file input; File System Access pickers are unsupported")
            if event.mode != "selectMultiple" and len(files) > 1:
                reject("invalid_upload", "This chooser accepts only one file")
            # Only the input identified by Chrome's intercepted event is writable.
            node = await self.conn.send(cdp.dom.describe_node(backend_node_id=event.backend_node_id))
            attributes = dict(zip((node.attributes or [])[::2], (node.attributes or [])[1::2]))
            if node.node_name != "INPUT" or attributes.get("type", "").lower() != "file" or "disabled" in attributes or "webkitdirectory" in attributes:
                reject("unsupported_chooser", "Chooser does not identify a supported file input")
            await self.conn.send(cdp.dom.set_file_input_files(files, backend_node_id=event.backend_node_id))
        finally:
            self.conn.remove_handler(cdp.page.FileChooserOpened, opened)
            if not chooser.done():
                chooser.cancel()
            # Always restore native chooser behavior, including rejection/cancellation.
            await asyncio.wait_for(self.conn.send(cdp.page.set_intercept_file_chooser_dialog(False)), 1)

    async def workflow(self, args, owner):
        completed, any_dispatched, url = 0, False, ""
        text_verification = None

        def text_report():
            return {"textVerification": text_verification} if text_verification else {}

        def report(index, verification, evidence, code, layer):
            step_dispatched = self.dispatched
            self.dispatched = any_dispatched or step_dispatched
            return {**text_report(), "completedSteps": completed, "failedStep": index, "verification": verification,
                    "dispatched": self.dispatched, "stepDispatched": step_dispatched,
                    "mutationMayHaveOccurred": self.dispatched, "url": url,
                    "evidence": evidence, "errorCode": code, "errorLayer": layer}

        try:
            for index, step in enumerate(args["steps"]):
                self.dispatched = False
                layer = "lease"
                try:
                    deadline = min(self.deadline, asyncio.get_running_loop().time() + step.get("timeoutMs", 10000) / 1000)
                    async with asyncio.timeout_at(deadline):
                        row = await self.guard(args, owner, True)
                        url = safe_url(row["url"])
                        layer = "target"
                        self.refs.clear()
                        while True:
                            ref = await self.resolve_target(step["target"])
                            if ref:
                                break
                            await asyncio.sleep(0.1)
                        layer = "input"
                        action_args = {key: value for key, value in step.items() if key != "target"}
                        prior_text_verification = text_verification
                        if step["action"] in ("fill", "typeText"):
                            text_verification = "unverified"
                        result = await self.action({**action_args, "elementRef": ref, "leaseId": args["leaseId"], "authorized": True})
                        if "textVerification" in result:
                            text_verification = "unverified" if "unverified" in (prior_text_verification, result["textVerification"]) else "confirmed"
                        url = result["url"]
                        if result["verification"] != "confirmed":
                            return report(index, result["verification"], result["evidence"], "postcondition_unconfirmed", "observation")
                    any_dispatched |= self.dispatched
                    completed += 1
                except TimeoutError:
                    return report(index, "timed_out", "Step deadline reached; inspect before continuing", "target_not_found" if layer == "target" else "timed_out", layer)
                except Rejected as error:
                    if error.code in ("stale_reference", "ambiguous_target", "not_actionable", "incomplete_observation"):
                        layer = "target"
                    return report(index, "inconclusive" if self.dispatched else "rejected", error.message, error.code, layer)
                except Exception as error:
                    code, message, layer = operation_error(error)
                    await self.disconnect()
                    return report(index, "inconclusive" if self.dispatched else "failed", message, code, layer)
            self.dispatched = any_dispatched
            evidence = "All step postconditions confirmed"
            if text_verification == "unverified":
                evidence += "; exact text remains unverified for one or more edits: use same-element expected values"
            return {**text_report(), "completedSteps": completed, "failedStep": None, "verification": "confirmed", "dispatched": any_dispatched, "stepDispatched": False, "mutationMayHaveOccurred": any_dispatched, "url": url, "evidence": evidence, "errorCode": None, "errorLayer": None}
        finally:
            # Outer request timeout/cancellation can escape a later step. Keep
            # dispatch evidence from earlier confirmed steps at the IPC owner.
            self.dispatched = any_dispatched or self.dispatched

    async def action(self, args):
        kind = args["action"]
        text_verification = None
        same_text_target = False
        if kind == "typeText" and args.get("inputMode", "fast") == "sequential":
            remaining = min(self.deadline - asyncio.get_running_loop().time(), args.get("timeoutMs", 10000) / 1000)
            if max(0, len(args["value"]) - 1) * args.get("keyDelayMs", 0) / 1000 + 0.2 >= remaining:
                reject("input_budget_exceeded", "Sequential delays exceed the operation deadline; no text dispatched")
        files = upload_files(args["files"], self.lease["browser"]) if kind == "upload" else None
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
                if kind == "drag":
                    start = await self.point(args["sourceRef"])
                    end = await self.point(args["targetRef"])
                    self.dispatched = True
                    await self.native_drag(start, end)
                    obj, state = None, None
                else:
                    obj, state = await self.element(args["elementRef"])
                if kind == "upload":
                    await self.upload(args, obj, state, files)
                elif kind != "drag":
                    if kind == "fill" and (state["readonly"] or state["tag"] not in ("INPUT", "TEXTAREA") or state["type"] in ("file", "hidden", "submit", "button", "checkbox", "radio")):
                        reject("invalid_element", "Fill requires an editable text control")
                    if kind == "select" and state["tag"] != "SELECT":
                        reject("invalid_element", "Select requires a native select element")
                    if kind in ("click", "rightClick", "doubleClick", "hover", "scroll", "wheel"):
                        pos = await self.point(args["elementRef"])
                        self.dispatched = True
                        if kind in ("click", "rightClick", "doubleClick"):
                            await self.native_click(pos, kind)
                        elif kind == "hover":
                            # Nodriver's native mouse_move finishes with a release
                            # event (no button is held). Deliver both as one bounded
                            # gesture to avoid a dangling isolated move response.
                            await asyncio.gather(
                                self.mouse("mouseMoved",pos["x"],pos["y"]),
                                self.mouse("mouseReleased",pos["x"],pos["y"]))

                        elif kind == "scroll":
                            await self.function(obj, "function(delta){this.scrollBy({top:delta,behavior:'instant'});}", [args["deltaY"]])
                        else:
                            await self.function(obj, "function(dx,dy){this.scrollLeft+=dx;this.scrollTop+=dy;}", [args["deltaX"], args["deltaY"]])
                    elif kind == "typeText":
                        if state["readonly"] or not (state["tag"] in ("INPUT","TEXTAREA") and state["type"] not in ("file","hidden") or await self.function(obj,"function(){return this.isContentEditable;}")):
                            reject("invalid_element", "Typing requires editable text or contenteditable")
                        obj = await self.focus(args["elementRef"], obj, editable=True)
                        plan = await self.text_plan(obj, args["value"], False)
                        if args.get("inputMode", "fast") == "sequential":
                            obj = await self.sequential_text(args)
                        else:
                            # Large insertText calls can monopolize Chrome's
                            # editing pipeline. Each ordered part is sent once;
                            # verify control progress before sending the next.
                            value = args["value"]
                            size = 8000 if len(value) > 12000 else len(value)
                            for start in range(0, len(value), size):
                                obj = await self.text_guard(args["elementRef"])
                                self.dispatched = True
                                await self.conn.send(cdp.input_.insert_text(value[start:start + size]))
                                obj = await self.text_guard(args["elementRef"])
                                if plan["control"] and not await self.function(obj, "function(expected,prefix,more){return this.value===expected&&(!more||this.selectionStart===prefix.length&&this.selectionEnd===prefix.length);}", [plan["prefix"] + value[:start + size] + plan["suffix"], plan["prefix"] + value[:start + size], start + size < len(value)]):
                                    reject("partial_input", "Control text differs after an ordered part; input stopped without replay")
                    elif kind == "keyCombo":
                        obj = await self.focus(args["elementRef"], obj)
                        bits={"Alt":1,"Control":2,"Meta":4,"Shift":8}
                        mask=sum(bits[m] for m in args["modifiers"])
                        key=args["key"]
                        vk=ord(key) if len(key)==1 else {"Enter":13,"Escape":27,"Tab":9,"Backspace":8,"Delete":46,"ArrowLeft":37,"ArrowUp":38,"ArrowRight":39,"ArrowDown":40}[key]
                        self.dispatched = True
                        await self.conn.send(cdp.input_.dispatch_key_event("rawKeyDown",key=key,code="Key"+key if len(key)==1 else key,modifiers=mask,windows_virtual_key_code=vk))
                        await self.conn.send(cdp.input_.dispatch_key_event("keyUp",key=key,code="Key"+key if len(key)==1 else key,modifiers=mask,windows_virtual_key_code=vk))
                    elif kind == "fill":
                        obj = await self.focus(args["elementRef"], obj, editable=True)
                        plan = await self.text_plan(obj, args["value"], True)
                        self.dispatched = True
                        result = await self.function(obj, "function(value){if(!this.isConnected||this.getRootNode().activeElement!==this||this.readOnly||this.getAttribute('aria-readonly')==='true'||this.matches(':disabled')||this.getAttribute('aria-disabled')==='true')return false;const proto=this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(this,value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;}", [args["value"]])
                        if not result:
                            reject("focus_changed", "Editor changed before filling; inspect before continuing")
                    elif kind == "select":
                        self.dispatched = True
                        result = await self.function(obj, "function(value){if(!Array.from(this.options).some(o=>o.value===value&&!o.disabled))return false;this.value=value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;}", [args["value"]])
                        if not result:
                            reject("invalid_option", "Requested select option unavailable")
                    elif kind == "keypress":
                        obj = await self.focus(args["elementRef"], obj)
                        self.dispatched = True
                        key = args["key"]
                        codes = {"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46, "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40, "Home": 36, "End": 35, "Space": 32}
                        await self.conn.send(cdp.input_.dispatch_key_event("keyDown", key=" " if key == "Space" else key, windows_virtual_key_code=codes[key], text="\r" if key == "Enter" else " " if key == "Space" else None))
                        await self.conn.send(cdp.input_.dispatch_key_event("keyUp", key=key, windows_virtual_key_code=codes[key]))
            if kind in ("fill", "typeText"):
                # Fill has finished dispatching. A change handler may move
                # focus or disable the accepted control; read back the same
                # identity/value without requiring another editable gesture.
                if kind == "fill":
                    obj, _ = await self.element(args["elementRef"], actionable=False)
                else:
                    obj = await self.text_guard(args["elementRef"])
                text_verification = "unverified"
                if plan["control"]:
                    if not await self.function(obj, "function(expected){return this.value===expected;}", [plan["expected"]]):
                        reject("partial_input", "Control text differs from the requested edit; input may be partial or transformed; inspect without replay")
                    text_verification = "confirmed"
                elif args.get("expected", {}).get("type") == "element" and "value" in args["expected"]:
                    original = self.refs[args["elementRef"]]
                    check_ref = await self.resolve_target(args["expected"]["target"])
                    if check_ref:
                        check = self.refs.pop(check_ref)
                        same_text_target = all(original[key] == check[key] for key in ("backend", "frame", "loader", "epoch"))
            text_result = {"textVerification": text_verification} if text_verification else {}
            if args.get("expected"):
                result = await self.wait(args["expected"], navigation_before, args.get("timeoutMs", 10000))
                if same_text_target and result["verification"] == "confirmed":
                    text_result["textVerification"] = "confirmed"
                if text_result.get("textVerification") == "unverified":
                    result["evidence"] += "; exact editor text requires a same-element expected value"
                return {**result, **text_result, "dispatched": True, "completed": True, "mutationMayHaveOccurred": True}
            evidence = "Command completed; application outcome requires an expected condition"
            if text_verification:
                evidence += "; exact control text matched" if text_verification == "confirmed" else "; exact editor text unverified: supply a same-element expected value"
            return {**text_result, "dispatched": True, "completed": True, "verification": "inconclusive", "url": safe_url((await self.current())["url"]), "evidence": evidence, "mutationMayHaveOccurred": True}
        finally:
            await self.release_objects()

    async def run(self, method, args, owner):
        if method == "hello":
            return {"protocol": 1, "nodriver": importlib.metadata.version("nodriver")}
        browser = args.get("browser", "linux")
        if method == "status":
            return await self.status(browser, args, owner)
        if method == "connect":
            return await self.connect(args, owner)
        if method == "tabs":
            rows = await self.targets(browser, args, owner)
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
            url = endpoint(browser)
            permission = urllib.parse.urlsplit(url).scheme == "ws"
            if self.approval and not permission:
                reject("lease_conflict", "Release the approved browser connection before attaching another browser")
            approval = await self.approved(args, owner, browser) if permission else None
            info = None if permission else await self.discover(browser)
            rows = await self.targets(browser, args, owner)
            row = next((row for row in rows if row["id"] == args["targetId"]), None)
            if not row:
                reject("target_missing", "Exact page target ID unavailable")
            if row.get("url") != "about:blank" and urllib.parse.urlsplit(row.get("url", "")).scheme not in ("http", "https"):
                reject("unsupported_page", "Attach supports HTTP/HTTPS pages and about:blank")
            try:
                if not permission:
                    await self.open_socket(info["webSocketDebuggerUrl"], 10)
                self.conn.target = cdp.target.TargetID(args["targetId"])
                await self.conn.attach(cdp.target.TargetID(args["targetId"]))
                await self.conn.send(cdp.page.enable())
                await self.conn.send(cdp.dom.enable())
                self.conn.add_handler(cdp.dom.DocumentUpdated, self.invalidate)
                self.conn.add_handler(cdp.page.FrameNavigated, self.invalidate)
                self.lease = {"id": secrets.token_urlsafe(32), "owner": owner, "browser": browser, "target": args["targetId"], "identity": approval["id"] if approval else info["webSocketDebuggerUrl"], "connection": approval["id"] if approval else None, "mode": args["controlMode"]}
                return {"leaseId": self.lease["id"], "browser": browser, "generation": self.generation(await self.frames()), "controlMode": args["controlMode"], "target": self.summary(row), "ownership": "external"}
            except Exception:
                await self.disconnect()
                raise
        if method == "detach" and "connectionId" in args:
            await self.approved(args, owner, check=False)
            await self.disconnect()
            return {"detached": True, "chromePreserved": True}
        await self.guard(args, owner, method in ("action", "workflow"))
        if method == "detach":
            await self.disconnect()
            return {"detached": True, "chromePreserved": True}
        if method == "snapshot":
            return await self.snapshot(args)
        if method == "wait":
            return await self.wait(args["condition"], timeout_ms=args.get("timeoutMs", 10000))
        if method == "workflow":
            return await self.workflow(args, owner)
        if method == "media":
            return await inspect_media(self, args)
        if method == "media_download":
            return await download_media(self, args)
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
        if args["browser"] not in ("linux", "windows"):
            reject("invalid_arguments", "Invalid browser selection")
    for field, minimum, maximum in (("maxItems", 1, 20), ("maxBytes", 1024, 33554432), ("maxNodes", 1, 300), ("maxTabs", 1, 100), ("width", 100, 1920), ("height", 100, 1080), ("timeoutMs", 1000 if method == "connect" else 100, 120000 if method == "connect" else 30000)):
        if field in args and (type(args[field]) is not int or not minimum <= args[field] <= maximum):
            reject("invalid_arguments", "Invalid browser argument bound")
    if "filter" in args and (not isinstance(args["filter"], str) or len(args["filter"]) > 200):
        reject("invalid_arguments", "Invalid observation filter")
    for field in ("leaseId", "connectionId", "targetId", "elementRef", "sourceRef", "targetRef", "frameId", "scopeRef"):
        if field in args and (not isinstance(args[field], str) or not 0 < len(args[field]) <= 256):
            reject("invalid_arguments", "Invalid browser identity")
    required = {"connect": ("browser", "authorized"), "attach": ("targetId", "controlMode"), "snapshot": ("leaseId",), "wait": ("leaseId", "condition"), "workflow": ("leaseId", "authorized", "steps"), "media": ("leaseId",), "media_download": ("leaseId", "elementRef", "authorized"), "screenshot": ("leaseId",), "action": ("leaseId", "action", "authorized")}
    if any(field not in args for field in required.get(method, ())):
        reject("invalid_arguments", "Missing required browser argument")
    if method == "attach" and args["controlMode"] not in ("observe", "control"):
        reject("invalid_arguments", "Invalid browser control mode")
    if method == "connect" and (args["browser"] != "windows" or args["authorized"] is not True):
        reject("invalid_arguments", "Windows connection requires explicit task authorization")
    if method == "detach" and (("leaseId" in args) == ("connectionId" in args)):
        reject("invalid_arguments", "Detach requires exactly one lease or connection handle")
    if method == "wait":
        validate_condition(args["condition"])
    if method == "media_download" and args["authorized"] is not True:
        reject("invalid_arguments", "Media retrieval requires explicit authorization")
    if method == "workflow":
        steps = args["steps"]
        if args["authorized"] is not True or not isinstance(steps, list) or not 1 <= len(steps) <= 12:
            reject("invalid_arguments", "Workflow requires authorization and 1 to 12 steps")
        for step in steps:
            if not isinstance(step, dict) or step.get("action") not in ("click", "fill", "typeText", "select", "keypress", "upload") or "expected" not in step or set(step) & {"leaseId", "authorized", "elementRef"}:
                reject("invalid_arguments", "Workflow steps require a target and postcondition")
            validate_target(step.get("target"))
            validate("action", {**{key: value for key, value in step.items() if key != "target"}, "leaseId": args["leaseId"], "authorized": True, "elementRef": "workflow-observation"})
    if method == "action":
        kind = args["action"]
        variants = {"navigate": {"url"}, "click": {"elementRef"}, "rightClick": {"elementRef"}, "doubleClick": {"elementRef"}, "hover": {"elementRef"}, "drag": {"sourceRef", "targetRef"}, "typeText": {"elementRef","value"}, "keyCombo": {"elementRef","key","modifiers"}, "wheel": {"elementRef","deltaX","deltaY"}, "fill": {"elementRef", "value"}, "select": {"elementRef", "value"}, "upload": {"elementRef", "files"}, "keypress": {"elementRef", "key"}, "scroll": {"elementRef", "deltaY"}}
        common = {"leaseId", "action", "authorized", "expected", "timeoutMs"}
        optional = {"inputMode", "keyDelayMs"} if kind == "typeText" else set()
        if args["authorized"] is not True or kind not in variants or set(args) - common - variants[kind] - optional or variants[kind] - set(args):
            reject("invalid_arguments", "Invalid or unauthorized browser action")
        for field in ("value", "url", "key"):
            limit = MAX_TEXT if kind in ("fill", "typeText") else 4096 if field == "url" else 1000 if field == "value" else 100
            if field in args and (not isinstance(args[field], str) or len(args[field]) > limit):
                reject("invalid_arguments", "Action " + field + " limit is " + str(limit) + " Unicode characters")
        if kind in ("fill", "typeText") and any(0xD800 <= ord(char) <= 0xDFFF for char in args["value"]):
            reject("unsupported_input", "Unpaired Unicode surrogates cannot be entered exactly")
        if kind == "typeText":
            mode, delay = args.get("inputMode", "fast"), args.get("keyDelayMs", 0)
            if not args["value"] or mode not in ("fast", "sequential") or type(delay) is not int or not 0 <= delay <= 1000 or mode != "sequential" and "keyDelayMs" in args:
                reject("invalid_arguments", "Typing requires text and a valid mode; keyDelayMs is sequential-only, from 0 to 1000")
            if mode == "sequential":
                if len(args["value"]) > MAX_SEQUENTIAL:
                    reject("sequential_limit", "Sequential limit is 2000 Unicode characters; use explicit fast input for longer text")
                if any(ord(char) < 32 and char != "\n" or ord(char) == 127 for char in args["value"]):
                    reject("unsupported_input", "Sequential text supports printable Unicode and LF; other control characters are unsupported")
        if kind == "upload" and (not isinstance(args["files"], list) or not 1 <= len(args["files"]) <= 10 or any(not isinstance(file, str) or len(file) > 4096 for file in args["files"])):
            reject("invalid_arguments", "Invalid upload files")
        if kind == "keyCombo" and (
            args["key"] not in ("A","C","V","X","Z","Enter","Escape","Tab","Backspace","Delete","ArrowLeft","ArrowRight","ArrowUp","ArrowDown")
            or not isinstance(args["modifiers"], list) or not 1 <= len(args["modifiers"]) <= 4
            or len(set(str(m) for m in args["modifiers"])) != len(args["modifiers"])
            or any(m not in ("Control","Alt","Shift","Meta") for m in args["modifiers"])
        ):
            reject("invalid_arguments", "Invalid shortcut key or modifiers")
        if kind == "wheel" and (type(args["deltaX"]) is not int or abs(args["deltaX"]) > 10000):
            reject("invalid_arguments", "Invalid wheel delta")
        if kind in ("scroll", "wheel") and (type(args["deltaY"]) is not int or abs(args["deltaY"]) > 10000):
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
                remaining = min(120 if method == "connect" else 30, deadline / 1000 - time.time())
                if remaining <= 0:
                    raise TimeoutError()
                adapter.deadline = asyncio.get_running_loop().time() + remaining - min(0.2, remaining / 5)
                async with asyncio.timeout(remaining):
                    result = await adapter.run(method, args, request["owner"])
                reply = {"id": request_id, "ok": True, "result": result}
            except Rejected as error:
                reply = {"id": request_id, "ok": False, "error": {"code": error.code, "message": error.message, "dispatched": adapter.dispatched, "verification": "inconclusive" if adapter.dispatched else "rejected"}}
            except MediaError as error:
                reply = {"id": request_id, "ok": False, "error": {"code": error.code, "message": error.message, "dispatched": False, "verification": "failed"}}
            except TimeoutError:
                dispatched = adapter.dispatched
                await adapter.disconnect()
                reply = {"id": request_id, "ok": False, "error": {"code": "timed_out", "message": "Browser deadline reached; leases invalidated; inspect before retrying", "dispatched": dispatched, "verification": "timed_out"}}
            except asyncio.CancelledError:
                raise
            except Exception as error:
                dispatched = adapter.dispatched
                code, message, _ = operation_error(error)
                await adapter.disconnect()
                reply = {"id": request_id, "ok": False, "error": {"code": code, "message": message, "dispatched": dispatched, "verification": "inconclusive" if dispatched else "failed"}}
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
