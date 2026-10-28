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
import { AdmissionError, SessionDeleteError, page } from "../src/bounds.js";

async function mcpFixture(fixture: ReturnType<typeof nativeFixture>, backend = new OpenCodeBackend(fixture.connect)) {
  const server = createServer(backend, new HostBackend(fixture.connect));
  const client = new Client({ name: "contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("MCP discovery uses resource groups and unified OpenCode worker names with bounded native command composition", async () => {
  const fixture = await mcpFixture(nativeFixture(() => { throw new Error("discovery must not access runtime"); }));
  try {
    const { tools } = await fixture.client.listTools();
    const focused = ["file.list", "file.read", "file.find", "git.repository", "git.status", "git.branches", "git.diff", "command.list", "terminal.list", "terminal.screen", "terminal.snapshot", "git.worktrees", "git.createWorktree", "git.removeWorktree", "git.refreshWorktrees", "command.run", "terminal.start", "terminal.startPersistent", "command.read", "terminal.observePersistent", "terminal.read", "terminal.remove", "command.remove", "terminal.resize", "terminal.input", "terminal.interrupt", "terminal.sendCtrlD"];
    const queries = ["opencode.sessionDiff", "opencode.inbox", "opencode.skill", "opencode.toolCalls", "opencode.toolCall", "opencode.models", "opencode.agents", "opencode.agent", "opencode.messages", "opencode.message", "opencode.permissions", "opencode.savedApprovals", "opencode.runtime", "opencode.skills", "opencode.providers", "opencode.usage", "opencode.sessions", "opencode.session"];
    const actions = ["steer", "cancelInbox", "updateInbox", "compact", "command", "invokeSkill", "interrupt", "respondPermission", "respondForm", "cancelForm", "delete", "revertStage", "revertClear", "revertCommit", "switchModel", "switchAgent", "setPermissions", "removeSavedApproval", "synthetic"].map(action => `opencode.${action === "command" ? "invokeCommand" : action}`);
    assert.equal(tools.length, 74);
    assert.deepEqual(tools.map((t) => t.name).sort(), ["connector.readiness", "opencode.recovery", "opencode.create", "opencode.continue", "opencode.fork", "opencode.wait", "opencode.activity", "opencode.result", ...queries, ...actions, "opencode.codexQuota", "file.write", ...focused].sort());
    // OpenAI plugin reference/guidelines reviewed 2026-10-15; see
    // docs/chatgpt-mcp-review.md for sources and behavior justifications.
    for (const [name, readOnlyHint, destructiveHint, openWorldHint, idempotentHint] of [
      ["connector.readiness", true, false, false, true], ["opencode.recovery", true, false, false, true],
      ["file.write", false, true, false, false],
      ["command.read", true, false, false, true], ["terminal.read", true, false, false, true], ["terminal.observePersistent", false, true, false, false], ["opencode.codexQuota", true, false, false, true],
      ...["file.list", "file.read", "file.find", "git.repository", "git.status", "git.branches", "git.diff", "command.list", "terminal.list", "terminal.screen", "terminal.snapshot", "git.worktrees"].map(name => [name, true, false, false, true] as const),
      ...["git.createWorktree", "git.removeWorktree", "command.run", "terminal.start", "terminal.startPersistent", "command.remove", "terminal.remove", "terminal.input", "terminal.interrupt", "terminal.sendCtrlD"].map(name => [name, false, true, (name.startsWith("command.") || name.startsWith("terminal.")), false] as const),
      ...["opencode.steer", "opencode.compact", "opencode.invokeCommand", "opencode.invokeSkill", "opencode.interrupt", "opencode.respondPermission", "opencode.respondForm", "opencode.revertCommit", "opencode.removeSavedApproval", "opencode.synthetic"].map(name => [name, false, true, ["opencode.steer", "opencode.compact", "opencode.invokeCommand", "opencode.invokeSkill", "opencode.interrupt", "opencode.respondPermission", "opencode.respondForm", "opencode.revertCommit", "opencode.synthetic"].includes(name), false] as const),
      ...["opencode.updateInbox", "opencode.switchModel", "opencode.switchAgent", "opencode.setPermissions"].map(name => [name, false, false, false, true] as const),
      ...["opencode.cancelInbox", "opencode.cancelForm", "opencode.delete"].map(name => [name, false, true, false, false] as const),
      ["opencode.revertStage", false, false, false, false], ["opencode.revertClear", false, false, false, true],
      ["git.refreshWorktrees", false, false, false, true],
      ["terminal.resize", false, false, false, true],
      ...["opencode.create", "opencode.continue", "opencode.fork"].map(name => [name, false, true, true, false] as const),
      ["opencode.wait", true, false, false, true],
      ["opencode.activity", true, false, false, true], ["opencode.result", true, false, false, true],
      ...queries.map(name => [name, true, false, false, true] as const),
    ] as const) {
      const tool = tools.find((t) => t.name === name)!;
      assert.ok(tool.title?.trim()); assert.ok(tool.description?.trim());
      const annotations = tools.find((t) => t.name === name)!.annotations!;
      assert.deepEqual(annotations, { readOnlyHint, destructiveHint, openWorldHint, idempotentHint }, name);
    }
    const start = tools.find((t) => t.name === "opencode.create")!.inputSchema;
    assert.equal("permissionMode" in start.properties!, false);
    assert.equal("permissions" in start.properties!, true);
    assert.equal(start.additionalProperties, false);
    const rejected = await fixture.client.callTool({ name: "opencode.create", arguments: { task: "x", model: "openai/a", cwd: "/tmp", permissionMode: "allow" } });
    assert.equal(rejected.isError, true);
  } finally { await fixture.close(); }
});

test("focused host and command tools have unique purpose-specific schemas and truthful mutation annotations", async () => {
  const fixture = await mcpFixture(nativeFixture(() => { throw new Error("schema discovery must not access runtime"); }));
  try {
    const { tools } = await fixture.client.listTools();
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    const reads = ["opencode.sessionDiff", "opencode.inbox", "opencode.skill", "opencode.toolCalls", "opencode.toolCall", "opencode.models", "opencode.agents", "opencode.agent", "opencode.messages", "opencode.message", "opencode.permissions", "opencode.savedApprovals", "opencode.runtime", "opencode.skills", "opencode.providers", "opencode.usage", "opencode.sessions", "opencode.session"];
    for (const name of ["file.list", "file.read", "file.find", "git.repository", "git.status", "git.branches", "git.diff", "command.list", "terminal.list", "terminal.screen", "terminal.snapshot", "git.worktrees", "git.createWorktree", "git.removeWorktree", "git.refreshWorktrees", "command.run", "terminal.start", "terminal.startPersistent", "command.remove", "terminal.resize", "terminal.input", "terminal.interrupt", "terminal.sendCtrlD", ...reads]) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, `missing ${name}`);
      assert.ok(tool.description?.trim());
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
    }
    for (const [name, absent] of [["file.list", "type"], ["git.worktrees", "action"], ["command.run", "kind"], ["command.remove", "action"], ["opencode.agents", "type"]] as const) {
      assert.equal(absent in tools.find(tool => tool.name === name)!.inputSchema.properties!, false, `${name} has no selector`);
    }
    const refresh = tools.find(tool => tool.name === "git.refreshWorktrees")!.annotations!;
    assert.deepEqual([refresh.readOnlyHint, refresh.destructiveHint, refresh.idempotentHint], [false, false, true]);
    const resize = tools.find(tool => tool.name === "terminal.resize")!.annotations!;
    assert.deepEqual([resize.readOnlyHint, resize.destructiveHint, resize.idempotentHint], [false, false, true]);
    const read = tools.find(tool => tool.name === "command.read")!.annotations!;
    assert.deepEqual([read.readOnlyHint, read.destructiveHint], [true, false]);
    const observer = tools.find(tool => tool.name === "terminal.observePersistent")!.annotations!;
    assert.deepEqual([observer.readOnlyHint, observer.destructiveHint, observer.idempotentHint], [false, true, false], "persistent observer may remove an exited handle");
    for (const name of ["host.inspect", "host.worktree", "command.start", "command.control", "opencode.query", "opencode.act", "opencode.start", "opencode.inspect", "status"]) assert.equal(tools.some(tool => tool.name === name), false, `${name} compatibility alias absent`);
  } finally { await fixture.close(); }
});

