import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { WindowsComputerBridge, type ComputerStep, type ComputerTransport } from "../src/computerBridge.js";
import { WINDOWS_COMPUTER_BRIDGE } from "../src/computerBridgeScript.js";
import { ComputerBackend } from "../src/computer.js";
import { computerObserveSchema, computerInteractSchema, locatorSchema } from "../src/computerSchema.js";
import { createServer } from "../src/mcp.js";
import { createHttpHandler } from "../src/http.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { nativeFixture } from "./native-fixture.js";
import { safeError } from "../src/bounds.js";

const handle = "0x1234";
const locator = { automationId: "Editor", ancestor: { name: "Pane" } };
const bounds = { x: -10, y: 20, width: 400, height: 300 };
const window = { handle, processId: 42, title: "App", bounds, executablePath: null, processName: "app" };
const state = { ...window, visible: true, minimized: false, maximized: false, foreground: true, enabled: true };
const element = { handle, name: "Editor", value: "hello", controlType: "Edit", automationId: "Editor", enabled: true, focused: true, offscreen: false, bounds, canInvoke: false, canSetValue: true };
const activation = { handle, isForeground: true };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXyoAAAAASUVORK5CYII=", "base64");
const get = { method: "GET", path: "/v1/windows" } as const;

class FakeProcess extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough();
  frames: { id: string; steps: ComputerStep[] }[] = [];
  killed = false;
  stdin = new Writable({ write: (chunk, _encoding, callback) => { this.frames.push(JSON.parse(chunk.toString())); callback(); } });
  kill() { this.killed = true; queueMicrotask(() => this.emit("exit", null)); return true; }
  child() { return this as unknown as ChildProcessWithoutNullStreams; }
  reply(index: number, results: unknown[], fragments = false) {
    const line = Buffer.from(JSON.stringify({ id: this.frames[index].id, ok: true, results }) + "\r\n");
    if (fragments) for (let i = 0; i < line.length; i++) this.stdout.write(line.subarray(i, i + 1));
    else this.stdout.write(line);
  }
}
function bridgeFixture(timeoutMs = 1000) {
  const processes: FakeProcess[] = [];
  const invocations: { executable: string; args: string[] }[] = [];
  const bridge = new WindowsComputerBridge({ timeoutMs, spawn: (executable, args) => {
    invocations.push({ executable, args });
    const child = new FakeProcess(); processes.push(child); return child.child();
  } });
  return { bridge, processes, invocations };
}
class FakeTransport implements ComputerTransport {
  calls: ComputerStep[][] = [];
  closed = false;
  constructor(public respond: (steps: ComputerStep[]) => unknown[] | Promise<unknown[]> = () => [{ success: true }]) {}
  async request(steps: ComputerStep[]) { this.calls.push(steps); return this.respond(steps); }
  close() { this.closed = true; }
}
async function mcpFixture(transport: ComputerTransport) {
  const native = nativeFixture(() => { throw new Error("must not access OpenCode"); });
  const server = createServer(new OpenCodeBackend(native.connect), new HostBackend(native.connect), undefined, new ComputerBackend(transport));
  const client = new Client({ name: "computer-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("bridge starts lazily, retains one process, correlates concurrent fragmented UTF-8 replies", async () => {
  const f = bridgeFixture();
  assert.equal(f.processes.length, 0);
  const first = f.bridge.request([get]); const second = f.bridge.request([get]);
  assert.equal(f.processes.length, 1);
  const child = f.processes[0];
  assert.notEqual(child.frames[0].id, child.frames[1].id);
  child.reply(1, [[{ title: "é😀" }]], true); child.reply(0, [[window]]);
  assert.deepEqual(await second, [[{ title: "é😀" }]]);
  assert.deepEqual(await first, [[window]]);
  const third = f.bridge.request([get]); child.reply(2, [[]]); await third;
  assert.equal(f.processes.length, 1);
  assert.equal(f.invocations[0].executable, process.env.OPENCODE_COMPUTER_PWSH ?? "/mnt/c/Program Files/PowerShell/7/pwsh.exe");
  assert.deepEqual(f.invocations[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(Buffer.from(f.invocations[0].args[4], "base64").toString("utf16le"), WINDOWS_COMPUTER_BRIDGE);
  f.bridge.close();
});

test("bridge rejects every pending call on exit, restarts lazily, ignores stale child exit", async () => {
  const f = bridgeFixture();
  const a = f.bridge.request([get]); const b = f.bridge.request([get]);
  const rejected = Promise.all([assert.rejects(a, /exited/), assert.rejects(b, /exited/)]);
  f.processes[0].emit("exit", 1); await rejected;
  assert.equal(f.processes.length, 1);
  const next = f.bridge.request([get]);
  f.processes[0].emit("exit", 1);
  f.processes[1].reply(0, [[]]); assert.deepEqual(await next, [[]]);
  f.bridge.close();
});

test("bridge bounded timeout kills child and rejects all calls; next call can recover", async () => {
  const f = bridgeFixture(15);
  await Promise.all([assert.rejects(f.bridge.request([get]), /timed out/), assert.rejects(f.bridge.request([get]), /timed out/)]);
  assert.equal(f.processes[0].killed, true);
  const next = f.bridge.request([get]); f.processes[1].reply(0, [[]]); await next;
  f.bridge.close(); await assert.rejects(f.bridge.request([get]), /closed/);
});

test("bridge rejects malformed, oversized, unknown-ID and wrong-count replies without leaking raw bytes", async () => {
  for (const kind of ["malformed", "oversized", "unknown", "count"]) {
    const f = bridgeFixture();
    const promise = f.bridge.request([get]);
    const rejected = assert.rejects(promise, (error: unknown) => {
      assert.equal(safeError(error).includes("PRIVATE-BEARER"), false); return true;
    });
    const child = f.processes[0];
    child.stderr.write("PRIVATE-BEARER".repeat(10000));
    const data = kind === "malformed" ? "PRIVATE-BEARER\n" : kind === "oversized" ? "PRIVATE-BEARER".repeat(170000)
      : JSON.stringify({ id: kind === "unknown" ? "wcu-999" : child.frames[0].id, ok: true, results: kind === "count" ? [[], []] : [[]] }) + "\n";
    child.stdout.write(data); await rejected;
    assert.equal(child.killed, true); f.bridge.close();
  }
});

test("bridge maps fixed upstream errors safely and does not restart for a bounded HTTP failure", async () => {
  const f = bridgeFixture(); const call = f.bridge.request([get]);
  f.processes[0].stdout.write(JSON.stringify({ id: f.processes[0].frames[0].id, ok: false, code: "http", status: 409, completedSteps: 1 }) + "\n");
  await assert.rejects(call, /status 409, completed steps 1.*reconcile/);
  const next = f.bridge.request([get]); f.processes[0].reply(1, [[]]); await next;
  assert.equal(f.processes.length, 1); f.bridge.close();
});

test("bridge spawn and stream errors omit sensitive exception details", async () => {
  const bridge = new WindowsComputerBridge({ spawn: () => { throw new Error("PRIVATE-BEARER"); } });
  await assert.rejects(bridge.request([get]), (error) => !safeError(error).includes("PRIVATE-BEARER"));
  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    const f = bridgeFixture(); const p = f.bridge.request([get]);
    f.processes[0][stream].emit("error", new Error("PRIVATE-BEARER"));
    await assert.rejects(p, (error) => !safeError(error).includes("PRIVATE-BEARER")); f.bridge.close();
  }
});

test("bridge bounds admission and frame size, and close releases pending requests", async () => {
  const f = bridgeFixture();
  await assert.rejects(f.bridge.request([]), /1..3/);
  await assert.rejects(f.bridge.request([{ ...get, body: "x".repeat(65536) }]), /64 KiB/);
  const calls = Array.from({ length: 64 }, () => f.bridge.request([get]));
  const rejected = calls.map((p) => assert.rejects(p, /closed/));
  await assert.rejects(f.bridge.request([get]), /64 pending/);
  f.bridge.close(); await Promise.all(rejected);
});

test("Windows script owns DPAPI and authorization, disables proxy/redirects and exports fixed errors only", () => {
  assert.match(WINDOWS_COMPUTER_BRIDGE, /ProtectedData\]::Unprotect/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /DataProtectionScope\]::CurrentUser/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /'token.dpapi'/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /http:\/\/127\.0\.0\.1:17842/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /AuthenticationHeaderValue\]::new\('Bearer', \$token\)/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /\$handler.UseProxy = \$false/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /\$handler.AllowAutoRedirect = \$false/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /\$encoded.Contains\(\$token/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /CancellationTokenSource\]::new\(10000\)/);
  assert.equal(WINDOWS_COMPUTER_BRIDGE.includes('$_'), false);
});

