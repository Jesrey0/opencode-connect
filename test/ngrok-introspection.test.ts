import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/inspect-ngrok.mjs", import.meta.url));
const secrets = ["AUTH_CANARY_1957", "PROMPT_CANARY_1957", "ARGS_CANARY_1957",
  "RESULT_CANARY_1957", "ERROR_CANARY_1957", "SESSION_CANARY_1957", "URL_CANARY_1957"];

async function cli(args: string[]) {
  try {
    const result = await execute(process.execPath, [script, ...args], { timeout: 15000, maxBuffer: 2 ** 20 });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

function privateOutput(result: { stdout: string; stderr: string }) {
  for (const secret of secrets) assert.equal((result.stdout + result.stderr).includes(secret), false, "captured data must remain private");
}

async function input(data: unknown, args: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "ngrok-introspection-"));
  try {
    const path = join(dir, secrets[2] + ".json");
    await writeFile(path, JSON.stringify(data));
    const result = await cli(["--input", path, ...args]);
    privateOutput(result);
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function wire(body: string | Buffer, fields: Record<string, string> = {}, response = false) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...fields };
  if (!Object.keys(headers).some(key => /^(content-length|transfer-encoding)$/i.test(key))) {
    headers["Content-Length"] = String(bytes.length);
  }
  const start = response ? "HTTP/1.1 200 OK" : "POST /mcp HTTP/1.1";
  return Buffer.concat([Buffer.from(start + "\r\n" + Object.entries(headers)
    .map(([key, value]) => key + ": " + value).join("\r\n") + "\r\n\r\n"), bytes]).toString("base64");
}

const call = (id: string | number, name = "command.run") =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { prompt: secrets[1], command: secrets[2] } } });
const success = (id: string | number, extra: Record<string, unknown> = {}) =>
  ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: secrets[3] }], ...extra } });

function capture(id: string, request: unknown, reply: unknown, options: {
  status?: number | null; session?: string | null; start?: string; duration?: number;
  tunnel?: string; requestRaw?: string; responseRaw?: string; path?: string; method?: string;
} = {}) {
  return {
    id, start: options.start ?? "2026-10-28T00:00:00Z", duration: options.duration ?? 1e6,
    tunnel_name: options.tunnel ?? "operator",
    request: { method: options.method ?? "POST", uri: options.path ?? "/mcp?token=" + secrets[6],
      headers: { Authorization: ["Bearer " + secrets[0]],
        ...(options.session === null ? {} : { "Mcp-Session-Id": [options.session ?? secrets[5]] }) },
      raw: options.requestRaw ?? wire(JSON.stringify(request), { Authorization: "Bearer " + secrets[0] }) },
    ...(options.status === null ? {} : { response: {
      status_code: options.status ?? 200, headers: { "Content-Type": ["application/json"] },
      ...(options.responseRaw !== undefined ? { raw: options.responseRaw } :
        reply === undefined ? {} : { raw: wire(JSON.stringify(reply), {}, true) }),
    } }),
  };
}

interface Report {
  source: string;
  inspection: { available: boolean; enabled: number; disabled: number; unknown: number };
  coverage: Record<string, number>;
  window: { first: string | null; last: string | null };
  methods: Array<{ name: string; count: number }>;
  tools: Array<{ name: string; calls: number; outcomes: Record<string, number>;
    latencyMs: { samples: number; p50: number | null; p95: number | null } }>;
  continuations: Array<{ name: string; count: number }>;
  sessionTransitions: Array<{ from: string; to: string; count: number }>;
  notes: string[];
}
function report(result: Awaited<ReturnType<typeof cli>>): Report {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
function tool(data: Report, name: string) {
  const found = data.tools.find(row => row.name === name);
  assert.ok(found, "expected tool " + name);
  return found;
}

async function server<T>(handler: RequestListener, run: (url: string) => Promise<T>) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  try { return await run("http://127.0.0.1:" + address.port + "/api/"); }
  finally { await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); }
}

