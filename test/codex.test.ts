import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { outputSchemas } from "../src/results.js";
import { nativeFixture, type NativeRequest } from "./native-fixture.js";

type Job = { jobId: string; status: string; result?: unknown; error?: unknown };

type CodexActResult = {
  action: "codexStart" | "codexCancel";
  jobId: string;
  status: string;
  result: Record<string, unknown> | null;
  error: { type: string; messageOmitted: true } | null;
  verified: boolean;
  readbackError: string | null;
  rpcDefinition: string;
  verifyNextCall: unknown;
  timeoutMs?: number;
  cwd?: string;
};

// Published output contract plus the precise Codex projection the test asserts on.
function codexResult(value: unknown): CodexActResult {
  outputSchemas.act.parse(value);
  return value as CodexActResult;
}

// Native RPC failures arrive as bounded RpcError payloads; the plugin message body is
// deliberately hostile here so every assertion can prove it never crosses the boundary.
function rpcFailure(type: string, message = "SECRET sk-key plugin body", status = 400) {
  return new Response(JSON.stringify({ _tag: "RpcError", type, message }), { status, headers: { "content-type": "application/json" } });
}

// One fake codex-direct plugin: canonical job registry plus a failing job when the
// registered handler answers. Nothing here reaches a real Codex model.
function plugin(jobs: Job[], handler: (request: NativeRequest) => unknown = () => undefined) {
  return nativeFixture((request) => {
    const method = request.path.replace("/api/rpc/codex-direct/", "");
    if (!request.path.startsWith("/api/rpc/codex-direct/")) throw new Error(`direct Codex dispatch must not reach ${request.path}`);
    const value = handler(request);
    if (value !== undefined) return value;
    if (method === "start") return { output: { jobId: "job-1", status: "queued" } };
    if (method === "cancel") return { output: { status: "cancelling" } };
    return { output: jobs[0] };
  });
}

function rpcCalls(fixture: ReturnType<typeof nativeFixture>) {
  return fixture.requests.map((request) => [request.method, request.path, request.body]);
}

test("codexStart dispatches through the plugin RPC, never a session lookup, and answers with canonical job state", async () => {
  const fixture = plugin([{ jobId: "job-1", status: "running", result: { exitCode: 0, summary: "done" } }]);
  const started = codexResult(await new OpenCodeBackend(fixture.connect).act({ action: "codexStart", cwd: "/tmp", prompt: "run the suite" }));
  assert.equal(started.action, "codexStart");
  assert.equal(started.jobId, "job-1");
  assert.equal(started.status, "running");
  assert.deepEqual(started.result, { exitCode: 0, summary: "done" });
  assert.equal(started.error, null);
  assert.equal(started.verified, true);
  assert.equal(started.readbackError, null);
  assert.equal(started.rpcDefinition, "codex-direct");
  assert.equal(started.timeoutMs, 45_000);
  assert.deepEqual(started.verifyNextCall, { tool: "opencode.query", arguments: { queries: [{ type: "codexJob", jobId: "job-1" }] } });
  // Canonical plugin identity only: no OpenCode session, message or worker id is invented.
  const json = JSON.stringify(started);
  for (const foreign of ["sessionId", "messageId", "worker", "assistantMessageId"]) assert.equal(json.includes(foreign), false, foreign);
  assert.deepEqual(rpcCalls(fixture), [
    ["POST", "/api/rpc/codex-direct/start", { input: { cwd: "/tmp", prompt: "run the suite" } }],
    ["POST", "/api/rpc/codex-direct/inspect", { input: { jobId: "job-1" } }],
  ]);
  assert.equal(fixture.requests.some((request) => request.path.startsWith("/api/session")), false);
});

test("codexStart keeps an admitted job readable when the canonical readback fails", async () => {
  const fixture = plugin([{ jobId: "job-1", status: "queued" }], (request) => (request.path.endsWith("/inspect") ? rpcFailure("codex.job_unavailable") : undefined));
  const started = codexResult(await new OpenCodeBackend(fixture.connect).act({ action: "codexStart", cwd: "/tmp", prompt: "task", timeoutMs: 1000 }));
  assert.equal(started.jobId, "job-1");
  assert.equal(started.status, "queued");
  assert.equal(started.verified, false);
  assert.equal(started.result, null);
  assert.match(started.readbackError!, /codex\.job_unavailable/);
  assert.equal(JSON.stringify(started).includes("SECRET"), false);
  assert.equal(started.timeoutMs, 1000);
  assert.equal(started.cwd, "/tmp");
});

