import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport, type JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { BrowserBackend } from "../src/browser/backend.js";
import { nativeFixture, session, user, assistant } from "./native-fixture.js";

async function fixture(handler: Parameters<typeof nativeFixture>[0]) {
  const native = nativeFixture(handler);
  const server = createServer(new OpenCodeBackend(native.connect), new HostBackend(native.connect));
  const client = new Client({ name: "catalog-migration-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, native, close: async () => { await client.close(); await server.close(); } };
}

test("HTTP discovery advertises resource namespaces, usable conditional inputs and a bounded complete catalog", async t => {
  const browser = new BrowserBackend({ enabled: true, env: {} });
  const handler = createMcpHandler(() => createServer(undefined, undefined, undefined, browser), { legacy: "reject" });
  try {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "catalog-migration-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    }));
    const reply = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(reply));
    const tools = reply.result.tools as any[];
    assert.equal(tools.length, 99);
    assert.equal(tools.filter(tool => tool.name.startsWith("browser.")).length, 25);
    assert.equal(new Set(tools.map(tool => tool.name)).size, 99);
    for (const name of [
      "status.readiness", "status.recovery", "host.list", "host.read", "host.find", "host.write",
      "host.vcs", "host.vcsStatus", "host.vcsBranch", "host.vcsDiff", "host.worktreeList", "host.worktreeCreate",
      "host.worktreeRemove", "host.worktreeRefresh", "host.commands", "host.terminalScreen", "host.terminalSnapshot",
      "command.startShell", "command.startPty", "command.startPersistentPty", "command.observePersistentPty",
      "command.resize", "command.input", "command.interrupt", "command.ctrlD", "codex.quota",
      "opencode.inspectActivity", "opencode.inspectResult", "opencode.tools", "opencode.tool", "opencode.command",
    ]) assert.equal(tools.some(tool => tool.name === name), false, name);
    assert.equal(tools.some(tool => /^(worker|codex|host|status)\./.test(tool.name)), false);
    for (const [name, fields] of [
      ["opencode.continue", ["runtime", "sessionId", "task"]],
      ["opencode.message", ["runtime", "sessionId", "messageId"]],
      ["opencode.messages", ["runtime", "sessionId"]],
      ["opencode.permissions", ["runtime", "sessionId", "section"]],
      ["opencode.sessions", ["runtime", "cursor", "limit"]],
    ] as const) {
      const input = tools.find(tool => tool.name === name).inputSchema;
      assert.equal(input.type, "object", name);
      assert.equal(input.allOf, undefined, name + " avoids an unnecessary wrapper hiding top-level fields");
      assert.ok(input.if && input.then, name + " retains conditional constraints");
      for (const field of fields) assert.ok(input.properties[field], name + "." + field);
    }
    const bytes = Buffer.byteLength(JSON.stringify(tools));
    const inputBytes = tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool.inputSchema)), 0);
    const outputBytes = tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool.outputSchema)), 0);
    t.diagnostic(JSON.stringify({ tools: tools.length, bytes, inputBytes, outputBytes, baselineBytes: 363220 }));
    assert.ok(bytes < 330000, "The complete catalog must materially improve on the 363,220-byte baseline: " + bytes);
    assert.equal(browser.snapshot().worker, "stopped");
  } finally { await handler.close(); browser.close(); }
});

