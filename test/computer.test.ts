import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { WindowsComputerBridge, ComputerBridgeError, type ComputerStep, type ComputerTransport } from "../src/computerBridge.js";
import { WINDOWS_COMPUTER_BRIDGE } from "../src/computerBridgeScript.js";
import { ComputerBackend, type ComputerTiming } from "../src/computer.js";
import { computerObserveSchema, computerInteractSchema, computerSequenceSchema, computerWaitSchema, computerOutputSchemas, locatorSchema } from "../src/computerSchema.js";
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
    for (const [name, discriminator, variants] of [["computer.observe", "type", ["capabilities", "windows", "state", "find", "inspect"]], ["computer.interact", "action", ["activate", "focus", "setValue", "invoke", "keySequence", "move", "click", "scroll", "drag", "close"]]] as const) {
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

function fakeTiming() {
  let time = 0;
  const sleeps: number[] = [];
  const timing: ComputerTiming = { now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; } };
  return { timing, sleeps, advance: (ms: number) => { time += ms; } };
}
const move = { action: "move", x: 1, y: 2 } as const;
const windowWait = { action: "waitFor", condition: { type: "windowPresent", title: "App", expected: true } } as const;
const absenceWait = { action: "waitFor", condition: { type: "elementState", handle, locator, predicate: { type: "exists", expected: false } } } as const;
const drag = { action: "drag", points: [{ x: -10, y: 20 }, { x: 100, y: -50 }], durationMs: 250, stepsPerSegment: 16 } as const;
const dragInput = { ...drag, points: [...drag.points] };
const dragResult = { success: true, metadata: { elapsedMs: 252.5, emittedInputCount: 19, steps: 16 } };

test("sequence rejects empty, oversize, code and invalid later steps before any mutation; accepts 32", async () => {
  const transport = new FakeTransport();
  const backend = new ComputerBackend(transport);
  for (const input of [{ steps: [] }, { steps: Array(33).fill(move) }, { steps: [move, { action: "screenshot" }] }, { steps: [move, { action: "keySequence", chords: [{ key: 65 }], activate: true }] }, { steps: [move], continueOnError: true }, { steps: [{ action: "shell", command: "echo x" }] }, { steps: [move, { action: "scroll", delta: 10, x: 1 }] }]) {
    assert.equal(computerSequenceSchema.safeParse(input).success, false);
    assert.throws(() => backend.sequence(input as never));
  }
  assert.equal(transport.calls.length, 0);
  const result = await backend.sequence({ steps: Array(32).fill(move) });
  assert.equal(result.completedSteps, 32); assert.equal(result.stoppedAt, null); assert.equal(result.success, true);
  assert.equal(transport.calls.length, 32);
});

test("drag preserves exact body and WCU metadata in interact and sequence, with point/move bounds", async () => {
  const clock = fakeTiming();
  const transport = new FakeTransport(() => { clock.advance(260); return [dragResult]; });
  const backend = new ComputerBackend(transport, clock.timing);
  assert.deepEqual(await backend.interact(dragInput), { action: "drag", result: dragResult });
  assert.deepEqual(transport.calls[0], [{ method: "POST", path: "/v1/input/drag", body: { points: dragInput.points, durationMs: 250, stepsPerSegment: 16 } }]);
  const result = await backend.sequence({ steps: [dragInput] });
  assert.deepEqual(result.results[0], { index: 0, success: true, result: { action: "drag", result: dragResult }, elapsedMs: 260 });
  assert.equal(result.totalElapsedMs, 260);
  const points = Array.from({ length: 128 }, () => ({ x: 0, y: 0 }));
  assert.equal(computerInteractSchema.safeParse({ action: "drag", points }).success, true);
  assert.equal(computerInteractSchema.safeParse({ action: "drag", points, stepsPerSegment: 4 }).success, true);
  assert.equal(computerInteractSchema.safeParse({ action: "drag", points: points.slice(0, 2), stepsPerSegment: 511 }).success, true);
  for (const input of [{ ...dragInput, points: [] }, { ...dragInput, points: points.slice(0, 1) }, { ...dragInput, points: [...points, points[0]] }, { ...dragInput, durationMs: 5001 }, { ...dragInput, durationMs: -1 }, { ...dragInput, stepsPerSegment: 0 }, { ...dragInput, stepsPerSegment: 512 }, { action: "drag", points, stepsPerSegment: 5 }, { ...dragInput, button: "left" }, { ...dragInput, points: [{ x: 0.1, y: 0 }, { x: 0, y: 0 }] }]) assert.equal(computerInteractSchema.safeParse(input).success, false);
  transport.respond = () => [{ success: true, metadata: { ...dragResult.metadata, elapsedMs: -1 } }];
  await assert.rejects(backend.interact(dragInput));
});

