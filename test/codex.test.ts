import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { outputSchemas } from "../src/results.js";
import { CodexSessionsDefinition } from "../src/codexRpc.js";
// Native plugin sources and their injection harness are intentionally JavaScript.
// @ts-expect-error no declaration file for the native JS workspace
import { CodexSessionsRpc } from "../packages/codex-plugin/src/direct.js";
// @ts-expect-error no declaration file for the native JS workspace
import { projectUsage } from "../packages/codex-plugin/src/usage.js";
// @ts-expect-error JS plugin test harness
import { createHarness } from "../packages/codex-plugin/test/harness.js";
import { nativeFixture, type NativeRequest } from "./native-fixture.js";

const capabilities = { continuation: true, exactPromptWait: false, modelSelection: false, permissions: "operator-selected", events: false, usageQuota: "codex-app-server", defaultMode: "agent", modes: [
  { id: "read-only", name: "Read-only", sandboxPolicy: "readOnly", approvalPolicy: "on-request", approvalsReviewer: "user" },
  { id: "workspace-write", name: "Workspace access", sandboxPolicy: "workspaceWrite", approvalPolicy: "on-request", approvalsReviewer: "user" },
  { id: "agent", name: "Auto review", sandboxPolicy: "workspaceWrite", approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
  { id: "agent-full-access", name: "Full access", sandboxPolicy: "dangerFullAccess", approvalPolicy: "never", approvalsReviewer: "user" },
] };
const snapshot = { sessionId: "native-thread", cwd: "/tmp", status: "completed", outcome: "completed", executionKnown: true, output: "answer", outputTruncated: false, assistantMessageId: "native-assistant", stopReason: "end_turn", completedAtMs: 1, error: null, capabilities, mode: "agent", pendingActions: [] };
function fixture(handler: (request: NativeRequest) => unknown = () => undefined) {
  return nativeFixture(request => {
    assert.ok(request.path.startsWith("/api/rpc/codex-sessions/"), request.path);
    const custom = handler(request); if (custom !== undefined) return custom;
    if (request.path.endsWith("/start")) return { output: { sessionId: "native-thread", cwd: "/tmp", status: "inProgress", messageId: null, capabilities, mode: "agent" } };
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
test("Codex inventory normalizes only native metadata and refuses unsupported filters", async () => {
  const f = fixture(() => ({ output: { sessions: [{ sessionId: "native-thread", cwd: "/tmp", title: "smoke audit priority", updatedAt: "2026-10-11T12:00:00Z", capabilities }, { sessionId: "other", cwd: "/tmp", updatedAt: "invalid", capabilities }], nextCursor: "native-cursor" } }));
  const backend = new OpenCodeBackend(f.connect);
  const inventory = (await backend.query([{ runtime: "codex", type: "sessions", cwd: "/tmp", cursor: "previous" }])).results[0].result as any;
  assert.equal(inventory.runtime, "codex"); assert.equal(inventory.cursor.next, "native-cursor");
  const s = inventory.sessions[0];
  assert.equal(s.runtime, "codex"); assert.equal(s.updatedAtMs, Date.parse("2026-10-11T12:00:00Z"));
  assert.equal(s.status, null); assert.equal(s.executionOutcome, null); assert.equal(s.outcome, "unknown"); assert.equal(s.outcomeBasis, "unavailable");
  for (const field of ["createdAtMs", "archivedAtMs", "idleAtMs"]) assert.equal(s[field], null);
  assert.equal("updatedAt" in s, false); assert.equal("importance" in s, false);
  assert.equal(inventory.sessions[1].updatedAtMs, null);
  assert.deepEqual(f.requests[0].body, { input: { cwd: "/tmp", cursor: "previous" } });
  for (const filter of [{ limit: 1 }, { searchTerm: "test" }, { offset: 0 }, { fingerprint: "x" }, { order: "asc" }]) {
    const result = await backend.query([{ runtime: "codex", type: "sessions", ...filter } as any]);
    assert.ok((result.results[0] as any).error);
  }
  assert.equal(f.requests.length, 1);
});
test("Codex delete RPC refusals are safe and uncertain acknowledgments never imply success", async () => {
  for (const [type, code, uncertain] of [["delete_active", "DELETE_SESSION_ACTIVE", false], ["delete_pending_approval", "DELETE_PENDING_APPROVAL", false], ["unsupported", "DELETE_UNSUPPORTED", false], ["busy", "DELETE_BUSY", false], ["unknown_session", "DELETE_NOT_FOUND", false], ["delete_unverified", "DELETE_UNVERIFIED", true], ["internal", "DELETE_FAILED", true]] as const) {
    const f = fixture(() => Response.json({ _tag: "RpcError", type: `codex-sessions.${type}`, ...(type === "unknown_session" ? { data: { catalogComplete: true } } : {}), message: "SECRET body" }, { status: 400 }));
    await assert.rejects(new OpenCodeBackend(f.connect).act({ action: "delete", runtime: "codex", sessionId: "native-thread" }), (e: any) => e.code === code && e.mutationMayHaveOccurred === uncertain && !e.message.includes("SECRET"));
  }
  const unreadable = fixture(() => Response.json({ _tag: "RpcError", type: "codex-sessions.delete_unverified", data: { mutationAttempted: false }, message: "SECRET preflight body" }, { status: 400 }));
  await assert.rejects(new OpenCodeBackend(unreadable.connect).act({ action: "delete", runtime: "codex", sessionId: "native-thread" }), (e: any) => e.code === "DELETE_PREFLIGHT_FAILED" && !e.mutationMayHaveOccurred && !e.message.includes("SECRET"));
  const ambiguous = fixture(() => Response.json({ _tag: "RpcError", type: "codex-sessions.unknown_session", message: "SECRET rejection" }, { status: 400 }));
  await assert.rejects(new OpenCodeBackend(ambiguous.connect).act({ action: "delete", runtime: "codex", sessionId: "native-thread" }), (e: any) => e.code === "DELETE_FAILED" && e.mutationMayHaveOccurred && !e.message.includes("SECRET"));
  for (const value of [{ sessionId: "other", deleted: true }, { sessionId: "native-thread", deleted: false }, null]) {
    const f = fixture(() => ({ output: value }));
    await assert.rejects(new OpenCodeBackend(f.connect).act({ action: "delete", runtime: "codex", sessionId: "native-thread" }), (e: any) => ["DELETE_UNVERIFIED", "DELETE_FAILED"].includes(e.code) && e.mutationMayHaveOccurred);
  }
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
      ["opencode.start", { task: "missing cwd" }],
      ["opencode.wait", { sessionId: "native-thread" }],
      ["opencode.act", { action: "codexStart", cwd: "/tmp", prompt: "old" }],
    ] as const) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
    assert.equal(f.requests.length, before);
  } finally { await client.close(); await server.close(); }
});

test("Codex quota queries use the direct plugin RPC without opening a model turn", async () => {
  const quota = projectUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1791700000 } } }, {});
  const f = fixture(request => request.path.endsWith("/usage") ? { output: { ...quota, capabilities, accountId: "SECRET", account: { ...quota.account, email: "SECRET" }, config: { token: "SECRET" } } } : undefined);
  const backend = new OpenCodeBackend(f.connect);
  const response = await backend.query([{ runtime: "codex", type: "usage" }]);
  const result = response.results[0] as any;
  assert.equal(result.result.runtime, "codex");
  assert.equal(result.result.buckets[0].primary.usedPercent, 37);
  assert.equal(result.result.capabilities.usageQuota, "codex-app-server");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].path.endsWith("/usage"));
});

