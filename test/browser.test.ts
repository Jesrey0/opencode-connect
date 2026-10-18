import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as httpServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { BrowserBackend, BrowserError, browserPython, endpoint } from "../src/browser/backend.js";
import { browserInputs } from "../src/browser/schemas.js";
import { createHttpHandler } from "../src/http.js";
import { Events } from "../src/events.js";
import { hashSourceTree } from "../src/deployment.js";

const root = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorCode = (code: string) => (error: unknown) => error instanceof BrowserError && error.code === code;

test("browser schemas reject ambiguous targets, arbitrary script, unsafe navigation and missing authorization", () => {
  for (const input of [{}, { targetId: "", controlMode: "control" }, { targetId: "id", controlMode: "control", url: "https://example.com" }]) assert.equal(browserInputs.attach.safeParse(input).success, false);
  for (const input of [
    { action: "evaluate", script: "alert(1)", leaseId: "l", authorized: true },
    { action: "navigate", url: "file:///etc/passwd", leaseId: "l", authorized: true },
    { action: "click", elementRef: "e", leaseId: "l" },
    { action: "fill", elementRef: "e", value: "x", leaseId: "l", authorized: true, selector: "body" },
    { action: "upload", elementRef: "e", files: [], leaseId: "l", authorized: true },
  ]) assert.equal(browserInputs.action.safeParse(input).success, false);
  assert.equal(browserInputs.wait.safeParse({ leaseId: "l", condition: { type: "text", value: "done" }, timeoutMs: 30001 }).success, false);
  assert.equal(browserInputs.screenshot.safeParse({ leaseId: "l", width: 1921 }).success, false);
});

test("CDP endpoints require explicit loopback IP, port and no redirects/credentials/path", () => {
  assert.equal(endpoint("http://127.0.0.1:9222"), "http://127.0.0.1:9222");
  for (const value of ["http://localhost:9222", "http://192.168.1.1:9222", "https://127.0.0.1:9222", "http://127.0.0.1", "http://u:p@127.0.0.1:9222", "http://127.0.0.1:9222/path", "http://127.0.0.1:9222?token=secret"]) assert.throws(() => endpoint(value));
});

test("browser is disabled by default and invalid actions never start a worker", async () => {
  const disabled = new BrowserBackend({ env: {} });
  await assert.rejects(disabled.call("tabs", {}), errorCode("disabled"));
  const backend = new BrowserBackend({ enabled: true, env: {} });
  await assert.rejects(backend.call("action", { action: "evaluate" }), errorCode("invalid_arguments"));
  backend.close();
  await assert.rejects(backend.call("launch", {}), errorCode("closed"));
  const cancelled = new BrowserBackend({ enabled: true });
  await assert.rejects(cancelled.call("launch", {}, "owner", AbortSignal.abort()), errorCode("cancelled"));
  const starting = cancelled.call("tabs", {});
  cancelled.close();
  await assert.rejects(starting, errorCode("closed"));
  assert.equal((cancelled as any).worker, undefined);
});

test("Python worker and dependency lock participate in immutable build identity", async () => {
  const tree = await hashSourceTree(root);
  for (const name of ["src/browser/worker.py", "src/browser/requirements.lock", "scripts/setup-browser.mjs"]) assert.ok(tree.files.includes(name));
  assert.ok(!tree.files.some(name => name.includes("__pycache__") || name.includes(".venv")));
});