test("sequence reuses every interact composition and timing in exact order", async () => {
  const clock = fakeTiming();
  const transport = new FakeTransport((steps) => { clock.advance(7); return steps.map((s) => s.path.endsWith("/activate") ? activation : s.path.endsWith("/close") ? { handle, requestPosted: true, disappeared: false } : s.path.endsWith("/inspect") || s.path.endsWith("/focus") ? element : s.path.endsWith("/drag") ? dragResult : { success: true }); });
  const backend = new ComputerBackend(transport, clock.timing);
  const steps = computerSequenceSchema.parse({ steps: [
    { action: "activate", handle }, { action: "focus", handle, locator, activate: true },
    { action: "setValue", handle, locator, value: "exact", activate: true }, { action: "invoke", handle, locator, readback: false },
    { action: "keySequence", chords: [{ key: 65 }], activate: true, handle }, move,
    { action: "click", x: 0, y: 1, button: "left", count: 1 }, { action: "scroll", delta: 120 }, dragInput, { action: "close", handle },
  ] }).steps;
  const individual = [];
  for (const step of steps) individual.push(await backend.interact(step as never));
  const expectedCalls = [...transport.calls]; transport.calls = [];
  const result = await backend.sequence({ steps });
  assert.deepEqual(transport.calls, expectedCalls);
  assert.deepEqual(result.results.map((r) => r.success && r.result), individual);
  assert.deepEqual(result.results.map((r) => r.elapsedMs), Array(10).fill(7));
  assert.equal(result.totalElapsedMs, 70); assert.equal(result.completedSteps, 10); assert.equal(result.stoppedAt, null);
  assert.deepEqual(transport.calls[4][1].body, { chords: [{ key: 65, modifiers: [] }] });
});

test("sequence stops on first uncertain bridge failure without retry and retains acknowledged composition count", async () => {
  const f = bridgeFixture(); const clock = fakeTiming(); const backend = new ComputerBackend(f.bridge, clock.timing);
  const call = backend.sequence({ steps: [move, { action: "invoke", handle, locator }, move] });
  f.processes[0].reply(0, [{ success: true }]);
  while (f.processes[0].frames.length < 2) await new Promise((resolve) => setImmediate(resolve));
  clock.advance(12);
  f.processes[0].stdout.write(JSON.stringify({ id: f.processes[0].frames[1].id, ok: false, code: "http", status: 404, completedSteps: 1 }) + "\n");
  const result = await call;
  assert.equal(result.success, false); assert.equal(result.completedSteps, 1); assert.equal(result.stoppedAt, 1);
  assert.equal(result.results.length, 2);
  const failed = result.results[1]; assert.equal(failed.success, false);
  if (!failed.success) { assert.equal(failed.error.code, "http"); assert.equal(failed.error.completedSteps, 1); assert.equal(failed.error.status, 404); }
  assert.equal(failed.elapsedMs, 12); assert.equal(result.totalElapsedMs, 12);
  assert.equal(f.processes.length, 1); assert.equal(f.processes[0].frames.length, 2);
  f.bridge.close();
});

test("sequence surfaces safe failure for transport loss, invalid output and reported action failure", async () => {
  for (const respond of [() => { throw new ComputerBridgeError("timeout"); }, () => { throw new Error("PRIVATE-BEARER"); }, () => [{ private: "PRIVATE-BEARER" }], () => [{ success: false }]]) {
    const transport = new FakeTransport(respond);
    const result = await new ComputerBackend(transport).sequence({ steps: [move, move] });
    assert.equal(result.success, false); assert.equal(result.completedSteps, 0); assert.equal(result.stoppedAt, 0);
    assert.equal(transport.calls.length, 1); assert.equal(JSON.stringify(result).includes("PRIVATE-BEARER"), false);
  }
});

