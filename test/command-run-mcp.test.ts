import assert from "node:assert/strict";
import test from "node:test";
import { createHttpApp, createHttpHandler } from "../src/http.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { BrowserBackend } from "../src/browser/backend.js";
import { nativeFixture, type NativeRequest } from "./native-fixture.js";

const version = "2026-07-28";
const meta = { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "foreground-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
async function fixture(hook?: (r: NativeRequest) => unknown | Promise<unknown>) {
  const state = { status: "exited", exit: 0, bytes: Buffer.from("done\n") };
  const location = { directory: "/canonical" };
  const native = nativeFixture(async r => {
    const overridden = await hook?.(r);
    if (overridden !== undefined) return overridden;
    if (r.path === "/api/location") return { ...location, project: { id: "p", canonical: "/canonical" } };
    if (r.path.endsWith("/output")) {
      const cursor = Number(r.query.get("cursor")), end = Math.min(state.bytes.length, cursor + Number(r.query.get("limit")));
      return { location, data: { output: state.bytes.subarray(cursor, end).toString("utf8"), cursor: end, size: state.bytes.length, truncated: end < state.bytes.length } };
    }
    return { location, data: { id: "native", cwd: "/canonical", status: state.status, pid: 42, exit: state.status === "running" ? undefined : state.exit, time: { started: 1 }, metadata: { PRIVATE: "SECRET" } } };
  });
  const handler = createHttpHandler(new OpenCodeBackend(native.connect), new HostBackend(native.connect), undefined, new BrowserBackend({ enabled: false }));
  const server = createHttpApp(handler).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  let id = 0;
  async function send(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const r = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { _meta: meta, ...params } }) });
    return await r.json() as any;
  }
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => (await send("tools/call", { name, arguments: args }, signal)).result;
  return { native, state, send, call, close: async () => { await handler.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

test("HTTP foreground command returns native output in one operator call and rejects unsupported input before admission", async () => {
  const f = await fixture();
  try {
    const result = await f.call("command.run", { cwd: "/alias", command: "printf done" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.output, "done\n");
    assert.equal(result.structuredContent.drained, true);
    assert.equal(result.structuredContent.nextCall, null);
    assert.equal(result.structuredContent.cwd, "/canonical");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(f.native.requests.filter(r => r.method === "POST").length, 1);
    const before = f.native.requests.length;
    const invalid = await f.call("command.run", { cwd: "/alias", command: "x", waitMs: 20001 });
    assert.equal(invalid.isError, true);
    const unsupported = await f.call("command.run", { cwd: "/alias", command: "x", background: true });
    assert.equal(unsupported.isError, true);
    assert.equal(f.native.requests.length, before);
  } finally { await f.close(); }
});

test("running output uses a read-only continuation while nonzero exit is an MCP error with retained evidence", async () => {
  const f = await fixture();
  try {
    f.state.status = "running";
    const first = await f.call("command.run", { cwd: "/alias", command: "work", waitMs: 0, timeoutMs: 5000 });
    const value = first.structuredContent;
    assert.equal(first.isError, undefined);
    assert.equal(value.drained, false);
    assert.equal(value.observation.reason, "waitTimeout");
    assert.equal(value.nextCall.tool, "command.read");
    f.state.status = "exited";
    const read = await f.call(value.nextCall.tool, value.nextCall.arguments);
    assert.equal(read.structuredContent.output, "done\n");
    assert.equal(read.structuredContent.drained, true);
    assert.equal(read.structuredContent.nextCall, null);
    f.state.exit = 7;
    const failed = await f.call("command.run", { cwd: "/alias", command: "exit 7" });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.exitCode, 7);
    assert.equal(failed.structuredContent.id, "native");
    assert.equal(failed.structuredContent.drained, true);
  } finally { await f.close(); }
});

test("uncertain admission exposes typed recovery without raw errors or invented handle", async () => {
  const f = await fixture(r => { if (r.method === "POST") throw new Error("PRIVATE provider data"); });
  try {
    const result = await f.call("command.run", { cwd: "/alias", command: "write" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "COMMAND_ADMISSION_UNCERTAIN");
    assert.equal(result.structuredContent.mutationMayHaveOccurred, true);
    assert.deepEqual(result.structuredContent.commandRecovery, { kind: "shell", cwd: "/canonical", admission: "mayHaveOccurred" });
    assert.equal("id" in result.structuredContent, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.equal(f.native.requests.filter(r => r.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("escaped output stays inside the MCP envelope and continuations preserve all unread source bytes", async () => {
  const f = await fixture();
  try {
    f.state.bytes = Buffer.alloc(65536, 0);
    let result = (await f.call("command.run", { cwd: "/alias", command: "binary", limit: 65536 })).structuredContent;
    let combined = result.output;
    assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: result })) <= 262144);
    assert.ok(result.cursor < 65536);
    assert.ok(result.nextCall);
    while (result.nextCall) {
      const next = await f.call(result.nextCall.tool, result.nextCall.arguments);
      assert.equal(next.isError, undefined);
      result = next.structuredContent;
      assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: result })) <= 262144);
      combined += result.output;
    }
    assert.equal(combined, f.state.bytes.toString("utf8"));
    assert.equal(result.cursor, 65536);
    assert.equal(result.drained, true);
    assert.equal(f.native.requests.filter(r => r.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("HTTP disconnect cancels observation without removing or replaying an admitted process", { timeout: 5000 }, async () => {
  let started!: () => void;
  const observing = new Promise<void>(resolve => { started = resolve; });
  let nativeSignal: AbortSignal | undefined;
  const f = await fixture(r => {
    if (r.method === "GET" && r.path.includes("/shell/") && !r.path.endsWith("/output")) {
      nativeSignal = r.signal; started(); return new Promise(() => {});
    }
  });
  const controller = new AbortController();
  try {
    f.state.status = "running";
    const request = f.call("command.run", { cwd: "/alias", command: "work", waitMs: 20000 }, controller.signal);
    await observing;
    controller.abort();
    await assert.rejects(request);
    const end = Date.now() + 1000;
    while (!nativeSignal?.aborted && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(nativeSignal?.aborted, true);
    assert.equal(f.native.requests.filter(r => r.method === "POST").length, 1);
    assert.equal(f.native.requests.some(r => r.method === "DELETE" || r.method === "PATCH"), false);
  } finally { await f.close(); }
});
