#!/usr/bin/env node
// Read-only analysis of the ngrok Agent API. Never persist captured payloads.
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const MAX_BYTES = 64 * 1024 * 1024;
const safeName = value => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const round = value => Math.round(value * 1000) / 1000;
const counts = () => ({ success: 0, toolError: 0, rpcError: 0, httpError: 0, pending: 0, unknown: 0 });
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const ranked = map => [...map].map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

function headers(message) {
  return new Map(Object.entries(message?.headers ?? {}).map(([key, value]) =>
    [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]));
}

function unchunk(bytes) {
  const chunks = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const end = bytes.indexOf("\r\n", cursor);
    if (end < 0) throw new Error();
    const size = bytes.subarray(cursor, end).toString("ascii").split(";")[0];
    if (!/^[\da-f]+$/i.test(size)) throw new Error();
    const length = Number.parseInt(size, 16);
    cursor = end + 2;
    if (!Number.isSafeInteger(length)) throw new Error();
    if (length === 0) {
      if (bytes.subarray(cursor, cursor + 2).toString() !== "\r\n" &&
          bytes.indexOf("\r\n\r\n", cursor) < 0) throw new Error();
      return Buffer.concat(chunks);
    }
    if (cursor + length + 2 > bytes.length ||
        bytes.subarray(cursor + length, cursor + length + 2).toString() !== "\r\n") throw new Error();
    chunks.push(bytes.subarray(cursor, cursor + length));
    cursor += length + 2;
  }
  throw new Error();
}