test("waitFor schemas require exact targets, typed predicates and bounded timers; waits are sequence-only", () => {
  for (const input of [windowWait, absenceWait]) assert.equal(computerWaitSchema.safeParse(input).success, true);
  assert.equal(computerInteractSchema.safeParse(windowWait).success, false);
  for (const input of [
    { ...windowWait, timeoutMs: 10001 }, { ...windowWait, timeoutMs: -1 }, { ...windowWait, pollIntervalMs: 49 }, { ...windowWait, pollIntervalMs: 1001 },
    { ...windowWait, condition: { type: "windowPresent", expected: true } }, { ...windowWait, condition: { ...windowWait.condition, handle } },
    { ...absenceWait, condition: { ...absenceWait.condition, locator: {} } },
    { ...absenceWait, condition: { ...absenceWait.condition, predicate: { type: "exists", expected: "false" } } },
    { ...absenceWait, condition: { ...absenceWait.condition, predicate: { type: "valueEquals", expected: true } } },
    { ...absenceWait, condition: { ...absenceWait.condition, predicate: { type: "contains", expected: "App" } } },
    { ...windowWait, condition: { ...windowWait.condition, fuzzy: true } },
  ]) assert.equal(computerWaitSchema.safeParse(input).success, false);
});

test("windowPresent polls exact titles and handles, succeeds after polls and respects present=false", async () => {
  const clock = fakeTiming(); let polls = 0;
  const transport = new FakeTransport(([step]) => step.method === "GET" ? [[{ ...window, title: ++polls < 3 ? "app" : "App" }]] : [{ success: true }]);
  const backend = new ComputerBackend(transport, clock.timing);
  const result = await backend.sequence({ steps: [windowWait, move] });
  assert.equal(result.completedSteps, 2); assert.equal(result.success, true);
  assert.deepEqual(result.results[0], { index: 0, success: true, elapsedMs: 200, result: { action: "waitFor", satisfied: true, polls: 3 } });
  assert.deepEqual(clock.sleeps, [100, 100]);
  assert.deepEqual(transport.calls.slice(0, 3), Array(3).fill([{ method: "GET", path: "/v1/windows" }]));
  transport.respond = () => [[window]];
  for (const condition of [{ type: "windowPresent", handle, expected: true }, { type: "windowPresent", handle: "0X00001234", expected: true }, { type: "windowPresent", title: "Different", expected: false }, { type: "windowPresent", title: "app", expected: false }]) assert.equal((await backend.sequence({ steps: [{ action: "waitFor", condition } as never] })).success, true);
});

