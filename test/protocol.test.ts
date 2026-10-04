import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { request as httpRequest } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createMcpHandler, type JsonSchemaType } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp.js";
import { createHttpHandler } from "../src/http.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { Events } from "../src/events.js";
import { nativeFixture, session, user, assistant, FakeSocket, binary, meta as replayMeta } from "./native-fixture.js";

const version = "2026-07-28";
const meta = { "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "http-contract-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {} };
const authorization = { principal: "operator", clientId: "chatgpt", grantId: "grant", resource: "https://ingress.example/opencode-connect/mcp", scope: "opencode-connect:access", grantContext: "opaque" };

async function httpFixture(native: ReturnType<typeof nativeFixture>, events?: Events, waitTimeoutMs = 20, host = new HostBackend(native.connect)) {
  const handler = createHttpHandler(new OpenCodeBackend(native.connect, waitTimeoutMs, 0, 0), host, events);
  const app = createMcpExpressApp();
  app.all("/mcp", (req, res) => toNodeHandler(handler)(req, res, req.body));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  let id = 0;
  const send = async (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}), "x-host-ingress-auth-context": "trusted", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { _meta: meta, ...params } }) });
    return { status: response.status, headers: response.headers, reply: await response.json() as any };
  };
  return { url, send, close: async () => { await handler.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

test("SDK rejects old sessions, versions, missing metadata, header mismatches and hostile origins without native access", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-protocol-events-"));
  const events = await Events.open(join(root, "store.json"), { authenticate: async () => authorization });
  const native = nativeFixture(() => { throw new Error("rejected wire must not touch native state"); });
  const http = await httpFixture(native, events);
  try {
    const discovery = await http.send("server/discover");
    assert.equal(discovery.status, 200);
    assert.deepEqual(discovery.reply.result.supportedVersions, [version]);
    assert.equal(discovery.reply.result.resultType, "complete");
    assert.ok(discovery.reply.result.capabilities.events);
    assert.equal(discovery.headers.has("mcp-session-id"), false);
    for (const old of ["2025-06-18", "2025-11-25"]) {
      for (const method of ["server/discover", "tools/list", "initialize"]) {
        const requestMeta = { ...meta, "io.modelcontextprotocol/protocolVersion": old };
        const response = await http.send(method, method === "initialize" ? { protocolVersion: old, capabilities: {}, clientInfo: { name: "old", version: "1" }, _meta: undefined } : { _meta: requestMeta }, { "mcp-protocol-version": old });
        assert.equal(response.status, 400, method);
        assert.equal(response.reply.error.code, -32022, method);
        assert.deepEqual(response.reply.error.data.supported, [version]);
      }
    }
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(http.url, { method, headers: { accept: "text/event-stream", "mcp-session-id": "old-session" } });
      assert.equal(response.status, 405);
    }
    const initialized = await fetch(http.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-method": "notifications/initialized" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(initialized.status, 202, "SDK ignores legacy notifications without creating an exchange");
    assert.equal(await initialized.text(), "");
    let created = 0;
    const strict = createMcpHandler(() => { created++; return createServer(new OpenCodeBackend(native.connect), new HostBackend(native.connect)); }, { legacy: "reject" });
    try {
      const response = await strict.fetch(new Request(http.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
      assert.equal(response.status, 202);
      assert.equal(await response.text(), "");
      assert.equal(created, 0, "inert notification must not create a server/exchange");
    } finally { await strict.close(); }
    const protocolLess = await fetch(http.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(protocolLess.status, 400);
    const protocolLessReply = await protocolLess.json() as any;
    assert.equal(protocolLessReply.error.code, -32022);
    assert.deepEqual(protocolLessReply.error.data.supported, [version]);
    for (const body of [JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }]), JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })]) {
      const response = await fetch(http.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
      assert.equal(response.status, 400);
    }
    for (const headers of [{}, { "mcp-protocol-version": "2025-11-25" }] as Record<string, string>[]) {
      const response = await http.send("tools/list", { _meta: undefined }, headers);
      assert.equal(response.status, 400);
      assert.ok(response.reply.error);
    }
    const mutation = { name: "opencode.act", arguments: { action: "delete", sessionId: "s" } };
    for (const [params, headers] of [
      [{ ...mutation, _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }, {}],
      [mutation, { "mcp-method": "tools/list" }],
      [mutation, { "mcp-name": "status" }],
      [mutation, { "mcp-protocol-version": "2025-11-25" }],
      [{ ...mutation, _meta: { ...meta, "io.modelcontextprotocol/clientInfo": "invalid" } }, {}],
      [{ ...mutation, _meta: { ...meta, "io.modelcontextprotocol/clientCapabilities": undefined } }, {}],
    ] as [Record<string, unknown>, Record<string, string>][]) {
      const response = await http.send("tools/call", params, headers);
      assert.equal(response.status, 400);
      assert.ok([-32020, -32602].includes(response.reply.error.code));
    }
    const hostileOrigin = await http.send("tools/call", mutation, { origin: "https://hostile.example" });
    assert.equal(hostileOrigin.status, 403);
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(http.url, { method: "POST", headers: { host: "hostile.example", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...mutation, _meta: meta } }));
    });
    assert.equal(hostileHost, 403);
    for (const params of [{ cursor: "old" }, { cursor: null }, { alias: "old" }]) {
      const response = await http.send("events/list", params);
      assert.equal(response.reply.error.code, -32602);
    }
    const subscription = { name: "opencode.session.terminal", arguments: { sessionId: "s", messageId: "u" }, delivery: { mode: "webhook", url: "https://hooks.example/callback", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` } };
    for (const params of [
      { ...subscription, arguments: null }, { ...subscription, arguments: [] },
      { ...subscription, arguments: { sessionId: 1, messageId: "u" } },
      { ...subscription, arguments: { sessionId: " s", messageId: "u" } },
      { ...subscription, arguments: { sessionId: "s", messageId: "u\n" } },
      { ...subscription, arguments: { sessionId: "s", messageId: "u", alias: "old" } },
      { ...subscription, cursor: "" }, { ...subscription, cursor: "old" },
      { ...subscription, ttlMs: -1 }, { ...subscription, ttlMs: 0.5 }, { ...subscription, ttlMs: "1" },
      { ...subscription, delivery: { ...subscription.delivery, alias: "old" } },
      { ...subscription, alias: "old" },
    ]) {
      const response = await http.send("events/subscribe", params);
      assert.equal(response.reply.error.code, -32602);
    }
    const cancellation = { ...subscription, delivery: { mode: "webhook", url: subscription.delivery.url } };
    for (const params of [{ ...cancellation, delivery: subscription.delivery }, { ...cancellation, cursor: null }, { ...cancellation, arguments: "s/u" }]) {
      const response = await http.send("events/unsubscribe", params);
      assert.equal(response.reply.error.code, -32602);
    }
    assert.equal(native.requests.length, 0);
  } finally { await http.close(); await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP disconnect cancels the wait observer promptly without interrupting the native worker", { timeout: 5_000 }, async () => {
  let subscribed!: () => void;
  const ready = new Promise<void>((resolve) => { subscribed = resolve; });
  let detached!: () => void;
  const released = new Promise<void>((resolve) => { detached = resolve; });
  let eventSignal: AbortSignal | undefined;
  const base = nativeFixture(({ path }) => {
    if (path === "/api/session/s") return { data: session() };
    if (path === "/api/session/active") return { data: { s: {} } };
    if (path.endsWith("/message/u")) return { data: user("u") };
    if (path.endsWith("/message")) return { data: [user("u")], cursor: {} };
    if (path.endsWith("/permission") || path.endsWith("/form")) return { data: [] };
    throw new Error(`unexpected ${path}`);
  });
  const client = { ...base.client, event: { subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
    async *[Symbol.asyncIterator]() {
      eventSignal = signal;
      subscribed();
      try {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
          if (signal?.aborted) resolve();
        });
      } finally { detached(); }
    },
  }) } };
  const native = { ...base, connect: async () => ({ ...base.connection, client }) };
  const http = await httpFixture(native, undefined, 30_000);
  const request = httpRequest(http.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version, "mcp-method": "tools/call", "mcp-name": "opencode.wait" } });
  const disconnected = new Promise<void>((resolve) => request.once("error", () => resolve()));
  try {
    request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: "opencode.wait", arguments: { sessionId: "s", messageId: "u" } } }));
    await ready;
    request.destroy();
    await disconnected;
    await released;
    assert.equal(eventSignal?.aborted, true);
    assert.equal(native.requests.every((request) => request.method === "GET"), true);
    assert.equal(native.requests.some((request) => request.path.endsWith("/interrupt")), false);
    const inspection = await http.send("tools/call", { name: "opencode.inspect", arguments: { sessionId: "s", messageId: "u" } });
    assert.equal(inspection.reply.result.structuredContent.session.status, "inProgress");
  } finally { request.destroy(); await http.close(); }
});

test("all twelve HTTP tools publish output schemas and return one canonical structured object", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-protocol-tools-"));
  let bytes = Buffer.from("persisted");
  const state = session(cwd);
  const shell = { id: "shell", cwd, status: "exited", pid: 1, exit: 0, time: { started: 1, ended: 2 } };
  const persistent = { id: "pty", cwd, status: "running", pid: 1, sessionID: "s", size: { rows: 24, cols: 80 }, output: { head: 0, tail: 10 } };
  const native = nativeFixture((request) => {
    const { path, method } = request;
    if (path === "/api/location") return { directory: cwd, project: { id: "p", canonical: cwd } };
    if (path === "/api/session/active") return { data: {} };
    if (path === "/api/session" && method === "GET") return { data: [state], cursor: {} };
    if (path === "/api/session" || path === "/api/session/s") return { data: state };
    if (path.endsWith("/message/u")) return { data: user("u") };
    if (path.endsWith("/message")) return { data: [assistant("a", "answer"), user("u")], cursor: {} };
    if (path.endsWith("/permission") || path.endsWith("/form")) return { data: [] };
    if (path === "/api/model") return { data: [{ providerID: "openai", id: "a", enabled: true, variants: [] }] };
    if (path === "/api/agent") return { data: [{ id: "build" }] };
    if (path.endsWith("/prompt")) return { data: user("u") };
    if (path.endsWith("/interrupt")) return { interrupted: true };
    if (path.endsWith("/terminal/read")) return { data: { ptyID: "pty", screen: { text: "screen", rows: 24, cols: 80, cursor: { x: 2, y: 3 } } } };
    if (path.endsWith("/snapshot")) return { data: { info: persistent, text: "snapshot", cursor: { x: 2, y: 3 }, checkpoint: "PRIVATE-CHECKPOINT" } };
    if (path.includes("/persistent-pty/pty")) return { data: persistent };
    if (path.startsWith("/api/fs/read/")) return new Response(bytes);
    if (path === "/api/experimental/fs/write") { bytes = Buffer.from(request.bytes!); return { location: { directory: cwd }, data: { path: request.query.get("path") } }; }
    if (path.endsWith("/list")) return { location: { directory: cwd }, data: [] };
    if (path === "/api/worktree") return [{ directory: cwd }];
    if (path.endsWith("/output")) return { location: { directory: cwd }, data: { output: "output", cursor: 6, size: 6, truncated: false } };
    if (path.includes("/shell")) return method === "DELETE" ? undefined : { location: { directory: cwd }, data: shell };
    throw new Error(`unexpected fixture endpoint ${path}`);
  });
  const http = await httpFixture(native);
  try {
    const listing = await http.send("tools/list");
    assert.equal(listing.status, 200);
    const tools = listing.reply.result.tools as any[];
    assert.equal(tools.length, 12);
    const validators = new AjvJsonSchemaValidator();
    for (const tool of tools) {
      assert.equal(tool.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(tool.outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof tool.annotations[hint], "boolean");
    }
    assert.equal(tools.find((tool) => tool.name === "opencode.act").annotations.openWorldHint, true);
    const calls: [string, Record<string, unknown>][] = [
      ["status", {}], ["host.inspect", { type: "list", cwd }],
      ["host.inspect", { type: "terminalScreen", cwd, sessionId: "s" }],
      ["host.inspect", { type: "terminalSnapshot", cwd, id: "pty" }],
      ["host.write", { cwd, path: "new", encoding: "utf8", data: "written", overwrite: false }],
      ["host.worktree", { action: "list", cwd }],
      ["command.start", { kind: "shell", cwd, command: "fixture" }],
      ["command.read", { kind: "shell", cwd, id: "shell" }],
      ["command.control", { action: "remove", kind: "shell", cwd, id: "shell" }],
      ["opencode.start", { cwd, model: "openai/a", task: "fixture" }],
      ["opencode.wait", { sessionId: "s", messageId: "u" }],
      ["opencode.inspect", { sessionId: "s", messageId: "u", detail: "result" }],
      ["opencode.inspect", { sessionId: "s" }],
      ["opencode.query", { queries: [{ type: "session", sessionId: "s" }] }],
      ["opencode.act", { action: "interrupt", sessionId: "s" }],
    ];
    for (const [name, args] of calls) {
      const response = await http.send("tools/call", { name, arguments: args });
      assert.equal(response.status, 200, JSON.stringify(response.reply));
      const value = response.reply.result;
      assert.notEqual(value.isError, true, `${name}: ${JSON.stringify(value)}; fixture paths ${native.requests.slice(-4).map((request) => request.path).join(", ")}`);
      assert.equal(value.resultType, "complete");
      assert.deepEqual(value.content, []);
      assert.equal(typeof value.structuredContent, "object");
      assert.equal(JSON.stringify(value).includes("PRIVATE-CHECKPOINT"), false);
      assert.ok(value._meta["io.modelcontextprotocol/serverInfo"]);
      assert.equal(response.headers.has("mcp-session-id"), false);
      const schema = tools.find((tool) => tool.name === name).outputSchema;
      assert.equal(validators.getValidator(schema as JsonSchemaType)(value.structuredContent).valid, true, name);
    }
    const failed = await http.send("tools/call", { name: "opencode.start", arguments: { cwd, task: "fixture", model: "missing/model" } });
    assert.equal(failed.reply.result.isError, true);
    assert.deepEqual(failed.reply.result.content, []);
    assert.match(failed.reply.result.structuredContent.error, /not available/);
    const invalid = await http.send("tools/call", { name: "status", arguments: { alias: "old" } });
    assert.equal(invalid.reply.result.isError, true);
  } finally { await http.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("HTTP command.read validates metadata-unavailable success for both PTY kinds", async () => {
  for (const kind of ["pty", "persistentPty"] as const) {
    let reads = 0;
    const info = { id: "pty", cwd: "/tmp", status: "running", pid: 1, sessionID: "s", size: { rows: 24, cols: 80 }, output: { head: 10, tail: 20 } };
    const native = nativeFixture(({ path }) => {
      if (path === "/api/location") return { directory: "/tmp" };
      if (path === "/api/session/s") return { data: session() };
      if (path.endsWith("connect-token")) return { location: { directory: "/tmp" }, data: { ticket: "PRIVATE-TICKET", expires_in: 10 } };
      if (++reads > 1) return Response.json({ _tag: "ServiceUnavailableError", message: "PRIVATE-UPSTREAM" }, { status: 503 });
      return { location: { directory: "/tmp" }, data: info };
    });
    const socket = new FakeSocket();
    const host = new HostBackend(native.connect, () => {
      queueMicrotask(() => {
        if (kind === "pty") { socket.frame("é😀"); socket.frame(replayMeta(13)); }
        else {
          socket.frame(JSON.stringify({ type: "attached", replay: { requestedOffset: 0, availableOffset: 10, endOffset: 16, truncated: true } }));
          socket.frame(binary(Buffer.from("é😀")));
          socket.frame(JSON.stringify({ type: "replay_complete" }));
        }
        socket.end();
      });
      return socket.asWebSocket();
    });
    const http = await httpFixture(native, undefined, 20, host);
    try {
      const response = await http.send("tools/call", { name: "command.read", arguments: { kind, cwd: "/tmp", id: "pty", waitMs: 0 } });
      const value = response.reply.result;
      assert.notEqual(value.isError, true, JSON.stringify(value));
      assert.deepEqual(value.content, []);
      assert.equal(value.structuredContent.metadataVerified, false);
      assert.equal(value.structuredContent.output, "é😀");
      assert.equal(value.structuredContent.handleAvailable, null);
      assert.equal(value.structuredContent.drained, false);
      assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
      const listing = await http.send("tools/list");
      const schema = listing.reply.result.tools.find((tool: any) => tool.name === "command.read").outputSchema;
      assert.equal(new AjvJsonSchemaValidator().getValidator(schema)(value.structuredContent).valid, true);
    } finally { await http.close(); }
  }
});

function pngChunk(name: string, bytes: Buffer) {
  const payload = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}

test("HTTP image tool retains its separate 1 MiB media allowance above the structured JSON ceiling", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-protocol-image-"));
  await writeFile(join(cwd, "image.png"), "fixture");
  const header = Buffer.alloc(13); header.writeUInt32BE(512); header.writeUInt32BE(500, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.concat(Array.from({ length: 500 }, () => Buffer.concat([Buffer.from([0]), randomBytes(512 * 4)])));
  let bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
  assert.ok(bytes.length > 262_144 && bytes.length <= 1_048_576);
  const native = nativeFixture((request) => request.path === "/api/location" ? { directory: cwd } : new Response(bytes));
  const http = await httpFixture(native);
  try {
    const response = await http.send("tools/call", { name: "host.inspect", arguments: { type: "read", cwd, path: "image.png", image: true } });
    const result = response.reply.result;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(result.content[0].data, "base64"), bytes);
    assert.equal(result.structuredContent.size, bytes.length);
    assert.equal(JSON.stringify(result.structuredContent).includes(result.content[0].data), false);
    bytes = Buffer.concat([bytes, Buffer.alloc(1_048_577 - bytes.length)]);
    const oversized = await http.send("tools/call", { name: "host.inspect", arguments: { type: "read", cwd, path: "image.png", image: true } });
    assert.equal(oversized.reply.result.isError, true);
    assert.match(oversized.reply.result.structuredContent.error, /1 MiB/);
  } finally { await http.close(); await rm(cwd, { recursive: true, force: true }); }
});
