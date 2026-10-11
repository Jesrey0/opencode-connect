import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ConsoleObserver, consoleReads, fetchRuntimeTranscript, observe } from "../src/console.js";
import { displayWidth, emptyState, handleKey, renderFrame, sessionStatus, visibleSessions } from "../src/consoleView.js";
import { nativeFixture, session, assistant, user, type NativeRequest } from "./native-fixture.js";

const capabilities = { permissions: "operator-selected", modes: [], defaultMode: null };
const supervised = (sessionId = "worker") => ({ sessionId, cwd: "/work/codex", title: "Codex task", status: "inProgress", outcome: "unknown", executionKnown: true, output: "", capabilities, mode: null, pendingActions: [] });
function fixture(rpc: (request: NativeRequest) => unknown) {
  return nativeFixture(request => {
    if (request.path.startsWith("/api/rpc/")) return rpc(request);
    if (request.path === "/api/server/info" || request.path === "/api/info") return { version: "2.0.24", pid: 3, urls: [], paths: { tmp: "/tmp" } };
    if (request.path === "/api/session") return { data: [session()], cursor: { next: null } };
    if (request.path === "/api/session/active") return { data: {} };
    if (request.path.endsWith("/message")) return { data: [assistant("a", "OpenCode answer"), user("u")], cursor: { next: null } };
    return undefined;
  });
}
const unavailable = () => Response.json({ _tag: "RpcError", type: "codex-sessions.unsupported", message: "PRIVATE backend body" }, { status: 400 });
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

test("console includes Codex history and active worker omitted by native listing", async () => {
  const native = fixture(request => request.path.endsWith("/list")
    ? { output: { sessions: [{ sessionId: "history", cwd: "/history", title: "History", updatedAt: "invalid", capabilities }], nextCursor: "older" } }
    : { output: { sessions: [supervised()] } });
  const snapshot = await observe(native.client);
  assert.equal(snapshot.sessions.length, 3);
  const worker = snapshot.sessions.find(entry => entry.id === "worker")!;
  const history = snapshot.sessions.find(entry => entry.id === "history")!;
  assert.equal(worker.runtime, "codex");
  assert.equal(sessionStatus(worker), "running");
  assert.equal(worker.model, null);
  assert.equal(worker.outcome, null);
  assert.equal(worker.updatedMs, null);
  assert.equal(sessionStatus(history), "unknown");
  assert.deepEqual(visibleSessions(snapshot, true).map(entry => entry.id), ["worker"]);
  assert.match(snapshot.codexVisibility, /partial.*more history/);
  assert.deepEqual(native.requests.filter(request => request.path.includes("/rpc/")).map(request => request.body), [{ input: {} }, { input: {} }]);
  for (const [width, height] of [[80, 24], [44, 14], [40, 10], [24, 8]]) {
    const state = emptyState();
    const frame = renderFrame(snapshot, null, state, width, height);
    assert.equal(frame.length, height);
    for (const line of frame) assert.equal(displayWidth(line), width);
    assert.match(plain(frame), /codex/);
    handleKey(state, snapshot, { kind: "enter" });
    state.transcript = [{ role: "assistant", text: "Persisted text" }];
    const detail = plain(renderFrame(snapshot, null, state, width, height));
    assert.match(detail, /codex/);
    assert.doesNotMatch(detail, /running · live/);
    if (width >= 40) assert.match(detail, /Bounded history.*no live/);
  }
});

test("Codex runtime routing keeps colliding session IDs and ignores OpenCode deltas", async () => {
  const native = fixture(request => {
    if (request.path.endsWith("/list")) return { output: { sessions: [], nextCursor: null } };
    if (request.path.endsWith("/status")) return { output: { sessions: [supervised("s")] } };
    assert.equal(request.path, "/api/rpc/codex-sessions/messages");
    assert.deepEqual(request.body, { input: { sessionId: "s" } });
    return { output: { sessionId: "s", historyComplete: false, messages: [
      { id: null, role: "user", text: "Codex prompt" },
      { id: "ca", role: "assistant", text: "Codex answer".repeat(100) },
    ] } };
  });
  const snapshot = await observe(native.client);
  assert.equal(snapshot.sessions.filter(entry => entry.id === "s").length, 2);
  const state = emptyState();
  handleKey(state, snapshot, { kind: "enter" });
  assert.deepEqual(state.view, { kind: "session", runtime: "codex", sessionId: "s" });
  const observer = new ConsoleObserver(state, {
    snapshot: async () => snapshot,
    transcript: (id, includePrompt, runtime) => fetchRuntimeTranscript(native.client, runtime, id, includePrompt),
  }, () => {});
  await observer.refresh();
  assert.equal(state.transcript?.[0].text, "Codex prompt");
  assert.match(state.transcript![1].text, /preview truncated/);
  assert.equal(observer.applyEvent({ id: "e", created: 1, type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "ca", ordinal: 0, delta: "WRONG RUNTIME" } } as never), false);
  const detail = plain(renderFrame(snapshot, null, state, 80, 24));
  assert.match(detail, /Codex worker/);
  assert.doesNotMatch(detail, /OpenCode worker|WRONG RUNTIME|running · live/);
  // Replayed bounded snapshots with null IDs must not duplicate cached history.
  await observer.refresh();
  assert.equal(state.transcript?.length, 2);
  assert.equal((await fetchRuntimeTranscript(native.client, "opencode", "s"))[1].text, "OpenCode answer");
  observer.applyKeys([{ kind: "escape" }, { kind: "down" }, { kind: "enter" }]);
  assert.deepEqual(state.view, { kind: "session", runtime: "opencode", sessionId: "s" });
  await observer.refresh();
  assert.equal(observer.applyEvent({ id: "oc", created: 2, type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "live", ordinal: 0, delta: "OpenCode streaming" } } as never), true);
  assert.equal(state.transcript?.at(-1)?.text, "OpenCode streaming");
  assert.match(plain(renderFrame(snapshot, null, state, 80, 24)), /OpenCode worker/);
});