test("waitFor timeout is machine-readable, uses remaining bounded sleep and stops before mutation", async () => {
  const clock = fakeTiming();
  const transport = new FakeTransport(() => [[]]);
  const result = await new ComputerBackend(transport, clock.timing).sequence({ steps: [{ ...windowWait, timeoutMs: 250 }, move] });
  assert.equal(result.success, false); assert.equal(result.completedSteps, 0); assert.equal(result.stoppedAt, 0);
  assert.equal(result.totalElapsedMs, 250); assert.equal(result.results[0].elapsedMs, 250);
  const failed = result.results[0]; if (!failed.success) { assert.equal(failed.error.code, "wait_timeout"); assert.equal(failed.error.polls, 4); }
  assert.deepEqual(clock.sleeps, [100, 100, 50]); assert.equal(transport.calls.length, 4);
  const zero = await new ComputerBackend(transport, clock.timing).sequence({ steps: [{ ...windowWait, timeoutMs: 0 }] });
  assert.equal(zero.success, false); assert.equal(zero.totalElapsedMs, 0);

  let now = 0;
  const advancingTiming: ComputerTiming = {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
  const immediate = new FakeTransport(async () => { now += 1; return [[window]]; });
  const satisfiedZero = await new ComputerBackend(immediate, advancingTiming).sequence({
    steps: [{ ...windowWait, timeoutMs: 0 }],
  });
  assert.equal(satisfiedZero.success, true);
  assert.equal(satisfiedZero.completedSteps, 1);
  assert.equal(satisfiedZero.results[0].success, true);
});

test("elementState predicates inspect exact locators; exists=true tolerates absent polls and exists=false satisfies absence only", async () => {
  for (const predicate of [{ type: "exists", expected: true }, { type: "focused", expected: true }, { type: "enabled", expected: true }, { type: "valueEquals", expected: "hello" }, { type: "nameEquals", expected: "Editor" }, { type: "valueEquals", expected: null }]) {
    const transport = new FakeTransport(() => [{ ...element, ...(predicate.expected === null ? { value: null } : {}) }]);
    assert.equal((await new ComputerBackend(transport).sequence({ steps: [{ action: "waitFor", condition: { type: "elementState", handle, locator, predicate } } as never] })).success, true);
    assert.deepEqual(transport.calls[0], [{ method: "POST", path: "/v1/elements/inspect", body: { handle, locator } }]);
  }
  for (const code of ["element_not_found", "locator_not_found"] as const) {
    const transport = new FakeTransport(() => { throw new ComputerBridgeError(code, 0, 404); });
    assert.equal((await new ComputerBackend(transport).sequence({ steps: [absenceWait] })).success, true);
    let polls = 0; const clock = fakeTiming();
    transport.respond = () => { if (++polls < 3) throw new ComputerBridgeError(code, 0, 404); return [element]; };
    assert.equal((await new ComputerBackend(transport, clock.timing).sequence({ steps: [{ ...absenceWait, condition: { ...absenceWait.condition, predicate: { type: "exists", expected: true } } }] })).success, true);
    assert.deepEqual(clock.sleeps, [100, 100]);
    transport.respond = () => { throw new ComputerBridgeError(code, 0, 404); };
    const failed = await new ComputerBackend(transport).sequence({ steps: [{ ...absenceWait, condition: { ...absenceWait.condition, predicate: { type: "focused", expected: false } } }] });
    assert.equal(failed.success, false);
  }
  for (const code of ["http", "transport", "timeout"] as const) {
    const transport = new FakeTransport(() => { throw new ComputerBridgeError(code, 0, 404); });
    const result = await new ComputerBackend(transport).sequence({ steps: [absenceWait, move] });
    assert.equal(result.success, false); assert.equal(transport.calls.length, 1);
  }
});

test("whole sequences serialize with concurrent desktop actions including during wait sleep", async () => {
  let release!: () => void; let sleeping!: () => void;
  const inSleep = new Promise<void>((resolve) => { sleeping = resolve; });
  let polls = 0;
  const transport = new FakeTransport(([step]) => step.method === "GET" ? [++polls === 1 ? [] : [window]] : [{ success: true }]);
  const backend = new ComputerBackend(transport, { now: () => 0, sleep: () => { sleeping(); return new Promise<void>((resolve) => { release = resolve; }); } });
  const sequence = backend.sequence({ steps: [windowWait, move] });
  await inSleep;
  const other = backend.interact({ ...move, x: 99 });
  assert.equal(transport.calls.length, 1);
  release(); await sequence; await other;
  assert.deepEqual(transport.calls.map(([step]) => step.body ?? step.path), ["/v1/windows", "/v1/windows", { x: 1, y: 2 }, { x: 99, y: 2 }]);
});

test("bridge accepts only fixed absence codes and rejects arbitrary upstream code text", async () => {
  for (const code of ["element_not_found", "locator_not_found", "PRIVATE-BEARER"]) {
    const f = bridgeFixture(); const call = f.bridge.request([{ method: "POST", path: "/v1/elements/inspect", body: { handle, locator } }]);
    f.processes[0].stdout.write(JSON.stringify({ id: f.processes[0].frames[0].id, ok: false, code, status: 404, completedSteps: 0 }) + "\n");
    await assert.rejects(call, (e) => code === "PRIVATE-BEARER" ? !safeError(e).includes(code) : e instanceof ComputerBridgeError && e.code === code);
    assert.equal(f.processes[0].killed, code === "PRIVATE-BEARER"); f.bridge.close();
  }
  assert.match(WINDOWS_COMPUTER_BRIDGE, /pointer-click\|scroll\|drag/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /\$status -eq 404 -and \$path -ceq '\/v1\/elements\/inspect'/);
  assert.match(WINDOWS_COMPUTER_BRIDGE, /\$problem\['code'\] -is \[string\]/);
  assert.doesNotMatch(WINDOWS_COMPUTER_BRIDGE, /\$problem\.code -ceq '(?:element|locator)_not_found'/);
});

test("MCP sequence discovery publishes bounded schemas and annotations; validates success and failure results", async () => {
  const transport = new FakeTransport(() => [dragResult]); const f = await mcpFixture(transport);
  try {
    const tool = (await f.client.listTools()).tools.find((t) => t.name === "computer.sequence")!;
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    const schema = tool.inputSchema as JsonSchemaType;
    assert.equal((schema.properties?.steps as JsonSchemaType).minItems, 1); assert.equal((schema.properties?.steps as JsonSchemaType).maxItems, 32);
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    for (const input of [{ steps: [dragInput, windowWait, absenceWait] }, { steps: [{ action: "drag", points: Array(128).fill({ x: 0, y: 0 }) }] }]) assert.equal(validate(input).valid, true);
    for (const input of [{ steps: [] }, { steps: Array(33).fill(move) }, { steps: [{ ...windowWait, condition: { type: "windowPresent", expected: true } }] }, { steps: [{ ...windowWait, condition: { ...windowWait.condition, handle } }] }, { steps: [{ ...absenceWait, condition: { ...absenceWait.condition, locator: {} } }] }, { steps: [{ action: "keySequence", chords: [{ key: 65 }], activate: true }] }, { steps: [{ action: "scroll", delta: 1, x: 0 }] }, { steps: [{ action: "drag", points: Array(128).fill({ x: 0, y: 0 }), stepsPerSegment: 5 }] }, { steps: [{ ...windowWait, timeoutMs: 10001 }] }, { steps: [move], continueOnError: true }, { steps: [{ action: "screenshot" }] }]) assert.equal(validate(input).valid, false, JSON.stringify(input));
    const response = await f.client.callTool({ name: "computer.sequence", arguments: { steps: [dragInput] } });
    assert.notEqual(response.isError, true);
    const output = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    assert.equal(output(response.structuredContent).valid, true);
    assert.equal(computerOutputSchemas.sequence.safeParse(response.structuredContent).success, true);
    transport.respond = () => { throw new ComputerBridgeError("transport"); };
    const failure = await f.client.callTool({ name: "computer.sequence", arguments: { steps: [move, move] } });
    assert.equal(failure.isError, true); assert.equal(output(failure.structuredContent).valid, true);
    assert.equal((failure.structuredContent as { stoppedAt: number }).stoppedAt, 0);
  } finally { await f.close(); }
});

test("WCU 0.4 capability drag limits are preserved without breaking older capability results", async () => {
  const transport = new FakeTransport(() => [{ apiVersion: "v1", hostVersion: "0.4.0", locatorFields: [], semanticActions: [], inputActions: ["drag"], windowActions: [], limits: { ...Object.fromEntries(["maxLocatorDepth", "maxLocatorNodes", "maxLocatorTextLength", "maxFindResults", "maxKeySequence", "maxVirtualKey", "maxWheelDelta", "maxTextLength", "maxValueLength", "maxTreeDepth", "maxTreeNodes", "maxClickCount"].map((name) => [name, 1])), maxDragPoints: 128, maxDragDurationMs: 5000, maxDragSteps: 512 } }]);
  const result = await new ComputerBackend(transport).observe({ type: "capabilities" });
  assert.equal(result.type, "capabilities");
  if (result.type === "capabilities") assert.equal(result.data.limits.maxDragSteps, 512);
});

test("wait deadline also bounds a stalled observation without replay or later mutation", async () => {
  let finish!: (result: unknown[]) => void;
  const transport = new FakeTransport(() => new Promise<unknown[]>((resolve) => { finish = resolve; }));
  const result = await new ComputerBackend(transport).sequence({ steps: [{ ...windowWait, timeoutMs: 20 }, move] });
  assert.equal(result.success, false); assert.equal(result.stoppedAt, 0);
  const step = result.results[0]; assert.equal(step.success, false);
  if (!step.success) assert.equal(step.error.code, "wait_timeout");
  assert.equal(transport.calls.length, 1);
  finish([[]]); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.calls.length, 1);
});

