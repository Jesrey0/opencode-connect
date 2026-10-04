import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRule, V2Event } from "@opencode/client";
import { OpenCodeBackend } from "../src/opencode.js";
import { permissionSummary } from "../src/catalog.js";
import { nativeFixture, session } from "./native-fixture.js";

const location = { directory: "/tmp/project" };
const context = { type: "agent" as const, agentId: "plan", location };
const rule = (action: string, resource: string, effect: PermissionRule["effect"]): PermissionRule => ({ action, resource, effect });
const allow = rule("*", "*", "allow");
const deny = rule("*", "*", "deny");
const agent = (id: string, hidden = false) => ({ id, name: id, mode: "primary", hidden, description: `${id} description`, system: "PRIVATE instructions", permissions: [allow], request: { headers: { authorization: "PRIVATE" } } });
// Query's heterogeneous results have independent projections; these assertions
// inspect the transport shape just as an MCP caller does.
const result = (value: unknown): any => JSON.parse(JSON.stringify(value)).results[0].result;

test("effective catalog lists native built-ins/custom agents compactly in canonical location, with explicit hidden/full views", async () => {
  const agents = [agent("build"), agent("plan"), agent("explore"), agent("general"), agent("project-reviewer"), agent("title", true)];
  const fixture = nativeFixture(() => ({ location, data: agents }));
  const backend = new OpenCodeBackend(fixture.connect);
  const compact = result(await backend.query([{ type: "agents", cwd: "/tmp/project/../project", includePermissionsSummary: true }]));
  assert.deepEqual(compact.data.map((a: any) => a.id), ["build", "plan", "explore", "general", "project-reviewer"]);
  assert.deepEqual(compact.location, location);
  assert.equal(compact.catalog, "effective"); assert.equal(compact.includesBuiltins, true);
  assert.equal(compact.provenanceAvailable, false); assert.equal(compact.hiddenCount, 1);
  assert.equal(JSON.stringify(compact).includes("PRIVATE"), false);
  for (const entry of compact.data) {
    assert.equal("system" in entry, false); assert.equal("permissions" in entry, false);
    assert.equal("scope" in entry, false);
    assert.equal(entry.permissionSummary.context.type, "agent");
    assert.deepEqual(entry.permissionSummary.excludedLayers, ["sessionRules", "savedApprovals", "policies"]);
  }
  const full = result(await backend.query([{ type: "agents", view: "full", includeHidden: true }]));
  assert.equal(full.data.length, 6); assert.equal(full.data[0].system.text, "PRIVATE instructions");
  assert.equal("request" in full.data[0], false);
  assert.equal(fixture.requests[0].query.get("location[directory]"), "/tmp/project/../project");
});

test("empty effective catalog is labeled without inventing built-ins or custom-only semantics", async () => {
  const fixture = nativeFixture(() => ({ location, data: [] }));
  const catalog = result(await new OpenCodeBackend(fixture.connect, 45_000, 0, 0).query([{ type: "agents" }]));
  assert.deepEqual(catalog.data, []); assert.equal(catalog.total, 0);
  assert.equal(catalog.catalog, "effective"); assert.equal(catalog.includesBuiltins, true);
  assert.deepEqual(catalog.location, location);
});