test("discovery states text and command wait limits in field descriptions as well as JSON Schema", async () => {
  const fixture = await mcpFixture(nativeFixture(() => { throw new Error("discovery must not access runtime"); }));
  try {
    const { tools } = await fixture.client.listTools();
    for (const name of ["opencode.skill", "opencode.message", "opencode.result"]) {
      const property = tools.find(tool => tool.name === name)!.inputSchema.properties!.textLimit as { minimum: number; maximum: number; default: number; description: string };
      assert.equal(property.minimum, 1, name);
      assert.equal(property.maximum, 12_000, name);
      assert.equal(property.default, 12_000, name);
      assert.match(property.description, /12,?000/);
      assert.match(property.description, /UTF-16/);
    }
    for (const name of ["terminal.read", "terminal.observePersistent"]) {
      const property = tools.find(tool => tool.name === name)!.inputSchema.properties!.waitMs as { minimum: number; maximum: number; description: string };
      assert.equal(property.minimum, 0, name);
      assert.equal(property.maximum, 2_000, name);
      assert.match(property.description, /2,?000/);
      assert.match(property.description, /250/);
    }
  } finally { await fixture.close(); }
});


test("focused output contracts reject unrelated operation results and retain typed errors", async () => {
  const fixture = await mcpFixture(nativeFixture(() => { throw new Error("output discovery must not access runtime"); }));
  const location = { directory: "/workspace" };
  const page = { location, data: [], offset: 0, nextOffset: null, total: 0, fingerprint: "f", nextCall: null };
  const command = { location, id: "job", cwd: location.directory, status: "running", pid: 1, exitCode: null, retention: "fixture", cursor: 0, cursorUnit: "bytes" };
  const readiness = { detail: "readiness", ready: true, connector: { version: "1", buildId: "source", release: false }, components: { opencode: { ready: true, release: "2", serverPid: 1, error: null }, events: { enabled: false, storageFailed: null }, browser: null } };
  const recovery = { ready: true, opencodeRelease: "2", serverPid: 1, workers: [], pendingActions: [] };
  const cases = [
    ["connector.readiness", readiness, recovery],
    ["opencode.recovery", recovery, readiness],
    ["file.read", { type: "read", location, path: "/workspace/a", size: 0, fingerprint: "f", nextCall: null }, { type: "find", location, data: [], limit: 1, possiblyTruncated: false, search: "a", nextCall: null }],
    ["file.list", { type: "list", ...page }, { type: "vcsStatus", ...page }],
    ["git.worktrees", { projectId: "p", ...page }, { action: "refresh", projectId: "p", persisted: true, data: [], offset: 0, nextOffset: null, total: 0, fingerprint: "f" }],
    ["git.createWorktree", { action: "create", projectId: "p", directory: "/workspace/new", persisted: true }, { action: "remove", projectId: "p", directory: "/workspace/new", persisted: true, removed: true }],
    ["terminal.start", { ...command, kind: "pty", cursorUnit: "utf16CodeUnits" }, { ...command, kind: "shell" }],
    ["command.remove", { kind: "shell", location, id: "job", removed: true }, { kind: "pty", location, id: "job", cwd: "/workspace", status: "running", pid: 1, exitCode: null, resized: true }],
    ["terminal.interrupt", { kind: "pty", location, id: "job", action: "interrupt", inputSent: true, acknowledged: false, delivery: "unacknowledged" }, { kind: "pty", location, id: "job", action: "ctrlD", inputSent: true, acknowledged: false, delivery: "unacknowledged" }],
    ["opencode.cancelForm", { action: "cancelForm", sessionId: "s", formId: "f", cancelled: true }, { action: "delete", runtime: "opencode", sessionId: "s", deleted: true }],
  ] as const;
  try {
    const { tools } = await fixture.client.listTools();
    const provider = new AjvJsonSchemaValidator();
    for (const [name, ownResult, unrelatedResult] of cases) {
      const validate = provider.getValidator(tools.find(tool => tool.name === name)!.outputSchema! as JsonSchemaType);
      assert.equal(validate(ownResult).valid, true, `${name} accepts its success result`);
      assert.equal(validate(unrelatedResult).valid, false, `${name} rejects another operation's success result`);
    }
    for (const tool of tools) {
      const validate = provider.getValidator(tool.outputSchema! as JsonSchemaType);
      assert.equal(validate({ error: "safe failure", mutationMayHaveOccurred: false }).valid, true, tool.name);
      assert.equal(validate({ error: 1 }).valid, false, `${tool.name} retains typed errors`);
    }
  } finally { await fixture.close(); }
});