test("backend serialization retains bounded admission and releases queue after failures", async () => {
  let release!: () => void; let first = true;
  const transport = new FakeTransport(async () => {
    if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); throw new ComputerBridgeError("transport"); }
    return [{ success: true }];
  });
  const backend = new ComputerBackend(transport);
  const firstCall = assert.rejects(backend.interact(move), /transport/);
  const calls = Array.from({ length: 63 }, () => backend.interact(move));
  await assert.rejects(backend.interact(move), /64 pending/);
  assert.equal(transport.calls.length, 1);
  release(); await firstCall; await Promise.all(calls);
  assert.equal(transport.calls.length, 64);
  await backend.interact(move); assert.equal(transport.calls.length, 65);
});

test("wait timeout includes observation time and rejects a match observed after the deadline", async () => {
  const clock = fakeTiming();
  const transport = new FakeTransport(() => { clock.advance(101); return [[window]]; });
  const result = await new ComputerBackend(transport, clock.timing).sequence({ steps: [{ ...windowWait, timeoutMs: 100 }, move] });
  assert.equal(result.success, false); assert.equal(result.stoppedAt, 0); assert.equal(result.totalElapsedMs, 101);
  assert.equal(transport.calls.length, 1); assert.deepEqual(clock.sleeps, []);
  const failed = result.results[0]; if (!failed.success) assert.equal(failed.error.code, "wait_timeout");
});
