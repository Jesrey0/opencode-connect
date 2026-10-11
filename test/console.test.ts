import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { handleKey, emptyState, renderFrame, renderTiny, visibleSessions, InputDecoder, sessionStatus, modelLabel, transcriptLines, type ConsoleSnapshot, type ConsoleState } from "../src/consoleView.js";
import { observe, observeCodex, messageToEntry, fetchTranscript, ConsoleObserver } from "../src/console.js";
import { nativeFixture, session, assistant, user } from "./native-fixture.js";

function snapshot(): ConsoleSnapshot {
  return {
    codexVisibility: "recent + supervised", ready: true,
    release: "2.0.24",
    pid: 7,
    sessions: [
      { runtime: "opencode", id: "s1", title: "Fix the parser", running: true, outcome: null, agent: "build", model: "openai/a", variant: "low", cwd: "/tmp/a", updatedMs: 5 },
      { runtime: "opencode", id: "s2", title: "Old task", running: false, outcome: "succeeded", agent: "build", model: "openai/b", variant: null, cwd: "/tmp/b", updatedMs: 3 },
      { runtime: "opencode", id: "s3", title: null, running: false, outcome: "failed", agent: null, model: null, variant: null, cwd: "/tmp/c", updatedMs: 1 },
    ],
    pending: [{ runtime: "opencode", kind: "permission", sessionId: "s1", id: "p1", label: "write · src/a.ts" }],
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
  assert.deepEqual(state.view, { kind: "session", runtime: "opencode", sessionId: "s1" });
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
  assert.deepEqual(state.view, { kind: "session", runtime: "opencode", sessionId: "s1" });
});

