import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeBackend } from "../src/opencode.js";
import { nativeFixture } from "./native-fixture.js";

const location = { directory: "/tmp/project" };
const allow = { action: "*", resource: "*", effect: "allow" as const };
const agent = (id: string, hidden = false) => ({ id, name: id, mode: "primary", hidden, description: `${id} description`, system: "PRIVATE instructions", permissions: [allow], request: { headers: { authorization: "PRIVATE" } } });
// Backend queries retain their private heterogeneous envelope. MCP callers
// receive each purpose-specific projection directly.
const result = (value: unknown): any => JSON.parse(JSON.stringify(value)).results[0].result;

test("model catalog retains native enabled state, pricing, variants, ordering, location and paging mode", async () => {
  const models = ["a", "b"].map((id) => ({
    id, providerID: "opencode", name: `Model ${id}`, family: "test", canonical: null,
    status: "active", enabled: id === "a", capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    time: { released: 123 }, variants: [{ id: "high" }], limit: { context: 100000, input: 90000, output: 10000 },
    cost: [{ input: id === "a" ? 0 : 1, output: 0, cache: { read: 0, write: 0 } }],
  }));
  const fixture = nativeFixture((request) => {
    if (request.path === "/api/model") return { location, data: models };
    throw new Error("unexpected " + request.path);
  });
  const backend = new OpenCodeBackend(fixture.connect);
  const query = { type: "models" as const, cwd: location.directory, view: "compact" as const, limit: 1 };
  const first = result(await backend.query([query]));
  assert.equal(first.view, "compact");
  assert.deepEqual(first.data[0], { id: "opencode/a", enabled: true, cost: models[0].cost, modalities: ["text", "image"], variants: ["high"] });
  assert.deepEqual(first.location, location);
  assert.equal(first.nextCall.tool, "opencode.models");
  assert.equal(first.nextCall.arguments.view, "compact");
  const second = result(await backend.query([{ ...first.nextCall.arguments, type: "models" }] as any));
  assert.equal(second.data[0].id, "opencode/b");
  assert.equal(second.data[0].enabled, false);
  assert.deepEqual(second.data[0].cost, models[1].cost);
  assert.equal(second.nextCall, null);
  const defaultView = result(await backend.query([{ type: "models", cwd: location.directory }]));
  assert.equal(defaultView.view, "compact");
  assert.deepEqual(defaultView.data[0], first.data[0]);
  const full = result(await backend.query([{ type: "models", cwd: location.directory, view: "full" }]));
  assert.equal(full.view, "full");
  assert.equal(full.data[0].name, "Model a");
  assert.equal(full.data[0].contextWindow, 100000);
  assert.ok(JSON.stringify(first.data[0]).length < JSON.stringify(full.data[0]).length);
});

test("effective catalog lists native built-ins/custom agents compactly in canonical location, with explicit hidden/full views", async () => {
  const agents = [agent("build"), agent("plan"), agent("explore"), agent("general"), agent("project-reviewer"), agent("title", true)];
  const fixture = nativeFixture(() => ({ location, data: agents }));
  const backend = new OpenCodeBackend(fixture.connect);
  const compact = result(await backend.query([{ type: "agents", cwd: "/tmp/project/../project" }]));
  assert.deepEqual(compact.data.map((a: any) => a.id), ["build", "plan", "explore", "general", "project-reviewer"]);
  assert.deepEqual(compact.location, location);
  assert.equal(compact.catalog, "effective"); assert.equal(compact.includesBuiltins, true);
  assert.equal(compact.provenanceAvailable, false); assert.equal(compact.hiddenCount, 1);
  assert.equal(JSON.stringify(compact).includes("PRIVATE"), false);
  for (const entry of compact.data) {
    assert.equal("system" in entry, false); assert.equal("permissions" in entry, false);
    assert.equal("scope" in entry, false);
  }
  const full = result(await backend.query([{ type: "agents", view: "full", includeHidden: true }]));
  assert.equal(full.data.length, 6); assert.equal(full.data[0].system.text, "PRIVATE instructions");
  assert.equal("request" in full.data[0], false);
  assert.equal(fixture.requests[0].query.get("location[directory]"), "/tmp/project/../project");
});

test("empty effective catalog is labeled without inventing built-ins or custom-only semantics", async () => {
  const fixture = nativeFixture(() => ({ location, data: [] }));
  const catalog = result(await new OpenCodeBackend(fixture.connect).query([{ type: "agents" }]));
  assert.deepEqual(catalog.data, []); assert.equal(catalog.total, 0);
  assert.equal(catalog.catalog, "effective"); assert.equal(catalog.includesBuiltins, true);
  assert.deepEqual(catalog.location, location);
});

