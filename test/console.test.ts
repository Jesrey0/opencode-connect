import assert from "node:assert/strict";
import test from "node:test";
import { handleKey, emptyState, renderFrame, renderTiny, visibleSessions, InputDecoder, sessionStatus, modelLabel, transcriptLines, type ConsoleSnapshot, type ConsoleState } from "../src/consoleView.js";
import { observe, messageToEntry, fetchTranscript, ConsoleObserver } from "../src/console.js";
import { nativeFixture, session, assistant, user } from "./native-fixture.js";

function snapshot(): ConsoleSnapshot {
  return {
    ready: true,
    release: "2.0.24",
    pid: 7,
    sessions: [
      { id: "s1", title: "Fix the parser", running: true, outcome: null, agent: "build", model: "openai/a", variant: "low", cwd: "/tmp/a", updatedMs: 5 },
      { id: "s2", title: "Old task", running: false, outcome: "succeeded", agent: "build", model: "openai/b", variant: null, cwd: "/tmp/b", updatedMs: 3 },
      { id: "s3", title: null, running: false, outcome: "failed", agent: null, model: null, variant: null, cwd: "/tmp/c", updatedMs: 1 },
    ],
    pending: [{ kind: "permission", sessionId: "s1", id: "p1", label: "write · src/a.ts" }],
    usage: { sessions: 3, prompts: 9, steps: 20, tokensTotal: 1500, costUsd: 0.42, activeDays: 2, streak: 1, models: ["openai/a"] },
    observedAtMs: 100,
  };
}

test("visibleSessions honors the active-only filter", () => {
  const snap = snapshot();
  assert.equal(visibleSessions(snap, false).length, 3);
  assert.deepEqual(visibleSessions(snap, true).map((s) => s.id), ["s1"]);
});

test("sessionStatus prefers running, then outcome, then idle", () => {
  const snap = snapshot();
  assert.equal(sessionStatus(snap.sessions[0]), "running");
  assert.equal(sessionStatus(snap.sessions[1]), "succeeded");
  assert.equal(sessionStatus(snap.sessions[2]), "failed");
  assert.equal(modelLabel(snap.sessions[0]), "openai/a#low");
  assert.equal(modelLabel(snap.sessions[2]), "<no model>");
});

test("dashboard navigation moves selection and enter opens a session", () => {
  const state = emptyState();
  const snap = snapshot();
  assert.equal(handleKey(state, snap, { kind: "down" }), true);
  assert.equal(state.selected, 1);
  assert.equal(handleKey(state, snap, { kind: "char", value: "k" }), true);
  assert.equal(state.selected, 0);
  assert.equal(handleKey(state, snap, { kind: "enter" }), true);
  assert.deepEqual(state.view, { kind: "session", sessionId: "s1" });
  assert.equal(state.follow, true);
  assert.equal(handleKey(state, snap, { kind: "escape" }), true);
  assert.deepEqual(state.view, { kind: "dashboard" });
});

test("active-only toggle re-filters and clamps selection", () => {
  const state = emptyState();
  const snap = snapshot();
  state.selected = 2;
  assert.equal(handleKey(state, snap, { kind: "char", value: "a" }), true);
  assert.equal(state.activeOnly, true);
  assert.equal(state.selected, 0);
  assert.equal(handleKey(state, snap, { kind: "enter" }), true);
  assert.deepEqual(state.view, { kind: "session", sessionId: "s1" });
});

test("transcript scroll pauses follow; G re-follows; q exits from dashboard", () => {
  const state: ConsoleState = emptyState();
  state.view = { kind: "session", sessionId: "s1" };
  assert.equal(handleKey(state, snapshot(), { kind: "down" }), true);
  assert.equal(state.follow, false);
  assert.equal(state.scroll, 1);
  assert.equal(handleKey(state, snapshot(), { kind: "char", value: "G" }), true);
  assert.equal(state.follow, true);
  state.view = { kind: "dashboard" };
  assert.equal(handleKey(state, snapshot(), { kind: "char", value: "q" }), true);
  assert.equal(state.quit, true);
});

test("help overlay toggles and swallows keys until dismissed", () => {
  const state = emptyState();
  assert.equal(handleKey(state, snapshot(), { kind: "char", value: "?" }), true);
  assert.equal(state.help, true);
  assert.equal(handleKey(state, snapshot(), { kind: "char", value: "j" }), false);
  assert.equal(handleKey(state, snapshot(), { kind: "escape" }), true);
  assert.equal(state.help, false);
});

test("InputDecoder decodes arrows, enter, paging, and standalone escape", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.push(0x1b).concat(decoder.push(0x5b)).concat(decoder.push(0x42)), [{ kind: "down" }]);
  assert.deepEqual(decoder.push(0x0d), [{ kind: "enter" }]);
  assert.deepEqual(decoder.push(0x1b).concat(decoder.push(0x5b)).concat(decoder.push(0x35)).concat(decoder.push(0x7e)), [{ kind: "pageUp" }]);
  assert.deepEqual(decoder.push(0x61), [{ kind: "char", value: "a" }]);
  assert.deepEqual([...Buffer.from("é")].flatMap((byte) => decoder.push(byte)), []);
  assert.deepEqual(decoder.push(0x1b), []);
  assert.deepEqual(decoder.flushEscape(), [{ kind: "escape" }]);
});