test("managed Chrome launch is independent of connector process and fails closed", async t => {
  const temp = await mkdtemp(join(tmpdir(), "browser-systemd-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const script = join(temp, "systemd-run");
  const trace = join(temp, "invocation.txt");
  await writeFile(script, `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(trace)}
exit 7
`, { mode: 0o755 });
  const unavailable = httpServer((_req, res) => { res.statusCode = 503; res.end(); });
  unavailable.listen(0, "127.0.0.1"); await once(unavailable, "listening");
  t.after(() => new Promise<void>(resolve => unavailable.close(() => resolve())));
  const address = unavailable.address(); assert.ok(address && typeof address !== "string");
  const backend = new BrowserBackend({
    enabled: true, chromeLaunchMode: "managed",
    env: { ...process.env, PATH: temp + ":" + process.env.PATH, XDG_DATA_HOME: temp,
      OPENCODE_CONNECT_BROWSER_CHROME: "/usr/bin/google-chrome-stable",
      OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT: `http://127.0.0.1:${address.port}` },
  });
  t.after(() => backend.close());
  await assert.rejects(backend.call("launch", { headless: true }), errorCode("launch_failed"));
  const args = await readFile(trace, "utf8");
  for (const expected of ["--user", "--unit=opencode-connect-chrome", "--collect", "--headless=new", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + temp]) {
    assert.ok(args.includes(expected), expected);
  }
});

test("managed worker uses only connection cleanup, without a Nodriver browser owner", async () => {
  const code = await readFile(join(root, "src/browser/worker.py"), "utf8");
  assert.doesNotMatch(code, /\bBrowser\s*\(|nodriver\.start\(|browser\.close\(|\.terminate\(|\.kill\(/);
  assert.match(code, /await asyncio.wait_for\(conn.aclose\(\), 2\)/);
});

test("Python boundary tests reject invalid commands and bound sensitive observations", { skip: process.env.OPENCODE_CONNECT_BROWSER_TEST !== "1" }, async () => {
  const python = await browserPython();
  const result = spawnSync(python, ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "browser_worker_test.py"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("private IPC validates, correlates, bounds, cancels and limits restarts", async t => {
  const temp = await mkdtemp(join(tmpdir(), "browser-ipc-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const worker = join(temp, "fixture.py");
  await writeFile(worker, `import json,sys,time\nfor line in sys.stdin:\n r=json.loads(line)\n if r['method']=='hello':\n  print(json.dumps({'id':r['id'],'ok':True,'result':{'protocol':1,'nodriver':'0.50.6'}}),flush=True)\n elif r['method']=='tabs':\n  print('x'*2200000,flush=True)\n else:\n  time.sleep(30)\n`);
  const env = { ...process.env, OPENCODE_CONNECT_BROWSER_PYTHON: "/usr/bin/python3" };
  const backend = new BrowserBackend({ enabled: true, env, workerPath: worker, restartBackoffMs: 1 });
  t.after(() => backend.close());
  await assert.rejects(backend.call("tabs", {}), errorCode("worker_unavailable"));
  await (backend as any).start();
  const controller = new AbortController();
  const waiting = backend.call("wait", { leaseId: "lease", timeoutMs: 1000, condition: { type: "text", value: "waiting" } }, "owner", controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(waiting, errorCode("worker_unavailable"));
  await assert.rejects(backend.call("action", { leaseId: "lease", action: "click", elementRef: "e", authorized: true, timeoutMs: 100 }), (error: unknown) => error instanceof BrowserError && error.code === "timed_out" && error.dispatched && error.verification === "timed_out");
  await assert.rejects(backend.call("tabs", {}), errorCode("restart_limited"));
});

test("worker death during concurrent pipe writes cannot terminate the connector", async t => {
  const temp = await mkdtemp(join(tmpdir(), "browser-pipe-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const worker = join(temp, "exit.py");
  await writeFile(worker, `import json,sys\nfor line in sys.stdin:\n r=json.loads(line)\n if r['method']=='hello': print(json.dumps({'id':r['id'],'ok':True,'result':{'protocol':1,'nodriver':'0.50.6'}}),flush=True)\n else: sys.exit(0)\n`);
  const backend = new BrowserBackend({ enabled: true, workerPath: worker, env: { ...process.env, OPENCODE_CONNECT_BROWSER_PYTHON: "/usr/bin/python3" } });
  t.after(() => backend.close());
  await (backend as any).start();
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => backend.call("tabs", { filter: "x".repeat(200) })));
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal((backend as any).worker, undefined);
});

const fixtureHtml = `<!doctype html><title>Browser fixture</title><h1>Test page</h1>
<label>Name <input aria-label="Name" id="name" oninput="document.getElementById('status').textContent='Name entered'"></label>
<button id="save" onclick="document.getElementById('status').textContent='Saved '+document.getElementById('name').value">Save</button>
<button id="trusted" onmousedown="document.getElementById('status').textContent='Trusted down '+event.isTrusted" onmousemove="document.getElementById('status').textContent='Trusted hover '+event.isTrusted" oncontextmenu="event.preventDefault();document.getElementById('status').textContent='Trusted context '+event.isTrusted" ondblclick="document.getElementById('status').textContent='Trusted double '+event.isTrusted">Native input test</button>
<input aria-label="Key receiver" value="Original" oninput="document.getElementById('status').textContent='Typed '+this.value">
<div draggable="true" role="button" aria-label="Drag source" ondragstart="event.dataTransfer.setData('text/plain','move')">Drag source</div>
<div role="button" aria-label="Drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.getElementById('status').textContent='Drop '+event.dataTransfer.getData('text/plain')">Drop target</div>
<select aria-label="Choice" onchange="document.getElementById('status').textContent='Choice '+this.value"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input aria-label="Upload" type="file" onchange="document.getElementById('status').textContent='Uploaded '+this.files[0].name">
<input type="password" value="private-password" aria-label="Password">
<button disabled>Disabled button</button>
<input readonly aria-label="Readonly" value="Fixed value">
<button onclick="this.remove()">Remove me</button><div id="status" role="status">Ready</div>
<a href="/next">Next page</a><iframe title="Fixture frame" src="/frame"></iframe>
<div style="height:80px;overflow:auto" role="region" aria-label="Scroll area" onscroll="document.getElementById('status').textContent='Wheel scrolled '+this.scrollTop"><div style="height:2000px">Scrollable</div></div>
<script>${"/* unneeded script data */".repeat(5000)}</script>`;

test("real Chrome browser acceptance and recovery", { skip: process.env.OPENCODE_CONNECT_BROWSER_TEST !== "1", timeout: 180000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "browser-acceptance-"));
  const python = await browserPython();
  let blockedRequest: (() => void) | undefined;
  let releaseBlocked: (() => void) | undefined;
  let iframeReloads = 0;
  let releaseIframe: (() => void) | undefined;
  const host = httpServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/blocked") { releaseBlocked = () => res.end("Released fixture"); blockedRequest?.(); return; }
    if (req.url === "/frame-auto") { res.end('<script>fetch("/frame-reload-gate").then(()=>location.replace("/frame?auto-reloaded"))</script>'); return; }
    if (req.url === "/frame-reload-gate") { releaseIframe = () => res.end("Reload now"); return; }
    if (req.url === "/frame?auto-reloaded") { iframeReloads++; res.end("Reloaded iframe"); return; }
    if (req.url === "/ad-reload") { res.end('<title>Iframe reload</title><iframe src="/frame-auto"></iframe>'); return; }
    res.end(req.url === "/frame" ? '<button onclick="document.body.append(\'Frame clicked\')">Frame button</button><button onclick="location.reload()">Reload frame</button>' : req.url === "/next" ? "<title>Next</title><h1>Navigation complete</h1><button>New document</button>" : fixtureHtml);
  });
  host.listen(0, "127.0.0.1"); await once(host, "listening");
  const addr = host.address(); assert.ok(addr && typeof addr !== "string");
  const pageUrl = `http://127.0.0.1:${addr.port}`;
  const reserve = httpServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const debugAddress = reserve.address(); assert.ok(debugAddress && typeof debugAddress !== "string");
  const cdpUrl = `http://127.0.0.1:${debugAddress.port}`;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const uploadRoot = join(temp, "uploads");
  const { mkdir } = await import("node:fs/promises"); await mkdir(uploadRoot);
  await writeFile(join(uploadRoot, "sample.txt"), "fixture upload");
  const env = { ...process.env, XDG_DATA_HOME: temp, OPENCODE_CONNECT_BROWSER_PYTHON: python, OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT: cdpUrl, OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS: uploadRoot };
  // The fixture owns an isolated process group; production systemd ownership
  // is exercised separately because Chrome must survive connector restarts.
  let backend = new BrowserBackend({ enabled: true, env, restartBackoffMs: 10, chromeLaunchMode: "direct" });
  let chromePid: number | null = null;
  t.after(async () => {
    backend.close();
    if (chromePid) { try { process.kill(-chromePid, "SIGTERM"); } catch {} }
    await new Promise<void>(resolve => host.close(() => resolve()));
    await sleep(300); await rm(temp, { recursive: true, force: true });
  });
  assert.equal((await backend.call("status", {})).reachable, false);
  const launched = await backend.call("launch", { headless: true });
  chromePid = launched.pid as number; assert.ok(chromePid);
  assert.ok((await readFile(`/proc/${chromePid}/cmdline`, "utf8")).includes("--hide-crash-restore-bubble"));
  const running = await backend.call("status", {});
  assert.ok((running.linuxProcesses as { pid: number; debugging: boolean }[]).some(item => item.pid === chromePid && item.debugging), "Running Linux Chrome is detected even when it rewrites its process title");
  assert.equal((await backend.call("launch", { headless: true })).reused, true);
  const newTab = async (url: string) => (await (await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json()) as { id: string };
  const one = await newTab(pageUrl + "/?token=private-token#private-fragment");
  const two = await newTab(pageUrl + "/next");
  const pageIds = async () => ((await (await fetch(cdpUrl + "/json/list")).json()) as { id: string; type: string }[]).filter(row => row.type === "page").map(row => row.id).sort();
  const baseline = await pageIds();
  let attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner");
  let leaseId = attached.leaseId as string;
  const snapshot = async () => await backend.call("snapshot", { leaseId }, "owner") as any;
  const getRef = async (name: string) => {
    const snap = await snapshot();
    const node = snap.nodes.find((node: any) => node.name === name && node.ref);
    assert.ok(node, `Missing reference: ${name} in ${JSON.stringify(snap)}`); return node.ref as string;
  };
  const act = (action: Record<string, unknown>) => backend.call("action", { leaseId, authorized: true, ...action }, "owner");
  await t.test("lease identity and competing callers fail closed", async () => {
    await assert.rejects(backend.call("attach", { targetId: two.id, controlMode: "control" }, "intruder"), errorCode("lease_conflict"));
    await assert.rejects(backend.call("snapshot", { leaseId }, "intruder"), errorCode("invalid_lease"));
    const tabs = await backend.call("tabs", {});
    assert.ok(!JSON.stringify(tabs).includes(leaseId));
    assert.ok(!JSON.stringify(tabs).includes("private-token"));
    assert.equal((await snapshot()).targetId, one.id);
  });
  await t.test("compact AX snapshots omit protected values and mark truncation", async () => {
    const snap = await snapshot();
    assert.ok(snap.nodes.some((node: any) => node.name === "Save"));
    assert.ok(snap.frames.length >= 2);
    assert.ok(JSON.stringify(snap).length < fixtureHtml.length / 5);
    assert.ok(!JSON.stringify(snap).includes("private-password"));
    assert.ok(!JSON.stringify(snap).includes("private-token"));
    assert.ok(snap.nodes.find((node: any) => node.name === "Disabled button").states.includes("disabled"));
    assert.equal((await backend.call("snapshot", { leaseId, maxNodes: 1 }, "owner")).truncated, true);
  });
  await t.test("native CDP events satisfy trusted pointer and keyboard interactions", async () => {
    assert.equal((await act({ action: "hover", elementRef: await getRef("Native input test"), expected: { type: "text", value: "Trusted hover true" } })).verification, "confirmed");
    assert.equal((await act({ action: "click", elementRef: await getRef("Native input test"), expected: { type: "text", value: "Trusted down true" } })).verification, "confirmed");
    assert.equal((await act({ action: "rightClick", elementRef: await getRef("Native input test"), expected: { type: "text", value: "Trusted context true" } })).verification, "confirmed");
    assert.equal((await act({ action: "doubleClick", elementRef: await getRef("Native input test"), expected: { type: "text", value: "Trusted double true" } })).verification, "confirmed");
    assert.equal((await act({ action: "keyCombo", elementRef: await getRef("Key receiver"), key: "A", modifiers: ["Control"] })).verification, "inconclusive");
    assert.equal((await act({ action: "typeText", elementRef: await getRef("Key receiver"), value: "New", expected: { type: "text", value: "Typed New" } })).verification, "confirmed");
    const refs = await snapshot();
    const sourceRef = refs.nodes.find((node: any) => node.name === "Drag source" && node.ref)?.ref;
    const targetRef = refs.nodes.find((node: any) => node.name === "Drop target" && node.ref)?.ref;
    assert.ok(sourceRef && targetRef);
    assert.equal((await act({ action: "drag", sourceRef, targetRef, expected: { type: "text", value: "Drop move" } })).verification, "confirmed");
    assert.equal((await act({ action: "wheel", elementRef: await getRef("Scroll area"), deltaX: 0, deltaY: 120 })).verification, "inconclusive");
  });
  await t.test("fill, click and expected conditions distinguish dispatch from success", async () => {
    assert.equal((await act({ action: "fill", elementRef: await getRef("Name"), value: "Operator", expected: { type: "text", value: "Name entered" } })).verification, "confirmed");
    assert.equal((await act({ action: "click", elementRef: await getRef("Save") })).verification, "inconclusive");
    assert.equal((await backend.call("wait", { leaseId, condition: { type: "text", value: "Saved Operator" } }, "owner")).verification, "confirmed");
    assert.equal((await act({ action: "select", elementRef: await getRef("Choice"), value: "b", expected: { type: "text", value: "Choice b" } })).verification, "confirmed");
    assert.equal((await act({ action: "keypress", elementRef: await getRef("Name"), key: "End" })).verification, "inconclusive");
    assert.equal((await act({ action: "scroll", elementRef: await getRef("Scroll area"), deltaY: 100 })).verification, "inconclusive");
    await assert.rejects(act({ action: "fill", elementRef: await getRef("Readonly"), value: "Forbidden" }), errorCode("invalid_element"));
  });
  await t.test("uploads require an explicitly selected file under authorized roots", async () => {
    const elementRef = await getRef("Upload");
    await assert.rejects(act({ action: "upload", elementRef, files: ["/etc/passwd"] }), errorCode("upload_denied"));
    assert.equal((await act({ action: "upload", elementRef, files: [join(uploadRoot, "sample.txt")], expected: { type: "text", value: "Uploaded sample.txt" } })).verification, "confirmed");
  });
  await t.test("same-origin iframe references resolve in their own document", async () => {
    assert.equal((await act({ action: "click", elementRef: await getRef("Frame button") })).verification, "inconclusive");
    assert.ok((await snapshot()).nodes.some((node: any) => node.name.includes("Frame clicked")));
    const snap = await snapshot();
    const old = snap.nodes.find((node: any) => node.name === "Frame button").ref;
    const reload = snap.nodes.find((node: any) => node.name === "Reload frame").ref;
    await act({ action: "click", elementRef: reload });
    await sleep(100);
    await assert.rejects(act({ action: "click", elementRef: old }), errorCode("stale_reference"));
  });
  await t.test("removed nodes and replaced snapshot IDs are never guessed", async () => {
    const elementRef = await getRef("Remove me");
    await act({ action: "click", elementRef });
    await assert.rejects(act({ action: "click", elementRef }), errorCode("stale_reference"));
    const stale = await getRef("Save"); await snapshot();
    await assert.rejects(act({ action: "click", elementRef: stale }), errorCode("stale_reference"));
  });
  await t.test("screenshots are bounded native image payloads", async () => {
    const result = await backend.call("screenshot", { leaseId, width: 640, height: 480 }, "owner");
    assert.ok((result.bytes as number) <= 1048576);
    assert.equal(Buffer.from(result.image as string, "base64").subarray(0, 2).toString("hex"), "ffd8");
  });
  await t.test("navigation invalidates prior element references", async () => {
    const elementRef = await getRef("Save");
    assert.equal((await act({ action: "navigate", url: pageUrl + "/next", expected: { type: "text", value: "Navigation complete" } })).verification, "confirmed");
    await assert.rejects(act({ action: "click", elementRef }), errorCode("stale_reference"));
  });
  await t.test("observe leases cannot mutate and normal detach preserves all tabs", async () => {
    await backend.call("detach", { leaseId }, "owner");
    attached = await backend.call("attach", { targetId: one.id, controlMode: "observe" }, "owner"); leaseId = attached.leaseId as string;
    await assert.rejects(act({ action: "navigate", url: pageUrl }), errorCode("observe_only"));
    await backend.call("detach", { leaseId }, "owner");
    assert.deepEqual(await pageIds(), baseline);
  });
  await t.test("worker crash and timeout recovery preserve Chrome and invalidate leases", async () => {
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    const worker = (backend as any).worker; process.kill(worker.pid, "SIGKILL"); await once(worker, "exit"); await sleep(20);
    await assert.rejects(snapshot(), errorCode("invalid_lease"));
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    await assert.rejects(backend.call("wait", { leaseId, timeoutMs: 200, condition: { type: "text", value: "Never appears" } }, "owner"), errorCode("timed_out"));
    await assert.rejects(snapshot(), errorCode("invalid_lease"));
    assert.equal((await backend.call("status", {})).reachable, true);
  });
  await t.test("redacted URL cannot confirm navigation without a document change", async () => {
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    await act({ action: "navigate", url: pageUrl + "/?token=hidden#fragment", expected: { type: "readyState", value: "complete" } });
    const observed = (await snapshot()).url;
    await assert.rejects(backend.call("wait", { leaseId, timeoutMs: 250, condition: { type: "navigation", fromUrl: observed } }, "owner"), errorCode("timed_out"));
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    assert.equal((await act({ action: "navigate", url: pageUrl + "/?token=hidden#fragment", expected: { type: "navigation", fromUrl: observed } })).verification, "confirmed");
    await backend.call("detach", { leaseId }, "owner");
  });
  await t.test("an unrelated iframe reload cannot confirm main-document navigation", async () => {
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    await act({ action: "navigate", url: pageUrl + "/ad-reload", expected: { type: "readyState", value: "complete" } });
    assert.ok(releaseIframe, "Iframe is loaded and waiting for the test trigger");
    const waiting = assert.rejects(backend.call("wait", { leaseId, timeoutMs: 3000, condition: { type: "navigation", fromUrl: pageUrl + "/ad-reload" } }, "owner"), errorCode("timed_out"));
    // The server releases the fetch; background-tab timer throttling cannot suppress the reload.
    await sleep(250);
    releaseIframe();
    await waiting;
    assert.ok(iframeReloads > 0, "Fixture iframe actually reloaded");
  });
  await t.test("separate HTTP requests share a lease and enforce verified ingress ownership", async () => {
    const events = await Events.open(join(temp, "events/store.json"), { authenticate: async context => ({ principal: context, clientId: "chatgpt", grantId: context, resource: "https://example.test/opencode-connect/mcp", scope: "opencode-connect:access", grantContext: "opaque" }) });
    const handler = createHttpHandler(undefined, undefined, events, backend);
    const version = "2026-07-28";
    let id = 0;
    const request = async (name: string, args: unknown, owner = "owner") => {
      const response = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": version, "mcp-method": "tools/call", "mcp-name": name, "x-host-ingress-auth-context": owner }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "browser-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
      return (await response.json()) as any;
    };
    try {
      const listResponse = await handler.fetch(new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": version, "mcp-method": "tools/list", "x-host-ingress-auth-context": "owner" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "browser-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } })
      }));
      const listed = (await listResponse.json()) as any;
      assert.equal(listResponse.status, 200, JSON.stringify(listed));
      const exposed = listed.result.tools as any[];
      assert.ok(!exposed.some(tool => tool.name === "browser.action"), "No generic action executor is exposed");
      for (const name of ["browser.hover", "browser.click", "browser.double_click", "browser.right_click", "browser.drag", "browser.key_combo", "browser.type_text", "browser.scroll_xy", "browser.scroll", "browser.navigate", "browser.fill", "browser.upload"]) {
        const tool = exposed.find(item => item.name === name);
        assert.ok(tool, "Missing MCP tool: "+name);
        for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof tool.annotations[hint], "boolean", name+" "+hint);
        assert.equal(tool.annotations.readOnlyHint, false, name);
        assert.equal(tool.annotations.openWorldHint, true, name);
      }
      assert.equal(exposed.find(item => item.name === "browser.click").annotations.destructiveHint, true);
      assert.equal(exposed.find(item => item.name === "browser.hover").annotations.destructiveHint, false);
      assert.equal(exposed.find(item => item.name === "browser.snapshot").annotations.readOnlyHint, true);
      assert.equal(exposed.find(item => item.name === "browser.snapshot").annotations.idempotentHint, false, "A fresh snapshot invalidates prior element refs");
      const reply = await request("browser.attach", { targetId: one.id, controlMode: "observe" });
      assert.ok(reply.result?.structuredContent?.leaseId, JSON.stringify(reply));
      const httpLease = reply.result.structuredContent.leaseId;
      const snap = await request("browser.snapshot", { leaseId: httpLease });
      assert.equal(snap.result.structuredContent.targetId, one.id);
      const denied = await request("browser.snapshot", { leaseId: httpLease }, "intruder");
      assert.equal(denied.result.structuredContent.errorCode, "invalid_lease");
      const refused = await request("browser.click", { leaseId: httpLease, authorized: true, elementRef: "e-not-observed" });
      assert.equal(refused.result.structuredContent.errorCode, "observe_only", "Named mutation tool honors observe-only lease");
      const shot = await request("browser.screenshot", { leaseId: httpLease, width: 300, height: 200 });
      assert.equal(shot.result.content[0].type, "image");
      assert.equal("image" in shot.result.structuredContent, false);
      await request("browser.detach", { leaseId: httpLease });
      const controlReply = await request("browser.attach", { targetId: one.id, controlMode: "control" });
      const controlId = controlReply.result?.structuredContent?.leaseId;
      assert.ok(controlId, JSON.stringify(controlReply));
      const nav = await request("browser.navigate", { leaseId: controlId, authorized: true, url: pageUrl, expected: { type: "text", value: "Test page" } });
      assert.equal(nav.result.structuredContent.verification, "confirmed");
      const visible = await request("browser.snapshot", { leaseId: controlId, filter: "Save" });
      const buttonRef = visible.result.structuredContent.nodes.find((node: any) => node.name === "Save" && node.ref)?.ref;
      assert.ok(buttonRef, "Observed click target through MCP");
      const clicked = await request("browser.click", { leaseId: controlId, authorized: true, elementRef: buttonRef, expected: { type: "text", value: "Saved" } });
      assert.equal(clicked.result.structuredContent.verification, "confirmed", JSON.stringify(clicked));
      await request("browser.detach", { leaseId: controlId });
    } finally { await handler.close(); await events.close(); }
    assert.equal((await fetch(cdpUrl + "/json/version")).ok, true);
    backend = new BrowserBackend({ enabled: true, env, chromeLaunchMode: "direct" });
  });
  await t.test("connector child normal and forced termination never closes Chrome", async () => {
    const script = `import {BrowserBackend} from ${JSON.stringify(join(root, "src/browser/backend.ts"))};const b=new BrowserBackend({enabled:true});await b.call('attach',{targetId:${JSON.stringify(one.id)},controlMode:'observe'});console.log('attached');process.stdin.resume();process.stdin.on('end',()=>{b.close();process.exit(0)});`;
    for (const forced of [false, true]) {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, env, stdio: "pipe" });
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("exit", code => reject(new Error("Connector child exited " + code))); });
      if (forced) child.kill("SIGKILL"); else child.stdin.end();
      await once(child, "exit"); await sleep(100);
      assert.equal((await fetch(cdpUrl + "/json/version")).ok, true);
      assert.deepEqual(await pageIds(), baseline);
    }
  });
  await t.test("forced connector exit reaps its worker during a blocked browser action", async () => {
    const script = `import {BrowserBackend} from ${JSON.stringify(join(root, "src/browser/backend.ts"))};const b=new BrowserBackend({enabled:true});const a=await b.call('attach',{targetId:${JSON.stringify(one.id)},controlMode:'control'});console.log(JSON.stringify({pid:b.worker.pid}));process.stdin.once('data',()=>{void b.call('action',{leaseId:a.leaseId,authorized:true,action:'navigate',url:${JSON.stringify(pageUrl + "/blocked")},timeoutMs:30000}).catch(()=>{});});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, env, stdio: "pipe" });
    t.after(() => { child.kill("SIGKILL"); releaseBlocked?.(); });
    const [data] = await once(child.stdout, "data");
    const workerPid = JSON.parse(data.toString()).pid;
    const blocked = new Promise<void>(resolve => { blockedRequest = resolve; });
    child.stdin.write("go"); await blocked;
    child.kill("SIGKILL"); await once(child, "exit");
    let running = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { const state = await readFile(`/proc/${workerPid}/stat`, "utf8"); running = state.split(") ")[1]?.[0] !== "Z"; } catch { running = false; }
      if (!running) break;
      await sleep(100);
    }
    assert.equal(running, false, "Owned worker exited after pipe EOF during its action");
    releaseBlocked?.(); blockedRequest = undefined;
    assert.equal((await fetch(cdpUrl + "/json/version")).ok, true);
    assert.deepEqual(await pageIds(), baseline);
  });
  await t.test("normal Python termination preserves Chrome and permits reattachment", async () => {
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    const worker = (backend as any).worker; process.kill(worker.pid, "SIGTERM"); await once(worker, "exit");
    assert.deepEqual(await pageIds(), baseline);
    backend.close(); backend = new BrowserBackend({ enabled: true, env, chromeLaunchMode: "direct" });
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    await backend.call("detach", { leaseId }, "owner");
  });
  await t.test("closed target and a replaced browser at the same port invalidate leases", async () => {
    const doomed = await newTab(pageUrl);
    attached = await backend.call("attach", { targetId: doomed.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    await fetch(cdpUrl + "/json/close/" + doomed.id);
    await assert.rejects(snapshot(), errorCode("target_closed"));
    attached = await backend.call("attach", { targetId: one.id, controlMode: "control" }, "owner"); leaseId = attached.leaseId as string;
    process.kill(-chromePid!, "SIGTERM");
    await sleep(800);
    const restarted = await backend.call("launch", { headless: true }); chromePid = restarted.pid as number;
    await assert.rejects(snapshot(), errorCode("disconnected"));
    assert.equal((await backend.call("status", {})).reachable, true);
  });
});