test("computer input schemas preserve exact locator semantics and WCU limits", () => {
  assert.deepEqual(locatorSchema.parse(locator), locator);
  for (const bad of [{}, { name: " " }, { name: "x".repeat(257) }, { name: "x", fuzzy: true }, { name: "x", ancestor: {} }, { name: "x", ancestor: { name: "a", ancestor: { name: "b" } } }]) assert.equal(locatorSchema.safeParse(bad).success, false);
  assert.equal(computerObserveSchema.safeParse({ type: "find", handle, locator, maxDepth: 0, maxResults: 100, maxNodes: 2000 }).success, true);
  for (const bad of [{ type: "state", handle: "invalid" }, { type: "state", handle: "0" }, { type: "state", handle: "0x8000000000000000" }, { type: "find", handle, locator, maxResults: 101 }, { type: "windows", activate: true }]) assert.equal(computerObserveSchema.safeParse(bad).success, false);
  for (const bad of [{ action: "keySequence", chords: [{ key: 65 }], activate: true }, { action: "keySequence", chords: [{ key: 65, modifiers: [17, 17] }] }, { action: "keySequence", chords: [{ key: 17, modifiers: [17] }] }, { action: "keySequence", chords: [{ key: "A" }] }, { action: "scroll", delta: 0 }, { action: "scroll", delta: 120, x: 1 }, { action: "click", x: 0, y: 0, button: "middle", count: 1 }, { action: "setValue", handle, locator, value: "x".repeat(4097) }]) assert.equal(computerInteractSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("backend maps every observe variant to its canonical WCU endpoint and validates data", async () => {
  const found = { handle, elements: [], visitedNodes: 10, complete: true };
  const capabilities = { apiVersion: "v1", hostVersion: "0.3.0", locatorFields: ["automationId", "name", "controlType"], semanticActions: [], inputActions: [], windowActions: [], limits: Object.fromEntries(["maxLocatorDepth", "maxLocatorNodes", "maxLocatorTextLength", "maxFindResults", "maxKeySequence", "maxVirtualKey", "maxWheelDelta", "maxTextLength", "maxValueLength", "maxTreeDepth", "maxTreeNodes", "maxClickCount"].map((key) => [key, 1])) };
  const transport = new FakeTransport(([step]) => [step.path === "/v1/capabilities" ? capabilities : step.path === "/v1/windows" ? [window] : step.path.endsWith("/state") ? state : step.path.endsWith("/find") ? found : element]);
  const backend = new ComputerBackend(transport);
  assert.equal((await backend.observe({ type: "capabilities" })).type, "capabilities");
  await backend.observe({ type: "windows" }); await backend.observe({ type: "state", handle });
  await backend.observe({ type: "find", handle, locator, maxResults: 4, maxNodes: 100, maxDepth: 3 });
  await backend.observe({ type: "inspect", handle, locator });
  assert.deepEqual(transport.calls.map(([step]) => [step.method, step.path]), [["GET", "/v1/capabilities"], ["GET", "/v1/windows"], ["GET", `/v1/windows/${handle}/state`], ["POST", "/v1/elements/find"], ["POST", "/v1/elements/inspect"]]);
  assert.deepEqual(transport.calls[3][0].body, { handle, locator, maxResults: 4, maxNodes: 100, maxDepth: 3 });
  transport.respond = () => [{ foreground: "true" }];
  await assert.rejects(backend.observe({ type: "state", handle }));
});

test("backend composes explicit activation, semantic action and immediate default readback atomically", async () => {
  const transport = new FakeTransport((steps) => steps.map((step) => step.path.endsWith("/activate") ? activation : step.path.endsWith("/inspect") || step.path.endsWith("/focus") ? element : { success: true }));
  const backend = new ComputerBackend(transport);
  for (const action of ["focus", "setValue", "invoke"] as const) {
    const input = action === "setValue" ? { action, handle, locator, value: "hello", activate: true } : { action, handle, locator, activate: true };
    const result = await backend.interact(input);
    assert.deepEqual("state" in result && result.state, element);
    assert.deepEqual("activation" in result && result.activation, activation);
    const steps = transport.calls.at(-1)!;
    assert.equal(steps.length, 3);
    assert.equal(steps[0].path, `/v1/windows/${handle}/activate`);
    assert.equal(steps[1].path, action === "focus" ? "/v1/elements/focus" : `/v1/actions/${action === "invoke" ? "invoke-located" : "set-value-located"}`);
    assert.deepEqual(steps[2], { method: "POST", path: "/v1/elements/inspect", body: { handle, locator } });
  }
  await backend.interact({ action: "invoke", handle, locator });
  assert.equal(transport.calls.at(-1)!.length, 2);
  assert.equal(transport.calls.at(-1)![0].path, "/v1/actions/invoke-located");
  const result = await backend.interact({ action: "invoke", handle, locator, readback: false });
  assert.equal("state" in result, false); assert.equal(transport.calls.at(-1)!.length, 1);
});

test("backend maps pointer/window/key actions without implicit foreground activation", async () => {
  const transport = new FakeTransport((steps) => steps.map((step) => step.path.endsWith("/activate") ? activation : step.path.endsWith("/close") ? { handle, requestPosted: true, disappeared: false } : { success: true }));
  const backend = new ComputerBackend(transport);
  await backend.interact({ action: "activate", handle }); await backend.interact({ action: "close", handle });
  await backend.interact({ action: "move", x: -20, y: 100 }); await backend.interact({ action: "click", x: 1, y: 2, button: "right", count: 2 });
  await backend.interact({ action: "scroll", delta: -120, x: 0, y: 0 });
  await backend.interact({ action: "keySequence", chords: [{ key: 65 }], handle });
  assert.equal(transport.calls.at(-1)!.length, 1);
  assert.deepEqual(transport.calls.at(-1)![0].body, { chords: [{ key: 65, modifiers: [] }] });
  await backend.interact({ action: "keySequence", chords: [{ key: 65, modifiers: [17] }], handle, activate: true });
  assert.deepEqual(transport.calls.at(-1)!.map((s) => s.path), [`/v1/windows/${handle}/activate`, "/v1/input/key-sequence"]);
  assert.deepEqual(transport.calls.slice(0, 5).map(([s]) => s.path), [`/v1/windows/${handle}/activate`, `/v1/windows/${handle}/close`, "/v1/input/move", "/v1/input/pointer-click", "/v1/input/scroll"]);
  const count = transport.calls.length;
  await assert.rejects(backend.interact({ action: "keySequence", chords: [{ key: 65 }], activate: true }));
  assert.equal(transport.calls.length, count);
});

test("backend captures desktop/window PNG with safe metadata and enforces image limits", async () => {
  const transport = new FakeTransport(() => [{ png: png.toString("base64") }]); const backend = new ComputerBackend(transport);
  const desktop = await backend.screenshot({}); assert.equal(desktop.metadata.target, "desktop");
  assert.deepEqual(desktop.metadata, { target: "desktop", mimeType: "image/png", size: png.length, width: 1, height: 1 });
  assert.equal((await backend.screenshot({ handle })).metadata.handle, handle);
  assert.deepEqual(transport.calls.map(([s]) => s.path), ["/v1/desktop/screenshot", `/v1/windows/${handle}/screenshot`]);
  transport.respond = () => [{ png: Buffer.alloc(1_048_577).toString("base64") }];
  await assert.rejects(backend.screenshot({}), /1 MiB/);
  transport.respond = () => [{ png: Buffer.from("not PNG").toString("base64") }];
  await assert.rejects(backend.screenshot({}), /not a PNG/);
});

test("real MCP discovery publishes all discriminants, fields, annotations and validated output schemas", async () => {
  const f = await mcpFixture(new FakeTransport(() => [[window]]));
  try {
    const { tools } = await f.client.listTools();
    for (const [name, discriminator, variants] of [["computer.observe", "type", ["capabilities", "windows", "state", "find", "inspect"]], ["computer.interact", "action", ["activate", "focus", "setValue", "invoke", "keySequence", "move", "click", "scroll", "close"]]] as const) {
      const tool = tools.find((t) => t.name === name)!;
      assert.deepEqual((tool.inputSchema.properties![discriminator] as { enum: string[] }).enum, [...variants]);
      assert.equal(typeof tool.inputSchema.properties!.handle, "object");
      assert.equal(typeof tool.inputSchema.properties!.locator, "object");
      const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
      const valid = name === "computer.observe" ? { type: "inspect", handle, locator } : { action: "setValue", handle, locator, value: "x", activate: true, readback: true };
      assert.equal(validate(valid).valid, true); assert.equal(validate({ ...valid, locator: {} }).valid, false);
      assert.equal(validate(name === "computer.observe" ? { type: "state" } : { action: "keySequence", chords: [{ key: 65 }], activate: true }).valid, false);
    }
    for (const name of ["computer.observe", "computer.screenshot"]) assert.deepEqual(tools.find((t) => t.name === name)!.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
    assert.deepEqual(tools.find((t) => t.name === "computer.interact")!.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false });
    const result = await f.client.callTool({ name: "computer.observe", arguments: { type: "windows" } });
    assert.equal(result.isError, undefined);
    assert.equal(new AjvJsonSchemaValidator().getValidator(tools.find((t) => t.name === "computer.observe")!.outputSchema!)(result.structuredContent).valid, true);
    const invalid = await f.client.callTool({ name: "computer.interact", arguments: { action: "keySequence", chords: [{ key: 65 }], activate: true } });
    assert.equal(invalid.isError, true);
  } finally { await f.close(); }
});

test("MCP screenshot returns exactly one image with no duplicate base64 structured text", async () => {
  const transport = new FakeTransport(() => [{ png: png.toString("base64") }]);
  const f = await mcpFixture(transport);
  try {
    const response = await f.client.callTool({ name: "computer.screenshot", arguments: {} });
    const content = response.content as { type: string; data: string; mimeType: string }[];
    assert.equal(content.length, 1); assert.equal(content[0].type, "image"); assert.equal(content[0].mimeType, "image/png");
    assert.equal(content[0].data, png.toString("base64"));
    assert.equal(JSON.stringify(response.structuredContent).includes(content[0].data), false);
    const tool = (await f.client.listTools()).tools.find((t) => t.name === "computer.screenshot")!;
    assert.equal(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid, true);
    const large = Buffer.concat([png, Buffer.alloc(1_048_576 - png.length)]);
    transport.respond = () => [{ png: large.toString("base64") }];
    const bounded = await f.client.callTool({ name: "computer.screenshot", arguments: {} });
    assert.notEqual(bounded.isError, true);
    assert.equal((bounded.structuredContent as { size: number }).size, 1_048_576);
    assert.equal((bounded.content as unknown[]).length, 1);
    transport.respond = () => [{ png: Buffer.alloc(1_048_577).toString("base64") }];
    const oversized = await f.client.callTool({ name: "computer.screenshot", arguments: {} });
    assert.equal(oversized.isError, true);
    assert.match((oversized.structuredContent as { error: string }).error, /1 MiB/);
    assert.deepEqual(oversized.content, []);
  } finally { await f.close(); }
});

test("MCP failures omit upstream bodies and reject malformed native results visibly", async () => {
  const transport = new FakeTransport(() => { throw new Error("PRIVATE-BEARER"); });
  const f = await mcpFixture(transport);
  try {
    for (const args of [{ type: "windows" }, { type: "inspect", handle, locator }]) {
      const response = await f.client.callTool({ name: "computer.observe", arguments: args });
      assert.equal(response.isError, true); assert.equal(JSON.stringify(response).includes("PRIVATE-BEARER"), false);
    }
    transport.respond = () => [{ malformed: "PRIVATE-BEARER" }];
    const bad = await f.client.callTool({ name: "computer.interact", arguments: { action: "invoke", handle, locator } });
    assert.equal(bad.isError, true); assert.equal(JSON.stringify(bad).includes("PRIVATE-BEARER"), false);
  } finally { await f.close(); }
});

test("HTTP MCP exchanges share one lazy ComputerBackend/Windows process; handler close owns its lifecycle", async () => {
  const f = bridgeFixture();
  const computer = new ComputerBackend(f.bridge);
  const native = nativeFixture(() => { throw new Error("must not touch OpenCode"); });
  const handler = createHttpHandler(new OpenCodeBackend(native.connect), new HostBackend(native.connect), undefined, computer);
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "computer-http", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const call = (id: number) => handler.fetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-method": "tools/call", "mcp-name": "computer.observe", "mcp-protocol-version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer.observe", arguments: { type: "windows" }, _meta: meta } }) }));
  try {
    for (let id = 1; id <= 2; id++) {
      const response = call(id);
      while (f.processes[0]?.frames.length !== id) await new Promise((resolve) => setTimeout(resolve, 1));
      f.processes[0].reply(id - 1, [[window]]);
      const body = await (await response).json() as any;
      assert.notEqual(body.result.isError, true); assert.deepEqual(body.result.structuredContent.data, [window]);
    }
    assert.equal(f.processes.length, 1);
  } finally { await handler.close(); }
  assert.equal(f.processes[0].killed, true);
});


test("tool text travels literally through NDJSON without being inserted into PowerShell source", async () => {
  const f = bridgeFixture();
  const backend = new ComputerBackend(f.bridge);
  const value = '$([Console]::WriteLine("INJECTION"))`n\n"é😀"';
  const call = backend.interact({ action: "setValue", handle, locator, value });
  assert.deepEqual(f.processes[0].frames[0].steps[0].body, { handle, locator, value });
  assert.equal(Buffer.from(f.invocations[0].args[4], "base64").toString("utf16le").includes(value), false);
  f.processes[0].reply(0, [{ success: true }, { ...element, value }]);
  const result = await call;
  assert.equal("state" in result && result.state?.value, value);
  f.bridge.close();
});

test("failed readback returns an MCP error identifying completed action steps, without automatic replay", async () => {
  const f = bridgeFixture(); const mcp = await mcpFixture(f.bridge);
  try {
    const call = mcp.client.callTool({ name: "computer.interact", arguments: { action: "invoke", handle, locator } });
    while (!f.processes[0]?.frames.length) await new Promise((resolve) => setTimeout(resolve, 1));
    f.processes[0].stdout.write(JSON.stringify({ id: f.processes[0].frames[0].id, ok: false, code: "http", status: 404, completedSteps: 1 }) + "\n");
    const result = await call;
    assert.equal(result.isError, true);
    assert.match((result.structuredContent as { error: string }).error, /completed steps 1.*reconcile/);
    assert.equal(f.processes[0].frames.length, 1);
    assert.equal(f.processes.length, 1);
  } finally { await mcp.close(); f.bridge.close(); }
});


test("standalone server owns its default backend; a supplied backend outlives individual servers", async () => {
  const native = nativeFixture(() => { throw new Error("must not touch OpenCode"); });
  const owned = createServer(new OpenCodeBackend(native.connect), new HostBackend(native.connect));
  assert.equal(typeof owned.server.onclose, "function");
  await owned.close();
  const transport = new FakeTransport(() => [[window]]);
  const computer = new ComputerBackend(transport);
  for (let index = 0; index < 2; index++) {
    const server = createServer(new OpenCodeBackend(native.connect), new HostBackend(native.connect), undefined, computer);
    const client = new Client({ name: "computer-lifecycle", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    await client.callTool({ name: "computer.observe", arguments: { type: "windows" } });
    await client.close(); await server.close();
    assert.equal(transport.closed, false);
  }
  computer.close(); assert.equal(transport.closed, true);
});
