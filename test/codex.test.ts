import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { outputSchemas } from "../src/results.js";
import { nativeFixture, type NativeRequest } from "./native-fixture.js";

const capabilities = { continuation: true, exactPromptWait: false, modelSelection: false, permissions: "read-only", events: false };
const snapshot = { sessionId: "native-thread", cwd: "/tmp", status: "completed", outcome: "completed", executionKnown: true, output: "answer", outputTruncated: false, assistantMessageId: "native-assistant", stopReason: "end_turn", completedAtMs: 1, error: null, capabilities };
function fixture(handler: (request: NativeRequest) => unknown = () => undefined) {
  return nativeFixture(request => {
    assert.ok(request.path.startsWith("/api/rpc/codex-sessions/"), request.path);
    const custom = handler(request); if (custom !== undefined) return custom;
    if (request.path.endsWith("/start")) return { output: { sessionId: "native-thread", cwd: "/tmp", status: "inProgress", messageId: null, capabilities } };
    if (request.path.endsWith("/interrupt")) return { output: { sessionId: "native-thread", interrupted: true } };
    return { output: snapshot };
  });
}
test("shared session tools route Codex directly and preserve native identities", async () => {
  const f = fixture(), backend = new OpenCodeBackend(f.connect);
  const admitted = await backend.start({ runtime: "codex", task: "review", cwd: "/tmp" });
  outputSchemas.start.parse(admitted);
  assert.equal(admitted.sessionId, "native-thread"); assert.equal(admitted.messageId, null);
  const inspected = await backend.inspect({ runtime: "codex", sessionId: admitted.sessionId, detail: "result" });
  outputSchemas.inspect.parse(inspected);
  assert.equal((inspected as any).result.text, "answer");
  const waited = await backend.wait(admitted.sessionId, undefined, undefined, "codex");
  outputSchemas.wait.parse(waited);
  assert.equal(waited.state, "terminal");
  outputSchemas.act.parse(await backend.act({ runtime: "codex", action: "interrupt", sessionId: admitted.sessionId }));
  await backend.start({ runtime: "codex", sessionId: admitted.sessionId, task: "continue" });
  assert.deepEqual(f.requests.at(-1)?.body, { input: { sessionId: "native-thread", task: "continue" } });
});
test("restart history remains unknown and unsupported capabilities never reach OpenCode", async () => {
  const f = fixture(() => ({ output: { ...snapshot, executionKnown: false, status: "idle", outcome: "unknown", stopReason: null } }));
  const backend = new OpenCodeBackend(f.connect);
  const waited = await backend.wait("native-thread", undefined, undefined, "codex");
  outputSchemas.wait.parse(waited); assert.equal(waited.state, "unknown");
  await assert.rejects(backend.wait("native-thread", "user-id", undefined, "codex"), /exact-prompt/);
  await assert.rejects(backend.start({ runtime: "codex", task: "work", cwd: "/tmp", model: "openai/model" }), /model.*unsupported/);
  await assert.rejects(backend.act({ runtime: "codex", action: "steer", sessionId: "native-thread", instruction: "work" }), /unsupported/);
  assert.equal(f.requests.length, 1);
  const unsupported = await backend.query([{ runtime: "codex", type: "sessions", searchTerm: "example" }]);
  assert.match((unsupported.results[0] as any).error, /search is unsupported/);
  assert.equal(f.requests.length, 1);
});
test("native errors stay bounded and mismatched sessions fail visibly", async () => {
  const hostile = fixture(() => new Response(JSON.stringify({ _tag: "RpcError", type: "codex-sessions.unknown_session", message: "SECRET provider body" }), { status: 400, headers: { "content-type": "application/json" } }));
  await assert.rejects(new OpenCodeBackend(hostile.connect).inspect({ runtime: "codex", sessionId: "native-thread" }), (e: Error) => { assert.match(e.message, /unknown_session/); assert.equal(e.message.includes("SECRET"), false); return true; });
  const mismatch = fixture(() => ({ output: { ...snapshot, sessionId: "different" } }));
  await assert.rejects(new OpenCodeBackend(mismatch.connect).inspect({ runtime: "codex", sessionId: "native-thread" }), /different native session/);
});
test("native message text pagination retains backend routing and exact IDs", async () => {
  const f = fixture(() => ({ output: { sessionId: "native-thread", historyComplete: true, messages: [{ id: "native-user", role: "user", text: "input" }, { id: "native-assistant", role: "assistant", text: "abcdefgh", truncated: false }] } }));
  const backend = new OpenCodeBackend(f.connect);
  const result = await backend.query([{ runtime: "codex", type: "message", sessionId: "native-thread", messageId: "native-assistant", textLimit: 3 }]);
  const m = result.results[0].result as any;
  assert.equal(m.text, "abc"); assert.equal(m.nextCall.arguments.queries[0].runtime, "codex");
  const missing = await backend.query([{ runtime: "codex", type: "message", sessionId: "native-thread", messageId: "absent" }]);
  assert.match((missing.results[0] as any).error, /no fallback/);
});
test("MCP removes job actions and enforces OpenCode prompt identity requirements", async () => {
  const f = fixture(), server = createServer(new OpenCodeBackend(f.connect), new HostBackend(f.connect));
  const client = new Client({ name: "session-contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const published = JSON.stringify(tools);
    for (const removed of ["codexStart", "codexCancel", "codexJob", "jobId"]) assert.equal(published.includes(removed), false);
    const valid = await client.callTool({ name: "opencode.start", arguments: { runtime: "codex", cwd: "/tmp", task: "review" } });
    assert.notEqual(valid.isError, true);
    assert.equal((valid.structuredContent as any).messageId, null);
    const before = f.requests.length;
    for (const [name, args] of [
      ["opencode.start", { cwd: "/tmp", task: "missing model" }],
      ["opencode.wait", { sessionId: "native-thread" }],
      ["opencode.act", { action: "codexStart", cwd: "/tmp", prompt: "old" }],
    ] as const) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
    assert.equal(f.requests.length, before);
  } finally { await client.close(); await server.close(); }
});
