import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createServer, permissionsSchema, commandStartSchema, querySchema, structuredResult } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { nativeFixture, session, assistant, user } from "./native-fixture.js";
import { page } from "../src/bounds.js";

async function mcpFixture(fixture: ReturnType<typeof nativeFixture>, backend = new OpenCodeBackend(fixture.connect)) {
  const server = createServer(backend, new HostBackend(fixture.connect));
  const client = new Client({ name: "contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("MCP discovery uses host/command groups and canonical worker names without aliases or exec duplicate", async () => {
  const fixture = await mcpFixture(nativeFixture(() => { throw new Error("discovery must not access runtime"); }));
  try {
    const { tools } = await fixture.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["computer.observe", "computer.interact", "computer.screenshot", "computer.sequence", "print.status", "print.capabilities", "print.media", "print.declare", "print.inspect", "print.submit", "print.queue", "print.job", "print.cancel", "status", "opencode.start", "opencode.wait", "opencode.inspect", "opencode.query", "opencode.act", "host.inspect", "host.write", "host.worktree", "command.start", "command.read", "command.control"].sort());
    for (const name of ["command.read", "host.write", "host.worktree"]) {
      const annotations = tools.find((t) => t.name === name)!.annotations!;
      assert.equal(annotations.readOnlyHint, false); assert.equal(annotations.idempotentHint, false); assert.equal(annotations.destructiveHint, true);
    }
    const start = tools.find((t) => t.name === "opencode.start")!.inputSchema;
    assert.equal("permissionMode" in start.properties!, false);
    assert.equal("permissions" in start.properties!, true);
    assert.equal(start.additionalProperties, false);
    const rejected = await fixture.client.callTool({ name: "opencode.start", arguments: { task: "x", model: "openai/a", cwd: "/tmp", permissionMode: "allow" } });
    assert.equal(rejected.isError, true);
  } finally { await fixture.close(); }
});