test("codexCancel requests native cancellation and reports the plugin's own status", async () => {
  const fixture = plugin([{ jobId: "job-1", status: "cancelled", result: { exitCode: 130 } }]);
  const cancelled = codexResult(await new OpenCodeBackend(fixture.connect).act({ action: "codexCancel", jobId: "job-1" }));
  assert.equal(cancelled.action, "codexCancel");
  assert.equal(cancelled.jobId, "job-1");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.result, { exitCode: 130 });
  assert.equal(cancelled.verified, true);
  assert.deepEqual(rpcCalls(fixture), [
    ["POST", "/api/rpc/codex-direct/cancel", { input: { jobId: "job-1" } }],
    ["POST", "/api/rpc/codex-direct/inspect", { input: { jobId: "job-1" } }],
  ]);
});

test("plugin failures project a bounded type and never native message bodies", async () => {
  const fixture = plugin([{ jobId: "job-1", status: "queued" }], () => rpcFailure("codex.job_not_found"));
  const backend = new OpenCodeBackend(fixture.connect);
  await assert.rejects(backend.act({ action: "codexCancel", jobId: "job-1" }), (error: Error) => {
    assert.match(error.message, /codex-direct cancel failed \(codex\.job_not_found\)/);
    assert.equal(error.message.includes("SECRET"), false);
    return true;
  });
  const queried = await backend.query([{ type: "codexJob", jobId: "job-1" }]);
  assert.equal("error" in queried.results[0], true);
  const entry = queried.results[0] as { error: string; errorCode: null; agentId: null };
  assert.match(entry.error, /codex-direct inspect failed \(codex\.job_not_found\)/);
  assert.equal(entry.error.includes("SECRET"), false);
  assert.equal(entry.errorCode, null);
  assert.equal(entry.agentId, null);
  // An absent plugin method is a bounded native failure too, not an invented job.
  const uninstalled = plugin([{ jobId: "job-1", status: "queued" }], () => rpcFailure("rpc.method_not_found", "SECRET", 404));
  await assert.rejects(new OpenCodeBackend(uninstalled.connect).act({ action: "codexCancel", jobId: "job-1" }), /rpc\.method_not_found/);
});

