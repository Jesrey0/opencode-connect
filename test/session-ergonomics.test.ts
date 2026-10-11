import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { OpenCodeBackend } from "../src/opencode.js";
import { createServer, actSchema } from "../src/mcp.js";
import { SessionDeleteError } from "../src/bounds.js";
import { outputSchemas } from "../src/results.js";
import { nativeFixture, session } from "./native-fixture.js";

const fault = (tag = "ServiceUnavailableError") => Response.json({ _tag: tag, message: "SECRET native body", sessionID: "s" }, { status: tag === "SessionNotFoundError" ? 404 : tag === "SessionBusyError" ? 400 : 409 });
function deletion(state: string) {
  let submitted = false;
  const f = nativeFixture(r => {
    if (r.method === "DELETE") { submitted = true; return state === "mutationError" ? fault() : state === "raceBusy" ? fault("SessionBusyError") : undefined; }
    if (r.path === "/api/session/s") return state === "notFound" ? fault("SessionNotFoundError") : state === "getError" ? fault() : submitted && state !== "remains" && state !== "mutationError" && state !== "raceBusy" ? fault(state === "readbackError" ? "ServiceUnavailableError" : "SessionNotFoundError") : { data: session() };
    if (r.path === "/api/session/active") return { data: state === "active" ? { s: { sessionID: "s" } } : {} };
    if (r.path.endsWith("/permission")) return state === "locationMissing" ? Response.json({ _tag: "LocationNotFoundError", location: { directory: "/confidential/deleted-worktree" }, message: "SECRET native body" }, { status: 404 }) : state === "preflightError" ? fault() : { data: state === "malformedPreflight" ? {} : state === "approval" ? [{ id: "p", sessionID: "s" }] : [] };
    if (r.path.endsWith("/form")) return { data: state === "form" ? [{ id: "f", sessionID: "s" }] : [] };
    if (r.path.endsWith("/inbox")) return { data: state === "inbox" ? [{ id: "i", sessionID: "s" }] : [] };
    throw new Error(`unexpected ${r.path}`);
  });
  return { ...f, backend: new OpenCodeBackend(f.connect) };
}
test("delete requires explicit valid runtime in MCP schema and facade before connecting", async () => {
  for (const runtime of [undefined, "wrong", null]) {
    const input = { action: "delete", sessionId: "s", runtime };
    assert.equal(actSchema.safeParse(input).success, false);
    const f = deletion("idle");
    await assert.rejects(f.backend.act(input as any), (e: unknown) => e instanceof SessionDeleteError && e.code === "DELETE_RUNTIME_REQUIRED");
    assert.equal(f.requests.length, 0);
  }
  for (const runtime of ["opencode", "codex"]) assert.equal(actSchema.safeParse({ action: "delete", sessionId: "s", runtime }).success, true);
});
test("OpenCode deletion blocks authoritative active/pending state and unreadable preflight", async () => {
  for (const [state, code] of [["active", "DELETE_SESSION_ACTIVE"], ["approval", "DELETE_PENDING_APPROVAL"], ["form", "DELETE_PENDING_FORM"], ["inbox", "DELETE_PENDING_INBOX"], ["preflightError", "DELETE_PREFLIGHT_FAILED"], ["malformedPreflight", "DELETE_PREFLIGHT_FAILED"]]) {
    const f = deletion(state);
    await assert.rejects(f.backend.act({ action: "delete", runtime: "opencode", sessionId: "s" }), (e: unknown) => e instanceof SessionDeleteError && e.code === code && !e.mutationMayHaveOccurred && !e.message.includes("SECRET"));
    assert.equal(f.requests.some(r => r.method === "DELETE"), false);
  }
});
test("OpenCode deletion explains removed worktree location without bypassing pending-action checks", async () => {
  const f = deletion("locationMissing");
  await assert.rejects(
    f.backend.act({ action: "delete", runtime: "opencode", sessionId: "s" }),
    (e: unknown) => e instanceof SessionDeleteError && e.code === "DELETE_LOCATION_UNAVAILABLE" &&
      !e.mutationMayHaveOccurred && e.reason.includes("restore") && !e.message.includes("SECRET"),
  );
  assert.equal(f.requests.some(r => r.method === "DELETE"), false);
  const server = createServer(f.backend);
  const client = new Client({ name: "missing-location-delete", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const blocked = await client.callTool({ name: "opencode.act", arguments: { action: "delete", runtime: "opencode", sessionId: "s" } });
    assert.equal(blocked.isError, true);
    assert.equal((blocked.structuredContent as Record<string, unknown>).errorCode, "DELETE_LOCATION_UNAVAILABLE");
    assert.equal((blocked.structuredContent as Record<string, unknown>).mutationMayHaveOccurred, false);
  } finally { await client.close(); await server.close(); }
});
test("OpenCode preflight distinguishes typed not-found from transport ambiguity", async () => {
  for (const [state, code] of [["notFound", "DELETE_NOT_FOUND"], ["getError", "DELETE_PREFLIGHT_FAILED"]]) {
    const f = deletion(state);
    await assert.rejects(f.backend.act({ action: "delete", runtime: "opencode", sessionId: "s" }), (e: unknown) => e instanceof SessionDeleteError && e.code === code && !e.mutationMayHaveOccurred && !e.message.includes("SECRET"));
    assert.deepEqual(f.requests.map(r => r.method), ["GET"]);
  }
});
test("OpenCode deletion reports success only after typed native absence readback", async () => {
  const f = deletion("idle");
  const result = await f.backend.act({ action: "delete", runtime: "opencode", sessionId: "s" });
  assert.deepEqual(result, { action: "delete", runtime: "opencode", sessionId: "s", deleted: true });
  outputSchemas.act.parse(result);
  for (const [state, code, uncertain] of [["remains", "DELETE_UNVERIFIED", true], ["readbackError", "DELETE_UNVERIFIED", true], ["mutationError", "DELETE_FAILED", true], ["raceBusy", "DELETE_SESSION_ACTIVE", false]] as const) {
    const failed = deletion(state);
    await assert.rejects(failed.backend.act({ action: "delete", runtime: "opencode", sessionId: "s" }), (e: unknown) => e instanceof SessionDeleteError && e.code === code && e.mutationMayHaveOccurred === uncertain && !e.message.includes("SECRET"));
  }
});
test("MCP rejects missing runtime before backend and emits structured safe application refusals", async () => {
  const f = deletion("active"), server = createServer(f.backend);
  const client = new Client({ name: "delete-safety", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const invalid = await client.callTool({ name: "opencode.act", arguments: { action: "delete", sessionId: "s" } });
    assert.equal(invalid.isError, true); assert.equal(f.requests.length, 0);
    const blocked = await client.callTool({ name: "opencode.act", arguments: { action: "delete", runtime: "opencode", sessionId: "s" } });
    assert.equal(blocked.isError, true);
    const diagnostic = blocked.structuredContent as Record<string, unknown>;
    assert.equal(diagnostic.errorCode, "DELETE_SESSION_ACTIVE");
    assert.equal(diagnostic.mutationMayHaveOccurred, false);
    assert.equal(typeof diagnostic.reason, "string");
  } finally { await client.close(); await server.close(); }
});
test("OpenCode inventory carries native lifecycle and archive time without result inference", async () => {
  const s = { ...session(), title: "smoke priority audit", time: { created: 1, updated: 2, archived: 3 } };
  const f = nativeFixture(r => r.path === "/api/session/active" ? { data: { s: {} } } : { data: [s], cursor: { next: null } });
  const inventory = (await new OpenCodeBackend(f.connect).query([{ type: "sessions" }])).results[0].result as any;
  assert.equal(inventory.runtime, "opencode");
  const item = inventory.sessions[0];
  assert.equal(item.runtime, "opencode"); assert.equal(item.status, "inProgress");
  assert.equal(item.executionOutcome, "succeeded"); assert.equal(item.outcome, "unknown"); assert.equal(item.outcomeBasis, "unavailable");
  assert.equal(item.archivedAtMs, 3); assert.equal(item.title, s.title);
  assert.equal("importance" in item, false);
});
