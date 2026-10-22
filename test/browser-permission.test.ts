import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as z from "zod/v4";
import { BrowserBackend, BrowserError, browserPython } from "../src/browser/backend.js";
import { browserInputs } from "../src/browser/schemas.js";

// Models Chrome's approval endpoint rather than a browser or another automation
// backend: HTTP discovery is unavailable, and consent gates the WebSocket upgrade.
const fixtureSource = String.raw`
import asyncio, json, logging, sys
from http import HTTPStatus
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

logging.disable(logging.CRITICAL)
PATH = "/devtools/browser/fixture-browser"
state = {"attempts": 0, "accepted": 0, "closed": 0, "http": [], "messages": [], "paths": []}
sockets = set()
consent = asyncio.Event()
consent.set()
mode = "allow"
next_socket = 0
redirect_url = None

def target(target_id):
    return {"targetId": target_id, "type": "page", "title": "Fixture " + target_id,
            "url": "https://fixture.test/" + target_id, "attached": False, "canAccessOpener": False}

async def upgrade(connection, request):
    if request.headers.get("Upgrade", "").lower() != "websocket":
        state["http"].append(request.path)
        if redirect_url is not None:
            response = connection.respond(HTTPStatus.TEMPORARY_REDIRECT, "")
            response.headers["Location"] = redirect_url
            return response
        return connection.respond(HTTPStatus.NOT_FOUND, "")
    state["attempts"] += 1
    state["paths"].append(request.path)
    if request.path != PATH or "Origin" in request.headers or mode == "deny":
        return connection.respond(HTTPStatus.FORBIDDEN, "Connection rejected")
    if redirect_url is not None:
        response = connection.respond(HTTPStatus.TEMPORARY_REDIRECT, "")
        response.headers["Location"] = redirect_url
        return response
    if mode == "delay":
        await consent.wait()
    return None

async def websocket(ws):
    global next_socket
    next_socket += 1
    socket_id = next_socket
    state["accepted"] += 1
    sockets.add(ws)
    sessions = {}
    try:
        async for raw in ws:
            request = json.loads(raw)
            method, params = request["method"], request.get("params") or {}
            state["messages"].append({"socket": socket_id, "method": method,
                                      "params": params, "sessionId": request.get("sessionId")})
            result = {}
            if method == "Browser.getVersion":
                result = {"protocolVersion": "1.3", "product": "Chrome/155.0.8059.82",
                          "revision": "fixture", "userAgent": "Fixture", "jsVersion": "fixture"}
            elif method == "Target.getTargets":
                result = {"targetInfos": [target("page-a"), target("page-b")]}
            elif method == "Target.getTargetInfo":
                result = {"targetInfo": target(params.get("targetId", "browser-root"))}
            elif method == "Target.attachToBrowserTarget":
                result = {"sessionId": "browser-session"}
                await ws.send(json.dumps({"method": "Target.attachedToTarget", "params": {
                    "sessionId": "browser-session", "targetInfo": {**target("browser-root"), "type": "browser"},
                    "waitingForDebugger": False}}))
            elif method == "Target.attachToTarget":
                session_id = "session-" + params["targetId"]
                sessions[session_id] = params["targetId"]
                result = {"sessionId": session_id}
            elif method == "Target.detachFromTarget":
                sessions.pop(params.get("sessionId"), None)
            elif method == "Page.getFrameTree":
                target_id = sessions.get(request.get("sessionId"), "page-a")
                result = {"frameTree": {"frame": {
                    "id": "frame-" + target_id, "loaderId": "loader-" + target_id,
                    "url": target(target_id)["url"], "domainAndRegistry": "fixture.test",
                    "securityOrigin": "https://fixture.test", "mimeType": "text/html",
                    "secureContextType": "Secure", "crossOriginIsolatedContextType": "NotIsolated",
                    "gatedAPIFeatures": []}}}
            elif method == "Accessibility.getFullAXTree":
                result = {"nodes": []}
            elif method not in ("Page.enable", "DOM.enable", "Runtime.enable",
                                "Target.setDiscoverTargets", "Runtime.releaseObjectGroup"):
                await ws.send(json.dumps({"id": request["id"], "error": {
                    "code": -32601, "message": "Unsupported fixture command: " + method}}))
                continue
            await ws.send(json.dumps({"id": request["id"], "result": result}))
    except ConnectionClosed:
        pass
    finally:
        sockets.discard(ws)
        state["closed"] += 1

async def main():
    global mode, PATH, redirect_url
    reader = asyncio.StreamReader()
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    async with serve(websocket, "127.0.0.1", 0, process_request=upgrade, open_timeout=120,
                     close_timeout=0.1) as server:
        server_port = server.sockets[0].getsockname()[1]
        print(json.dumps({"id": "ready", "port": server_port, "path": PATH}), flush=True)
        while line := await reader.readline():
            command = json.loads(line)
            action = command["action"]
            if action == "mode":
                mode = command["value"]
                if mode == "delay": consent.clear()
                else: consent.set()
            elif action == "allow":
                consent.set()
            elif action == "drop":
                await asyncio.gather(*(ws.close(code=1011, reason="fixture connection lost") for ws in tuple(sockets)))
            elif action == "path":
                PATH = command["value"]
            elif action == "redirect":
                redirect_url = command["value"]
            print(json.dumps({"id": command["id"], **state}), flush=True)
        consent.set()
    transport.close()

asyncio.run(main())
`;

