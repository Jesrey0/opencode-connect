import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { BrowserBackend } from "../src/browser/backend.js";
import { Events } from "../src/events.js";
import { sourceBuildInfo } from "../src/buildInfo.js";
import { nativeFixture, session, assistant, user } from "./native-fixture.js";

async function fixture(native: ReturnType<typeof nativeFixture>, events?: Events, browser?: BrowserBackend) {
  // Exercise the real native info request as connectNative does, without service discovery.
  const backend = new OpenCodeBackend(async () => ({ ...native.connection, info: await native.client.server.info() }));
  const server = createServer(backend, new HostBackend(native.connect), events, browser);
  const client = new Client({ name: "status-contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const { tools } = await client.listTools();
  const status = tools.find(tool => tool.name === "status.recovery")!;
  const readiness = tools.find(tool => tool.name === "status.readiness")!;
  const provider = new AjvJsonSchemaValidator();
  const validateRecovery = provider.getValidator(status.outputSchema! as JsonSchemaType);
  const validateReadiness = provider.getValidator(readiness.outputSchema! as JsonSchemaType);
  return { client, status, readiness, validateRecovery, validateReadiness, close: async () => { await client.close(); await server.close(); browser?.close(); } };
}

test("MCP readiness reads native info only and reports concise local components", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-status-"));
  const events = await Events.open(join(directory, "store.json"));
  events.snapshot = () => { throw new Error("readiness must not collect recovery diagnostics"); };
  // A readiness read must work without spawning or probing this deliberately absent worker.
  const browser = new BrowserBackend({ enabled: true, env: { OPENCODE_CONNECT_BROWSER_PYTHON: "/missing/status-test-python" } });
  const native = nativeFixture(request => {
    if (request.path === "/api/info") return native.connection.info;
    throw new Error(`readiness must not inspect native inventory: ${request.path}`);
  });
  const f = await fixture(native, events, browser);
  try {
    assert.equal(native.requests.length, 0, "discovery is passive");
    const validateInput = new AjvJsonSchemaValidator().getValidator(f.readiness.inputSchema as JsonSchemaType);
    assert.deepEqual(f.readiness.inputSchema.properties, {});
    for (let attempt = 0; attempt < 3; attempt++) {
      const args = {};
      assert.equal(validateInput(args).valid, true);
      const response = await f.client.callTool({ name: "status.readiness", arguments: args });
      assert.notEqual(response.isError, true);
      assert.deepEqual(response.content, []);
      assert.equal(f.validateReadiness(response.structuredContent).valid, true);
      const { version, buildId, release } = sourceBuildInfo();
      assert.deepEqual(response.structuredContent, {
        detail: "readiness", ready: true, connector: { version, buildId, release },
        components: {
          opencode: { ready: true, release: "2.0.24", serverPid: 1, error: null },
          events: { enabled: true, storageFailed: false },
          browser: { scope: "supervisor", enabled: true, worker: "stopped", currentIssue: null },
        },
      });
      assert.ok(Buffer.byteLength(JSON.stringify(response.structuredContent)) < 1024);
    }
    assert.deepEqual(native.requests.map(request => request.path), ["/api/info", "/api/info", "/api/info"]);
    const rejected = await f.client.callTool({ name: "status.readiness", arguments: { detail: "light" } });
    assert.equal(rejected.isError, true);
    const wrongScope = await f.client.callTool({ name: "status.readiness", arguments: { runtime: "codex" } });
    assert.equal(wrongScope.isError, true);
    assert.equal(native.requests.length, 3, "invalid readiness inputs are rejected before native access");
  } finally { await f.close(); await events.close(); await rm(directory, { recursive: true, force: true }); }
});

test("MCP readiness retains connector identity and sanitizes unavailable OpenCode evidence", async () => {
  const native = nativeFixture(() => Response.json({ _tag: "UnauthorizedError", message: "PRIVATE-UPSTREAM" }, { status: 401 }));
  const f = await fixture(native);
  try {
    const response = await f.client.callTool({ name: "status.readiness", arguments: {} });
    assert.equal(response.isError, true);
    assert.deepEqual(response.content, []);
    assert.equal(f.validateReadiness(response.structuredContent).valid, true);
    const result = response.structuredContent as any;
    assert.equal(result.detail, "readiness"); assert.equal(result.ready, false);
    assert.equal(result.connector.version, sourceBuildInfo().version);
    assert.equal(result.connector.buildId, "source");
    assert.equal(result.components.opencode.ready, false);
    assert.equal(result.components.opencode.release, null); assert.equal(result.components.opencode.serverPid, null);
    assert.match(result.components.opencode.error, /UnauthorizedError/);
    assert.deepEqual(result.components.events, { enabled: false, storageFailed: null });
    assert.equal(result.components.browser, null);
    assert.equal(JSON.stringify(response).includes("PRIVATE-UPSTREAM"), false);
    assert.deepEqual(native.requests.map(request => request.path), ["/api/info"]);
  } finally { await f.close(); }
});

test("MCP omitted and explicit recovery retain worker result evidence and runtime routing", async () => {
  const state = session();
  const failed = { ...assistant("answer", "partial answer"), finish: "error", error: { type: "provider.quota", message: "PRIVATE-UPSTREAM" } };
  const native = nativeFixture(request => {
    if (request.path === "/api/info") return native.connection.info;
    if (request.path === "/api/session/active") return { data: {} };
    if (request.path === "/api/session") return { data: [state], cursor: {} };
    if (request.path === "/api/session/s") return { data: state };
    if (request.path.endsWith("/message")) return { data: [failed, user("target")], cursor: {} };
    if (request.path === "/api/rpc/codex-sessions/status") return { output: { sessions: [] } };
    throw new Error(`unexpected recovery request: ${request.path}`);
  });
  const f = await fixture(native);
  try {
    let defaultResult: unknown;
    for (const args of [{}, { runtime: "opencode" }]) {
      const response = await f.client.callTool({ name: "status.recovery", arguments: args });
      assert.notEqual(response.isError, true);
      assert.equal(f.validateRecovery(response.structuredContent).valid, true);
      const result = response.structuredContent as any;
      assert.equal(result.ready, true); assert.equal(result.workers.length, 1);
      assert.equal(result.workers[0].executionOutcome, "succeeded");
      assert.equal(result.workers[0].outcome, "failed");
      assert.equal(result.workers[0].outcomeEvidence.assistantMessageId, "answer");
      assert.equal(result.workers[0].outcomeEvidence.error.type, "provider.quota");
      assert.equal(JSON.stringify(response).includes("PRIVATE-UPSTREAM"), false);
      if (defaultResult) assert.deepEqual(result, defaultResult);
      else defaultResult = result;
    }
    assert.ok(native.requests.some(request => request.path.endsWith("/message")));
    const before = native.requests.length;
    const codex = await f.client.callTool({ name: "status.recovery", arguments: { runtime: "codex" } });
    assert.notEqual(codex.isError, true);
    assert.equal(f.validateRecovery(codex.structuredContent).valid, true);
    assert.deepEqual((codex.structuredContent as any).workers, []);
    assert.deepEqual(native.requests.slice(before).map(request => request.path), ["/api/info", "/api/rpc/codex-sessions/status"]);
  } finally { await f.close(); }
});