test("codex identity and status come from the plugin; unusable payloads fail visibly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-"));
  try {
    const anonymous = plugin([{ jobId: "job-1", status: "queued" }], (request) => (request.path.endsWith("/start") ? { output: { status: "queued" } } : undefined));
    await assert.rejects(new OpenCodeBackend(anonymous.connect).act({ action: "codexStart", cwd, prompt: "task" }), /canonical job id/);
    const loose = plugin([{ jobId: "job-1", status: "queued" }], (request) => (request.path.endsWith("/start") ? { output: { jobId: "job-1", status: "queued with spaces" } } : undefined));
    await assert.rejects(new OpenCodeBackend(loose.connect).act({ action: "codexStart", cwd, prompt: "task" }), /job status/);
    const mismatched = plugin([{ jobId: "other-job", status: "running" }]);
    const mismatchQuery = await new OpenCodeBackend(mismatched.connect).query([{ type: "codexJob", jobId: "job-1" }]);
    const mismatch = mismatchQuery.results[0] as { error: string };
    assert.match(mismatch.error, /different job id/);
    assert.equal(mismatch.error.includes("other-job"), false);
    // A job error keeps its type and drops the plugin's message body.
    const failed = plugin([{ jobId: "job-1", status: "failed", error: { type: "codex.run_failed", message: "SECRET stderr" } }]);
    const job = await new OpenCodeBackend(failed.connect).query([{ type: "codexJob", jobId: "job-1" }]);
    assert.deepEqual(job.results[0].result, { jobId: "job-1", status: "failed", result: null, error: { type: "codex.run_failed", messageOmitted: true }, nextCall: null });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("codexStart requires an absolute existing cwd and bounds its own call, before any dispatch", async () => {
  const fixture = plugin([{ jobId: "job-1", status: "queued" }]);
  const backend = new OpenCodeBackend(fixture.connect);
  await assert.rejects(backend.act({ action: "codexStart", cwd: "relative/path", prompt: "task" }), /absolute/);
  await assert.rejects(backend.act({ action: "codexStart", cwd: "/tmp/opencode-missing-codex", prompt: "task" }), /directory/);
  await assert.rejects(backend.act({ action: "codexStart", cwd: "/tmp", prompt: "x".repeat(65_537) }), /64 KiB/);
  await assert.rejects(backend.act({ action: "codexStart", cwd: "/tmp", prompt: "task", timeoutMs: 90_001 }), /timeoutMs must be an integer between 1 and 90000/);
  await assert.rejects(backend.act({ action: "codexStart", cwd: "/tmp", prompt: "task", timeoutMs: 0 }), /timeoutMs must be an integer between 1 and 90000/);
  assert.deepEqual(fixture.requests, []);
});

test("MCP publishes strict codex act/query variants and answers them without a native session", async () => {
  const fixture = plugin([{ jobId: "job-1", status: "running", result: { exitCode: 0 } }]);
  const server = createServer(new OpenCodeBackend(fixture.connect), new HostBackend(fixture.connect));
  const client = new Client({ name: "codex-contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
    const act = schemas.get("opencode.act")!;
    const actions = (act.properties!.action as { enum: string[] }).enum;
    assert.ok(actions.includes("codexStart")); assert.ok(actions.includes("codexCancel"));
    for (const field of ["cwd", "prompt", "timeoutMs", "jobId"]) assert.ok(field in act.properties!, field);
    assert.equal((act.properties!.timeoutMs as { type: string; maximum: number }).maximum, 90_000);
    assert.ok(Array.isArray(act.oneOf));
    const actVariants = act.oneOf as { properties: Record<string, { const?: string }>; required: string[]; additionalProperties: boolean }[];
    const codexStart = actVariants.find((variant) => variant.properties.action.const === "codexStart")!;
    const codexCancel = actVariants.find((variant) => variant.properties.action.const === "codexCancel")!;
    assert.equal(codexStart.additionalProperties, false);
    assert.equal(codexCancel.additionalProperties, false);
    assert.deepEqual(codexStart.required, ["action", "cwd", "prompt"]);
    assert.deepEqual(codexCancel.required, ["action", "jobId"]);

    const query = schemas.get("opencode.query")!;
    const items = (query.properties!.queries as { items: { properties: Record<string, { enum?: string[] }>; oneOf: { properties: Record<string, { const?: string }>; additionalProperties: boolean; required: string[] }[] } }).items;
    assert.ok((items.properties.type.enum ?? []).includes("codexJob"));
    const jobVariant = items.oneOf.find((variant) => variant.properties.type.const === "codexJob")!;
    assert.equal(jobVariant.additionalProperties, false);
    assert.deepEqual(jobVariant.required, ["type", "jobId"]);

    // Direct dispatch is a mutation with open-world effect, not a read.
    const annotations = tools.find((tool) => tool.name === "opencode.act")!.annotations!;
    assert.equal(annotations.readOnlyHint, false); assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.openWorldHint, true); assert.equal(annotations.idempotentHint, false);

    const validate = new AjvJsonSchemaValidator().getValidator(act as JsonSchemaType);
    for (const invalid of [
      { action: "codexStart", cwd: "/tmp", prompt: "task", sessionId: "s" },
      { action: "codexStart", cwd: "/tmp" },
      { action: "codexStart", cwd: "/tmp", prompt: "task", timeoutMs: 90_001 },
      { action: "codexStart", cwd: "/tmp", prompt: "task", timeoutMs: 0 },
      { action: "codexCancel" },
      { action: "codexCancel", jobId: "job-1", sessionId: "s" },
    ]) {
      assert.equal(validate(invalid).valid, false, JSON.stringify(invalid));
      const rejected = await client.callTool({ name: "opencode.act", arguments: invalid });
      assert.equal(rejected.isError, true, JSON.stringify(invalid));
    }
    const before = fixture.requests.length;
    assert.equal(validate({ action: "codexStart", cwd: "/tmp", prompt: "task", timeoutMs: 90_000 }).valid, true);

    const response = await client.callTool({ name: "opencode.act", arguments: { action: "codexStart", cwd: "/tmp", prompt: "run the suite" } });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.content, []);
    const structured = response.structuredContent as { jobId: string; status: string; rpcDefinition: string };
    assert.equal(structured.jobId, "job-1");
    assert.equal(structured.status, "running");
    assert.equal(structured.rpcDefinition, "codex-direct");

    const read = await client.callTool({ name: "opencode.query", arguments: { queries: [{ type: "codexJob", jobId: "job-1" }] } });
    assert.notEqual(read.isError, true);
    assert.deepEqual((read.structuredContent as { results: { type: string; result: Job }[] }).results[0].result, { jobId: "job-1", status: "running", result: { exitCode: 0 }, error: null, nextCall: null });
    assert.equal(fixture.requests.slice(before).every((request) => request.path.startsWith("/api/rpc/codex-direct/")), true);
  } finally { await client.close(); await server.close(); }
});