test("transcript scroll pauses follow; G re-follows; q exits from dashboard", () => {
  const state: ConsoleState = emptyState();
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
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
  assert.ok(text.includes("1 running · 1 pending"));
  assert.ok(text.includes("Needs 0xOperator · permission: write · src/a.ts"));
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

test("observe includes active OpenCode sessions outside the recent page", async () => {
  const recent = Array.from({ length: 25 }, (_, index) => ({ ...session(), id: `recent-${index}`, time: { created: 1, updated: 100 - index } }));
  const olderActive = { ...session(), id: "older-active", title: "Long running task", time: { created: 1, updated: 1 } };
  const native = nativeFixture(request => {
    if (request.path === "/api/info") return { version: "2.0.24", pid: 3, urls: [], paths: { tmp: "/tmp" } };
    if (request.path === "/api/session/active") return { data: { "recent-0": { type: "running" }, "older-active": { type: "running" } } };
    if (request.path === "/api/session") return { data: recent, cursor: { next: "older" } };
    if (request.path === "/api/session/older-active") return { data: olderActive };
    if (request.path.includes("/permission") || request.path.includes("/form")) return { data: [] };
    return undefined;
  });
  const observed = await observe(native.client, async () => ({ sessions: [], pending: [], visibility: "recent + supervised" }));
  assert.deepEqual(observed.sessions.filter(entry => entry.running).map(entry => entry.id), ["recent-0", "older-active"]);
  assert.equal(observed.sessions.find(entry => entry.id === "older-active")?.title, "Long running task");
  assert.equal(native.requests.filter(request => request.path === "/api/session/older-active").length, 1);
  assert.equal(native.requests.filter(request => request.path === "/api/session/recent-0").length, 0);
});

test("failed metadata read retains an active ID beside known recent sessions", async () => {
  const native = nativeFixture(request => {
    if (request.path === "/api/info") return { version: "2.0.24", pid: 3, urls: [], paths: { tmp: "/tmp" } };
    if (request.path === "/api/session/active") return { data: { missing: { type: "running" } } };
    if (request.path === "/api/session") return { data: [session()], cursor: { next: null } };
    if (request.path === "/api/session/missing") return Response.json({ message: "private failure" }, { status: 404 });
    if (request.path.includes("/permission") || request.path.includes("/form")) return { data: [] };
    return undefined;
  });
  const observed = await observe(native.client, async () => ({ sessions: [], pending: [], visibility: "recent + supervised" }));
  assert.deepEqual(observed.sessions.map(entry => entry.id), ["missing", "s"]);
  const missing = observed.sessions[0];
  assert.equal(missing.running, true);
  assert.equal(missing.updatedMs, null);
  assert.match(missing.title!, /metadata unavailable/);
  assert.equal(missing.cwd, "<unavailable>");
  assert.doesNotMatch(renderFrame(observed, null, emptyState(), 80, 24).join("\n"), /private failure/);
});

test("pending permission labels omit native action and resource payloads", async () => {
  const native = nativeFixture(request => {
    if (request.path === "/api/info") return { version: "2.0.24", pid: 3, urls: [], paths: { tmp: "/tmp" } };
    if (request.path === "/api/session/active") return { data: { s: { type: "running" } } };
    if (request.path === "/api/session") return { data: [session()], cursor: { next: null } };
    if (request.path.includes("/permission")) return { data: [{ id: "p", sessionID: "s", action: "PRIVATE_ACTION", resources: ["PRIVATE_RESOURCE"] }] };
    if (request.path.includes("/form")) return { data: [] };
    return undefined;
  });
  const observed = await observe(native.client, async () => ({ sessions: [], pending: [], visibility: "recent + supervised" }));
  assert.deepEqual(observed.pending, [{ runtime: "opencode", kind: "permission", sessionId: "s", id: "p", label: "native permission request" }]);
  assert.doesNotMatch(renderFrame(observed, null, emptyState(), 80, 24).join("\n"), /PRIVATE_/);
});

test("observed Codex terminal status without an outcome remains unverified", async () => {
  const native = nativeFixture(request => {
    if (request.path.endsWith("/list")) return { output: { sessions: [], nextCursor: null } };
    if (request.path.endsWith("/status")) return { output: { sessions: [{
      sessionId: "worker", cwd: "/tmp", title: "Worker", status: "completed", outcome: "unknown",
      executionKnown: true, output: "", capabilities: { permissions: "operator-selected", modes: [], defaultMode: null }, mode: null,
      pendingActions: [{ requestId: "approval", sessionId: "worker", action: "PRIVATE_COMMAND", resources: ["PRIVATE_RESOURCE"], options: [], details: { locations: [], truncatedFields: [] } }],
    }] } };
    return undefined;
  });
  const inventory = await observeCodex(native.client);
  assert.equal(inventory.sessions[0].running, null);
  assert.equal(inventory.sessions[0].outcome, null);
  assert.equal(inventory.pending[0].label, "native permission request");
  assert.doesNotMatch(JSON.stringify(inventory.pending), /PRIVATE_/);
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

test("native transcript reads stop when their view is cancelled", async () => {
  const started = deferred<void>();
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const native = nativeFixture(request => {
    requestSignal = request.signal;
    started.resolve();
    return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const read = fetchTranscript(native.client, "s", true, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(read);
  assert.equal(requestSignal?.aborted, true);
});

test("cancelled native dashboard reads settle while Codex observation starts concurrently", async () => {
  const started = deferred<void>();
  const controller = new AbortController();
  let codexReads = 0;
  let requestSignal: AbortSignal | undefined;
  const native = nativeFixture(request => {
    if (request.path === "/api/info") {
      requestSignal = request.signal;
      started.resolve();
      return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    }
    if (request.path === "/api/session/active") return { data: {} };
    if (request.path === "/api/session") return { data: [], cursor: { next: null } };
    return undefined;
  });
  const read = observe(native.client, async () => { codexReads++; return { sessions: [], pending: [], visibility: "recent + supervised" }; }, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(read);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(codexReads, 1);
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

test("refresh keeps the selected session when the inventory reorders", async () => {
  const state = emptyState();
  state.selected = 1;
  let moved = false;
  const observer = new ConsoleObserver(state, {
    snapshot: async () => {
      const initial = snapshot();
      return { ...initial, sessions: moved ? [initial.sessions[1], initial.sessions[0], initial.sessions[2]] : initial.sessions };
    },
    transcript: async () => [],
  }, () => {});
  await observer.refresh();
  moved = true;
  await observer.refresh();
  assert.equal(state.selected, 0);
  observer.applyKeys([{ kind: "enter" }]);
  assert.deepEqual(state.view, { kind: "session", runtime: "opencode", sessionId: "s2" });
});

test("stream outage remains visible after a successful snapshot and suppresses live mode", async () => {
  const state = emptyState();
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
  const observer = new ConsoleObserver(state, { snapshot: async () => snapshot(), transcript: async () => [] }, () => {});
  observer.streamError = "event stream ended; reconnecting";
  await observer.refresh();
  assert.equal(observer.error, null);
  assert.equal(observer.displayError, "event stream ended; reconnecting");
  const degraded = renderFrame(observer.snapshot, observer.displayError, state, 80, 24).join("\n");
  assert.doesNotMatch(degraded, /running · live/);
  assert.match(degraded, /stale/);
  observer.streamError = null;
  assert.match(renderFrame(observer.snapshot, observer.displayError, state, 80, 24).join("\n"), /running · live/);
});

test("dashboard help swallows r without scheduling a history refresh", async () => {
  const state = emptyState();
  const historyFlags: boolean[] = [];
  const observer = new ConsoleObserver(state, {
    snapshot: async (refreshHistory) => { historyFlags.push(Boolean(refreshHistory)); return snapshot(); },
    transcript: async () => [],
  }, () => {});
  await observer.refresh();
  assert.equal(observer.applyKeys([{ kind: "char", value: "?" }, { kind: "char", value: "r" }]), false);
  await observer.refresh();
  assert.deepEqual(historyFlags, [false, false]);
});

test("opening another session cancels the previous transcript read", async () => {
  const state = emptyState();
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
  const started = deferred<void>();
  let aborted = false;
  const observer = new ConsoleObserver(state, {
    snapshot: async () => snapshot(),
    transcript: async (id, _includePrompt, _runtime, signal) => {
      if (id === "s2") return [{ role: "assistant", text: "second session" }];
      started.resolve();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true }));
    },
  }, () => {});
  const first = observer.refresh();
  await started.promise;
  assert.equal(observer.applyKeys([{ kind: "escape" }, { kind: "down" }, { kind: "enter" }]), true);
  void observer.refresh();
  await first;
  assert.equal(aborted, true);
  assert.deepEqual(state.view, { kind: "session", runtime: "opencode", sessionId: "s2" });
  assert.deepEqual(state.transcript, [{ role: "assistant", text: "second session" }]);
});

test("continuous refresh requests settle each bounded batch and retain a delayed trailing read", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = emptyState();
  let reads = 0;
  let inFlight = 0;
  let maximum = 0;
  let churn = true;
  let allowedReads = 2;
  const unexpectedRead = deferred<ConsoleSnapshot>();
  const frames: number[] = [];
  const observer = new ConsoleObserver(state, {
    snapshot: async () => {
      reads++;
      maximum = Math.max(maximum, ++inFlight);
      try {
        // A broken unbounded drain blocks here rather than spinning forever.
        if (reads > allowedReads) return await unexpectedRead.promise;
        // Every read, including the second, receives a burst of queued events.
        await Promise.resolve();
        if (churn) for (let event = 0; event < 10; event++) void observer.refresh();
        return { ...snapshot(), pid: reads };
      } finally { inFlight--; }
    },
    transcript: async () => [],
  }, () => { frames.push(observer.snapshot!.pid); });
  await observer.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(frames, [1, 2]);
  t.mock.timers.tick(749);
  assert.equal(reads, 2);
  allowedReads = 4;
  t.mock.timers.tick(1);
  await observer.refresh();
  assert.equal(reads, 4);
  assert.deepEqual(frames, [1, 2, 3, 4]);
  churn = false;
  allowedReads = 5;
  t.mock.timers.tick(750);
  // Let the scheduled read settle without requesting another refresh.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 5);
  t.mock.timers.tick(7500);
  assert.equal(reads, 5);
  assert.equal(maximum, 1);
});

test("console paints a connecting first frame even when startup observers never resolve", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith("/src/native.ts")) return {
          format: "module", shortCircuit: true,
          source: 'export async function connectNative() { return { client: { server: { info: () => new Promise(() => {}) }, session: { active: () => new Promise(() => {}), list: () => new Promise(() => {}), stats: () => new Promise(() => {}) }, event: { subscribe: async function* () { await new Promise(() => {}); } } } }; }',
        };
        if (url.endsWith("/src/codexQuota.ts")) return {
          format: "module", shortCircuit: true,
          source: 'export function observeCodexQuota() { return { refresh() {}, async close() {} }; }',
        };
        return nextLoad(url, context);
      },
    });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => {};
    const { run } = await import("./src/console.ts");
    void run();
    setTimeout(() => process.exit(0), 100);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[\?1049h/);
  assert.match(result.stdout, /opencode connect/);
  assert.match(result.stdout, /connecting/);
});

test("console paints and restores the terminal if interrupted during native connection", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith("/src/native.ts")) return {
        format: "module", shortCircuit: true,
        source: 'export async function connectNative() { return new Promise(() => {}); }',
      };
      return nextLoad(url, context);
    } });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => {};
    const { run } = await import("./src/console.ts");
    void run();
    setTimeout(() => process.kill(process.pid, "SIGINT"), 100);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stdout, /\x1b\[\?1049h/);
  assert.match(result.stdout, /connecting/);
  assert.match(result.stdout, /\x1b\[\?1049l/);
});