test("ngrok CLI summarizes frequency, distinct failure layers and transport duration without payloads", async () => {
  const rows = [
    capture("one", call(1), success(1, { structuredContent: { nextCall: { tool: "command.read", arguments: { id: secrets[2] } } } }), { duration: 1e6 }),
    capture("two", call(2), success(2, { isError: true, structuredContent: { nextCall: { tool: "should.not.count" } } }), { duration: 2e6 }),
    capture("three", call(3), { jsonrpc: "2.0", id: 3, error: { code: -32602, message: secrets[4] } }, { duration: 3e6 }),
    capture("four", call(4), success("4"), { duration: 4e6 }),
    capture("five", call(5, "git.status"), success(5), { status: 503 }),
    capture("six", call(6, "file.read"), undefined, { status: null }),
    capture("seven", call(7, "file.read"), undefined, { duration: 6.125e6 }),
    capture("init", { jsonrpc: "2.0", id: 8, method: "initialize" }, { jsonrpc: "2.0", id: 8, result: {} }),
    capture("other-path", call(9), success(9), { path: "/health" }),
    capture("get", call(10), success(10), { method: "GET" }),
  ];
  const data = report(await input({ requests: rows }, ["--json"]));
  assert.equal(data.coverage.analyzed, 8);
  assert.equal(data.coverage.toolCalls, 7);
  assert.deepEqual(data.methods, [{ name: "tools/call", count: 7 }, { name: "initialize", count: 1 }]);
  assert.deepEqual(data.tools.map(row => [row.name, row.calls]), [["command.run", 4], ["file.read", 2], ["git.status", 1]]);
  assert.deepEqual(tool(data, "command.run").outcomes,
    { success: 1, toolError: 1, rpcError: 1, httpError: 0, pending: 0, unknown: 1 });
  assert.deepEqual(tool(data, "command.run").latencyMs, { samples: 4, p50: 2, p95: 4 });
  assert.equal(tool(data, "git.status").outcomes.httpError, 1);
  assert.deepEqual(tool(data, "file.read").outcomes,
    { success: 0, toolError: 0, rpcError: 0, httpError: 0, pending: 1, unknown: 1 });
  assert.deepEqual(tool(data, "file.read").latencyMs, { samples: 1, p50: 6.125, p95: 6.125 });
  assert.deepEqual(data.continuations, [{ name: "command.read", count: 1 }]);
  const text = await input({ requests: rows });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /command\.run \| 4 \| 1 \| 1\/1\/0 \| 0\/1 \| 2\/4/);
  assert.match(text.stdout, /command\.read \(1\)/);
});

test("ngrok CLI decodes complete SSE and chunked gzip, rejecting truncated or ambiguous evidence", async () => {
  const rpcError = { jsonrpc: "2.0", id: 4, error: { code: -32603, message: secrets[4] } };
  const zipped = gzipSync(Buffer.from(JSON.stringify(rpcError)));
  const framed = Buffer.concat([Buffer.from(zipped.length.toString(16) + ";extension=yes\r\n"), zipped, Buffer.from("\r\n0\r\n\r\n")]);
  const sse = "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }) + "\n\n" +
    "data: " + JSON.stringify(success(99, { isError: true })) + "\n\n" +
    "data: " + JSON.stringify(success(1)) + "\n\n" +
    "data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: secrets[4] } });
  const short = Buffer.from(JSON.stringify(success(2))).subarray(0, 18);
  const rows = [
    capture("sse", call(1), undefined, { responseRaw: wire(sse, { "Content-Type": "text/event-stream" }, true) }),
    capture("short", call(2), undefined, { responseRaw: wire(short, { "Content-Length": "10000" }, true) }),
    capture("tail", call(3), undefined, { responseRaw: wire("data: " + JSON.stringify(success(3)), { "Content-Type": "text/event-stream" }, true) }),
    capture("gzip", call(4), undefined, { responseRaw: wire(framed, { "Transfer-Encoding": "chunked", "Content-Encoding": "gzip" }, true) }),
    capture("bad-request", call(5), success(5), { requestRaw: "not base64 " + secrets[2] }),
    capture("ambiguous", call(6), undefined, { responseRaw: wire("data: " + JSON.stringify(success(6)) + "\n\ndata: " +
      JSON.stringify(success(6)) + "\n\n", { "Content-Type": "text/event-stream" }, true) }),
  ];
  const data = report(await input({ requests: rows }, ["--json"]));
  assert.equal(data.coverage.unreadableRequests, 1);
  assert.deepEqual(tool(data, "command.run").outcomes,
    { success: 1, toolError: 0, rpcError: 1, httpError: 0, pending: 0, unknown: 3 });
});