test("shell and terminal inventories filter before paging and keep native scope in executable continuations", async () => {
  const info = (id: string) => ({ id, cwd: "/tmp", status: "running", pid: 1, command: "PRIVATE", shell: "sh", file: "PRIVATE", time: { started: 1 } });
  const f = await fixture(r => {
    if (r.path === "/api/location") return { directory: "/tmp" };
    if (r.path === "/api/session/s") return { data: session() };
    if (r.path === "/api/experimental/session/s/terminal") return { data: [info("persistent-1"), info("persistent-2")] };
    if (r.path.includes("shell")) return { location: { directory: "/tmp" }, data: [info("shell-1"), info("shell-2")] };
    if (r.path.includes("pty")) return { location: { directory: "/tmp" }, data: [info("pty-1"), info("pty-2")] };
    throw new Error("unexpected " + r.path);
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await f.client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response) + JSON.stringify(f.native.requests.map(r => r.path)));
    return response.structuredContent as any;
  };
  try {
    const shell = await call("command.list", { cwd: "/tmp/.", limit: 1 });
    assert.deepEqual(shell.data.map((entry: any) => [entry.kind, entry.id]), [["shell", "shell-1"]]);
    assert.equal(shell.total, 2);
    assert.equal(shell.nextCall.tool, "command.list");
    assert.equal(shell.nextCall.arguments.cwd, "/tmp");
    assert.equal(shell.nextCall.arguments.scope, undefined);
    assert.equal(shell.nextCall.arguments.type, undefined);
    assert.equal(shell.nextCall.arguments.kind, undefined);
    assert.equal((await call(shell.nextCall.tool, shell.nextCall.arguments)).data[0].id, "shell-2");
    assert.equal(f.native.requests.some(r => /pty|persistent/.test(r.path)), false);
    const before = f.native.requests.length;
    assert.equal((await f.client.callTool({ name: "command.list", arguments: { cwd: "/tmp", sessionId: "s" } })).isError, true);
    assert.equal(f.native.requests.length, before);

    f.native.requests.length = 0;
    const ordinary = await call("terminal.list", { cwd: "/tmp" });
    assert.deepEqual(ordinary.data.map((entry: any) => entry.kind), ["pty", "pty"]);
    assert.match(ordinary.terminalListScope, /persistent PTYs: not requested/);
    assert.equal(f.native.requests.some(r => /shell|persistent/.test(r.path)), false);
    const terminal = await call("terminal.list", { cwd: "/tmp", sessionId: "s", limit: 2 });
    assert.equal(terminal.total, 4);
    assert.equal(terminal.nextCall.tool, "terminal.list");
    assert.equal(terminal.nextCall.arguments.sessionId, "s");
    const continued = await call(terminal.nextCall.tool, terminal.nextCall.arguments);
    assert.deepEqual(continued.data.map((entry: any) => [entry.kind, entry.id]), [["persistentPty", "persistent-1"], ["persistentPty", "persistent-2"]]);
    assert.equal(continued.nextCall, null);
    assert.equal(JSON.stringify(terminal).includes("PRIVATE"), false);
  } finally { await f.close(); }
});

test("direct session and message reads retain typed native identity and recover long text with their owning tool", async () => {
  const long = "A😀".repeat(3000);
  const f = await fixture(r => {
    if (r.path === "/api/session/active") return { data: {} };
    if (r.path === "/api/session/s") return { data: session() };
    if (r.path.includes("message") && r.path.endsWith("/a")) return { data: assistant("a", long) };
    if (r.path.includes("message")) return { data: [user("u"), assistant("a", long)], cursor: { next: null, previous: null } };
    throw new Error("unexpected " + r.path);
  });
  const validator = new AjvJsonSchemaValidator();
  try {
    const { tools } = await f.client.listTools();
    const check = (name: string, value: unknown) => {
      const schema = tools.find(tool => tool.name === name)!.outputSchema!;
      assert.equal(validator.getValidator(schema as JsonSchemaType)(value).valid, true, name);
    };
    const sessionReply = await f.client.callTool({ name: "opencode.session", arguments: { sessionId: "s" } });
    assert.notEqual(sessionReply.isError, true, JSON.stringify(sessionReply) + JSON.stringify(f.native.requests.map(r => r.path)));
    const s = sessionReply.structuredContent as any;
    assert.equal(s.sessionId, "s"); assert.equal(s.runtime, "opencode"); assert.equal(s.results, undefined);
    check("opencode.session", s);
    const reply = await f.client.callTool({ name: "opencode.messages", arguments: { sessionId: "s" } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply) + JSON.stringify(f.native.requests.map(r => r.path)));
    const messages = reply.structuredContent as any;
    check("opencode.messages", messages);
    const preview = messages.messages[1];
    assert.equal(preview.id, "a");
    assert.equal(preview.nextCall.tool, "opencode.message");
    const restReply = await f.client.callTool({ name: preview.nextCall.tool, arguments: preview.nextCall.arguments });
    assert.notEqual(restReply.isError, true, JSON.stringify(restReply));
    const rest = restReply.structuredContent as any;
    check("opencode.message", rest);
    assert.equal(preview.text + rest.text, long);
    assert.equal(rest.nextCall, null);
  } finally { await f.close(); }
});
