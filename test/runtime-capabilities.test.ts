import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeBackend } from "../src/opencode.js";
import { nativeFixture } from "./native-fixture.js";

const capabilities = { continuation: true, exactPromptWait: false, modelSelection: false, permissions: "operator-selected", events: false, defaultMode: "read-only", modes: [
  { id: "read-only", name: "Read-only", sandboxPolicy: "readOnly", approvalPolicy: "on-request", approvalsReviewer: "user" },
] };
const identity = { status: "available", packageVersion: "0.4.0", nativeVersion: "2.0.24", build: { kind: "source", buildId: null, evidence: "package-relative-source" } };
const first = (value: Awaited<ReturnType<OpenCodeBackend["query"]>>) => value.results[0]!;

test("OpenCode runtime diagnostics describe connector capability and keep bounded canonical inventory", async () => {
  const location = { directory: "/canonical" };
  const native = nativeFixture(r => {
    if (r.path === "/api/location") return { ...location, project: { id: "p", canonical: "/canonical" } };
    if (r.path === "/api/plugin") return { location, data: [{ id: "plugin", source: { type: "local", path: "PRIVATE" }, features: { server: true }, state: { status: "active", error: "PRIVATE" } }] };
    if (r.path === "/api/mcp") return { location, data: [{ name: "server", status: { status: "connected", headers: "PRIVATE" } }] };
    if (r.path === "/api/command") return { location, data: [{ name: "review", command: "PRIVATE" }] };
    throw new Error("unexpected native route " + r.path);
  });
  const backend = new OpenCodeBackend(native.connect);
  const page = first(await backend.query([{ type: "runtime", runtime: "opencode", cwd: "/alias", limit: 1 }])).result as any;
  assert.equal(page.runtime, "opencode");
  assert.equal(page.diagnostics.capabilityScope, "connector-api");
  assert.equal(page.diagnostics.context.plane, "WorkerPlane");
  assert.equal(page.diagnostics.context.session, "not-selected");
  assert.equal(page.diagnostics.hostInterface.plane, "HostPlane");
  assert.equal(page.diagnostics.control.interface, "native-api");
  assert.equal(page.diagnostics.api.modelSelection, true);
  assert.equal(page.diagnostics.api.fork, true);
  assert.equal(page.diagnostics.api.promptCorrelation, "canonical-user-message");
  assert.deepEqual(page.diagnostics.api.sessionIdentity, ["runtime", "sessionId"]);
  assert.equal(page.diagnostics.effectiveTools.status, "unavailable");
  assert.equal(page.diagnostics.execution.osSandbox, "not-observed");
  assert.equal(page.total, 3);
  assert.equal(page.data.length, 1);
  assert.equal(page.nextCall.arguments.cwd, "/canonical");
  assert.equal(page.nextCall.arguments.runtime, "opencode");
  assert.equal(JSON.stringify(page).includes("PRIVATE"), false);
  const next = first(await backend.query([{ ...page.nextCall.arguments, type: "runtime" }])).result as any;
  assert.equal(next.data[0].type, "mcp");
  assert.equal(next.diagnostics.control.evidence, "native-location-and-inventory");
  assert.equal(native.requests.some(r => r.method !== "GET"), false);
});

test("Codex diagnostics use status RPC without a model turn and declare the OpenCode control dependency", async () => {
  const native = nativeFixture(r => {
    assert.equal(r.path, "/api/rpc/codex-sessions/status");
    assert.deepEqual(r.body, { input: {} });
    return { output: { capabilities, pluginIdentity: { ...identity, PRIVATE: "SECRET" } } };
  });
  const page = first(await new OpenCodeBackend(native.connect).query([{ type: "runtime", runtime: "codex", cwd: "/tmp" }])).result as any;
  assert.equal(page.runtime, "codex");
  assert.equal(page.diagnostics.control.service, "opencode");
  assert.equal(page.diagnostics.control.interface, "plugin-rpc");
  assert.equal(page.diagnostics.control.rpc, "codex-sessions");
  assert.equal(page.diagnostics.api.modelSelection, false);
  assert.equal(page.diagnostics.api.fork, false);
  assert.equal(page.diagnostics.api.promptCorrelation, "current-turn-only");
  assert.equal(page.diagnostics.api.nativeModes, true);
  assert.equal(page.capabilities.exactPromptWait, false);
  assert.deepEqual(page.pluginIdentity, identity);
  assert.equal(JSON.stringify(page).includes("SECRET"), false);
  assert.equal(native.requests.length, 1);
});

test("older plugins leave loaded identity unavailable while malformed identity fails without private details", async () => {
  let pluginIdentity: unknown = undefined;
  const native = nativeFixture(() => ({ output: { capabilities, ...(pluginIdentity === undefined ? {} : { pluginIdentity }) } }));
  const backend = new OpenCodeBackend(native.connect);
  const old = first(await backend.query([{ type: "runtime", runtime: "codex", cwd: "/tmp" }])).result as any;
  assert.deepEqual(old.pluginIdentity, { status: "unavailable", reason: "not-reported" });
  for (const value of [
    { ...identity, packageVersion: "SECRET" },
    { ...identity, build: { kind: "immutable", buildId: "current", evidence: "package-relative-build-record" } },
    null,
  ]) {
    pluginIdentity = value;
    const failure = first(await backend.query([{ type: "runtime", runtime: "codex", cwd: "/tmp" }]));
    assert.match(failure.error!, /invalid plugin identity/);
    assert.equal(JSON.stringify(failure).includes("SECRET"), false);
  }
});