type Message = { socket: number; method: string; params: Record<string, unknown>; sessionId: string | null };
type FixtureStats = { attempts: number; accepted: number; closed: number; http: string[]; paths: string[]; messages: Message[] };
type Fixture = {
  port: number;
  path: string;
  command: (action: string, fields?: Record<string, unknown>) => Promise<FixtureStats>;
  close: () => Promise<void>;
};
const rejected = (error: unknown) => error instanceof BrowserError && error.verification === "rejected" && !error.dispatched;
const errorCode = (code: string) => (error: unknown) => error instanceof BrowserError && error.code === code;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check: () => Promise<boolean>, message: string) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (await check()) return;
    await pause(20);
  }
  assert.fail(message);
}

async function startFixture(python: string, directory: string): Promise<Fixture> {
  const script = join(directory, "permission-endpoint.py");
  await writeFile(script, fixtureSource);
  const child: ChildProcessWithoutNullStreams = spawn(python, ["-B", script], { stdio: "pipe" });
  let output = "", diagnostics = "", sequence = 0;
  const pending = new Map<string, { resolve: (reply: any) => void; reject: (error: Error) => void }>();
  const receive = (id: string): Promise<any> => new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  const ready = receive("ready");
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
  child.stdout.on("data", chunk => {
    output += chunk.toString();
    while (output.includes("\n")) {
      const end = output.indexOf("\n"), line = output.slice(0, end);
      output = output.slice(end + 1);
      const reply = JSON.parse(line);
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    }
  });
  const fail = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Permission fixture exited: " + diagnostics));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  const initial = await ready;
  return {
    port: initial.port,
    path: initial.path,
    async command(action, fields = {}) {
      const id = "fixture-" + ++sequence, reply = receive(id);
      child.stdin.write(JSON.stringify({ id, action, ...fields }) + "\n");
      return reply;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    },
  };
}

async function setup(t: TestContext, configuration: "file" | "websocket" | "http" = "file") {
  const python = await browserPython();
  try { await access(python); } catch { t.skip("Run npm run browser:setup to install the pinned browser dependencies"); return; }
  const directory = await mkdtemp(join(tmpdir(), "browser-permission-"));
  let fixture: Fixture | undefined;
  let backend: BrowserBackend | undefined;
  t.after(async () => { backend?.close(); await fixture?.close(); await rm(directory, { recursive: true, force: true }); });
  fixture = await startFixture(python, directory);
  const userDataDir = join(directory, "user-data");
  await mkdir(userDataDir);
  const writeDiscovery = (port: number, path: string) => writeFile(join(userDataDir, "DevToolsActivePort"), `${port}\n${path}\n`);
  await writeDiscovery(fixture.port, fixture.path);
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONNECT_BROWSER_PYTHON: python };
  delete env.OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT;
  delete env.OPENCODE_CONNECT_BROWSER_WINDOWS_USER_DATA_DIR;
  if (configuration === "file") env.OPENCODE_CONNECT_BROWSER_WINDOWS_USER_DATA_DIR = userDataDir;
  else env.OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT = configuration === "http"
    ? `http://127.0.0.1:${fixture.port}` : `ws://127.0.0.1:${fixture.port}${fixture.path}`;
  backend = new BrowserBackend({ enabled: true, env });
  // Consent tests measure the browser approval gate, independently of lazy
  // Python import/startup time. This public read remains a passive TCP probe.
  await backend.call("status", { browser: "windows" }, "operator");
  const connect = (timeoutMs = 5000, owner = "operator") => backend!.call("connect", { browser: "windows", authorized: true, timeoutMs }, owner);
  return { backend, fixture, connect, writeDiscovery, directory };
}

