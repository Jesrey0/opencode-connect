import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Events, EVENT_NAME, MAX_DELIVERIES_PER_TICK, canonicalTerminalStatus, standardWebhookSignature, validateCallbackUrl } from "../src/events.js";
import { createHttpHandler } from "../src/http.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { nativeFixture } from "./native-fixture.js";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const auth = { principal: "operator", clientId: "chatgpt", grantId: "g1", resource: "https://ingress.example/opencode-connect/mcp", scope: "opencode-connect:access", grantContext: "sealed" };

function eventHarness(path: string, statuses: number[] = []) {
  let time = 1_800_000_000_000;
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  let valid = true;
  const eventsPromise = Events.open(path, {
    authenticate: async () => auth,
    valid: async () => valid,
    now: () => time,
    post: async (url, body, headers) => {
      requests.push({ url: url.href, body, headers });
      if (JSON.parse(body).type === "verification") return { status: 200, body: Buffer.from(JSON.stringify({ challenge: JSON.parse(body).challenge })) };
      return { status: statuses.shift() ?? 200, body: Buffer.alloc(0) };
    },
  });
  return { eventsPromise, requests, advance: (ms: number) => { time += ms; }, revoke: () => { valid = false; } };
}

async function subscribe(events: Events, messageId = "u1", signingSecret = secret) {
  return events.subscribe({ name: EVENT_NAME, arguments: { sessionId: "s1", messageId }, delivery: { mode: "webhook", url: "https://hooks.example/callback", secret: signingSecret } }, auth, async () => {});
}