test("session action tools expose selector-free contracts and dispatch each exact native action", async () => {
  class DispatchBackend extends OpenCodeBackend {
    readonly calls: Record<string, unknown>[] = [];
    override async act(input: Parameters<OpenCodeBackend["act"]>[0]): Promise<never> {
      this.calls.push(input as unknown as Record<string, unknown>);
      throw new Error("native dispatch reached");
    }
  }
  const native = nativeFixture(() => { throw new Error("dispatch stub prevents native access"); });
  const backend = new DispatchBackend(native.connect);
  const fixture = await mcpFixture(native, backend);
  const actions: [string, string, Record<string, unknown>][] = [
    ["steer", "steer", { sessionId: "s", instruction: "continue" }],
    ["cancelInbox", "cancelInbox", { sessionId: "s", inboxId: "i" }],
    ["updateInbox", "updateInbox", { sessionId: "s", inboxId: "i", delivery: "queue" }],
    ["compact", "compact", { sessionId: "s" }],
    ["invokeCommand", "command", { sessionId: "s", name: "test", text: "" }],
    ["invokeSkill", "invokeSkill", { sessionId: "s", skillId: "canonical" }],
    ["interrupt", "interrupt", { sessionId: "s" }],
    ["respondPermission", "respondPermission", { runtime: "codex", sessionId: "s", requestId: "r", optionId: "exact-option" }],
    ["respondForm", "respondForm", { sessionId: "s", formId: "f", answer: { ok: true } }],
    ["cancelForm", "cancelForm", { sessionId: "s", formId: "f" }],
    ["delete", "delete", { runtime: "opencode", sessionId: "s" }],
    ["revertStage", "revertStage", { sessionId: "s", messageId: "m" }],
    ["revertClear", "revertClear", { sessionId: "s" }],
    ["revertCommit", "revertCommit", { sessionId: "s" }],
    ["switchModel", "switchModel", { sessionId: "s", model: "openai/model" }],
    ["switchAgent", "switchAgent", { sessionId: "s", agent: "build" }],
    ["setPermissions", "setPermissions", { sessionId: "s", permissions: [] }],
    ["removeSavedApproval", "removeSavedApproval", { sessionId: "s", approvalId: "approval" }],
    ["synthetic", "synthetic", { sessionId: "s", text: "queued" }],
  ];
  try {
    const { tools } = await fixture.client.listTools();
    const provider = new AjvJsonSchemaValidator();
    for (const [toolAction, , args] of actions) {
      const tool = tools.find(candidate => candidate.name === `opencode.${toolAction}`)!;
      assert.ok(tool, `opencode.${toolAction} is registered`);
      assert.equal("action" in tool.inputSchema.properties!, false, `${tool.name} has no action selector`);
      assert.equal(provider.getValidator(tool.inputSchema as JsonSchemaType)(args).valid, true, `${tool.name} accepts only its action schema`);
      const result = await fixture.client.callTool({ name: tool.name, arguments: args });
      assert.equal(result.isError, true, `${tool.name} reached the dispatch stub`);
      assert.match((result.structuredContent as any).error, /details omitted/);
    }
    assert.equal(backend.calls.length, actions.length);
    for (let index = 0; index < actions.length; index += 1) assert.equal(backend.calls[index].action, actions[index][1]);
  } finally { await fixture.close(); }
});

