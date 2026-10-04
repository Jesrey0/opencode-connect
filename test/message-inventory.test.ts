import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeBackend, projectMessage } from "../src/opencode.js";
import { MESSAGE_PREVIEW_LIMIT, COMPACTION_PREVIEW_LIMIT, MESSAGE_TOOL_PREVIEW_LIMIT, TEXT_LIMIT } from "../src/bounds.js";
import { structuredResult } from "../src/mcp.js";
import { nativeFixture, session, user, assistant } from "./native-fixture.js";
import type { SessionMessageInfo } from "@opencode/client";

type BackendQuery = Parameters<OpenCodeBackend["query"]>[0];
type QueryCall = { tool: string; arguments: { queries: BackendQuery } };

function pagingFixture(messages: SessionMessageInfo[]) {
  const state = session();
  const native = nativeFixture((r) => {
    if (r.path === "/api/session/s") return { data: state };
    if (r.path === "/api/session/active") return { data: {} };
    if (r.path.includes("/message/")) {
      const id = decodeURIComponent(r.path.split("/").at(-1)!);
      const message = messages.find((m) => m.id === id);
      if (!message) return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
      return { data: message };
    }
    if (r.path.endsWith("/message")) {
      const cursor = r.query.get("cursor");
      assert.ok(!cursor || !r.query.has("order"), "native cursor cannot be combined with order");
      const order = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()).order : r.query.get("order") ?? "desc";
      const ordered = order === "desc" ? [...messages].reverse() : messages;
      const start = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()).offset : 0;
      const limit = Number(r.query.get("limit"));
      const data = ordered.slice(start, start + limit);
      const next = start + data.length;
      return { data, cursor: { next: next < ordered.length ? Buffer.from(JSON.stringify({ order, offset: next })).toString("base64url") : null } };
    }
    throw new Error(`unexpected ${r.path}`);
  });
  return { ...native, state };
}

function envelopeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ structuredContent: value }));
}

async function recoverText(backend: OpenCodeBackend, entry: Record<string, any>): Promise<string> {
  let text = entry.text;
  let call = entry.nextCall;
  while (call) {
    const response = await backend.query(call.arguments.queries);
    assert.equal(response.results.some((r) => "error" in r), false);
    const result = response.results[0].result as { text: string; nextCall: QueryCall | null };
    text += result.text;
    call = result.nextCall;
  }
  return text;
}

function compaction(id: string, status: "completed" | "failed" | "running", summary: string, recent: string): SessionMessageInfo {
  return {
    id, type: "compaction", sessionID: "s", status, reason: "manual",
    ...(status === "failed" ? {} : { summary, recent }),
    ...(status === "completed" ? { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } }, cost: 1 } : {}),
    time: { created: 1 },
  } as unknown as SessionMessageInfo;
}

test("default messages page previews long text and recovers it losslessly within the envelope", async () => {
  const full = "a".repeat(12_000);
  const messages = Array.from({ length: 25 }, (_, i) => ({ ...user(`u${i}`), text: full } as SessionMessageInfo));
  const native = pagingFixture(messages);
  const backend = new OpenCodeBackend(native.connect);
  const response = await backend.query([{ type: "messages", sessionId: "s", limit: 25, order: "asc" }]);
  assert.equal(response.results.some((r) => "error" in r), false);
  structuredResult(response);
  assert.ok(envelopeBytes(response) < 262_144);
  const page = response.results[0].result as { messages: Record<string, any>[]; cursor: unknown };
  assert.equal(page.messages.length, 25);
  assert.deepEqual(page.messages.map((m) => m.id), messages.map((m) => m.id));
  for (const entry of page.messages) {
    assert.equal(entry.text.length, MESSAGE_PREVIEW_LIMIT);
    assert.equal(entry.truncated, true);
    assert.equal(entry.textPaging.size, 12_000);
    assert.equal(entry.textPaging.nextOffset, MESSAGE_PREVIEW_LIMIT);
    assert.equal(entry.nextCall.tool, "opencode.query");
    assert.equal(entry.nextCall.arguments.queries[0].textLimit, TEXT_LIMIT);
    assert.equal(await recoverText(backend, entry), full);
  }
});