test("renderFrame is deterministic and includes core native evidence", () => {
  const state = emptyState();
  const width = 100;
  const height = 24;
  const a = renderFrame(snapshot(), null, state, width, height);
  const b = renderFrame(snapshot(), null, emptyState(), width, height);
  assert.deepEqual(a, b);
  const text = a.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(text.includes("opencode connect"));
  assert.ok(text.includes("opencode 2.0.24 · pid 7"));
  assert.ok(text.includes("Fix the parser"));
  assert.ok(text.includes("running"));
  assert.ok(text.includes("Needs 0xOperator · 1 pending"));
  assert.ok(text.includes("openai/a"));
  assert.ok(text.includes("? help"));
  assert.equal(a.length, height);
  assert.equal(renderFrame(snapshot(), "backend unavailable", emptyState(), width, height).length, height);
});

test("renderTiny handles zero space and small terminals", () => {
  assert.deepEqual(renderTiny(snapshot(), null, emptyState(), 0, 0), []);
  const lines = renderTiny(snapshot(), null, emptyState(), 40, 8);
  assert.ok(lines.join("\n").includes("3 sessions"));
});

test("transcriptLines render operator/worker identity and wraps text", () => {
  const lines = transcriptLines([{ role: "user", text: "hello" }, { role: "assistant", text: "x".repeat(200) }], 40);
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(text.includes("0xOperator"));
  assert.ok(text.includes("OpenCode worker"));
  assert.ok(lines.length > 3);
});

test("messageToEntry maps canonical messages to transcript entries", () => {
  assert.deepEqual(messageToEntry(user("u1")), { role: "user", text: "task" });
  assert.deepEqual(messageToEntry(assistant("a1", "done")), { role: "assistant", text: "done" });
});

test("observe projects sessions, pending actions, and usage from the native client", async () => {
  const native = nativeFixture((request) => {
    if (request.path === "/api/session" && request.method === "GET") {
      if (request.query.has("limit")) return { data: [session()], cursor: { next: null } };
      return undefined;
    }
    if (request.path === "/api/session/active") return { data: { s: { type: "running" } } };
    if (request.path === "/api/server/info" || request.path === "/api/info") return { version: "2.0.24", pid: 3, urls: [], paths: { tmp: "/tmp" } };
    if (request.path === "/api/experimental/session/stats") return { data: {
      range: { from: 0, to: 1 }, sessions: 1, subagents: 0, prompts: 2, steps: 4,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.01, tools: { mode: "none" }, activeDays: 1, streak: 1, activity: [],
      models: [{ model: { providerID: "openai", id: "a" }, steps: 4, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 }],
    } };
    if (request.path.includes("/permission")) return { data: [] };
    if (request.path.includes("/form")) return { data: [] };
    return undefined;
  });
  const observed = await observe(native.client);
  assert.equal(observed.ready, true);
  assert.equal(observed.release, "2.0.24");
  assert.equal(observed.sessions.length, 1);
  assert.equal(observed.sessions[0].running, true);
  assert.equal(observed.sessions[0].model, "openai/a");
  assert.equal(observed.usage?.models[0], "openai/a");
  assert.equal(observed.pending.length, 0);
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("fetchTranscript reads recent native messages in chronological order", async () => {
  const native = nativeFixture((request) => {
    assert.equal(request.query.get("limit"), "25");
    assert.equal(request.query.get("order"), "desc");
    return { data: [assistant("a1", "done"), user("u1")], cursor: { next: null } };
  });
  assert.deepEqual((await fetchTranscript(native.client, "s")).map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "task" },
    { role: "assistant", text: "done" },
  ]);
});

test("console refresh coalesces events without overlapping native reads", async () => {
  const started = deferred<void>();
  const release = deferred<ConsoleSnapshot>();
  let reads = 0;
  let inFlight = 0;
  let maximum = 0;
  const observer = new ConsoleObserver(emptyState(), {
    snapshot: async () => {
      reads++;
      maximum = Math.max(maximum, ++inFlight);
      try {
        if (reads === 1) { started.resolve(); return await release.promise; }
        return snapshot();
      } finally { inFlight--; }
    },
    transcript: async () => [],
  }, () => {});
  const first = observer.refresh();
  await started.promise;
  const second = observer.refresh();
  const third = observer.refresh();
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(reads, 1);
  release.resolve(snapshot());
  await first;
  assert.equal(reads, 2);
  assert.equal(maximum, 1);
});