test("file.read dispatch and fingerprint continuation target the selector-free file.read tool schema", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-focused-read-"));
  try {
    await writeFile(join(cwd, "data.txt"), "abcdef");
    const bytes = Buffer.from("abcdef");
    const native = nativeFixture(request => {
      if (request.path === "/api/location") return { directory: cwd, project: { id: "p", directory: cwd, canonical: cwd } };
      if (request.path.startsWith("/api/fs/read/")) return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      throw new Error(`unexpected native request ${request.path}`);
    });
    const fixture = await mcpFixture(native);
    try {
      const { tools } = await fixture.client.listTools();
      const read = tools.find(tool => tool.name === "file.read")!;
      const validate = new AjvJsonSchemaValidator().getValidator(read.inputSchema as JsonSchemaType);
      const first = await fixture.client.callTool({ name: "file.read", arguments: { cwd, path: "data.txt", limit: 2 } });
      assert.equal(first.isError, undefined);
      const content = first.structuredContent as { nextCall: { tool: string; arguments: Record<string, unknown> } };
      assert.deepEqual(content.nextCall, { tool: "file.read", arguments: { cwd, path: join(cwd, "data.txt"), limit: 2, offset: 2, fingerprint: (first.structuredContent as any).fingerprint } });
      assert.equal(validate(content.nextCall.arguments).valid, true);
      const next = await fixture.client.callTool({ name: content.nextCall.tool, arguments: content.nextCall.arguments });
      assert.equal(next.isError, undefined);
      assert.equal((next.structuredContent as any).text, "cd");
      assert.equal(native.requests.filter(request => request.path.startsWith("/api/fs/read/")).length, 2);
    } finally { await fixture.close(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("focused query dispatch and fingerprint paging target selector-free opencode tool identities", async () => {
  const cwd = "/workspace";
  const agents = ["one", "two"].map(id => ({ id, name: id, mode: "primary", hidden: false, description: `${id} agent`, system: "system", permissions: [], request: {} }));
  const native = nativeFixture(request => {
    if (request.path === "/api/agent") return { location: { directory: cwd }, data: agents };
    throw new Error(`unexpected native request ${request.path}`);
  });
  const fixture = await mcpFixture(native);
  try {
    const { tools } = await fixture.client.listTools();
    const names = ["sessionDiff", "inbox", "skill", "tools", "tool", "models", "agents", "agent", "messages", "message", "permissions", "savedApprovals", "runtime", "skills", "providers", "usage", "sessions", "session"].map(type => `opencode.${type === "tools" ? "toolCalls" : type === "tool" ? "toolCall" : type}`);
    for (const name of names) {
      const tool = tools.find(candidate => candidate.name === name)!;
      assert.ok(tool.description?.trim(), name);
      assert.ok(tool.outputSchema, name);
      assert.equal("type" in tool.inputSchema.properties!, false, `${name} has no query discriminator`);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
    }
    const first = await fixture.client.callTool({ name: "opencode.agents", arguments: { cwd, limit: 1 } });
    assert.equal(first.isError, undefined);
    const entry = first.structuredContent as any;
    assert.equal(entry.data[0].id, "one");
    const nextCall = entry.nextCall;
    assert.deepEqual(nextCall, { tool: "opencode.agents", arguments: { cwd, limit: 1, offset: 1, fingerprint: entry.fingerprint } });
    assert.equal("type" in nextCall.arguments, false);
    const schema = tools.find(tool => tool.name === nextCall.tool)!.inputSchema as JsonSchemaType;
    assert.equal(new AjvJsonSchemaValidator().getValidator(schema)(nextCall.arguments).valid, true);
    const second = await fixture.client.callTool({ name: nextCall.tool, arguments: nextCall.arguments });
    assert.equal((second.structuredContent as any).data[0].id, "two");
    assert.equal((second.structuredContent as any).nextCall, null);
  } finally { await fixture.close(); }
});

test("MCP image response contains safe metadata and one bounded image block, never duplicate base64 text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-mcp-image-"));
  await writeFile(`${cwd}/image`, "fixture");
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  const fixture = await mcpFixture(nativeFixture((r) => r.path === "/api/location" ? { directory: cwd } : new Response(png)));
  try {
    const response = await fixture.client.callTool({ name: "file.read", arguments: { cwd, path: "image", image: true } });
    assert.equal(response.isError, undefined);
    const content = response.content as {type:string;text?:string;mimeType?:string;data?:string}[];
    assert.equal(content.length, 1); assert.equal(content[0].type, "image"); assert.equal(content[0].mimeType, "image/png");
    assert.equal(content[0].text, undefined);
    assert.equal(JSON.stringify(response.structuredContent).includes(png.toString("base64")), false);
  } finally { await fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("host discovery publishes purpose-specific examples without operation selectors", async () => {
  const native = nativeFixture(() => { throw new Error("discovery must not access runtime"); });
  const fixture = await mcpFixture(native);
  try {
    const { tools } = await fixture.client.listTools();
    const provider = new AjvJsonSchemaValidator();
    for (const [name, example] of [
      ["file.list", { cwd: "/workspace" }],
      ["file.read", { cwd: "/workspace", path: "README.md", limit: 2000 }],
      ["command.run", { cwd: "/workspace", command: "pwd" }],
    ] as const) {
      const tool = tools.find(tool => tool.name === name)!;
      const validate = provider.getValidator(tool.inputSchema as JsonSchemaType);
      assert.ok(tool.description!.trim());
      assert.equal(validate(example).valid, true, `${name} example passes its published contract`);
    }
    const run = tools.find(tool => tool.name === "command.run")!;
    assert.match(run.description!, /foreground output/);
    assert.match(run.description!, /nextCall/);
    assert.match(JSON.stringify(run.outputSchema), /command\.read/, "Shell continuations name the owning read tool");
    assert.equal(native.requests.length, 0);
  } finally { await fixture.close(); }
});

test("strict union errors omit arbitrary unknown keys and reject wrong selectors before native access", async () => {
  const native = nativeFixture(() => { throw new Error("invalid arguments must not reach runtime"); });
  const fixture = await mcpFixture(native);
  try {
    for (const [name, args] of [["file.list", { type: "list", cwd: "/workspace" }], ["file.read", { cwd: "/workspace", path: "file", unknownAction: true }]] as const) {
      const result = await fixture.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Unrecognized field/);
    }
    const keys = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`PRIVATE-KEY-${i}-${"x".repeat(1000)}`, "PRIVATE-VALUE"]));
    for (const [name, args] of [
      ["file.list", { cwd: "/workspace", ...keys }],
      ["command.run", { cwd: "/workspace", command: "pwd", args: [], ...keys }],
      ["opencode.agents", { includeHidden: true, ...keys }],
    ] as const) {
      const result = await fixture.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      const json = JSON.stringify(result);
      assert.ok(Buffer.byteLength(json) < 512, `${name} unknown-field error stays concise`);
      assert.equal(json.includes("PRIVATE-"), false, "arbitrary argument keys and values are not echoed");
      assert.match(json, /Unrecognized field/);
    }
    assert.equal(native.requests.length, 0);
  } finally { await fixture.close(); }
});