test("max messages page with multibyte, escaping and large tool inventories stays within the envelope", async () => {
  const tricky = "é😀\"\n\\\u0000".repeat(2000);
  assert.ok(tricky.length > 12_000);
  const userText = tricky.slice(0, 12_000);
  const assistantText = ("界😀".repeat(4000)).slice(0, 12_000);
  const tools = Array.from({ length: 50 }, (_, i) => ({
    type: "tool" as const, id: `tool-${i}`, name: `n-${"x".repeat(60)}`, executed: true,
    state: { status: "completed" as const, input: {}, content: [{ type: "text" as const, text: "ok" }] },
    time: { created: 1 },
  }));
  const messages: SessionMessageInfo[] = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({ ...user(`u${i}`), text: userText } as SessionMessageInfo);
    const base = assistant(`a${i}`, assistantText) as unknown as Record<string, any>;
    messages.push({ ...base, content: [...(base.content as unknown[]), ...tools] } as unknown as SessionMessageInfo);
  }
  const native = pagingFixture(messages);
  const backend = new OpenCodeBackend(native.connect);
  const response = await backend.query([{ type: "messages", sessionId: "s", limit: 50, order: "asc" }]);
  assert.equal(response.results.some((r) => "error" in r), false);
  structuredResult(response);
  assert.ok(envelopeBytes(response) < 262_144);
  const page = response.results[0].result as { messages: Record<string, any>[] };
  assert.equal(page.messages.length, 50);
  assert.deepEqual(page.messages.map((m) => m.id), messages.map((m) => m.id));
  for (const entry of page.messages) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(entry.text), "no split surrogate pairs");
  }
  const firstAssistant = page.messages.find((m) => m.type === "assistant")!;
  assert.equal(firstAssistant.tools.length, MESSAGE_TOOL_PREVIEW_LIMIT);
  assert.equal(firstAssistant.toolCount, 50);
  assert.equal(firstAssistant.toolsTruncated, true);
  assert.equal(await recoverText(backend, page.messages[0]), userText);
  assert.equal(await recoverText(backend, firstAssistant), assistantText);
  const full = await backend.query([{ type: "tools", sessionId: "s", messageId: firstAssistant.id, limit: 50 }]);
  const fullResult = full.results[0].result as { data: unknown[]; fingerprint: string };
  assert.equal(fullResult.data.length, 50);
  const rest = await backend.query([{ type: "tools", sessionId: "s", messageId: firstAssistant.id, limit: 10, offset: 45, fingerprint: fullResult.fingerprint }]);
  assert.equal((rest.results[0].result as { data: unknown[] }).data.length, 5);
});

test("preview continuation straddling a surrogate pair stays lossless", async () => {
  const full = `${"a".repeat(MESSAGE_PREVIEW_LIMIT - 1)}😀${"b".repeat(2000)}`;
  const native = pagingFixture([{ ...user("u"), text: full } as SessionMessageInfo]);
  const backend = new OpenCodeBackend(native.connect);
  const response = await backend.query([{ type: "messages", sessionId: "s" }]);
  const entry = (response.results[0].result as { messages: Record<string, any>[] }).messages[0];
  assert.equal(entry.text, "a".repeat(MESSAGE_PREVIEW_LIMIT - 1));
  assert.equal(await recoverText(backend, entry), full);
});

test("explicit type:message textLimit is preserved while type:message defaults to full text", async () => {
  const full = "z".repeat(12_000);
  const native = pagingFixture([{ ...user("u"), text: full } as SessionMessageInfo]);
  const backend = new OpenCodeBackend(native.connect);
  const exact = await backend.query([{ type: "message", sessionId: "s", messageId: "u", textLimit: 512 }]);
  const narrow = exact.results[0].result as unknown as { text: string; truncated: boolean; nextCall: QueryCall };
  assert.equal(narrow.text.length, 512);
  assert.equal(narrow.truncated, true);
  assert.equal((narrow.nextCall.arguments.queries[0] as unknown as Record<string, unknown>).textLimit, 512);
  assert.equal(await recoverText(backend, narrow), full);
  const onDemand = await backend.query([{ type: "message", sessionId: "s", messageId: "u" }]);
  const complete = onDemand.results[0].result as unknown as { text: string; truncated: boolean; nextCall: null };
  assert.equal(complete.text, full);
  assert.equal(complete.truncated, false);
  assert.equal(complete.nextCall, null);
});