test("approval connection schemas require authorization and bound the human consent deadline", () => {
  assert.equal(browserInputs.connect.parse({ browser: "windows", authorized: true }).timeoutMs, 60000);
  for (const input of [{ browser: "windows" }, { browser: "linux", authorized: true },
    { browser: "windows", authorized: false }, { browser: "windows", authorized: true, timeoutMs: 999 },
    { browser: "windows", authorized: true, timeoutMs: 120001 }]) {
    assert.equal(browserInputs.connect.safeParse(input).success, false);
  }
  assert.equal(browserInputs.connect.safeParse({ browser: "windows", authorized: true, timeoutMs: 120000 }).success, true);
  for (const input of [{}, { leaseId: "lease", connectionId: "connection" }]) assert.equal(browserInputs.detach.safeParse(input).success, false);
  assert.equal(browserInputs.detach.safeParse({ connectionId: "connection" }).success, true);
  for (const [schema, fields] of [[browserInputs.tabs, {}], [browserInputs.attach, { targetId: "page-a", controlMode: "observe" }]] as const) {
    assert.equal(schema.safeParse(fields).success, true, "Linux remains the default without a connection handle");
    assert.equal(schema.safeParse({ ...fields, browser: "windows" }).success, false, "Windows requires an approved connection handle");
    assert.equal(schema.safeParse({ ...fields, browser: "windows", connectionId: "connection" }).success, true);
    assert.equal(schema.safeParse({ ...fields, browser: "linux", connectionId: "connection" }).success, false);
    const published = z.toJSONSchema(schema, { io: "input" });
    assert.ok(published.properties?.connectionId, "The connection field remains visible to MCP clients");
    const windows = published.oneOf?.find(variant => {
      const selection = variant.properties?.browser;
      return typeof selection === "object" && selection.const === "windows";
    });
    assert.ok(windows?.required?.includes("connectionId"), "Published Windows constraints require the approved handle");
  }
  assert.equal(browserInputs.status.safeParse({ browser: "windows" }).success, true);
  assert.equal(browserInputs.status.safeParse({ connectionId: "unused" }).success, false);
});

test("WS-only Chrome status is passive and discovery requires an approved connection", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  assert.equal((await fetch(`http://127.0.0.1:${fixture.port}/json/version`)).status, 404);
  const before = await fixture.command("stats");
  const status = await backend.call("status", { browser: "windows" }, "operator");
  assert.equal(status.reachable, true);
  assert.equal(status.connectionState, "approval_required");
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId: "not-approved" }, "operator"), errorCode("approval_required"));
  await assert.rejects(backend.call("attach", { browser: "windows", connectionId: "not-approved", targetId: "page-a", controlMode: "observe" }, "operator"), errorCode("approval_required"));
  const passive = await fixture.command("stats");
  assert.equal(passive.attempts, 0);
  assert.deepEqual(passive.http, before.http, "Passive status/tabs must not use HTTP discovery on an approval endpoint");
  assert.deepEqual(passive.messages, []);
  const connected = await connect();
  assert.equal(connected.browser, "windows");
  assert.equal(connected.version, "Chrome/155.0.8059.82");
  assert.equal(typeof connected.connectionId, "string");
  const connectionId = connected.connectionId as string;
  const connectedStatus = await backend.call("status", { browser: "windows", connectionId }, "operator");
  assert.equal(connectedStatus.connectionState, "connected");
  const tabs = await backend.call("tabs", { browser: "windows", connectionId }, "operator");
  assert.deepEqual((tabs.targets as any[]).map(row => row.targetId), ["page-a", "page-b"]);
  assert.ok(!JSON.stringify(tabs).includes(connectionId));
  const active = await fixture.command("stats");
  assert.equal(active.accepted, 1);
  assert.ok(active.messages.some(message => message.method === "Browser.getVersion"));
  assert.ok(active.messages.some(message => message.method === "Target.getTargets"));
  assert.ok(!active.messages.some(message => message.method === "Target.attachToTarget"), "Discovery must not select a page");
  assert.deepEqual(active.http, before.http);
});