test("console restores the terminal when raw input setup fails", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith("/src/native.ts")) return {
        format: "module", shortCircuit: true,
        source: 'export async function connectNative() { return { client: { event: { subscribe: async function* () {} } } }; }',
      };
      return nextLoad(url, context);
    } });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => { throw new Error("raw mode unavailable"); };
    const { run } = await import("./src/console.ts");
    try { await run(); } catch (cause) { if (cause.message !== "raw mode unavailable") process.exit(2); }
    process.exit(0);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[\?1049h/);
  assert.match(result.stdout, /\x1b\[\?1049l/);
});

test("help overlay blocks dashboard r from refreshing quota", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith("/src/native.ts")) return {
        format: "module", shortCircuit: true,
        source: 'export async function connectNative() { return { client: { server: { info: async () => ({ version: "2.0.24", pid: 1 }) }, session: { active: async () => ({}), list: async () => ({ data: [], cursor: { next: null } }), stats: async () => null }, event: { subscribe: async function* () { await new Promise(() => {}); } } } }; }',
      };
      if (url.endsWith("/src/codexQuota.ts")) return {
        format: "module", shortCircuit: true,
        source: 'export function observeCodexQuota() { return { refresh() { process.stdout.write("QUOTA_REFRESH"); }, async close() {} }; }',
      };
      return nextLoad(url, context);
    } });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => {};
    const { run } = await import("./src/console.ts");
    void run();
    setTimeout(() => process.stdin.emit("data", Buffer.from("?r")), 200);
    setTimeout(() => process.stdin.emit("data", Buffer.from("?q")), 350);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /QUOTA_REFRESH/);
  assert.match(result.stdout, /\x1b\[\?1049l/);
});

for (const fails of [false, true]) {
  test(`late transcript ${fails ? "error" : "content"} cannot affect a newly opened view`, async () => {
    const state = emptyState();
    state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
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
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
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
  assert.deepEqual(state.view, { kind: "session", runtime: "opencode", sessionId: "s2" });
  assert.equal(state.transcriptError, null);
  await observer.refresh();
  assert.deepEqual(state.transcript, [{ role: "assistant", text: "session two" }]);
});

test("scrolling and help retain the loaded transcript without another read", async () => {
  const state = emptyState();
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
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
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
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
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
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