test("installed workspace RPC and connector definitions agree and usage crosses the real client boundary", async () => {
  assert.equal(CodexSessionsDefinition.id, CodexSessionsRpc.id);
  assert.deepEqual(Object.keys(CodexSessionsDefinition.methods).sort(), Object.keys(CodexSessionsRpc.methods).sort());
  const harness = await createHarness({ internals: { direct: { readUsage: async () => projectUsage({ rateLimits: { primary: { usedPercent: 7 } } }, {}) } } });
  const f = fixture(async request => ({ output: await harness.rpcCall("codex-sessions", request.path.split("/").at(-1), (request.body as any).input) }));
  const server = createServer(new OpenCodeBackend(f.connect), new HostBackend(f.connect));
  const client = new Client({ name: "workspace-rpc-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const response = await client.callTool({ name: "opencode.query", arguments: { queries: [{ runtime: "codex", type: "usage" }] } });
    assert.notEqual(response.isError, true);
    const result = (response.structuredContent as any).results[0];
    assert.equal(result.result.buckets[0].primary.usedPercent, 7);
    assert.equal(result.result.nextCall, null);
    assert.deepEqual(harness.rpcCalls.map((call: any) => call.method), ["codex-sessions.usage"]);
    assert.deepEqual(harness.nativeCalls, []);
  } finally { await client.close(); await server.close(); }
});

test("malformed quota RPC records and unavailable plugins fail without falling back to OpenCode usage", async () => {
  for (const output of [{}, { source: "codex-app-server", buckets: Array(65).fill({}) }]) {
    const f = fixture(() => ({ output }));
    const result = (await new OpenCodeBackend(f.connect).query([{ runtime: "codex", type: "usage" }])).results[0];
    assert.match(result.error!, /unusable quota/);
    assert.equal(f.requests.length, 1);
  }
  const f = fixture(() => new Response(JSON.stringify({ _tag: "RpcError", type: "rpc.not_found", message: "SECRET" }), { status: 404, headers: { "content-type": "application/json" } }));
  const result = (await new OpenCodeBackend(f.connect).query([{ runtime: "codex", type: "usage" }])).results[0];
  assert.match(result.error!, /details omitted/);
  assert.equal(result.error!.includes("SECRET"), false);
  assert.equal(f.requests.length, 1);
});

const permission = {
  sessionId: "native-thread", requestId: "native-request", action: "Run command",
  resources: [], message: null, details: { command: "npm test", cwd: "/tmp", locations: [], content: null, truncated: false, truncatedFields: [] },
  options: [{ optionId: "accept_execpolicy_amendment", name: "Remember", kind: "allow_always" }, { optionId: "native-once", name: "Proceed", kind: "allow_once" }],
  reviewable: true, createdAtMs: 1,
};
test("pending Codex approvals wake waits and retain native options without raw configuration", async () => {
  const f = fixture(request => {
    if (request.path.endsWith("/permissions")) return { output: { sessionId: "native-thread", mode: "workspace-write", pendingActions: [permission], capabilities } };
    return { output: { ...snapshot, status: "inProgress", outcome: "unknown", stopReason: null, pendingActions: [{ ...permission, config: { apiKey: "SECRET" } }] } };
  });
  const backend = new OpenCodeBackend(f.connect);
  const waited = await backend.wait("native-thread", undefined, undefined, "codex");
  outputSchemas.wait.parse(waited);
  assert.equal(waited.wakeReason, "actionRequired");
  assert.equal(waited.pendingActions[0].details.command, "npm test");
  assert.equal(JSON.stringify(waited).includes("SECRET"), false);
  const result = await backend.query([{ runtime: "codex", type: "permissions", section: "pending", sessionId: "native-thread" }]);
  assert.equal((result.results[0].result as any).data[0].options[0].optionId, "accept_execpolicy_amendment");
});
test("MCP routes exact Codex options and rejects mixing runtime decision formats before admission", async () => {
  const f = fixture(request => {
    if (request.path.endsWith("/start")) return { output: { sessionId: "native-thread", cwd: "/tmp", status: "inProgress", messageId: null, capabilities, mode: (request.body as any).input.mode ?? "agent" } };
    if (request.path.endsWith("/respondPermission")) return { output: { ...(request.body as any).input, accepted: true } };
    if (request.path.endsWith("/list")) return { output: { sessions: [], nextCursor: null } };
  });
  const server = createServer(new OpenCodeBackend(f.connect), new HostBackend(f.connect));
  const client = new Client({ name: "codex-mode-contract", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const admitted = await client.callTool({ name: "opencode.start", arguments: { runtime: "codex", cwd: "/tmp", task: "implement", mode: "workspace-write" } });
    assert.notEqual(admitted.isError, true);
    assert.equal((admitted.structuredContent as any).mode, "workspace-write");
    const accepted = await client.callTool({ name: "opencode.act", arguments: { runtime: "codex", action: "respondPermission", sessionId: "native-thread", requestId: "native-request", optionId: "native-once" } });
    assert.notEqual(accepted.isError, true);
    assert.deepEqual(f.requests.at(-1)?.body, { input: { sessionId: "native-thread", requestId: "native-request", optionId: "native-once" } });
    const inventory = await client.callTool({ name: "opencode.query", arguments: { queries: [{ runtime: "codex", type: "sessions" }] } });
    assert.notEqual(inventory.isError, true);
    assert.equal("error" in (inventory.structuredContent as any).results[0], false);
    const before = f.requests.length;
    for (const args of [
      { runtime: "codex", action: "respondPermission", sessionId: "native-thread", requestId: "native-request", decision: "once" },
      { action: "respondPermission", sessionId: "native-thread", requestId: "native-request", optionId: "native-once" },
      { runtime: "codex", action: "respondPermission", sessionId: "native-thread", requestId: "native-request", decision: "always", optionId: "native-once" },
    ]) assert.equal((await client.callTool({ name: "opencode.act", arguments: args })).isError, true);
    assert.equal((await client.callTool({ name: "opencode.start", arguments: { cwd: "/tmp", task: "native", model: "openai/model", mode: "agent" } })).isError, true);
    assert.equal(f.requests.length, before);
  } finally { await client.close(); await server.close(); }
});
test("Codex mode mismatches and foreign permission sessions fail instead of hiding identity loss", async () => {
  const wrongMode = fixture(request => request.path.endsWith("/start") ? { output: { sessionId: "native-thread", cwd: "/tmp", status: "inProgress", messageId: null, capabilities, mode: "agent-full-access" } } : undefined);
  await assert.rejects(new OpenCodeBackend(wrongMode.connect).start({ runtime: "codex", cwd: "/tmp", task: "review", mode: "read-only" }), /different native mode/);
  const wrongSession = fixture(() => ({ output: { ...snapshot, pendingActions: [{ ...permission, sessionId: "other-session" }] } }));
  await assert.rejects(new OpenCodeBackend(wrongSession.connect).inspect({ runtime: "codex", sessionId: "native-thread" }), /permission identity/);
});