test("ngrok CLI matches batch IDs by type and does not invent success for malformed results", async () => {
  const rows = [
    capture("typed", [call(1), call("1")], [success("1", { isError: true }), success(1)]),
    capture("duplicate-ids", [call(2), call(2)], [success(2)]),
    capture("bad-error", call(3), { jsonrpc: "2.0", id: 3, error: { code: secrets[4] } }),
    capture("no-content", call(4), { jsonrpc: "2.0", id: 4, result: {} }),
    capture("bad-is-error", call(5), success(5, { isError: "false" })),
    capture("both", call(6), { ...success(6), error: { code: -1 } }),
    capture("accepted", call(7), undefined, { status: 202 }),
  ];
  const data = report(await input({ requests: rows }, ["--json"]));
  assert.deepEqual(tool(data, "command.run").outcomes,
    { success: 1, toolError: 1, rpcError: 0, httpError: 0, pending: 0, unknown: 7 });
});

test("ngrok CLI orders deduplicated sessions and preserves gaps, timestamp ties and isolation", async () => {
  const at = (second: number) => "2026-10-28T00:00:" + String(second).padStart(2, "0") + "Z";
  const item = (id: string, name: string, second: number, session = secrets[5], extra = {}) =>
    capture(id, call(id, name), success(id), { start: at(second), session, ...extra });
  const first = item("a", "command.run", 0);
  const rows = [
    item("c", "command.read", 3), first, item("b", "opencode.read", 1), first,
    item("other-session", "file.read", 2, "separate"),
    item("other-tunnel", "git.status", 2, secrets[5], { tunnel: "separate" }),
    item("no-session-1", "file.read", 0, secrets[5], { session: null }),
    item("no-session-2", "file.write", 3, secrets[5], { session: null }),
    item("gap-before", "gap.before", 0, "gap"),
    item("gap-unreadable", "gap.hidden", 1, "gap", { requestRaw: "invalid" }),
    item("gap-after", "gap.after", 2, "gap"),
    item("tie-before", "tie.before", 0, "tie"),
    item("tie-a", "tie.a", 1, "tie"),
    item("tie-b", "tie.b", 1, "tie"),
    item("tie-after", "tie.after", 2, "tie"),
    item("time-before", "time.before", 0, "missing-time"),
    item("time-invalid", "time.invalid", 1, "missing-time", { start: "invalid" }),
    item("time-after", "time.after", 2, "missing-time"),
  ];
  const data = report(await input({ requests: rows }, ["--json"]));
  assert.equal(data.coverage.duplicates, 1);
  assert.equal(data.coverage.callsWithoutSession, 2);
  assert.equal(data.coverage.callsWithoutTime, 1);
  assert.deepEqual(data.sessionTransitions, [
    { from: "command.run", to: "opencode.read", count: 1 },
    { from: "opencode.read", to: "command.read", count: 1 },
  ]);
  assert.deepEqual(data.window, { first: new Date(at(0)).toISOString(), last: new Date(at(3)).toISOString() });
  const limited = report(await input({ requests: rows }, ["--json", "--limit", "1"]));
  assert.equal(limited.coverage.captured, rows.length);
  assert.equal(limited.coverage.analyzed, 1);
  assert.deepEqual(limited.sessionTransitions, []);
  assert.match(limited.notes.join("\n"), /limit was reached/);
});

