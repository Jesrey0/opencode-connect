import assert from "node:assert/strict";
import test from "node:test";
import { EventDiagnostics } from "../src/eventsDiagnostics.js";
import { Events } from "../src/events.js";
import { structuredResult, createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("diagnostic history is bounded by count and bytes while counters retain totals", () => {
  const trace = new EventDiagnostics(() => 1);
  for (let index = 0; index < 200; index++) trace.record("deliveryAttempt", { sessionId: "s".repeat(256), messageId: "u".repeat(256), attempt: index });
  const snapshot = trace.snapshot();
  assert.equal(snapshot.evidence.counters.deliveryAttempt, 200);
  assert.ok(snapshot.evidence.recent.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.evidence.recent)) < 25 * 1024);
  assert.equal(snapshot.evidence.recent.at(-1)!.attempt, 199);
  const fields = { requestId: 1, url: "https://secret.example", secret: "secret", rawError: "private", authorization: "credential" };
  trace.record("subscriptionReceived", fields);
  assert.deepEqual(trace.snapshot().evidence.recent.at(-1), { stage: "subscriptionReceived", timestampMs: 1, requestId: 1 });
});

test("existing status tool exposes the same sanitized event snapshot as local observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-status-"));
  const events = await Events.open(join(root, "events", "store.json"));
  const backend = new OpenCodeBackend();
  backend.status = async () => ({ ready: true, opencodeRelease: "2.0.24", serverPid: 1, workers: [], pendingActions: [] });
  const server = createServer(backend, undefined, events);
  const client = new Client({ name: "diagnostic-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const response = await client.callTool({ name: "status", arguments: {} });
    assert.equal(response.isError, undefined);
    assert.deepEqual((response.structuredContent as any).events, events.snapshot());
    assert.equal((response.structuredContent as any).ready, true);
    assert.ok(Buffer.byteLength(JSON.stringify(structuredResult({ events: events.snapshot() }))) < 262_144);
  } finally { await client.close(); await server.close(); await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("a full store with maximum-length identities keeps status diagnostics bounded and marks omitted summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-full-status-"));
  const path = join(root, "store.json");
  const { writeFile } = await import("node:fs/promises");
  const subscriptions = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [String(index), {
    id: `sub_${String(index).padStart(64, "0")}`, sessionId: "s".repeat(256), messageId: String(index).padStart(256, "u"),
    state: "active", expiresAt: null, retiredAt: null,
    authorization: { principal: "private-principal", clientId: "private-client", grantId: "private-grant", resource: "https://private.example", scope: "private-scope", grantContext: "private-context" },
    url: "https://private.example/callback", secret: "private-secret",
  }]));
  await writeFile(path, JSON.stringify({ subscriptions }));
  const events = await Events.open(path);
  try {
    for (let index = 0; index < 128; index++) events.lifecycle.record("deliveryAttempt", { sessionId: "s".repeat(256), messageId: "u".repeat(256), attempt: index });
    const snapshot = events.snapshot();
    assert.equal(snapshot.subscriptionCount, 128);
    assert.equal(snapshot.subscriptionsTruncated, true);
    assert.ok(snapshot.subscriptions.length <= 32);
    assert.equal(snapshot.states.paused, 128);
    assert.ok(Buffer.byteLength(JSON.stringify(structuredResult({ events: snapshot }))) < 110 * 1024);
    assert.equal(JSON.stringify(snapshot).includes("private-"), false);
    assert.equal(JSON.stringify(snapshot).includes("private.example"), false);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});