function entity(message) {
  // ngrok raw is base64 of the entire HTTP message, including wire framing.
  try {
    const raw = message?.raw;
    if (typeof raw !== "string" || !raw || raw.length > MAX_BYTES * 1.4 ||
        raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null;
    const bytes = Buffer.from(raw, "base64");
    const boundary = bytes.indexOf("\r\n\r\n");
    if (boundary < 0) return null;
    const head = bytes.subarray(0, boundary).toString("latin1");
    if (!/^(?:HTTP\/\d(?:\.\d)? \d{3}|[A-Z]+ \S+ HTTP\/\d(?:\.\d)?)/.test(head)) return null;
    const fields = new Map();
    for (const line of head.split("\r\n").slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    let body = bytes.subarray(boundary + 4);
    const transfer = fields.get("transfer-encoding")?.toLowerCase();
    if (transfer) {
      if (transfer !== "chunked") return null;
      body = unchunk(body);
    } else if (fields.has("content-length")) {
      const length = Number(fields.get("content-length"));
      if (!Number.isSafeInteger(length) || length < 0 || body.length !== length) return null;
    }
    const encodings = (fields.get("content-encoding") ?? "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    for (const encoding of encodings.reverse()) {
      const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
      if (encoding === "identity") continue;
      if (!decode) return null;
      body = decode(body, { maxOutputLength: MAX_BYTES });
    }
    return { body: body.toString("utf8"), type: fields.get("content-type") ?? headers(message).get("content-type") ?? "" };
  } catch { return null; }
}

function messages(message) {
  const decoded = entity(message);
  if (!decoded) return [];
  try {
    if (decoded.type.toLowerCase().includes("text/event-stream")) {
      // Only terminated SSE events are evidence; ignore an incomplete tail.
      return decoded.body.replace(/\r\n/g, "\n").split("\n\n").slice(0, -1).flatMap(event => {
        const data = event.split("\n").filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) return [];
        try { return [JSON.parse(data)]; } catch { return []; }
      }).flat().filter(object);
    }
    const parsed = JSON.parse(decoded.body);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(object);
  } catch { return []; }
}

function outcome(capture, request, responses) {
  const status = capture.response?.status_code;
  if (!capture.response) return "pending";
  if (Number.isInteger(status) && status >= 300 && status <= 599) return "httpError";
  if (!Number.isInteger(status) || status < 200 || status >= 300) return "unknown";
  if (!["string", "number"].includes(typeof request.id)) return "unknown";
  const matches = responses.filter(row => row.jsonrpc === "2.0" && row.id === request.id &&
    (Object.hasOwn(row, "result") || Object.hasOwn(row, "error")));
  if (matches.length !== 1) return "unknown";
  const reply = matches[0];
  if (object(reply.error) && Number.isInteger(reply.error.code) && !Object.hasOwn(reply, "result")) return "rpcError";
  if (Object.hasOwn(reply, "error") || !object(reply.result) || !Array.isArray(reply.result.content)) return "unknown";
  if (reply.result.isError === true) return "toolError";
  if (reply.result.isError !== undefined && reply.result.isError !== false) return "unknown";
  return "success";
}

function analyze(data, { path, limit, source, inspection }) {
  if (!object(data) || !Array.isArray(data.requests) || data.requests.some(row => !object(row)))
    throw new Error("Expected ngrok Agent API JSON with a requests array.");
  const methods = new Map(), tools = new Map(), continuations = new Map(), transitions = new Map(), sessions = new Map();
  const seen = new Set(), times = [], unorderedSessions = new Set();
  function sequence(capture, timestamp, name) {
    const session = headers(capture.request).get("mcp-session-id");
    if (!session) return;
    const key = JSON.stringify([capture.tunnel_name, session]);
    if (!Number.isFinite(timestamp)) { unorderedSessions.add(key); return; }
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push({ timestamp, name });
  }
  const coverage = { captured: data.requests.length, analyzed: 0, duplicates: 0, unreadableRequests: 0,
    toolCalls: 0, unnamedToolCalls: 0, callsWithoutSession: 0, callsWithoutTime: 0 };
  for (const capture of data.requests.slice(0, limit)) {
    if (typeof capture.id === "string") {
      if (seen.has(capture.id)) { coverage.duplicates++; continue; }
      seen.add(capture.id);
    }
    let pathname;
    try { pathname = new URL(capture.request?.uri, "http://capture.invalid").pathname; } catch { continue; }
    if (pathname !== path || capture.request?.method !== "POST") continue;
    coverage.analyzed++;
    const timestamp = typeof capture.start === "string" ? Date.parse(capture.start) : NaN;
    if (Number.isFinite(timestamp)) times.push(timestamp);
    const requests = messages(capture.request).filter(row => row.jsonrpc === "2.0" && safeName(row.method));
    if (!requests.length) {
      coverage.unreadableRequests++;
      sequence(capture, timestamp, null);
      continue;
    }
    const responses = messages(capture.response);
    for (const request of requests) {
      increment(methods, request.method);
      if (request.method !== "tools/call") continue;
      coverage.toolCalls++;
      const name = safeName(request.params?.name) ? request.params.name : "(unavailable)";
      if (name === "(unavailable)") coverage.unnamedToolCalls++;
      if (!tools.has(name)) tools.set(name, { name, calls: 0, outcomes: counts(), durations: [] });
      const tool = tools.get(name);
      tool.calls++;
      const duplicateId = requests.filter(row => row.id === request.id).length > 1;
      const state = duplicateId ? "unknown" : outcome(capture, request, responses);
      tool.outcomes[state]++;
      // Agent API duration is a Go time.Duration in nanoseconds. Include completed
      // HTTP exchanges only; this is transport latency, not native job duration.
      if (capture.response && Number.isFinite(capture.duration) && capture.duration >= 0)
        tool.durations.push(capture.duration / 1e6);
      if (state === "success") {
        const reply = responses.find(row => row.jsonrpc === "2.0" && row.id === request.id && object(row.result));
        const next = reply?.result.structuredContent?.nextCall?.tool;
        if (safeName(next)) increment(continuations, next);
      }
      const session = headers(capture.request).get("mcp-session-id");
      if (!session) coverage.callsWithoutSession++;
      if (!Number.isFinite(timestamp)) coverage.callsWithoutTime++;
      sequence(capture, timestamp, name === "(unavailable)" ? null : name);
    }
  }
  for (const [key, calls] of sessions) {
    if (unorderedSessions.has(key)) continue;
    calls.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < calls.length; i++) {
      const previous = calls[i - 1], current = calls[i];
      // Unreadable calls break adjacency. Tied timestamps (including batches)
      // have no established order on either side of the tied group.
      if (previous.name && current.name && previous.timestamp < current.timestamp &&
          calls[i - 2]?.timestamp !== previous.timestamp && calls[i + 1]?.timestamp !== current.timestamp)
        increment(transitions, JSON.stringify([previous.name, current.name]));
    }
  }
  const notes = ["Counts cover only this bounded, evictable capture sample; they are not lifetime usage.",
    "Success means an observed MCP tool result, not native job or user-task success.",
    "Latency is the HTTP exchange duration; session adjacency is not proof of a workflow.",
    "Internal worker tools and model-loaded catalog visibility are outside this capture."];
  if (source === "agent" && !inspection.available) notes.push("Endpoint inspection settings could not be read; capture coverage is unverified.");
  if (inspection.disabled) notes.push("Local inspection is disabled on " + inspection.disabled + " endpoint(s); this script does not enable it.");
  if (data.requests.length >= limit) notes.push("The request limit was reached; older captures may be omitted.");
  if (!coverage.toolCalls) notes.push("No readable MCP tools/call requests in this sample.");
  if (coverage.unreadableRequests) notes.push("Some MCP request payloads are missing, unsupported or incomplete.");
  if (coverage.callsWithoutSession) notes.push("Calls without MCP session IDs are excluded from sequence analysis.");
  const rows = [...tools.values()].map(({ durations, ...tool }) => {
    durations.sort((a, b) => a - b);
    const percentile = p => durations.length ? round(durations[Math.ceil(durations.length * p) - 1]) : null;
    return { ...tool, latencyMs: { samples: durations.length, p50: percentile(.5), p95: percentile(.95) } };
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return { schemaVersion: 1, source, inspection, coverage,
    window: { first: times.length ? new Date(Math.min(...times)).toISOString() : null,
      last: times.length ? new Date(Math.max(...times)).toISOString() : null },
    methods: ranked(methods), tools: rows, continuations: ranked(continuations),
    sessionTransitions: ranked(transitions).map(({ name, count }) => {
      const [from, to] = JSON.parse(name); return { from, to, count };
    }), notes };
}

async function getJson(base, path) {
  let response;
  try { response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10000), redirect: "error" }); }
  catch { throw new Error("Cannot reach the ngrok Agent API (connection, timeout or redirect)."); }
  if (!response.ok) {
    const error = new Error("ngrok Agent API returned HTTP " + response.status + ".");
    error.status = response.status;
    await response.body?.cancel();
    throw error;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("ngrok API response is unreadable or exceeds 64 MiB."); }
}