test("ngrok CLI uses only GET requests and reports disabled endpoint inspection", async () => {
  const requests: string[] = [];
  await server((req, res) => {
    requests.push(req.method + " " + req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/requests/http?limit=2") res.end(JSON.stringify({ requests: [] }));
    else if (req.url === "/api/endpoints") res.end(JSON.stringify({
      endpoints: [{ inspect: false, url: secrets[6] }, { inspect: true }, { inspect: "unverified" }],
    }));
    else { res.statusCode = 500; res.end(secrets[4]); }
  }, async base => {
    const result = await cli(["--api-url", base, "--limit", "2", "--json"]);
    privateOutput(result);
    const data = report(result);
    assert.equal(data.source, "agent");
    assert.deepEqual(data.inspection, { available: true, enabled: 1, disabled: 1, unknown: 1 });
    assert.match(data.notes.join("\n"), /inspection is disabled on 1/);
    assert.deepEqual(requests, ["GET /api/requests/http?limit=2", "GET /api/endpoints"]);
  });
});

test("ngrok CLI falls back to legacy tunnels only for unsupported endpoint inventory", async () => {
  for (const status of [404, 405, 500]) {
    const requests: string[] = [];
    await server((req, res) => {
      requests.push(req.method + " " + req.url);
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/api/requests/http?")) res.end(JSON.stringify({ requests: [] }));
      else if (req.url === "/api/endpoints") { res.statusCode = status; res.end(secrets[4]); }
      else if (req.url === "/api/tunnels") res.end(JSON.stringify({
        tunnels: [{ config: { inspect: false }, public_url: secrets[6] }],
      }));
      else { res.statusCode = 500; res.end(secrets[4]); }
    }, async base => {
      const result = await cli(["--api-url", base, "--json"]);
      privateOutput(result);
      const data = report(result);
      assert.equal(data.inspection.available, status !== 500);
      assert.equal(data.inspection.disabled, status === 500 ? 0 : 1);
      assert.equal(requests.includes("GET /api/tunnels"), status !== 500);
      assert.equal(requests.every(row => row.startsWith("GET ")), true);
      if (status === 500) assert.match(data.notes.join("\n"), /coverage is unverified/);
    });
  }
});

test("ngrok CLI rejects invalid arguments and inputs without echoing sensitive values", async () => {
  for (const args of [
    ["--unknown-" + secrets[2]],
    ["--limit", secrets[2]],
    ["--limit", "0"],
    ["--limit", "10001"],
    ["--path", "/mcp?token=" + secrets[6]],
    ["--input", "/missing/" + secrets[2]],
    ["--api-url", "http://user:" + secrets[0] + "@127.0.0.1:4040/api/"],
    ["--api-url", "file:///" + secrets[2]],
    ["--input", secrets[2], "--api-url", "http://127.0.0.1:4040/api/"],
  ]) {
    const result = await cli(args);
    privateOutput(result);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ngrok introspection: /);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  for (const data of [{ [secrets[2]]: true }, { requests: [null] }]) {
    const result = await input(data, ["--json"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Expected ngrok Agent API JSON/);
  }
  const dir = await mkdtemp(join(tmpdir(), "ngrok-invalid-"));
  try {
    const path = join(dir, secrets[2]);
    await writeFile(path, "{ " + secrets[2]);
    const result = await cli(["--input", path]);
    privateOutput(result);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Cannot read capture JSON/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ngrok CLI sanitizes API errors and refuses redirects rather than following captured locations", async () => {
  for (const status of [503, 200, 302]) {
    const requests: string[] = [];
    await server((req, res) => {
      requests.push(req.method + " " + req.url);
      res.statusCode = status;
      res.setHeader("Location", "/api/" + secrets[6]);
      res.end(secrets[4]);
    }, async base => {
      const result = await cli(["--api-url", base, "--json"]);
      privateOutput(result);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, status === 503 ? /HTTP 503/ : status === 200 ? /unreadable/ : /redirect/);
      assert.deepEqual(requests, ["GET /api/requests/http?limit=1000"]);
    });
  }
  let closed = "";
  await server((_req, res) => res.end("{}"), async base => { closed = base; });
  const result = await cli(["--api-url", closed]);
  privateOutput(result);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot reach/);
});