test("real tools/list exposes object fields and discriminators; JSON Schema and runtime reject invalid variants", async () => {
  let nativeCalls = 0;
  const fixture = await mcpFixture(nativeFixture(() => { nativeCalls++; throw new Error("invalid inputs must not access native state"); }));
  try {
    const { tools } = await fixture.client.listTools();
    const provider = new AjvJsonSchemaValidator();
    const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
    for (const [name, fields] of [
      ["file.read", ["cwd", "path", "fingerprint"]],
      ["git.removeWorktree", ["cwd", "directory", "force"]],
      ["command.run", ["cwd", "command", "timeoutMs"]],
      ["terminal.resize", ["kind", "cwd", "id", "rows", "cols"]],
      ["opencode.switchAgent", ["sessionId", "agent"]],
      ["opencode.setPermissions", ["sessionId", "permissions"]],
    ] as const) {
      const schema = schemas.get(name)!;
      assert.equal(schema.type, "object");
      for (const field of fields) assert.ok(field in schema.properties!, `${name}.${field}`);
      assert.ok(schema.required?.length, `${name} exposes required fields`);
    }
    const agentsTool = schemas.get("opencode.agents")!;
    for (const field of ["cwd", "runtime", "view", "includeHidden", "offset", "limit", "fingerprint"]) assert.ok(field in agentsTool.properties!, `agents.${field}`);
    assert.deepEqual((agentsTool.properties!.view as { enum: string[] }).enum, ["compact", "full"]);
    assert.equal("includePermissionsSummary" in agentsTool.properties!, false);
    const sessionsTool = schemas.get("opencode.sessions")!;
    for (const field of ["cursor", "limit", "cwd", "searchTerm", "runtime"]) assert.ok(field in sessionsTool.properties!, `sessions.${field}`);
    assert.equal((sessionsTool.properties!.limit as { default?: number }).default, undefined, "OpenCode page defaults must not be injected into Codex calls");
    assert.equal((schemas.get("opencode.message")!.properties!.textLimit as { default?: number }).default, 12000);
    const start = schemas.get("opencode.create")!;
    assert.equal((start.properties!.agent as { type: string }).type, "string");
    const contextAgents = start.properties!.agents as { type: string; maxItems: number; items: { type: string; properties: Record<string, { type: string }>; required: string[]; additionalProperties: boolean } };
    assert.equal(contextAgents.type, "array");
    assert.equal(contextAgents.maxItems, 20);
    assert.equal(contextAgents.items.type, "object");
    assert.equal(contextAgents.items.properties.name.type, "string");
    assert.deepEqual(contextAgents.items.required, ["name"]);
    assert.equal(contextAgents.items.additionalProperties, false);
    assert.equal((schemas.get("opencode.switchAgent")!.properties!.agent as { type: string }).type, "string");
    const validateStart = provider.getValidator(start as JsonSchemaType);
    assert.equal(validateStart({ task: "task", cwd: "/tmp", model: "openai/a", agent: "build", agents: [{ name: "explore" }] }).valid, true);
    assert.equal(validateStart({ task: "task", cwd: "/tmp", model: "openai/a", agent: [{ name: "build" }] }).valid, false);
    assert.equal(validateStart({ task: "task", cwd: "/tmp", model: "openai/a", agents: ["explore"] }).valid, false);
    const cases: [string, Record<string, unknown>, Record<string, unknown>[]][] = [
      ["file.read", { cwd: "/tmp", path: "file", limit: 65536 }, [
        { cwd: "/tmp", limit: 1 }, { cwd: "/tmp", path: "file", limit: 65537 },
      ]],
      ["git.removeWorktree", { cwd: "/tmp", directory: "/tmp/tree", force: false }, [
        { cwd: "/tmp", directory: "/tmp/tree" }, { cwd: "/tmp", directory: "/tmp/tree", force: true, action: "remove" },
      ]],
      ["command.run", { cwd: "/tmp", command: "true", timeoutMs: 86400000 }, [
        { cwd: "/tmp", command: "true", args: [] }, { cwd: "/tmp", command: "true", timeoutMs: 86400001 },
      ]],
      ["terminal.resize", { kind: "pty", cwd: "/tmp", id: "pty", rows: 1, cols: 1000 }, [
        { kind: "shell", cwd: "/tmp", id: "shell", rows: 24, cols: 80 }, { kind: "pty", cwd: "/tmp", id: "pty", rows: 0, cols: 80 },
      ]],
      ["opencode.agents", { includeHidden: true, limit: 50 }, [{ includeHidden: true, limit: 51 }, { view: "unknown" }, { limit: 0 }]],
      ["opencode.usage", {}, [{ sessionId: "s" }, { type: "usage" }]],
      ["opencode.message", { sessionId: "s", messageId: "m", textLimit: 12000 }, [{ sessionId: "s" }, { sessionId: "s", messageId: "m", textLimit: 12001 }]],
      ["opencode.messages", { sessionId: "s", cursor: "native" }, [{ sessionId: "s", cursor: "native", order: "desc" }, { sessionId: "s", limit: 51 }]],
      ["opencode.agent", { agentId: "build", textLimit: 12000 }, [{ agentId: "build", textLimit: 12001 }]],
      ["opencode.switchAgent", { sessionId: "s", agent: "build" }, [
        { sessionId: "s", agents: [{ name: "build" }] }, { sessionId: "s", text: "x" }, { sessionId: "s", agent: [{ name: "build" }] },
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

test("discovered output schemas accept existing safe structured errors, including recovery and deletion", async () => {
  class ErrorBackend extends OpenCodeBackend {
    override async start(): Promise<never> { throw new AdmissionError("admission uncertain", { sessionId: "s", stage: "prompt", promptSubmitted: null }); }
    override async act(): Promise<never> { throw new SessionDeleteError("DELETE_READBACK_FAILED", "readback failed", true); }
  }
  const native = nativeFixture(() => Response.json({ _tag: "ServiceUnavailableError", message: "PRIVATE-UPSTREAM" }, { status: 503 }));
  const fixture = await mcpFixture(native, new ErrorBackend(native.connect));
  try {
    const { tools } = await fixture.client.listTools();
    for (const [name, args] of [
       ["git.repository", { cwd: "/workspace" }],
      ["opencode.create", { cwd: "/workspace", model: "openai/a", task: "test" }],
      ["opencode.delete", { runtime: "opencode", sessionId: "s" }],
    ] as const) {
      const response = await fixture.client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      assert.deepEqual(response.content, [], "no duplicate text payload");
      assert.equal(JSON.stringify(response).includes("PRIVATE-UPSTREAM"), false);
      const validate = new AjvJsonSchemaValidator().getValidator(tools.find(tool => tool.name === name)!.outputSchema! as JsonSchemaType);
      assert.equal(validate(response.structuredContent).valid, true, name);
      assert.equal(validate({ error: 1 }).valid, false, "error field stays typed");
      assert.equal(validate({ error: "x", recovery: { sessionId: "s", stage: "prompt", promptSubmitted: true } }).valid, false);
    }
  } finally { await fixture.close(); }
});

test("Shell admission-only run retains native create, get and output calls with saved byte cursor", async () => {
  const location = { directory: "/workspace" };
  const shell = { id: "native-shell", cwd: location.directory, status: "exited", exit: 0, time: { started: 1, ended: 2 } };
  const native = nativeFixture(r => {
    if (r.path === "/api/location") return location;
    if (r.path === "/api/shell" && r.method === "POST") return { location, data: shell };
    if (r.path === "/api/shell/native-shell") return { location, data: shell };
    if (r.path === "/api/shell/native-shell/output") return { location, data: { output: "pwd", cursor: 3, size: 3, truncated: false } };
    throw new Error(`unexpected fixture call ${r.path}`);
  });
  const fixture = await mcpFixture(native);
  try {
    const started = await fixture.client.callTool({ name: "command.run", arguments: { cwd: location.directory, command: "pwd", waitMs: 0 } });
    assert.notEqual(started.isError, true);
    assert.deepEqual(native.requests.map(r => [r.method, r.path]), [["GET", "/api/location"], ["POST", "/api/shell"]]);
    assert.deepEqual(native.requests[1].body, { cwd: location.directory, command: "pwd", timeout: 120000 });
    const handle = started.structuredContent as any;
    assert.equal(handle.id, shell.id); assert.equal(handle.cursor, 0); assert.equal(handle.cursorUnit, "bytes");
    const read = await fixture.client.callTool({ name: "command.read", arguments: { cwd: handle.cwd, id: handle.id, cursor: handle.cursor, limit: 3 } });
    assert.notEqual(read.isError, true);
    assert.deepEqual(native.requests.slice(2).map(r => [r.method, r.path]), [["GET", "/api/location"], ["GET", "/api/shell/native-shell"], ["GET", "/api/shell/native-shell/output"]]);
    assert.equal(native.requests.at(-1)!.query.get("cursor"), "0");
    assert.equal(native.requests.at(-1)!.query.get("limit"), "3");
    const result = read.structuredContent as Record<string, unknown>;
    assert.equal(result.cursor, 3); assert.equal(result.drained, true);
  } finally { await fixture.close(); }
});

test("Codex start rejects OpenCode-only fields at MCP admission while OpenCode title reaches the backend", async () => {
  const starts: Parameters<OpenCodeBackend["start"]>[0][] = [];
  class AdmissionBackend extends OpenCodeBackend {
    override async start(input: Parameters<OpenCodeBackend["start"]>[0]): Promise<never> {
      starts.push(input);
      throw new Error("test backend admission reached");
    }
  }
  const native = nativeFixture(() => { throw new Error("schema test must not access runtime"); });
  const fixture = await mcpFixture(native, new AdmissionBackend(native.connect));
  try {
    const { tools } = await fixture.client.listTools();
    const schema = tools.find(tool => tool.name === "opencode.create")!.inputSchema;
    const validate = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType);
    assert.match((schema.properties!.title as { description: string }).description, /OpenCode-only/);
    const codex = { runtime: "codex", cwd: "/tmp", task: "test" };
    assert.equal(validate(codex).valid, true);
    for (const [field, value] of Object.entries({ model: "openai/a", agent: "build", variant: "high", permissions: [], title: "x", files: [], agents: [], skills: [] })) {
      const args = { ...codex, [field]: value };
      assert.equal(validate(args).valid, false, field);
      const response = await fixture.client.callTool({ name: "opencode.create", arguments: args });
      assert.equal(response.isError, true, field);
      assert.ok(JSON.stringify(response.content).includes(`${field} is OpenCode-only and is not supported by Codex create`), field);
      assert.equal(starts.length, 0, "rejected without backend invocation");
    }
    for (const runtime of [undefined, "opencode"]) {
      const args = { ...(runtime ? { runtime } : {}), cwd: "/tmp", task: "test", model: "openai/a", title: "x" };
      assert.equal(validate(args).valid, true);
      await fixture.client.callTool({ name: "opencode.create", arguments: args });
      assert.deepEqual(starts.at(-1), args, "OpenCode title is passed through unchanged");
    }
    assert.equal(starts.length, 2);
    assert.equal(native.requests.length, 0);
  } finally { await fixture.close(); }
});

test("focused start and inspect schemas reject cross-purpose and runtime-invalid inputs before dispatch", async () => {
  let starts = 0, inspects = 0;
  class DispatchBackend extends OpenCodeBackend {
    override async start(): Promise<never> { starts++; throw new Error("start dispatched"); }
    override async inspect(): Promise<never> { inspects++; throw new Error("inspect dispatched"); }
  }
  const native = nativeFixture(() => { throw new Error("invalid schema input reached native access"); });
  const fixture = await mcpFixture(native, new DispatchBackend(native.connect));
  try {
    const { tools } = await fixture.client.listTools();
    const schemas = new Map(tools.map(tool => [tool.name, tool.inputSchema]));
    const validator = (tool: string, args: Record<string, unknown>) => new AjvJsonSchemaValidator().getValidator(schemas.get(tool)! as JsonSchemaType)(args).valid;
    const accepted: [string, Record<string, unknown>][] = [
      ["opencode.create", { cwd: "/tmp", task: "create", variant: "high", model: "openai/model" }],
      ["opencode.continue", { sessionId: "s", task: "continue", runtime: "codex", mode: "agent" }],
      ["opencode.fork", { forkFromSessionId: "s", beforeMessageId: "m", task: "fork" }],
      ["opencode.activity", { sessionId: "s" }],
      ["opencode.result", { sessionId: "s", messageId: "u", selectionCursor: "c", selectionFingerprint: "f", candidateAssistantMessageId: "a" }],
      ["opencode.result", { sessionId: "s", runtime: "codex", textLimit: 100 }],
    ];
    for (const [name, args] of accepted) assert.equal(validator(name, args), true, `${name} ${JSON.stringify(args)}`);
    const rejected: [string, Record<string, unknown>][] = [
      ["opencode.create", { task: "missing cwd" }],
      ["opencode.create", { cwd: "/tmp", task: "codex", runtime: "codex", title: "unsupported" }],
      ["opencode.continue", { sessionId: "s", task: "continue", cwd: "/tmp" }],
      ["opencode.continue", { sessionId: "s", task: "continue", permissions: [] }],
      ["opencode.continue", { sessionId: "s", task: "continue", variant: "high" }],
      ["opencode.continue", { sessionId: "s", task: "continue", mode: "agent" }],
      ["opencode.continue", { sessionId: "s", task: "continue", runtime: "codex", model: "openai/model" }],
      ["opencode.fork", { forkFromSessionId: "s", task: "fork", runtime: "codex" }],
      ["opencode.activity", { sessionId: "s", detail: "result" }],
      ["opencode.activity", { sessionId: "s", runtime: "codex", messageId: "u" }],
      ["opencode.result", { sessionId: "s", selectionCursor: "c" }],
      ["opencode.result", { sessionId: "s", candidateAssistantMessageId: "a" }],
      ["opencode.result", { sessionId: "s", runtime: "codex", messageId: "u" }],
    ];
    for (const [name, args] of rejected) {
      assert.equal(validator(name, args), false, `${name} schema`);
      const response = await fixture.client.callTool({ name, arguments: args });
      assert.equal(response.isError, true, `${name} runtime`);
      assert.equal(starts + inspects, 0, "invalid input rejected before backend dispatch");
    }
    for (const [name, args] of accepted) await fixture.client.callTool({ name, arguments: args });
    assert.equal(starts, 3);
    assert.equal(inspects, 3);
    assert.equal(native.requests.length, 0);
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
  const json = JSON.stringify(result); assert.equal(json.includes("SECRET"), false); assert.equal(json.includes('"capabilities"'), false);
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
  const fixture = await mcpFixture(native, new OpenCodeBackend(native.connect));
  try {
    const { tools } = await fixture.client.listTools();
    const schema = JSON.stringify(tools.find((tool) => tool.name === "opencode.agents")!.inputSchema);
    for (const option of ["includeHidden", "compact"]) assert.ok(schema.includes(option));
    for (const removed of ["includePermissionsSummary", "permissionSummary"]) assert.equal(schema.includes(removed), false);
    const rejected = await fixture.client.callTool({ name: "opencode.agents", arguments: { limit: 100 } });
    assert.equal(rejected.isError, true); assert.equal(calls, 0);
    assert.match(JSON.stringify(rejected.content), /limit/); assert.match(JSON.stringify(rejected.content), /50/);
    const unknown = await fixture.client.callTool({ name: "opencode.agents", arguments: { includeBuiltins: false } });
    assert.equal(unknown.isError, true); assert.equal(calls, 0);
    const accepted = await fixture.client.callTool({ name: "opencode.agents", arguments: { includeHidden: true } });
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
    const semantic = await call("opencode.activity", { sessionId: "s" });
    const waited = await call("opencode.wait", { sessionId: "s", messageId: "u" });
    assert.equal(waited.wakeReason, "actionRequired"); assert.equal(waited.pendingActions.length, 1);
    const preview = semantic.currentActivity;
    let recovered = preview.text;
    let offset = preview.textPaging.nextOffset;
    while (offset !== null) {
      const query = await call("opencode.message", { sessionId: "s", messageId: preview.id, textOffset: offset, textFingerprint: preview.textPaging.fingerprint });
      const result = query;
      recovered += result.text; offset = result.textPaging.nextOffset;
    }
    assert.equal(recovered, text);
  } finally { await fixture.close(); }
});
