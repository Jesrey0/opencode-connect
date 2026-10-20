// Bounded source-checkout probe: real MCP SDK/client, deterministic native fixture.
// No live services, model turns, browser actions or ChatGPT acceptance claims.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp.ts";
import { OpenCodeBackend } from "../src/opencode.ts";
import { HostBackend } from "../src/host.ts";
import { nativeFixture, session, assistant, user } from "../test/native-fixture.ts";

const recent = Array.from({ length: 20 }, (_, index) => ({ ...session(), id: `fixture-${index}` }));
let selectedSessions = 0;
const native = nativeFixture(({ path, query }) => {
  if (path === "/api/info") return native.connection.info;
  if (path === "/api/session/active") return { data: {} };
  if (path === "/api/session") {
    const limit = Number(query.get("limit"));
    assert.ok(Number.isInteger(limit) && limit > 0);
    const selected = recent.slice(0, limit);
    selectedSessions = selected.length;
    return { data: selected, cursor: { next: recent.length > limit ? "fixture-older" : null } };
  }
  const id = path.split("/")[3];
  const selected = recent.find(entry => entry.id === id);
  if (selected && path.endsWith("/message")) return {
    data: [assistant(`answer-${id}`, "Fixture-only completed result"), user(`prompt-${id}`)].map(message => ({ ...message, sessionID: id })), cursor: {},
  };
  if (selected && path === `/api/session/${id}`) return { data: selected };
  throw new Error(`Unexpected fixture request: ${path}`);
});
let connections = 0;
const connect = async () => { connections++; return { ...native.connection, info: await native.client.server.info() }; };
const server = createServer(new OpenCodeBackend(connect), new HostBackend(connect));
const client = new Client({ name: "operator-fixture-benchmark", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a); await client.connect(b);
const samples = { readiness: [], recovery: [] };
const measure = async detail => {
  const before = { requests: native.requests.length, connections };
  const start = performance.now();
  const response = await client.callTool({ name: "status", arguments: { detail } });
  const elapsedMs = performance.now() - start;
  assert.notEqual(response.isError, true);
  const result = response.structuredContent;
  assert.equal(result.ready, true);
  if (detail === "readiness") {
    assert.equal("workers" in result, false);
    assert.deepEqual(native.requests.slice(before.requests).map(request => request.path), ["/api/info"]);
  } else {
    assert.equal(result.workers.length, selectedSessions);
    assert.ok(result.workers.every(worker => worker.outcome === "completed" && worker.outcomeEvidence.selectionComplete));
  }
  return {
    elapsedMs, toolCalls: 1, nativeRequests: native.requests.length - before.requests,
    connectionReads: connections - before.connections, responseBytes: Buffer.byteLength(JSON.stringify(response)),
    verified: true,
  };
};
const summarize = rows => {
  const sorted = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const stable = field => { assert.equal(new Set(rows.map(row => row[field])).size, 1); return rows[0][field]; };
  return {
    trials: rows.length, medianMs: +((sorted[9] + sorted[10]) / 2).toFixed(3), p95Ms: +sorted[18].toFixed(3),
    toolCallsPerTrial: stable("toolCalls"), nativeRequestsPerTrial: stable("nativeRequests"),
    connectionReadsPerTrial: stable("connectionReads"), responseBytes: stable("responseBytes"), verifiedTrials: rows.filter(row => row.verified).length,
  };
};
try {
  for (let i = 0; i < 22; i++) {
    // Alternate order; discard two warmups for each detail on the same fixture.
    for (const detail of i % 2 ? ["recovery", "readiness"] : ["readiness", "recovery"]) {
      const row = await measure(detail);
      if (i >= 2) samples[detail].push(row);
    }
  }
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(), layer: "local MCP SDK with in-memory transport and deterministic native fetch fixture",
    node: process.version, fixture: { totalSessions: recent.length, selectedRecentSessions: selectedSessions, activeSessions: 0, messagesPerSession: 2, injectedLatencyMs: 0 },
    readiness: summarize(samples.readiness), recovery: summarize(samples.recovery),
    limitations: "Measures fixture processing and serialization, not network/service latency, ChatGPT routing, operator reasoning, browser health, live recovery or end-to-end workflow acceptance.",
  }, null, 2));
} finally { await client.close(); await server.close(); }