test("approved discovery and tab attachment use one socket and enforce owner, token and lease identity", { timeout: 15000 }, async t => {
  const context = await setup(t, "websocket"); if (!context) return;
  const { backend, fixture, connect } = context;
  const { connectionId } = await connect();
  const otherCapabilities: [unknown, string][] = [["incorrect-token", "operator"], [connectionId, "other-caller"]];
  for (const [token, owner] of otherCapabilities) {
    await assert.rejects(backend.call("tabs", { browser: "windows", connectionId: token }, owner), rejected);
    await assert.rejects(backend.call("attach", { browser: "windows", connectionId: token, targetId: "page-a", controlMode: "observe" }, owner), rejected);
    await assert.rejects(backend.call("detach", { connectionId: token }, owner), rejected);
  }
  await assert.rejects(backend.call("attach", { targetId: "page-a", controlMode: "observe" }, "operator"), errorCode("lease_conflict"));
  const attached = await backend.call("attach", { browser: "windows", connectionId, targetId: "page-a", controlMode: "observe" }, "operator");
  assert.equal((attached.target as any).targetId, "page-a");
  assert.equal((await backend.call("snapshot", { leaseId: attached.leaseId }, "operator")).targetId, "page-a");
  await assert.rejects(backend.call("attach", { browser: "windows", connectionId, targetId: "page-b", controlMode: "control" }, "operator"), rejected);
  const active = await fixture.command("stats");
  assert.equal(active.accepted, 1);
  assert.equal(new Set(active.messages.map(message => message.socket)).size, 1);
  assert.deepEqual(active.http, [], "Approved lease guards and snapshot must not fall back to HTTP discovery");
  const attaches = active.messages.filter(message => message.method === "Target.attachToTarget");
  assert.deepEqual(attaches.map(message => message.params.targetId), ["page-a"]);
  await backend.call("detach", { leaseId: attached.leaseId }, "operator");
  await eventually(async () => (await fixture.command("stats")).closed === 1, "Detach did not close its WebSocket");
  const detached = await fixture.command("stats");
  assert.ok(!detached.messages.some(message => ["Browser.close", "Target.closeTarget", "Target.disposeBrowserContext"].includes(message.method)));
  assert.equal((await backend.call("status", { browser: "windows" }, "operator")).connectionState, "approval_required");
  assert.equal((await fixture.command("stats")).attempts, 1, "Detach/status must not reopen an approval connection");
});

test("Windows HTTP configuration fails closed before discovery, redirects or consent", { timeout: 15000 }, async t => {
  const context = await setup(t, "http"); if (!context) return;
  const { backend, fixture, connect, directory } = context;
  const redirectedDirectory = join(directory, "redirected");
  await mkdir(redirectedDirectory);
  const redirected = await startFixture(await browserPython(), redirectedDirectory);
  t.after(() => redirected.close());
  for (const mode of ["allow", "deny", "delay"]) {
    await fixture.command("mode", { value: mode });
    await fixture.command("redirect", { value: mode === "allow" ? null : `http://127.0.0.1:${redirected.port}/json/version` });
    const status = await backend.call("status", { browser: "windows" }, "operator");
    assert.deepEqual((await fixture.command("stats")).http, [], "Invalid Windows HTTP configuration must reject before the first discovery request");
    assert.equal(status.reachable, false);
    assert.equal(status.attached, false);
    assert.equal(status.connectionState, "unreachable");
    assert.match(String(status.currentIssue), /Windows.*WebSocket/);
    await assert.rejects(connect(), errorCode("invalid_endpoint"));
    await assert.rejects(backend.call("tabs", { browser: "windows", connectionId: "not-approved" }, "operator"), errorCode("invalid_endpoint"));
    await assert.rejects(backend.call("attach", { browser: "windows", connectionId: "not-approved", targetId: "page-a", controlMode: "observe" }, "operator"), errorCode("invalid_endpoint"));
  }
  const stats = await fixture.command("stats");
  assert.deepEqual(stats.http, [], "Invalid Windows HTTP configuration must reject before the first discovery request");
  assert.equal(stats.attempts, 0, "Invalid configuration must not request Chrome consent");
  assert.equal(stats.accepted, 0);
  assert.deepEqual(stats.messages, []);
  const destination = await redirected.command("stats");
  assert.deepEqual(destination.http, []);
  assert.equal(destination.attempts, 0);
});