test("catalog queries reconcile native location initialization before exposing emptiness", async () => {
  let agentReads = 0;
  let providerReads = 0;
  const events: V2Event[] = [
    { type: "agent.updated", location, data: {} } as V2Event,
    { type: "provider.updated", location, data: {} } as V2Event,
  ];
  const fixture = nativeFixture((request) => {
    if (request.path === "/api/agent") return { location, data: ++agentReads >= 3 ? [agent("build")] : [] };
    if (request.path === "/api/provider") return { location, data: ++providerReads >= 3 ? [{ id: "openai", name: "OpenAI", activation: "enabled" }] : [] };
    throw new Error("unexpected " + request.path);
  });
  const client = { ...fixture.client, event: { subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted && events.length) yield events.shift()!;
    },
  }) } };
  const backend = new OpenCodeBackend(async () => ({ ...fixture.connection, client }), 45_000, 500, 0);
  const queried = JSON.parse(JSON.stringify(await backend.query([
    { type: "agents", cwd: location.directory },
    { type: "providers", cwd: location.directory },
  ]))).results;
  assert.deepEqual(queried[0].result.data.map((entry: { id: string }) => entry.id), ["build"]);
  assert.deepEqual(queried[1].result.data.map((entry: { id: string }) => entry.id), ["openai"]);
  assert.ok(agentReads >= 3);
  assert.ok(providerReads >= 3);
});

test("catalog continuation detects location, view, hidden-filter and summarized policy changes", async () => {
  let currentLocation = location;
  const agents = [agent("build"), agent("plan")];
  const fixture = nativeFixture(() => ({ location: currentLocation, data: agents }));
  const backend = new OpenCodeBackend(fixture.connect);
  const query = { type: "agents" as const, limit: 1, includePermissionsSummary: true };
  const first = result(await backend.query([query]));
  assert.deepEqual(first.nextCall, { tool: "opencode.query", arguments: { queries: [{ ...query, cwd: location.directory, offset: first.nextOffset, fingerprint: first.fingerprint }] } });
  const continued = result(await backend.query(first.nextCall.arguments.queries));
  assert.equal(continued.data[0].id, "plan");
  assert.equal(continued.nextCall, null);
  const continuation = { ...query, offset: first.nextOffset, fingerprint: first.fingerprint };
  assert.equal(result(await backend.query([continuation])).data[0].id, "plan");
  for (const change of [{ view: "full" as const }, { includeHidden: true }]) {
    assert.match(JSON.stringify(await backend.query([{ ...continuation, ...change }])), /content changed/);
  }
  currentLocation = { directory: "/tmp/other" };
  assert.match(JSON.stringify(await backend.query([continuation])), /content changed/);
  currentLocation = location; agents[0].permissions.push(rule("read", "*.env", "deny"));
  assert.match(JSON.stringify(await backend.query([continuation])), /content changed/);
});

test("later universal allow overrides shipped restrictions; summaries never infer authority from agent names", () => {
  const rules = [allow, rule("read", "*.env", "ask"), deny, rule("edit", "*", "deny"), allow];
  const summary = permissionSummary(rules, context);
  assert.equal(summary.defaultEffect, "allow"); assert.equal(summary.defaultRuleIndex, 4);
  assert.deepEqual(summary.exceptions.data, []); assert.equal(summary.shadowedRuleCount, 4);
  assert.equal(JSON.stringify(summary).includes("read-only"), false);
});

test("summary preserves overlapping wildcard exceptions and their order, removing only provable shadows", () => {
  const rules = [deny, rule("read", "*", "allow"), rule("read", "*.env", "ask"), rule("read", "secret.env", "deny"), rule("read", "*.env", "allow")];
  const summary = permissionSummary(rules, context);
  assert.equal(summary.defaultEffect, "deny");
  assert.deepEqual(summary.exceptions.data.map(({ ruleIndex, ...r }) => r), [rules[1], rules[3], rules[4]]);
  assert.deepEqual(summary.exceptions.data.map((r) => r.ruleIndex), [1, 3, 4]);
  assert.equal(summary.shadowedRuleCount, 1);
  assert.equal(permissionSummary([], context).defaultEffect, "ask");
  const noBaseline = permissionSummary([rule("read", "*", "allow")], context);
  assert.equal(noBaseline.defaultEffect, "ask"); assert.equal(noBaseline.exceptions.total, 1);
});