test("catalog queries project each native read directly without stabilization or filtering", async () => {
  let agentReads = 0, providerReads = 0;
  const fixture = nativeFixture((request) => {
    if (request.path === "/api/agent") { agentReads++; return { location, data: [] }; }
    if (request.path === "/api/provider") { providerReads++; return { location, data: [{ id: "openai", name: "OpenAI", activation: "disabled" }] }; }
    throw new Error("unexpected " + request.path);
  });
  const backend = new OpenCodeBackend(fixture.connect);
  const queried = JSON.parse(JSON.stringify(await backend.query([
    { type: "agents", cwd: location.directory },
    { type: "providers", cwd: location.directory },
  ]))).results;
  assert.deepEqual(queried[0].result.data, []);
  assert.deepEqual(queried[1].result.data.map((entry: { id: string }) => entry.id), ["openai"]);
  assert.equal(agentReads, 1);
  assert.equal(providerReads, 1);
});

test("catalog continuation detects location, view and hidden-filter changes", async () => {
  let currentLocation = location;
  const agents = [agent("build"), agent("plan")];
  const fixture = nativeFixture(() => ({ location: currentLocation, data: agents }));
  const backend = new OpenCodeBackend(fixture.connect);
  const query = { type: "agents" as const, limit: 1 };
  const first = result(await backend.query([query]));
  assert.deepEqual(first.nextCall, { tool: "opencode.agents", arguments: { limit: 1, cwd: location.directory, offset: first.nextOffset, fingerprint: first.fingerprint } });
  const continued = result(await backend.query([{ ...first.nextCall.arguments, type: "agents" }] as any));
  assert.equal(continued.data[0].id, "plan");
  assert.equal(continued.nextCall, null);
  const continuation = { ...query, offset: first.nextOffset, fingerprint: first.fingerprint };
  assert.equal(result(await backend.query([continuation])).data[0].id, "plan");
  for (const change of [{ view: "full" as const }, { includeHidden: true }]) {
    assert.match(JSON.stringify(await backend.query([{ ...continuation, ...change }])), /content changed/);
  }
  currentLocation = { directory: "/tmp/other" };
  assert.match(JSON.stringify(await backend.query([continuation])), /content changed/);
});

test("model continuation detects resolved location and view changes", async () => {
  let currentLocation = location;
  const models = ["a", "b"].map((id) => ({
    id, providerID: "opencode", name: `Model ${id}`, family: "test", canonical: null,
    status: "active", enabled: true, capabilities: { tools: true, input: ["text"], output: ["text"] },
    time: { released: 123 }, variants: [], limit: { context: 100000, output: 10000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  }));
  const fixture = nativeFixture(() => ({ location: currentLocation, data: models }));
  const backend = new OpenCodeBackend(fixture.connect);
  const query = { type: "models" as const, view: "compact" as const, limit: 1 };
  const first = result(await backend.query([query]));
  // The continuation carries the location the native read actually resolved,
  // so the second page is requested against the same resolved catalog.
  assert.equal(first.nextCall.tool, "opencode.models");
  assert.equal(first.nextCall.arguments.cwd, location.directory);
  const continuation = { ...query, cwd: location.directory, offset: first.nextOffset, fingerprint: first.fingerprint };
  assert.equal(result(await backend.query([continuation])).data[0].id, "opencode/b");
  assert.match(JSON.stringify(await backend.query([{ ...continuation, view: "full" }])), /content changed/);
  currentLocation = { directory: "/tmp/other" };
  assert.match(JSON.stringify(await backend.query([continuation])), /content changed/);
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


test("skill and provider pagination binds to the native resolved location", async () => {
  let resolved = location;
  const fixture = nativeFixture((request) => {
    if (request.path === "/api/skill") return { location: resolved, data: [
      { id: "one", name: "one", description: "first", path: "/tmp/one" },
      { id: "two", name: "two", description: "second", path: "/tmp/two" },
    ] };
    if (request.path === "/api/provider") return { location: resolved, data: [
      { id: "a", name: "A", activation: "enabled" },
      { id: "b", name: "B", activation: "enabled" },
    ] };
    throw new Error("unexpected " + request.path);
  });
  const backend = new OpenCodeBackend(fixture.connect);
  for (const type of ["skills", "providers"] as const) {
    resolved = location;
    const initial = result(await backend.query([{ type, limit: 1 }]));
    assert.deepEqual(initial.location, location);
    assert.equal(initial.nextCall.arguments.cwd, location.directory);
    const continuation = { ...initial.nextCall.arguments, type } as any;
    assert.equal(result(await backend.query([continuation])).data.length, 1);
    resolved = { directory: "/tmp/other" };
    assert.match(JSON.stringify(await backend.query([continuation])), /content changed/);
  }
});