test("a connection can be detached before page selection without terminating Chrome", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  const { connectionId } = await connect();
  assert.equal((await backend.call("detach", { connectionId }, "operator")).chromePreserved, true);
  await eventually(async () => (await fixture.command("stats")).closed === 1, "Connection detach did not close its WebSocket");
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId }, "operator"), rejected);
  const stats = await fixture.command("stats");
  assert.ok(!stats.messages.some(message => message.method === "Target.attachToTarget" || message.method === "Browser.close"));
  assert.equal(stats.attempts, 1);
});

test("denied consent returns a controlled rejection without discovery or implicit retry", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  await fixture.command("mode", { value: "deny" });
  await assert.rejects(connect(), errorCode("approval_denied"));
  const denied = await fixture.command("stats");
  assert.equal(denied.attempts, 1);
  assert.equal(denied.accepted, 0);
  assert.deepEqual(denied.http, [], "Denied consent must not fall back to HTTP discovery");
  assert.deepEqual(denied.messages, []);
  assert.equal((await backend.call("status", { browser: "windows" }, "operator")).connectionState, "approval_required");
  assert.equal((await fixture.command("stats")).attempts, 1);
});

test("pending human approval blocks competing operations and can outlive a ten-second handshake", { timeout: 25000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  await fixture.command("mode", { value: "delay" });
  let settled = false;
  const waiting = connect(15000).finally(() => { settled = true; });
  // Attach the rejection observer immediately so a premature handshake deadline
  // becomes a normal assertion failure instead of an unhandled rejection.
  const outcome = waiting.then(value => ({ value }), error => ({ error }));
  await eventually(async () => (await fixture.command("stats")).attempts === 1, "Connection never reached the approval gate");
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId: "not-approved" }, "other-caller"), errorCode("busy"));
  await assert.rejects(backend.call("status", { browser: "windows" }, "operator"), errorCode("busy"));
  await pause(10500);
  assert.equal(settled, false, "A ten-second library/default deadline prematurely ended human approval");
  await fixture.command("allow");
  const result = await outcome;
  if ("error" in result) throw result.error;
  assert.equal(result.value.browser, "windows");
  assert.equal((await fixture.command("stats")).accepted, 1);
});

test("approval deadline expiry does not reconnect or continue discovery after late consent", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  await fixture.command("mode", { value: "delay" });
  await assert.rejects(connect(1000), (error: unknown) => error instanceof BrowserError && !error.dispatched && error.verification === "timed_out");
  await fixture.command("allow");
  await backend.call("status", { browser: "windows" }, "operator");
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId: "not-approved" }, "operator"), errorCode("approval_required"));
  const stats = await fixture.command("stats");
  assert.equal(stats.attempts, 1);
  assert.deepEqual(stats.http, [], "Expired consent must not fall back to HTTP discovery");
  assert.deepEqual(stats.messages, []);
});

test("socket loss invalidates connection and page capabilities without another consent request", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  const { connectionId } = await connect();
  const attached = await backend.call("attach", { browser: "windows", connectionId, targetId: "page-a", controlMode: "observe" }, "operator");
  await fixture.command("drop");
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId }, "operator"), rejected);
  await assert.rejects(backend.call("snapshot", { leaseId: attached.leaseId }, "operator"), rejected);
  await assert.rejects(backend.call("attach", { browser: "windows", connectionId, targetId: "page-b", controlMode: "observe" }, "operator"), rejected);
  assert.equal((await fixture.command("stats")).attempts, 1, "An old token must never silently create a new approval socket");
});