test("summary pages remain bounded and detect changes even to shadowed rules or context", () => {
  const rules = [deny, ...Array.from({ length: 60 }, (_, i) => rule("read", `file-${i}`, "allow"))];
  const first = permissionSummary(rules, context, { limit: 50 });
  const continuation = { offset: first.exceptions.nextOffset!, fingerprint: first.exceptions.fingerprint, limit: 50 };
  const last = permissionSummary(rules, context, continuation);
  assert.equal(first.exceptions.data.length + last.exceptions.data.length, 60);
  assert.throws(() => permissionSummary(rules, context, { offset: 50 }), /fingerprint/);
  assert.throws(() => permissionSummary([allow, ...rules], context, continuation), /changed/);
  assert.throws(() => permissionSummary(rules, { ...context, agentId: "other" }, continuation), /changed/);
});

test("session summary appends persisted session rules and identifies unevaluated approval/policy layers", async () => {
  const state = { ...session(location.directory), agent: "plan", permissions: [deny, rule("read", "*", "allow")] };
  const fixture = nativeFixture((request) => {
    if (request.path === "/api/session/s") return { data: state };
    if (request.path === "/api/agent/plan") return { location, data: agent("plan") };
    throw new Error("summary must not read config, approvals or unrelated state");
  });
  const summary = result(await new OpenCodeBackend(fixture.connect).query([{ type: "permissions", sessionId: "s", section: "summary" }])).permissionSummary;
  assert.equal(summary.context.type, "session"); assert.equal(summary.context.sessionId, "s");
  assert.equal(summary.defaultEffect, "deny"); assert.equal(summary.exceptions.data[0].action, "read");
  assert.deepEqual(summary.excludedLayers, ["savedApprovals", "policies"]);
  assert.equal(fixture.requests[1].query.get("location[directory]"), location.directory);
});

test("single-agent summary supports independent paging and cannot invent an unset session agent", async () => {
  const rules = [deny, ...Array.from({ length: 55 }, (_, i) => rule("read", `file-${i}`, "allow"))];
  const fixture = nativeFixture((request) => request.path === "/api/session/s"
    ? { data: { ...session(location.directory), agent: undefined } }
    : { location, data: request.path === "/api/agent" ? [{ ...agent("plan"), permissions: rules }] : { ...agent("plan"), permissions: rules } });
  const backend = new OpenCodeBackend(fixture.connect);
  const query = { type: "agent" as const, agentId: "plan", field: "permissionSummary" as const, limit: 50 };
  const first = result(await backend.query([query])).permissionSummary;
  const last = result(await backend.query([{ ...query, offset: first.exceptions.nextOffset, fingerprint: first.exceptions.fingerprint }])).permissionSummary;
  assert.equal(first.exceptions.data.length + last.exceptions.data.length, 55);
  const missing = await backend.query([{ type: "permissions", sessionId: "s", section: "summary" }]);
  assert.match(missing.results[0].error!, /no persisted agent/);
  const invalid = await backend.query([{ type: "agents", limit: 100 }]);
  assert.match(invalid.results[0].error!, /limit must be an integer between 1 and 50/);
});

test("agent-not-found errors preserve only requested identity, while other native failures stay sanitized", async () => {
  const fixture = nativeFixture((request) => Response.json(request.path.endsWith("/absent")
    ? { _tag: "AgentNotFoundError", agentID: "PRIVATE", message: "PRIVATE" }
    : { _tag: "UnknownError", message: "PRIVATE provider response", ref: "PRIVATE" }, { status: request.path.endsWith("/absent") ? 404 : 500 }));
  const query = await new OpenCodeBackend(fixture.connect).query([{ type: "agent", agentId: "absent" }, { type: "agent", agentId: "build" }]);
  assert.equal(query.results[0].error, "AGENT_NOT_FOUND: absent");
  assert.equal(query.results[0].errorCode, "AGENT_NOT_FOUND"); assert.equal(query.results[0].agentId, "absent");
  assert.match(query.results[1].error!, /native operation failed/);
  assert.equal(JSON.stringify(query).includes("PRIVATE"), false);
});