test("max compaction page uses small previews with fingerprinted full recovery of summary and recent", async () => {
  const hostile = "\"\\\n\u0000\r\tnull".repeat(300);
  const messages = Array.from({ length: 50 }, (_, i) =>
    i % 2 === 0 ? compaction(`c${i}`, "completed", hostile, hostile) : compaction(`c${i}`, "failed", "", ""));
  const native = pagingFixture(messages);
  const backend = new OpenCodeBackend(native.connect);
  const response = await backend.query([{ type: "messages", sessionId: "s", limit: 50, order: "asc" }]);
  assert.equal(response.results.some((r) => "error" in r), false);
  structuredResult(response);
  assert.ok(envelopeBytes(response) < 262_144);
  const page = response.results[0].result as { messages: Record<string, any>[] };
  assert.equal(page.messages.length, 50);
  for (const entry of page.messages) {
    assert.ok(entry.summaryPreview === undefined || entry.summaryPreview.text.length <= COMPACTION_PREVIEW_LIMIT);
    assert.ok(entry.recentPreview === undefined || entry.recentPreview.text.length <= COMPACTION_PREVIEW_LIMIT);
    assert.equal(entry.inboxCorrelationSupported, true);
  }
  const completed = page.messages[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.summaryPreview.truncated, true);
  assert.equal(completed.requestUsageBasis, "nativeCompactionRequest");
  assert.deepEqual(completed.requestTokens, { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } });
  assert.equal(await recoverText(backend, { text: completed.summaryPreview.text, nextCall: completed.summaryNextCall }), hostile);
  assert.equal(await recoverText(backend, { text: completed.recentPreview.text, nextCall: completed.recentNextCall }), hostile);
  const failed = page.messages[1];
  assert.equal(failed.status, "failed");
  assert.equal(failed.summaryNextCall, null);
  assert.equal(failed.requestUsageBasis, "unavailable");
  const direct = await backend.query([{ type: "message", sessionId: "s", messageId: "c0", field: "summary" }]);
  assert.equal((direct.results[0].result as { field: string }).field, "summary");
  await assert.rejects(backend.query([{ type: "message", sessionId: "s", messageId: "c1", field: "summary" }]).then((r) => {
    if ("error" in r.results[0]) throw new Error(r.results[0].error);
  }), /no such native text field/);
  await assert.rejects(backend.query([{ type: "message", sessionId: "s", messageId: "u-missing", field: "summary" }]).then((r) => {
    if ("error" in r.results[0]) throw new Error(r.results[0].error);
  }));
});

test("usage labels separate cumulative session totals from latest-request evidence", async () => {
  const withTokens = { ...assistant("a", "done"), tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 80, write: 0 } }, cost: 2 };
  const native = pagingFixture([user("u"), withTokens as SessionMessageInfo, assistant("plain", "text")]);
  const backend = new OpenCodeBackend(native.connect);
  const projected = projectMessage(withTokens as SessionMessageInfo, 0, MESSAGE_PREVIEW_LIMIT, undefined, "s", true) as Record<string, any>;
  assert.deepEqual(projected.requestTokens, withTokens.tokens);
  assert.equal(projected.requestCost, 2);
  assert.equal(projected.requestUsageBasis, "nativeAssistantRequest");
  assert.equal(projected.contextOccupancy, "unknown");
  const absent = projectMessage(assistant("plain", "text"), 0, MESSAGE_PREVIEW_LIMIT, undefined, "s", true) as Record<string, any>;
  assert.equal(absent.requestTokens, null);
  assert.equal(absent.requestUsageBasis, "unavailable");
  const listed = await backend.query([{ type: "messages", sessionId: "s", limit: 50, order: "asc" }]);
  const entries = (listed.results[0].result as { messages: Record<string, any>[] }).messages;
  assert.equal(entries.find((m) => m.id === "a")!.requestUsageBasis, "nativeAssistantRequest");
  const inspected = await backend.query([{ type: "session", sessionId: "s" }]);
  const viewed = inspected.results[0].result as Record<string, any>;
  assert.equal(viewed.usageBasis, "cumulativeSessionTotals");
  assert.equal(viewed.contextOccupancy, "unknown");
  assert.ok("tokens" in viewed && "cost" in viewed);
});