test("DevToolsActivePort path changes invalidate approved capabilities before reconnect", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect, writeDiscovery } = context;
  const { connectionId } = await connect();
  const changedPath = "/devtools/browser/replaced-browser";
  await fixture.command("path", { value: changedPath });
  await writeDiscovery(fixture.port, changedPath);
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId }, "operator"), rejected);
  assert.equal((await fixture.command("stats")).attempts, 1);
  const fresh = await connect();
  assert.notEqual(fresh.connectionId, connectionId);
  await backend.call("tabs", { browser: "windows", connectionId: fresh.connectionId }, "operator");
  assert.deepEqual((await fixture.command("stats")).paths, [fixture.path, changedPath]);
});

test("DevToolsActivePort port changes require a newly approved connection", { timeout: 15000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect, writeDiscovery, directory } = context;
  const secondDirectory = join(directory, "replacement");
  await mkdir(secondDirectory);
  const replacement = await startFixture(await browserPython(), secondDirectory);
  t.after(() => replacement.close());
  const { connectionId } = await connect();
  await writeDiscovery(replacement.port, replacement.path);
  await assert.rejects(backend.call("tabs", { browser: "windows", connectionId }, "operator"), rejected);
  assert.equal((await replacement.command("stats")).attempts, 0);
  const fresh = await connect();
  assert.notEqual(fresh.connectionId, connectionId);
  assert.equal((await replacement.command("stats")).accepted, 1);
  assert.equal((await fixture.command("stats")).attempts, 1);
});

test("browser WebSockets reject redirects before contacting another endpoint", { timeout: 30000 }, async t => {
  for (const configuration of ["file", "websocket"] as const) await t.test(configuration, async child => {
    const context = await setup(child, configuration); if (!context) return;
    const { fixture, connect, directory } = context;
    const redirectedDirectory = join(directory, "redirected");
    await mkdir(redirectedDirectory);
    const redirected = await startFixture(await browserPython(), redirectedDirectory);
    child.after(() => redirected.close());
    await fixture.command("redirect", { value: `ws://127.0.0.1:${redirected.port}${redirected.path}` });
    await assert.rejects(connect(), (error: unknown) => error instanceof BrowserError && !error.dispatched);
    const source = await fixture.command("stats");
    assert.equal(source.attempts, 1);
    assert.deepEqual(source.http, [], "A rejected WebSocket must not fall back to HTTP discovery");
    const destination = await redirected.command("stats");
    assert.equal(destination.attempts, 0, "A validated loopback URI must not authorize a redirected CDP destination");
    assert.deepEqual(destination.http, []);
  });
});

test("malformed Unicode capabilities cannot revoke another caller's approved connection or lease", { timeout: 30000 }, async t => {
  const context = await setup(t); if (!context) return;
  const { backend, fixture, connect } = context;
  const { connectionId } = await connect();
  const attached = await backend.call("attach", { browser: "windows", connectionId, targetId: "page-a", controlMode: "observe" }, "operator");
  for (const owner of ["other-caller", "operator"]) for (const malformed of ["invalid-连接", "invalid-\ud800"]) {
    await assert.rejects(backend.call("tabs", { browser: "windows", connectionId: malformed }, owner), rejected);
    await assert.rejects(backend.call("detach", { connectionId: malformed }, owner), rejected);
    await assert.rejects(backend.call("snapshot", { leaseId: malformed }, owner), rejected);
    const anonymousStatus = await backend.call("status", { browser: "windows", connectionId: malformed }, owner);
    assert.notEqual(anonymousStatus.connectionState, "connected");
    assert.equal((await backend.call("snapshot", { leaseId: attached.leaseId }, "operator")).targetId, "page-a");
    assert.equal((await backend.call("status", { browser: "windows", connectionId }, "operator")).connectionState, "connected");
  }
  assert.equal((await fixture.command("stats")).accepted, 1, "Invalid capabilities must preserve the existing owner's socket");
});