test("MCP image response contains safe metadata and one bounded image block, never duplicate base64 text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-mcp-image-"));
  await writeFile(`${cwd}/image`, "fixture");
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  const fixture = await mcpFixture(nativeFixture((r) => r.path === "/api/location" ? { directory: cwd } : new Response(png)));
  try {
    const response = await fixture.client.callTool({ name: "host.inspect", arguments: { type: "read", cwd, path: "image", image: true } });
    assert.equal(response.isError, undefined);
    const content = response.content as {type:string;text?:string;mimeType?:string;data?:string}[];
    assert.equal(content.length, 1); assert.equal(content[0].type, "image"); assert.equal(content[0].mimeType, "image/png");
    assert.equal(content[0].text, undefined);
    assert.equal(JSON.stringify(response.structuredContent).includes(png.toString("base64")), false);
  } finally { await fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("real tools/list exposes object fields and discriminators; JSON Schema and runtime reject invalid variants", async () => {
  let nativeCalls = 0;
  const fixture = await mcpFixture(nativeFixture(() => { nativeCalls++; throw new Error("invalid inputs must not access native state"); }));
  try {
    const { tools } = await fixture.client.listTools();
    const provider = new AjvJsonSchemaValidator();
    const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
    for (const [name, discriminator, fields] of [
      ["host.inspect", "type", ["cwd", "path", "textFingerprint", "sessionId"]],
      ["host.worktree", "action", ["cwd", "directory", "force"]],
      ["command.start", "kind", ["cwd", "command", "sessionId", "timeoutMs", "args"]],
      ["command.control", "action", ["kind", "id", "text", "takeover", "rows"]],
      ["opencode.act", "action", ["sessionId", "agent", "agents", "permissions"]],
    ] as const) {
      const schema = schemas.get(name)!;
      assert.equal(schema.type, "object");
      assert.ok(schema.required?.includes(discriminator));
      assert.ok(Array.isArray((schema.properties![discriminator] as { enum: unknown[] }).enum));
      for (const field of fields) assert.ok(field in schema.properties!, `${name}.${field}`);
      assert.ok(Array.isArray(schema.oneOf), "variant constraints remain published alongside properties");
    }
    const query = schemas.get("opencode.query")!;
    const items = (query.properties!.queries as { items: { type: string; properties: Record<string, Record<string, unknown>>; required: string[]; oneOf: Record<string, unknown>[] } }).items;
    assert.equal(items.type, "object");
    assert.ok(items.required.includes("type"));
    for (const field of ["type", "agentId", "view", "includeHidden", "includePermissionsSummary", "sessionId", "messageId", "toolId", "field", "textOffset", "cursor", "limit"]) assert.ok(field in items.properties, field);
    assert.equal(items.properties.type.type, "string");
    assert.equal(items.properties.limit.type, "integer");
    assert.equal(items.properties.field.type, "string");
    assert.deepEqual(items.properties.view.enum, ["compact", "full"]);
    const sessions = items.oneOf.find((variant) => (variant.properties as Record<string, { const?: string }>).type.const === "sessions")!;
    assert.equal((sessions.properties as Record<string, { default?: number }>).limit.default, 25);
    assert.equal(items.properties.textLimit.default, 12000);
    const start = schemas.get("opencode.start")!;
    assert.equal((start.properties!.agent as { type: string }).type, "string");
    const contextAgents = start.properties!.agents as { type: string; maxItems: number; items: { type: string; properties: Record<string, { type: string }>; required: string[]; additionalProperties: boolean } };
    assert.equal(contextAgents.type, "array");
    assert.equal(contextAgents.maxItems, 20);
    assert.equal(contextAgents.items.type, "object");
    assert.equal(contextAgents.items.properties.name.type, "string");
    assert.deepEqual(contextAgents.items.required, ["name"]);
    assert.equal(contextAgents.items.additionalProperties, false);
    assert.equal((schemas.get("opencode.act")!.properties!.agent as { type: string }).type, "string");
    const validateStart = provider.getValidator(start as JsonSchemaType);
    assert.equal(validateStart({ task: "task", cwd: "/tmp", model: "openai/a", agent: "build", agents: [{ name: "explore" }] }).valid, true);
    assert.equal(validateStart({ task: "task", cwd: "/tmp", model: "openai/a", agent: [{ name: "build" }] }).valid, false);
    assert.equal(validateStart({ task: "task", cwd: "/tmp", model: "openai/a", agents: ["explore"] }).valid, false);
    const cases: [string, Record<string, unknown>, Record<string, unknown>[]][] = [
      ["host.inspect", { type: "read", cwd: "/tmp", path: "file", limit: 65536 }, [
        { type: "read", cwd: "/tmp", limit: 1 }, { type: "list", cwd: "/tmp", image: true }, { type: "find", cwd: "/tmp", query: "x", limit: 51 }, { type: "read", cwd: "/tmp", path: "x", limit: 65537 }, { type: "terminalScreen", cwd: "/tmp", sessionId: "s", lines: 1001 },
      ]],
      ["host.worktree", { action: "remove", cwd: "/tmp", directory: "/tmp/tree", force: false }, [
        { action: "remove", cwd: "/tmp", directory: "/tmp/tree" }, { action: "list", cwd: "/tmp", force: true },
      ]],
      ["command.start", { kind: "shell", cwd: "/tmp", command: "true", timeoutMs: 86400000 }, [
        { kind: "shell", cwd: "/tmp", command: "true", args: [] }, { kind: "pty", cwd: "/tmp", command: "sh", timeoutMs: 1 }, { kind: "persistentPty", cwd: "/tmp", command: "sh" }, { kind: "shell", cwd: "/tmp", command: "true", timeoutMs: 86400001 },
      ]],
      ["command.control", { action: "resize", kind: "pty", cwd: "/tmp", id: "pty", rows: 1, cols: 1000 }, [
        { action: "input", kind: "shell", cwd: "/tmp", id: "shell", text: "x" }, { action: "remove", kind: "pty", cwd: "/tmp", id: "pty", text: "x" }, { action: "resize", kind: "pty", cwd: "/tmp", id: "pty", rows: 0, cols: 80 },
      ]],
      ["opencode.query", { queries: [{ type: "agents", includePermissionsSummary: true, limit: 50 }, { type: "sessions" }] }, [
        { queries: [{ type: "agents", limit: 51 }] }, { queries: [{ type: "usage", agentId: "build" }] }, { queries: [{ type: "message", sessionId: "s" }] }, { queries: [{ type: "messages", sessionId: "s", cursor: "native", order: "desc" }] }, { queries: [{ type: "agent", agentId: "build", textLimit: 12001 }] }, { queries: [{ type: "agents", limit: 0 }] }, { queries: Array.from({ length: 11 }, () => ({ type: "usage" })) },
      ]],
      ["opencode.act", { action: "switchAgent", sessionId: "s", agent: "build" }, [
        { action: "switchAgent", sessionId: "s", agents: [{ name: "build" }] }, { action: "interrupt", sessionId: "s", text: "x" }, { action: "steer", sessionId: "s", instruction: "x", agent: "build" },
      ]],
    ];
    for (const [name, valid, invalid] of cases) {
      const validate = provider.getValidator(schemas.get(name)! as JsonSchemaType);
      const before = JSON.stringify(valid);
      assert.equal(validate(valid).valid, true, name);
      assert.equal(JSON.stringify(valid), before, "discovery defaults do not mutate arguments or replay calls");
      for (const args of invalid) {
        assert.equal(validate(args).valid, false, `${name} ${JSON.stringify(args)}`);
        const response = await fixture.client.callTool({ name, arguments: args });
        assert.equal(response.isError, true, `${name} runtime`);
      }
    }
    assert.equal(nativeCalls, 0);
  } finally { await fixture.close(); }
});

test("runtime inventory drops config/env/auth/failed-error text while retaining native capabilities", async () => {
  const native = nativeFixture((r) => {
    const location = { directory: "/tmp" };
    if (r.path === "/api/location") return { directory: "/tmp", project: { id: "p" }, env: "SECRET" };
    if (r.path === "/api/plugin") return { location, data: [{ id: "policy", source: { type: "package", target: "SECRET" }, features: { rpc: true }, state: { status: "failed", error: "SECRET", ref: "SECRET" } }] };
    if (r.path === "/api/mcp") return { location, data: [{ name: "native", status: { status: "needs_auth", error: "SECRET" }, config: { env: "SECRET", headers: "SECRET" } }] };
    if (r.path === "/api/command") return { location, data: [{ name: "init", description: "SECRET" }] };
    throw new Error(`unexpected ${r.path}`);
  });
  const result = await new OpenCodeBackend(native.connect).query([{ type: "runtime", cwd: "/tmp" }]);
  assert.equal(result.results.some((entry) => "error" in entry), false);
  const json = JSON.stringify(result); assert.equal(json.includes("SECRET"), false); assert.ok(json.includes('"liveLsp":false'));
  assert.equal(native.requests.some((r) => r.path.includes("config") || r.path.includes("credential")), false);
});

test("structured JSON projections fail visibly at 256 KiB; paged native projections remain bounded and complete", () => {
  const data = Array.from({ length: 40 }, (_, id) => ({ id, text: "x".repeat(16000) }));
  assert.throws(() => structuredResult({ data }), /256 KiB/);
  let offset = 0; let total = 0; let hash: string | undefined;
  while (true) {
    const result = page(data, { offset, limit: 50, fingerprint: hash });
    const transport = structuredResult(result);
    assert.deepEqual(transport.content, []);
    assert.ok(Buffer.byteLength(JSON.stringify(transport)) < 100000);
    total += result.data.length;
    if (result.nextOffset === null) break;
    offset = result.nextOffset; hash = result.fingerprint;
  }
  assert.equal(total, data.length);
});

test("schemas bound commands, dimensions, permission lists and native message pages", () => {
  assert.equal(permissionsSchema.safeParse([{ action: "read", resource: "*", effect: "allow" }]).success, true);
  assert.equal(permissionsSchema.safeParse([{ action: "read", resource: "*", effect: "allow", alias: "readonly" }]).success, false);
  assert.equal(permissionsSchema.safeParse(Array.from({length:101},()=>({action:"read",resource:"*",effect:"allow"}))).success,false);
  assert.equal(commandStartSchema.safeParse({kind:"persistentPty",cwd:"/tmp",sessionId:"s",command:"sh",rows:0}).success,false);
  assert.equal(commandStartSchema.safeParse({kind:"persistentPty",cwd:"/tmp",sessionId:"s",command:"sh",args:Array.from({length:101},()=>"-x")}).success,false);
  assert.equal(querySchema.safeParse({type:"messages",sessionId:"s",limit:51}).success,false);
});

test("MCP catalog advertises compact options and reports field-specific bounds before native access", async () => {
  let calls = 0;
  const native = nativeFixture(() => { calls += 1; return { location: { directory: "/tmp" }, data: [] }; });
  const fixture = await mcpFixture(native, new OpenCodeBackend(native.connect, 45_000, 0, 0));
  try {
    const { tools } = await fixture.client.listTools();
    const schema = JSON.stringify(tools.find((tool) => tool.name === "opencode.query")!.inputSchema);
    for (const option of ["includePermissionsSummary", "includeHidden", "permissionSummary", "compact"]) assert.ok(schema.includes(option));
    const rejected = await fixture.client.callTool({ name: "opencode.query", arguments: { queries: [{ type: "agents", limit: 100 }] } });
    assert.equal(rejected.isError, true); assert.equal(calls, 0);
    assert.match(JSON.stringify(rejected.content), /limit/); assert.match(JSON.stringify(rejected.content), /50/);
    const unknown = await fixture.client.callTool({ name: "opencode.query", arguments: { queries: [{ type: "agents", includeBuiltins: false }] } });
    assert.equal(unknown.isError, true); assert.equal(calls, 0);
    const accepted = await fixture.client.callTool({ name: "opencode.query", arguments: { queries: [{ type: "agents", includePermissionsSummary: true }] } });
    assert.notEqual(accepted.isError, true); assert.equal(calls, 1);
    assert.deepEqual(accepted.content, []);
    assert.match(JSON.stringify(accepted.structuredContent), /effective/);
  } finally { await fixture.close(); }
});

test("semantic and action-required recovery stay transport-bounded with long Unicode history and recover full messages", async () => {
  const text = "界".repeat(15000);
  const messages = Array.from({ length: 20 }, (_, i) => assistant(`a${i}`, text));
  const native = nativeFixture((r) => {
    if (r.path === "/api/session/s") return { data: session() };
    if (r.path === "/api/session/active") return { data: { s: {} } };
    if (r.path.endsWith("/message/u")) return { data: user("u") };
    if (r.path.endsWith("/message/a0")) return { data: messages[0] };
    if (r.path.endsWith("/message")) return { data: messages, cursor: {} };
    if (r.path.endsWith("/permission")) return { data: [{ id: "pending", sessionID: "s", action: "edit", resources: ["file"] }] };
    if (r.path.endsWith("/form")) return { data: [] };
    throw new Error(`unexpected ${r.path}`);
  });
  const fixture = await mcpFixture(native);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fixture.client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.content, []);
    assert.ok(Buffer.byteLength(JSON.stringify(response.structuredContent)) < 100000);
    return response.structuredContent as any;
  };
  try {
    const semantic = await call("opencode.inspect", { sessionId: "s", detail: "semantic" });
    const waited = await call("opencode.wait", { sessionId: "s", messageId: "u" });
    assert.equal(waited.wakeReason, "actionRequired"); assert.equal(waited.pendingActions.length, 1);
    const preview = semantic.currentActivity;
    let recovered = preview.text;
    let offset = preview.textPaging.nextOffset;
    while (offset !== null) {
      const query = await call("opencode.query", { queries: [{ type: "message", sessionId: "s", messageId: preview.id, textOffset: offset, textFingerprint: preview.textPaging.fingerprint }] });
      const result = query.results[0].result;
      recovered += result.text; offset = result.textPaging.nextOffset;
    }
    assert.equal(recovered, text);
  } finally { await fixture.close(); }
});