for (const fails of [false, true]) {
  test(`late transcript ${fails ? "error" : "content"} cannot affect a newly opened view`, async () => {
    const state = emptyState();
    state.view = { kind: "session", sessionId: "s1" };
    const started = deferred<void>();
    const release = deferred<NonNullable<ConsoleState["transcript"]>>();
    const observer = new ConsoleObserver(state, {
      snapshot: async () => snapshot(),
      transcript: async () => { started.resolve(); return release.promise; },
    }, () => {});
    const refresh = observer.refresh();
    await started.promise;
    // Even reopening the same session must discard the previous view's read.
    assert.equal(observer.applyKeys([{ kind: "escape" }, { kind: "enter" }]), true);
    if (fails) release.reject(new Error("old view read failed"));
    else release.resolve([{ role: "assistant", text: "old view content" }]);
    await refresh;
    assert.equal(state.transcript, null);
    assert.equal(state.transcriptError, null);
  });
}

test("late transcript error cannot leak into another session", async () => {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s1" };
  const started = deferred<void>();
  const release = deferred<NonNullable<ConsoleState["transcript"]>>();
  const observer = new ConsoleObserver(state, {
    snapshot: async () => snapshot(),
    transcript: async (id) => {
      if (id === "s1") { started.resolve(); return release.promise; }
      return [{ role: "assistant", text: "session two" }];
    },
  }, () => {});
  const refresh = observer.refresh();
  await started.promise;
  observer.applyKeys([{ kind: "escape" }, { kind: "down" }, { kind: "enter" }]);
  release.reject(new Error("session one read failed"));
  await refresh;
  assert.deepEqual(state.view, { kind: "session", sessionId: "s2" });
  assert.equal(state.transcriptError, null);
  await observer.refresh();
  assert.deepEqual(state.transcript, [{ role: "assistant", text: "session two" }]);
});

test("scrolling and help retain the loaded transcript without another read", async () => {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s1" };
  let reads = 0;
  const observer = new ConsoleObserver(state, {
    snapshot: async () => snapshot(),
    transcript: async () => { reads++; return [{ role: "user", text: "cached" }]; },
  }, () => {});
  await observer.refresh();
  const cached = state.transcript;
  assert.equal(observer.applyKeys([{ kind: "up" }]), false);
  assert.equal(state.follow, false);
  assert.equal(state.transcript, cached);
  assert.equal(observer.applyKeys([{ kind: "char", value: "?" }]), false);
  assert.equal(observer.applyKeys([{ kind: "escape" }]), false);
  await observer.refresh();
  assert.equal(reads, 1);
  assert.equal(state.transcript, cached);
  assert.equal(observer.applyKeys([{ kind: "end" }]), true);
  assert.equal(state.transcript, cached);
});

test("failed reads retain cached content and recover while follow is paused", async () => {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s1" };
  const cached = [{ role: "user" as const, text: "cached" }];
  state.transcript = cached;
  let reads = 0;
  const observer = new ConsoleObserver(state, {
    snapshot: async () => snapshot(),
    transcript: async () => {
      if (++reads === 1) throw new Error("temporary read failure PRIVATE-UPSTREAM-BODY");
      return [{ role: "assistant", text: "recovered" }];
    },
  }, () => {});
  await observer.refresh();
  assert.equal(state.transcript, cached);
  assert.match(state.transcriptError!, /details omitted/);
  assert.equal(state.transcriptError!.includes("PRIVATE-UPSTREAM-BODY"), false);
  observer.applyKeys([{ kind: "up" }]);
  await observer.refresh();
  assert.equal(reads, 2);
  assert.equal(state.transcriptError, null);
  assert.deepEqual(state.transcript, [{ role: "assistant", text: "recovered" }]);
});

test("console ignores late reads and redraws after quitting", async () => {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s1" };
  const started = deferred<void>();
  const release = deferred<NonNullable<ConsoleState["transcript"]>>();
  let redraws = 0;
  const observer = new ConsoleObserver(state, {
    snapshot: async () => snapshot(),
    transcript: async () => { started.resolve(); return release.promise; },
  }, () => { redraws++; });
  const refresh = observer.refresh();
  await started.promise;
  state.quit = true;
  release.reject(new Error("late failure"));
  await refresh;
  assert.equal(state.transcriptError, null);
  assert.equal(redraws, 0);
});

test("failed dashboard reads retain the last successful snapshot", async () => {
  let reads = 0;
  const observer = new ConsoleObserver(emptyState(), {
    snapshot: async () => {
      if (++reads === 2) throw new Error("backend unavailable PRIVATE-UPSTREAM-BODY");
      return snapshot();
    },
    transcript: async () => [],
  }, () => {});
  await observer.refresh();
  const cached = observer.snapshot;
  await observer.refresh();
  assert.equal(observer.snapshot, cached);
  assert.match(observer.error!, /details omitted/);
  assert.equal(observer.error!.includes("PRIVATE-UPSTREAM-BODY"), false);
  await observer.refresh();
  assert.equal(observer.error, null);
});