test("compaction admission preserves the native inbox identity and never claims completion", async () => {
  const state = session();
  let inbox: Record<string, any>[] = [];
  let stage: "missing" | "running" | "completed" = "missing";
  const native = nativeFixture((r) => {
    if (r.path === "/api/session/s") return { data: state };
    if (r.path.endsWith("/inbox")) return { data: inbox };
    if (r.path.endsWith("/message/compact-native")) {
      if (stage === "missing") throw new Error("not materialized yet");
      return { data: { ...compaction("compact-native", "completed", "exact native summary", ""), status: stage, model: { providerID: "opencode", id: "free-compaction" } } };
    }
    if (r.path.endsWith("/compact")) {
      const admitted = { id: "compact-native", sessionID: "s", type: "compaction", delivery: "queue", time: { created: 2 }, payload: {} };
      inbox = [admitted];
      return { data: admitted };
    }
    throw new Error(`unexpected ${r.path}`);
  });
  const backend = new OpenCodeBackend(native.connect);
  const admitted = await backend.act({ action: "compact", sessionId: "s" }) as unknown as Record<string, any>;
  assert.equal(admitted.inboxId, "compact-native");
  assert.equal(admitted.status, "admitted");
  assert.equal(admitted.completed, false);
  assert.equal(admitted.correlationSupported, true);
  assert.match(admitted.completionNote, /does not prove completion/);
  assert.equal(admitted.verifyNextCall.tool, "opencode.query");
  assert.deepEqual(admitted.verifyNextCall.arguments.queries, [{ type: "message", sessionId: "s", messageId: admitted.inboxId }]);
  const absent = await backend.query(admitted.verifyNextCall.arguments.queries);
  assert.ok("error" in absent.results[0]);
  assert.equal("messageId" in admitted, false);
  inbox = [];
  const pending = await backend.query([{ type: "inbox", sessionId: "s" }]);
  assert.equal((pending.results[0].result as { data: unknown[] }).data.length, 0);
  const stillAbsent = await backend.query(admitted.verifyNextCall.arguments.queries);
  assert.ok("error" in stillAbsent.results[0]);
  stage = "running";
  const running = await backend.query(admitted.verifyNextCall.arguments.queries);
  assert.equal((running.results[0].result as Record<string, any>).status, "running");
  assert.equal(admitted.completed, false);
  stage = "completed";
  const observed = await backend.query(admitted.verifyNextCall.arguments.queries);
  const record = observed.results[0].result as Record<string, any>;
  assert.equal(record.id, admitted.inboxId);
  assert.equal(record.type, "compaction");
  assert.equal(record.status, "completed");
  assert.equal(record.model, "opencode/free-compaction");
});

test("failed compaction retains the native error category without provider or diagnostic messages", async () => {
  const message = {
    ...compaction("compact-unavailable", "failed", "", ""),
    error: { type: "compaction.unavailable", message: "private-provider-response" },
  } as SessionMessageInfo;
  const native = pagingFixture([message]);
  const backend = new OpenCodeBackend(native.connect);
  for (const query of [
    { type: "messages", sessionId: "s", limit: 50 },
    { type: "message", sessionId: "s", messageId: message.id },
  ] as BackendQuery) {
    const response = await backend.query([query]);
    structuredResult(response);
    const result = response.results[0].result as Record<string, any>;
    const entry = query.type === "messages" ? result.messages[0] : result;
    assert.equal(entry.status, "failed");
    assert.deepEqual(entry.error, { type: "compaction.unavailable", messageOmitted: true });
    assert.equal(JSON.stringify(response).includes("private-provider-response"), false);
    assert.equal(entry.summaryNextCall, null);
  }
  assert.equal((projectMessage(compaction("complete", "completed", "summary", "")) as Record<string, any>).error, null);
});