test("Events catalog publishes exactly one exact session/message terminal event", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-"));
  const events = await Events.open(join(root, "events", "store.json"));
  try {
    const catalog = events.catalog();
    assert.equal(catalog.events.length, 1);
    assert.equal(catalog.events[0]!.name, EVENT_NAME);
    assert.deepEqual(catalog.events[0]!.inputSchema.required, ["sessionId", "messageId"]);
    assert.equal(catalog.events[0]!.inputSchema.additionalProperties, false);
    assert.deepEqual((catalog.events[0]!.payloadSchema.properties!.status as { enum: string[] }).enum, ["completed", "failed", "interrupted", "incomplete"]);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("Standard Webhooks signature uses exact body bytes and verified callback URLs require public HTTPS", () => {
  const body = '{"data":"界"}';
  const signed = standardWebhookSignature(secret, "evt_1", "1790000000", body);
  assert.equal(signed, "v1,d4hQARR4+39L5JVZjd3EmGIG0/ANh5GdWfEQjm9kVMs=", "independent HMAC-SHA256 vector over exact UTF-8 body bytes");
  assert.notEqual(signed, standardWebhookSignature(secret, "evt_1", "1790000000", `${body} `));
  assert.equal(validateCallbackUrl("https://receiver.example/events").href, "https://receiver.example/events");
  for (const url of ["http://receiver.example", "https://user:pass@receiver.example", "https://receiver.example:444", "https://127.0.0.1/hook", "https://[::1]/hook", "https://[2001:db8::1]/hook", "https://receiver.example/#fragment"]) {
    assert.throws(() => validateCallbackUrl(url), url);
  }
});

test("TTL defaults, clamps, null lifetime and refresh preserve exact principal-owned identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-ttl-"));
  const fixture = eventHarness(join(root, "store.json"));
  const events = await fixture.eventsPromise;
  const input = { name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u1" }, delivery: { mode: "webhook", url: "https://hooks.example/callback", secret } };
  try {
    const original = await events.subscribe(input, auth, async () => {});
    const time = 1_800_000_000_000;
    assert.equal(Date.parse(original.refreshBefore!), time + 3_600_000);
    fixture.advance(1000);
    for (const [ttlMs, granted] of [[0, 60_000], [90_000, 90_000], [100_000_000, 86_400_000]] as const) {
      const refreshed = await events.subscribe({ ...input, ttlMs, cursor: null }, auth, async () => {});
      assert.equal(refreshed.id, original.id);
      assert.equal(Date.parse(refreshed.refreshBefore!), time + 1000 + granted);
    }
    const perpetual = await events.subscribe({ ...input, ttlMs: null }, auth, async () => {});
    assert.equal(perpetual.id, original.id); assert.equal(perpetual.refreshBefore, null);
    const cancellation = { ...input, delivery: { mode: "webhook", url: input.delivery.url } };
    await events.unsubscribe(cancellation, { ...auth, principal: "other-principal" });
    assert.equal(events.diagnostics()[0]!.state, "active");
    await events.unsubscribe(cancellation, auth);
    assert.equal(events.diagnostics()[0]!.state, "cancelled");
    await events.observe("s1", "u1", "completed"); await events.processDeliveries();
    assert.equal(fixture.requests.length, 1, "cancelled exact subscription must not deliver");
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("expiry during asynchronous grant validation prevents callback dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-dispatch-expiry-"));
  let time = 1_800_000_000_000;
  let expireDuringValidation = false;
  let requests = 0;
  const events = await Events.open(join(root, "store.json"), {
    now: () => time,
    valid: async () => { if (expireDuringValidation) time += 60_000; return true; },
    post: async (_url, body) => { requests++; return { status: 200, body: Buffer.from(JSON.stringify({ challenge: JSON.parse(body).challenge })) }; },
  });
  try {
    await events.subscribe({ name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u1" }, delivery: { mode: "webhook", url: "https://hooks.example/callback", secret }, ttlMs: 60_000 }, auth, async () => {});
    await events.observe("s1", "u1", "completed");
    expireDuringValidation = true;
    await events.processDeliveries();
    assert.equal(requests, 1, "only admission challenge should be sent");
    assert.equal(events.diagnostics()[0]!.state, "expired");
    assert.equal(events.diagnostics()[0]!.attempts, 0);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("ingress authorization rejects malformed types and compares canonical fields independent of JSON key order", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-auth-"));
  const events = await Events.open(join(root, "store.json"));
  let reply: unknown;
  const ingress = mock.method(globalThis, "fetch", async () => Response.json(reply));
  try {
    for (const authorization of [null, [], { ...auth, principal: 1 }, { ...auth, resource: "https://not a URL/opencode-connect/mcp" }, { ...auth, scope: "other" }, { ...auth, extra: true }]) {
      reply = { allowed: true, authorization };
      await assert.rejects(events.authenticate("fixture-context"), (error: any) => error.code === 1001);
      assert.equal(await events.valid(auth), false);
    }
    reply = { allowed: "true", authorization: auth };
    await assert.rejects(events.authenticate("fixture-context"), (error: any) => error.code === 1001);
    reply = { allowed: true, authorization: Object.fromEntries(Object.entries(auth).reverse()) };
    assert.deepEqual(await events.authenticate("fixture-context"), auth);
    assert.equal(await events.valid(auth), true);
    reply = { allowed: true, authorization: { ...auth, grantId: "different" } };
    assert.equal(await events.valid(auth), false);
  } finally { ingress.mock.restore(); await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("subscription capacity and transient delivery attempts are bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-limits-"));
  const fixture = eventHarness(join(root, "store.json"), Array(8).fill(500));
  const events = await fixture.eventsPromise;
  try {
    for (let index = 0; index < 128; index++) await subscribe(events, `u${index}`);
    await assert.rejects(subscribe(events, "u128"), (error: any) => error.code === 1002);
    assert.equal(events.snapshot().subscriptionCount, 128);
    await events.observe("s1", "u0", "completed");
    for (let attempt = 0; attempt < 10; attempt++) { await events.processDeliveries(); fixture.advance(256_000); }
    const deliveries = fixture.requests.filter((request) => !JSON.parse(request.body).type);
    assert.equal(deliveries.length, 8);
    assert.equal(events.diagnostics().find((sub) => sub.messageId === "u0")!.deliveryState, "exhausted");
    assert.equal(new Set(deliveries.map((request) => JSON.parse(request.body).eventId)).size, 1);
    assert.ok(deliveries.every((request) => Buffer.byteLength(request.body) <= 262_144));
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("one delivery tick serves several due subscriptions in order within an explicit bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-multidelivery-"));
  const fixture = eventHarness(join(root, "store.json")); const events = await fixture.eventsPromise;
  try {
    assert.ok(MAX_DELIVERIES_PER_TICK >= 2 && MAX_DELIVERIES_PER_TICK < 128);
    for (let index = 0; index < MAX_DELIVERIES_PER_TICK + 2; index++) await subscribe(events, `u${index}`);
    for (let index = 0; index < MAX_DELIVERIES_PER_TICK + 2; index++) await events.observe("s1", `u${index}`, "completed");
    await events.processDeliveries();
    const first = fixture.requests.filter((request) => !JSON.parse(request.body).type);
    assert.equal(first.length, MAX_DELIVERIES_PER_TICK);
    assert.deepEqual(first.map((request) => JSON.parse(request.body).data.messageId),
      Array.from({ length: MAX_DELIVERIES_PER_TICK }, (_, index) => `u${index}`));
    await events.processDeliveries();
    const second = fixture.requests.filter((request) => !JSON.parse(request.body).type);
    assert.equal(second.length, MAX_DELIVERIES_PER_TICK + 2);
    assert.deepEqual(second.slice(MAX_DELIVERIES_PER_TICK).map((request) => JSON.parse(request.body).data.messageId), [`u${MAX_DELIVERIES_PER_TICK}`, `u${MAX_DELIVERIES_PER_TICK + 1}`]);
    assert.equal(new Set(second.map((request) => JSON.parse(request.body).eventId)).size, MAX_DELIVERIES_PER_TICK + 2);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("subscription state store is exclusive and survives reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-store-"));
  const path = join(root, "events", "store.json");
  const first = await Events.open(path);
  await assert.rejects(Events.open(path), /already owned/u);
  await first.close();
  const restarted = await Events.open(path);
  try { assert.deepEqual(restarted.targets(), []); }
  finally { await restarted.close(); await rm(root, { recursive: true, force: true }); }
});

test("subscribe verifies a signed challenge with deterministic subscription header; exact filters and restart are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-lifecycle-"));
  const path = join(root, "events", "store.json"); const fixture = eventHarness(path);
  const events = await fixture.eventsPromise;
  try {
    const receipt = await subscribe(events);
    await subscribe(events);
    assert.equal(fixture.requests.length, 1, "refresh should reuse the bounded principal+callback verification cache");
    fixture.advance(300_001);
    await subscribe(events);
    assert.equal(fixture.requests.length, 2, "expired verification cache should require a fresh challenge");
    const challenge = fixture.requests[0]!;
    const challengePayload = JSON.parse(challenge.body);
    assert.equal(challenge.headers["x-mcp-subscription-id"], receipt.id);
    assert.equal(challenge.headers["webhook-signature"], standardWebhookSignature(secret, challenge.headers["webhook-id"]!, challenge.headers["webhook-timestamp"]!, challenge.body));
    assert.equal(challengePayload.type, "verification");
    await events.observe("other-session", "u1", "completed");
    assert.equal(events.diagnostics()[0]!.deliveryState, null);
    await events.observe("s1", "other-message", "completed");
    assert.equal(events.diagnostics()[0]!.deliveryState, null);
    await events.observe("s1", "u1", "completed");
    await events.processDeliveries();
    assert.equal(fixture.requests[2]!.headers["webhook-id"], JSON.parse(fixture.requests[2]!.body).eventId);
    await events.close();
    const reopened = await Events.open(path, { authenticate: async () => auth, valid: async () => true, post: async () => ({ status: 200, body: Buffer.alloc(0) }) });
    try { assert.deepEqual(reopened.targets(), [{ sessionId: "s1", messageId: "u1" }]); assert.equal(reopened.diagnostics()[0]!.deliveryState, "delivered"); }
    finally { await reopened.close(); }
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("callback challenge failure reports the Events callback error code and a categorized reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-challenge-error-"));
  const events = await Events.open(join(root, "events", "store.json"), {
    authenticate: async () => auth, valid: async () => true,
    post: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ challenge: "wrong" })) }),
  });
  try {
    let caught: any; try { await subscribe(events); } catch (error) { caught = error; }
    assert.equal(caught?.code, -32015); assert.equal(caught?.data?.reason, "challenge_failed");
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("transient deliveries retry with stable event ID and refreshed signature; 410 and 413 stop retries", async () => {
  for (const terminalStatus of [410, 413]) {
    const root = await mkdtemp(join(tmpdir(), "opencode-events-retry-")); const fixture = eventHarness(join(root, "events", "store.json"), [500, terminalStatus, 200]); const events = await fixture.eventsPromise;
    try {
      await subscribe(events); await events.observe("s1", "u1", "failed");
      await events.processDeliveries(); fixture.advance(2000); await events.processDeliveries(); fixture.advance(60_000); await events.processDeliveries();
      const deliveries = fixture.requests.filter((request) => !JSON.parse(request.body).type);
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0]!.headers["webhook-id"], deliveries[1]!.headers["webhook-id"]);
      assert.equal(events.diagnostics()[0]!.deliveryState, "exhausted");
    } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
  }
  const root = await mkdtemp(join(tmpdir(), "opencode-events-backoff-")); const fixture = eventHarness(join(root, "events", "store.json"), [500, 200]); const events = await fixture.eventsPromise;
  try {
    await subscribe(events); await events.observe("s1", "u1", "completed"); await events.processDeliveries();
    const first = fixture.requests.at(-1)!; fixture.advance(2000); await events.processDeliveries(); const second = fixture.requests.at(-1)!;
    assert.equal(JSON.parse(first.body).eventId, JSON.parse(second.body).eventId);
    assert.equal(first.body, second.body);
    assert.notEqual(first.headers["webhook-signature"], second.headers["webhook-signature"]);
    assert.equal(events.diagnostics()[0]!.deliveryState, "delivered");
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("refresh dual-signs during secret rotation and unsubscribe is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-rotation-")); const fixture = eventHarness(join(root, "events", "store.json")); const events = await fixture.eventsPromise;
  const nextSecret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  try {
    const receipt = await subscribe(events); await subscribe(events, "u1", nextSecret);
    await events.observe("s1", "u1", "interrupted"); await events.processDeliveries();
    const delivery = fixture.requests.at(-1)!;
    const parts = delivery.headers["webhook-signature"]!.split(" ");
    assert.equal(parts.length, 2);
    assert.equal(parts[0], standardWebhookSignature(nextSecret, delivery.headers["webhook-id"]!, delivery.headers["webhook-timestamp"]!, delivery.body));
    assert.equal(parts[1], standardWebhookSignature(secret, delivery.headers["webhook-id"]!, delivery.headers["webhook-timestamp"]!, delivery.body));
    const cancellation = { name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u1" }, delivery: { mode: "webhook", url: "https://hooks.example/callback" } };
    assert.deepEqual(await events.unsubscribe(cancellation, auth), {}); assert.deepEqual(await events.unsubscribe(cancellation, auth), {});
    assert.equal(events.targets().length, 0); assert.ok(receipt.id);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("authenticated MCP HTTP boundary discovers, lists, subscribes, and unsubscribes Events", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-mcp-")); const fixture = eventHarness(join(root, "events", "store.json")); const events = await fixture.eventsPromise;
  const native = nativeFixture((request) => {
    if (request.path.endsWith("/message/u1")) return { data: { id: "u1", type: "user", sessionID: "s1", text: "prompt", time: { created: 1 } } };
    throw new Error(`unexpected ${request.path}`);
  });
  const mcp = createHttpHandler(new OpenCodeBackend(native.connect), new HostBackend(native.connect), events);
  const app = createMcpExpressApp();
  app.all("/mcp", (req, res) => toNodeHandler(mcp)(req, res, req.body));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const send = async (method: string, params: unknown = {}, id = 1, context = true) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(context ? { "x-host-ingress-auth-context": "trusted-context" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...(params as object), _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "events-http-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    });
    const reply = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(reply));
    return reply;
  };
  try {
    const discovery = await send("server/discover", {}, 2);
    assert.equal(discovery.result.resultType, "complete");
    assert.deepEqual(discovery.result.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(discovery.result.capabilities, { tools: { listChanged: false }, events: {} });
    const directDiscovery = await mcp.fetch(new Request("http://127.0.0.1/mcp", {
      method: "POST", headers: { "content-type": "application/json", "mcp-method": "server/discover" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "server/discover", params: {} }),
    }));
    assert.equal(directDiscovery.status, 401, "raw Fetch clients cannot bypass discovery authorization");
    const listing = await send("events/list", {}, 3);
    assert.equal(listing.result.events.length, 1); assert.equal(listing.result.events[0].name, EVENT_NAME);
    const denied = await send("events/list", {}, 4, false); assert.equal(denied.error.code, 1001);
    const subscription = await send("events/subscribe", { name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u1" }, delivery: { mode: "webhook", url: "https://hooks.example/callback", secret } }, 5);
    assert.equal(subscription.result.id, fixture.requests[0]!.headers["x-mcp-subscription-id"]);
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionAccepted, 1);
    const deniedSubscribe = await send("events/subscribe", {}, 7, false);
    assert.equal(deniedSubscribe.error.code, 1001);
    const malformedSubscribe = await send("events/subscribe", { rawSecret: secret }, 8);
    assert.equal(malformedSubscribe.error.code, -32602);
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionReceived, 3);
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionRejected, 2);
    assert.equal(JSON.stringify(events.snapshot()).includes(secret), false);
    await events.observe("other-session", "u1", "completed");
    await events.processDeliveries(); assert.equal(fixture.requests.length, 1);
    await events.observe("s1", "u1", "completed"); await events.processDeliveries();
    const delivery = fixture.requests.at(-1)!;
    assert.equal(delivery.headers["webhook-signature"], standardWebhookSignature(secret, delivery.headers["webhook-id"]!, delivery.headers["webhook-timestamp"]!, delivery.body));
    assert.equal(events.snapshot().lifecycle.evidence.counters.callbackAcknowledged, 1);
    const wireRejection = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "events/subscribe", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    });
    assert.equal(wireRejection.status, 400);
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionReceived, 4);
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionRejected, 3);
    const legacy = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }),
    });
    assert.equal(legacy.status, 400);
    const legacyReply = await legacy.json() as any;
    assert.equal(legacyReply.error.code, -32022);
    assert.deepEqual(legacyReply.error.data.supported, ["2026-07-28"]);
    const cancellation = await send("events/unsubscribe", { name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u1" }, delivery: { mode: "webhook", url: "https://hooks.example/callback" } }, 6);
    assert.equal(cancellation.result.resultType, "complete");
    assert.deepEqual(Object.keys(cancellation.result).filter((key) => key !== "resultType" && key !== "_meta"), []);
    await events.observe("s1", "u1", "completed"); await events.processDeliveries();
    assert.equal(fixture.requests.length, 2);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await mcp.close(); await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("canonical reconciliation ignores stale/partial reads and maps only persisted terminal outcomes", () => {
  assert.equal(canonicalTerminalStatus("succeeded", { terminal: false, selectionComplete: false, outcome: "completed" }), null);
  assert.equal(canonicalTerminalStatus("succeeded", { terminal: true, selectionComplete: false, outcome: "completed" }), null);
  assert.equal(canonicalTerminalStatus("succeeded", { terminal: true, selectionComplete: true, outcome: "completed" }), "completed");
  assert.equal(canonicalTerminalStatus("failed", { terminal: true, selectionComplete: true, outcome: "unknown" }), "failed");
  assert.equal(canonicalTerminalStatus("interrupted", { terminal: true, selectionComplete: true, outcome: "incomplete" }), "interrupted");
  assert.equal(canonicalTerminalStatus("succeeded", { terminal: true, selectionComplete: true, outcome: "incomplete" }), "incomplete");
});

test("lifecycle distinguishes verified activation, filtered queue, retry, receipt and cancellation without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-trace-"));
  const fixture = eventHarness(join(root, "events", "store.json"), [500, 200]);
  const events = await fixture.eventsPromise;
  try {
    const receipt = await events.lifecycle.subscription(() => subscribe(events));
    await events.observe("wrong", "u1", "completed");
    assert.equal(events.snapshot().lifecycle.evidence.counters.eventQueued, undefined);
    await events.observe("s1", "u1", "completed");
    await events.observe("s1", "u1", "completed");
    await events.processDeliveries();
    assert.equal(events.snapshot().lifecycle.evidence.counters.callbackAcknowledged, undefined);
    fixture.advance(2000); await events.processDeliveries();
    const trace = events.snapshot();
    assert.deepEqual(trace.lifecycle.evidence.recent.map((entry) => entry.stage), [
      "subscriptionsRecovered", "subscriptionReceived", "verificationStarted", "verificationSucceeded",
      "subscriptionActivated", "subscriptionAccepted", "eventQueued", "deliveryAttempt", "deliveryOutcome",
      "deliveryAttempt", "deliveryOutcome", "callbackAcknowledged",
    ]);
    const outcomes = trace.lifecycle.evidence.recent.filter((entry) => entry.stage === "deliveryOutcome");
    assert.deepEqual(outcomes.map((entry) => [entry.attempt, entry.httpStatus, entry.outcome]), [[1, 500, "retry"], [2, 200, "delivered"]]);
    assert.equal(trace.subscriptions[0]!.subscriptionId, receipt.id);
    assert.equal(trace.lifecycle.evidence.counters.eventQueued, 1);
    const serialized = JSON.stringify(trace);
    for (const sensitive of [secret, "https://hooks.example/callback", auth.principal, auth.grantContext, auth.resource, fixture.requests[0]!.body]) assert.equal(serialized.includes(sensitive), false, sensitive);
    trace.lifecycle.evidence.recent.length = 0;
    assert.ok(events.snapshot().lifecycle.evidence.recent.length > 0, "readers cannot mutate retained evidence");
    const cancel = { name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u1" }, delivery: { mode: "webhook", url: "https://hooks.example/callback" } };
    await events.unsubscribe(cancel, auth); await events.unsubscribe(cancel, auth);
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionCancelled, 1);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("verification failures never record activation, acceptance or secret error bodies", async () => {
  for (const failure of ["wrongChallenge", "timeout", "nonStringChallenge"]) {
    const root = await mkdtemp(join(tmpdir(), "opencode-events-failure-trace-"));
    const events = await Events.open(join(root, "events", "store.json"), {
      valid: async () => true,
      post: async () => {
        if (failure === "timeout") throw new Error(`timeout at https://private.example/${secret}`);
        return { status: 200, body: Buffer.from(JSON.stringify({ challenge: failure === "nonStringChallenge" ? { secret } : "wrong" })) };
      },
    });
    try {
      await assert.rejects(events.lifecycle.subscription(() => subscribe(events)), (error: any) => error.code === -32015);
      const snapshot = events.snapshot();
      assert.equal(snapshot.subscriptionCount, 0);
      assert.equal(snapshot.lifecycle.evidence.counters.subscriptionActivated, undefined);
      assert.equal(snapshot.lifecycle.evidence.counters.subscriptionAccepted, undefined);
      assert.equal(snapshot.lifecycle.evidence.counters.subscriptionRejected, 1);
      assert.equal(snapshot.lifecycle.evidence.counters.verificationFailed, 1);
      assert.equal(JSON.stringify(snapshot).includes(secret), false);
      assert.equal(JSON.stringify(snapshot).includes("private.example"), false);
    } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("restart retains pending delivery and resets process evidence; revocation and expiration stop delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-recovery-trace-"));
  const path = join(root, "events", "store.json");
  const fixture = eventHarness(path); const events = await fixture.eventsPromise;
  await subscribe(events); await events.observe("s1", "u1", "completed"); await events.close();
  const restarted = await Events.open(path, { now: () => 1_800_000_001_000, valid: async () => false });
  try {
    assert.equal(restarted.snapshot().subscriptions[0]!.deliveryState, "pending");
    assert.equal(restarted.snapshot().lifecycle.evidence.counters.subscriptionActivated, undefined);
    await restarted.processDeliveries();
    assert.equal(restarted.snapshot().lifecycle.evidence.counters.subscriptionRevoked, 1);
    assert.equal(restarted.snapshot().lifecycle.evidence.counters.deliveryAttempt, undefined);
  } finally { await restarted.close(); }
  const expiring = eventHarness(join(root, "expiration", "store.json")); const expiry = await expiring.eventsPromise;
  try {
    await subscribe(expiry); await expiry.observe("s1", "u1", "completed");
    expiring.advance(3_600_001); await expiry.processDeliveries();
    assert.equal(expiry.snapshot().lifecycle.evidence.counters.subscriptionExpired, 1);
    assert.equal(expiry.snapshot().lifecycle.evidence.counters.deliveryAttempt, undefined);
  } finally { await expiry.close(); await rm(root, { recursive: true, force: true }); }
});

test("storage failure prevents a reported activation and leaves sanitized evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-storage-trace-"));
  const path = join(root, "events", "store.json"); const fixture = eventHarness(path); const events = await fixture.eventsPromise;
  try {
    await rm(join(root, "events"), { recursive: true });
    await assert.rejects(events.lifecycle.subscription(() => subscribe(events)));
    const snapshot = events.snapshot();
    assert.equal(snapshot.storageFailed, true);
    assert.equal(snapshot.subscriptionCount, 0);
    assert.equal(snapshot.lifecycle.evidence.counters.storageFailed, 1);
    assert.equal(snapshot.lifecycle.evidence.counters.subscriptionActivated, undefined);
    assert.equal(snapshot.lifecycle.evidence.counters.subscriptionAccepted, undefined);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("authorization outages pause delivery, recovery resumes, and transport errors retain sanitized retry evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-pause-trace-"));
  let outage = false; let transportFails = true;
  const events = await Events.open(join(root, "events", "store.json"), {
    valid: async () => { if (outage) throw new Error(`private grant ${auth.grantContext}`); return true; },
    post: async (_url, body) => {
      const payload = JSON.parse(body);
      if (payload.type === "verification") return { status: 200, body: Buffer.from(JSON.stringify({ challenge: payload.challenge })) };
      if (transportFails) throw new Error(`private transport ${secret}`);
      return { status: 200, body: Buffer.alloc(0) };
    },
  });
  try {
    await subscribe(events); await events.observe("s1", "u1", "completed");
    outage = true; await events.processDeliveries();
    assert.equal(events.snapshot().subscriptions[0]!.state, "paused");
    assert.equal(events.snapshot().lifecycle.evidence.counters.deliveryAttempt, undefined);
    outage = false; await events.processDeliveries();
    assert.equal(events.snapshot().lifecycle.evidence.counters.subscriptionResumed, 1);
    assert.equal(events.snapshot().lifecycle.evidence.recent.at(-1)!.outcome, "transportFailed");
    assert.equal(events.snapshot().lifecycle.evidence.counters.callbackAcknowledged, undefined);
    assert.equal(JSON.stringify(events.snapshot()).includes(secret), false);
    assert.equal(JSON.stringify(events.snapshot()).includes(auth.grantContext), false);
    transportFails = false;
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent duplicate subscriptions verify once, persist one identity, and cancel in admission order", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-concurrent-"));
  const fixture = eventHarness(join(root, "events", "store.json")); const events = await fixture.eventsPromise;
  try {
    const receipts = await Promise.all(Array.from({ length: 8 }, () => subscribe(events)));
    assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 1);
    assert.equal(events.snapshot().subscriptionCount, 1);
    assert.equal(fixture.requests.length, 1);
    const create = subscribe(events, "u2");
    const cancel = events.unsubscribe({ name: EVENT_NAME, arguments: { sessionId: "s1", messageId: "u2" }, delivery: { mode: "webhook", url: "https://hooks.example/callback" } }, auth);
    await Promise.all([create, cancel]);
    assert.equal(events.diagnostics().find((entry) => entry.messageId === "u2")!.state, "cancelled");
    await events.observe("s1", "u2", "completed"); await events.processDeliveries();
    assert.equal(fixture.requests.length, 1);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test("a third signing key cannot discard the active rotation key and can replace it after the window", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-events-key-window-"));
  const fixture = eventHarness(join(root, "events", "store.json")); const events = await fixture.eventsPromise;
  const second = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  const third = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  try {
    await subscribe(events); await subscribe(events, "u1", second);
    await assert.rejects(subscribe(events, "u1", third), /rotation is still in progress/u);
    fixture.advance(300_001); await subscribe(events, "u1", third);
    await events.observe("s1", "u1", "completed"); await events.processDeliveries();
    const delivery = fixture.requests.at(-1)!;
    assert.deepEqual(delivery.headers["webhook-signature"]!.split(" "), [third, second].map((key) => standardWebhookSignature(key, delivery.headers["webhook-id"]!, delivery.headers["webhook-timestamp"]!, delivery.body)));
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});