test("a rejected Codex inventory read cannot blank the OpenCode snapshot", async () => {
  const native = fixture(unavailable);
  const snapshot = await observe(native.client, async () => { throw new Error("PRIVATE inventory failure"); });
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.sessions[0].runtime, "opencode");
  assert.match(snapshot.codexVisibility, /unavailable.*partial visibility/);
  assert.doesNotMatch(plain(renderFrame(snapshot, null, emptyState(), 80, 24)), /PRIVATE/);
});

test("unsupported or disconnected Codex RPC preserves OpenCode and reports partial visibility", async () => {
  for (const failure of [unavailable, () => { throw new Error("PRIVATE disconnected body"); }]) {
    const native = fixture(failure);
    const snapshot = await observe(native.client);
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].runtime, "opencode");
    assert.match(snapshot.codexVisibility, /unavailable.*partial visibility/);
    const text = plain(renderFrame(snapshot, null, emptyState(), 80, 24));
    assert.match(text, /opencode.*succeeded/);
    assert.match(text, /Codex.*unavailable/);
    assert.doesNotMatch(text, /PRIVATE/);
  }
});

test("Codex list and supervised failures remain independent and replay is never running", async () => {
  for (const failed of ["list", "status"]) {
    const native = fixture(request => {
      if (request.path.endsWith(`/${failed}`)) return unavailable();
      if (request.path.endsWith("/list")) return { output: { sessions: [{ sessionId: "history", cwd: "/history", capabilities }], nextCursor: null } };
      return { output: { sessions: [{ ...supervised(), executionKnown: false, status: "idle" }] } };
    });
    const snapshot = await observe(native.client);
    assert.equal(snapshot.sessions.length, 2);
    assert.equal(sessionStatus(snapshot.sessions.find(entry => entry.runtime === "codex")!), "unknown");
    assert.match(snapshot.codexVisibility, new RegExp(`partial.*${failed === "list" ? "history" : "supervised status"} unavailable`));
  }
});

test("Codex reads and failures are reused across event refreshes until the slow fallback", async () => {
  let now = 0;
  let failed = true;
  const native = fixture(request => {
    if (failed) return unavailable();
    if (request.path.endsWith("/list")) return { output: { sessions: [], nextCursor: null } };
    if (request.path.endsWith("/status")) return { output: { sessions: [supervised()] } };
    return { output: { sessionId: "worker", messages: [{ id: null, role: "assistant", text: "Recovered" }], historyComplete: false } };
  });
  const reads = consoleReads(native.client, () => now);
  const state = emptyState();
  state.view = { kind: "session", runtime: "codex", sessionId: "worker" };
  state.transcript = [{ role: "assistant", text: "Cached history" }];
  const observer = new ConsoleObserver(state, reads, () => {});
  for (let index = 0; index < 5; index++) {
    now = index * 750;
    await observer.refresh();
  }
  assert.equal(native.requests.filter(request => request.path.includes("/rpc/")).length, 3);
  assert.equal(state.transcript?.[0].text, "Cached history");
  assert.match(state.transcriptError!, /Codex messages failed/);
  assert.match(observer.snapshot!.codexVisibility, /unavailable/);
  failed = false;
  now = 5000;
  await observer.refresh();
  assert.equal(native.requests.filter(request => request.path.includes("/rpc/")).length, 6);
  assert.equal(state.transcriptError, null);
  assert.equal(state.transcript?.[0].text, "Recovered");
  assert.equal(observer.snapshot!.sessions[0].runtime, "codex");
  now = 5750;
  await observer.refresh();
  assert.equal(native.requests.filter(request => request.path.includes("/rpc/")).length, 6);
});

test("overlapping Codex inventories deduplicate native IDs and pending actions stay runtime-local", async () => {
  const native = fixture(request => {
    if (request.path.endsWith("/list")) return { output: { sessions: [{ sessionId: "s", cwd: "/history", title: "Native title", updatedAt: "2026-10-11T12:00:00Z", capabilities }], nextCursor: null } };
    return { output: { sessions: [{ ...supervised("s"), title: null, status: "completed", outcome: "completed", pendingActions: [] }] } };
  });
  const snapshot = await observe(native.client);
  const codex = snapshot.sessions.find(entry => entry.runtime === "codex")!;
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(codex.title, "Native title");
  assert.equal(codex.cwd, "/work/codex");
  assert.equal(codex.updatedMs, Date.parse("2026-10-11T12:00:00Z"));
  assert.equal(sessionStatus(codex), "completed");
  snapshot.pending = [{ runtime: "codex", sessionId: "s", kind: "permission", id: "p", label: "Codex-only request" }];
  const state = emptyState();
  state.view = { kind: "session", runtime: "opencode", sessionId: "s" };
  assert.doesNotMatch(plain(renderFrame(snapshot, null, state, 80, 24)), /Codex-only request|Pending 1/);
  state.view = { kind: "session", runtime: "codex", sessionId: "s" };
  assert.match(plain(renderFrame(snapshot, null, state, 80, 24)), /Pending 1.*Codex-only request/);
});