async function inspectionState(base) {
  try {
    let entries;
    try {
      const data = await getJson(base, "endpoints");
      if (!Array.isArray(data?.endpoints)) throw new Error();
      entries = data.endpoints.map(row => row?.inspect);
    } catch (error) {
      if (error.status !== 404 && error.status !== 405) throw error;
      const data = await getJson(base, "tunnels");
      if (!Array.isArray(data?.tunnels)) throw new Error();
      entries = data.tunnels.map(row => row?.config?.inspect);
    }
    return { available: true, enabled: entries.filter(x => x === true).length,
      disabled: entries.filter(x => x === false).length, unknown: entries.filter(x => typeof x !== "boolean").length };
  } catch { return { available: false, enabled: 0, disabled: 0, unknown: 0 }; }
}

function render(report) {
  const lines = ["ngrok MCP introspection", "Sample: " + report.coverage.captured + " captured HTTP requests; " +
    report.coverage.analyzed + " MCP POSTs; " + report.coverage.toolCalls + " tool calls.",
    "Window: " + (report.window.first ?? "unavailable") + " to " + (report.window.last ?? "unavailable"), "",
    "Tool | Calls | Success | Tool/RPC/HTTP errors | Pending/Unknown | p50/p95 ms"];
  for (const tool of report.tools) {
    const o = tool.outcomes, l = tool.latencyMs;
    lines.push([tool.name, tool.calls, o.success, [o.toolError, o.rpcError, o.httpError].join("/"),
      [o.pending, o.unknown].join("/"), [l.p50 ?? "-", l.p95 ?? "-"].join("/")].join(" | "));
  }
  lines.push("", "Observed continuation targets: " + (report.continuations.map(x => x.name + " (" + x.count + ")").join(", ") || "none"),
    "Adjacent calls within MCP sessions:");
  lines.push(...report.sessionTransitions.slice(0, 20).map(x => "  " + x.from + " -> " + x.to + ": " + x.count));
  if (!report.sessionTransitions.length) lines.push("  unavailable");
  lines.push("", ...report.notes.map(note => "- " + note));
  return lines.join("\n") + "\n";
}

async function main() {
  let options;
  try {
    options = parseArgs({ options: { input: { type: "string" }, "api-url": { type: "string" },
      limit: { type: "string", default: "1000" }, path: { type: "string", default: "/mcp" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }).values;
  } catch { throw new Error("Invalid arguments. Run with --help."); }
  if (options.help) {
    console.log("Usage: node scripts/inspect-ngrok.mjs [--json] [--limit 1000] [--path /mcp]\n" +
      "       [--api-url http://127.0.0.1:4040/api/ | --input capture.json]\n\n" +
      "Reads the ngrok Agent API or a saved GET /api/requests/http JSON response.\n" +
      "Prints summaries only; never replays requests, changes capture, or saves payloads.");
    return;
  }
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("--limit must be an integer from 1 to 10000.");
  if (!/^\/[^?#\s]*$/.test(options.path)) throw new Error("--path must be an absolute HTTP path without query or fragment.");
  if (options.input && options["api-url"]) throw new Error("Choose --input or --api-url.");
  let data, inspection = { available: false, enabled: 0, disabled: 0, unknown: 0 };
  if (options.input) {
    try {
      if ((await stat(options.input)).size > MAX_BYTES) throw new Error();
      data = JSON.parse(await readFile(options.input, "utf8"));
    } catch { throw new Error("Cannot read capture JSON (missing, invalid or larger than 64 MiB)."); }
  } else {
    let base;
    try {
      base = new URL((options["api-url"] ?? "http://127.0.0.1:4040/api/").replace(/\/?$/, "/"));
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    } catch { throw new Error("--api-url must be an HTTP(S) API base without credentials, query or fragment."); }
    data = await getJson(base, "requests/http?limit=" + limit);
    inspection = await inspectionState(base);
  }
  const report = analyze(data, { path: options.path, limit, source: options.input ? "file" : "agent", inspection });
  process.stdout.write(options.json ? JSON.stringify(report, null, 2) + "\n" : render(report));
}

main().catch(error => {
  // Our errors contain only fixed diagnostics and HTTP status, never captures.
  console.error("ngrok introspection: " + error.message);
  process.exitCode = 1;
});
