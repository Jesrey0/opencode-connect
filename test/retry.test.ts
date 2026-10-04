import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessageInfo, V2Event } from "@opencode/client";
import { OpenCodeBackend } from "../src/opencode.js";
import { EventReconciler } from "../src/eventsReconciliation.js";
import { outputSchemas } from "../src/results.js";
import { nativeFixture, session, user, assistant } from "./native-fixture.js";

const target = { sessionId: "s", messageId: "u" };
const providerError = { type: "provider", status: 429, message: "SECRET", body: "SECRET", headers: { authorization: "SECRET" } };
const expectedRetry = (attempt = 2, at = 1_900_000_000_000) => ({ assistantMessageId: "a", attempt, nextAttemptAtMs: at, error: { type: "provider", status: 429, messageOmitted: true } });
const answer = () => assistant("a", "") as Extract<SessionMessageInfo, { type: "assistant" }>;

function retryFixture(timeoutMs = 100) {
  const state = session();
  let active = false;
  let messages: SessionMessageInfo[] = [user("u")]; // Descending native order.
  let messageReadFails = false;
  let promptFails = false;
  let permissionReads = 0;
  const checkpoints: { count: number; resolve: () => void }[] = [];
  const native = nativeFixture((request) => {
    if (request.path === "/api/session/s") return { data: state };
    if (request.path === "/api/session") return { data: [state], cursor: {} };
    if (request.path === "/api/session/active") return { data: active ? { s: { type: "running" } } : {} };
    if (request.path.endsWith("/prompt")) {
      active = true;
      if (promptFails) return Response.json({ message: "SECRET" }, { status: 503 });
      return { data: user("u") };
    }
    if (request.path.endsWith("/message")) {
      if (messageReadFails) return Response.json({ message: "SECRET" }, { status: 500 });
      return { data: messages.slice(0, Number(request.query.get("limit"))), cursor: {} };
    }
    if (request.path.includes("/message/")) {
      return { data: messages.find((message) => message.id === request.path.split("/").at(-1)) };
    }
    if (request.path.endsWith("/form")) return { data: [] };
    if (request.path.endsWith("/permission")) {
      permissionReads++;
      for (const checkpoint of checkpoints) if (permissionReads >= checkpoint.count) checkpoint.resolve();
      return { data: [] };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const events: V2Event[] = [];
  let wake: (() => void) | undefined;
  const client = { ...native.client, event: { subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        if (events.length) { yield events.shift()!; continue; }
        await new Promise<void>((resolve) => {
          const resume = () => { signal?.removeEventListener("abort", resume); wake = undefined; resolve(); };
          wake = resume;
          signal?.addEventListener("abort", resume, { once: true });
          if (signal?.aborted) resume();
        });
      }
    },
  }) } };
  const backend = new OpenCodeBackend(async () => ({ ...native.connection, client }), timeoutMs);
  const queued: unknown[][] = [];
  const reconciler = new EventReconciler(backend, {
    targets: () => [target], observe: async (...args: unknown[]) => { queued.push(args); },
    lifecycle: { record: () => assert.fail("canonical reconciliation should succeed") },
  } as never);
  return {
    backend, native, state, reconciler, queued,
    start: () => backend.start({ task: "task", model: "openai/a", sessionId: "s" }),
    retry: (attempt = 2, at = 1_900_000_000_000) => {
      messages = [{ ...answer(), finish: undefined, time: { created: 2 }, retry: { attempt, at, error: providerError } }, user("u")];
    },
    stepStarted: () => { messages = [{ ...answer(), finish: undefined, time: { created: 2 } }, user("u")]; },
    stepFailed: (status = 403) => {
      messages = [{ ...answer(), finish: "error", error: { ...providerError, status } }, user("u")];
    },
    terminal: (outcome: "succeeded" | "failed") => {
      active = false;
      state.outcome = outcome;
      if (outcome === "succeeded") messages = [assistant("a", "finished"), user("u")];
    },
    messages: (value: SessionMessageInfo[]) => { messages = value; },
    failMessageRead: () => { messageReadFails = true; },
    failPrompt: () => { promptFails = true; },
    emit: (type: string) => { events.push({ type, data: { sessionID: "s" } } as V2Event); wake?.(); },
    checkpoint: (count: number) => permissionReads >= count ? Promise.resolve() : new Promise<void>((resolve) => checkpoints.push({ count, resolve })),
    mutations: () => native.requests.filter((request) => request.method !== "GET"),
  };
}

test("native retry projects across status, inspect, wait and messages without replaying the admitted prompt", async () => {
  const fixture = retryFixture();
  assert.equal((await fixture.start()).messageId, "u");
  for (const [attempt, at] of [[2, 1_900_000_000_000], [3, 1]] as const) {
    fixture.retry(attempt, at);
    const status = await fixture.backend.status();
    const semantic = await fixture.backend.inspect(target);
    const result = await fixture.backend.inspect({ ...target, detail: "result" });
    const waited = await fixture.backend.wait("s", "u");
    const query = await fixture.backend.query([{ type: "message", sessionId: "s", messageId: "a" }]);
    assert.ok("retry" in semantic && "result" in result && "retry" in waited);
    const queried = query.results[0].result as { retry: unknown };
    for (const retry of [status.workers[0].retry, semantic.retry, result.result.retry, waited.retry, queried.retry]) {
      assert.deepEqual(retry, expectedRetry(attempt, at));
    }
    assert.equal(status.workers[0].status, "inProgress");
    assert.equal(status.workers[0].terminalAtMs, null);
    assert.equal(status.workers[0].retryReadError, null);
    assert.equal(result.result.terminal, false);
    assert.equal(result.result.selectionComplete, false);
    assert.equal(result.result.outcome, "unknown");
    assert.equal(waited.state, "active");
    assert.equal(waited.wakeReason, "timeout");
    assert.equal(waited.session.status, "inProgress");
    assert.equal(JSON.stringify([status, semantic, result, waited, query]).includes("SECRET"), false);
    outputSchemas.status.parse(status);
    outputSchemas.inspect.parse(semantic);
    outputSchemas.inspect.parse(result);
    outputSchemas.wait.parse(waited);
    await fixture.reconciler.reconcile();
    assert.equal(fixture.queued.length, 0);
  }
  fixture.stepStarted();
  assert.equal((await fixture.backend.status()).workers[0].retry, null);
  const resumed = await fixture.backend.inspect({ ...target, detail: "result" });
  assert.ok("result" in resumed);
  assert.equal(resumed.result.retry, null);
  assert.equal(resumed.result.outcome, "unknown");
  fixture.terminal("succeeded");
  const complete = await fixture.backend.wait("s", "u");
  assert.ok(complete.state === "terminal");
  assert.equal(complete.result.outcome, "completed");
  assert.equal(complete.result.retry, null);
  await fixture.reconciler.reconcile();
  assert.deepEqual(fixture.queued[0]?.slice(0, 3), ["s", "u", "completed"]);
  assert.deepEqual(fixture.mutations().map((request) => [request.method, request.path]), [["POST", "/api/session/s/prompt"]]);
  assert.equal(fixture.mutations()[0].body.text, "task");
  assert.equal(fixture.native.requests.filter((request) => request.path.endsWith("/message")).every((request) => Number(request.query.get("limit")) <= 50), true);
});

for (const retried of [false, true]) {
  test(`${retried ? "exhausted transient retries" : "immediate auth 403"} cannot wake wait or queue terminal events before native termination`, async () => {
    const fixture = retryFixture(1000);
    await fixture.start();
    if (retried) fixture.retry(11);
    const wait = fixture.backend.wait("s", "u");
    await fixture.checkpoint(2);
    if (retried) fixture.emit("session.retry.scheduled");
    fixture.stepFailed(retried ? 502 : 403);
    fixture.emit("session.step.failed");
    fixture.emit("session.execution.failed"); // Even an early terminal hint is insufficient.
    await fixture.checkpoint(3);
    await fixture.reconciler.reconcile();
    assert.equal(fixture.queued.length, 0);
    const inspected = await fixture.backend.inspect({ ...target, detail: "result" });
    assert.ok("result" in inspected);
    assert.equal(inspected.result.terminal, false);
    assert.equal(inspected.result.outcome, "unknown");
    assert.equal(inspected.result.retry, null);
    fixture.terminal("failed");
    fixture.emit("session.execution.failed");
    const failed = await wait;
    assert.ok("result" in failed);
    assert.equal(failed.state, "terminal");
    assert.equal(failed.session.status, "failed");
    assert.equal(failed.result.outcome, "failed");
    assert.equal(failed.result.error?.status, retried ? 502 : 403);
    outputSchemas.wait.parse(failed);
    await fixture.reconciler.reconcile();
    assert.deepEqual(fixture.queued[0]?.slice(0, 3), ["s", "u", "failed"]);
    assert.equal(fixture.mutations().length, 1);
  });
}

test("retry after partial output remains observable even on a completed error step", async () => {
  const fixture = retryFixture();
  await fixture.start();
  fixture.messages([{ ...answer(), finish: "error", error: providerError, retry: { attempt: 2, at: 1, error: providerError } }, user("u")]);
  const inspected = await fixture.backend.inspect({ ...target, detail: "result" });
  assert.ok("result" in inspected);
  assert.equal(inspected.result.completedAtMs, 2);
  assert.equal(inspected.result.finish, "error");
  assert.deepEqual(inspected.result.retry, expectedRetry(2, 1));
  assert.equal(inspected.result.outcome, "unknown");
  assert.equal(inspected.result.terminal, false);
  assert.deepEqual((await fixture.backend.status()).workers[0].retry, expectedRetry(2, 1));
  await fixture.reconciler.reconcile();
  assert.equal(fixture.queued.length, 0);
  const waited = await fixture.backend.wait("s", "u");
  assert.ok("retry" in waited);
  assert.equal(waited.state, "active");
  assert.deepEqual(waited.retry, expectedRetry(2, 1));
  assert.equal(fixture.mutations().length, 1);
});

test("current retry never borrows metadata across a user/idle boundary or a newer assistant", async () => {
  const fixture = retryFixture();
  await fixture.start();
  const old = { ...assistant("old", ""), retry: { attempt: 2, at: 1, error: providerError } };
  for (const boundary of [user("new"), { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } }, assistant("new", "") ] as SessionMessageInfo[]) {
    fixture.messages([boundary, old, user("u")]);
    assert.equal((await fixture.backend.status()).workers[0].retry, null);
    const semantic = await fixture.backend.inspect(target);
    assert.ok("retry" in semantic);
    assert.equal(semantic.retry, null);
  }
  fixture.messages([user("new"), { ...old, id: "a" }, user("u")]);
  const selected = await fixture.backend.inspect({ ...target, detail: "result" });
  assert.ok("result" in selected);
  assert.deepEqual(selected.result.retry, expectedRetry(2, 1)); // Exact old target, never latest-session substitution.
});

test("unavailable retry reads retain active inventory with explicit sanitized evidence", async () => {
  const fixture = retryFixture();
  await fixture.start(); fixture.failMessageRead();
  const status = await fixture.backend.status();
  assert.equal(status.ready, true);
  assert.equal(status.workers[0].status, "inProgress");
  assert.equal(status.workers[0].retry, null);
  assert.ok(status.workers[0].retryReadError);
  assert.equal(status.workers[0].outcome, "unknown");
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
  await assert.rejects(fixture.backend.inspect(target));
  assert.equal(fixture.mutations().length, 1);
});

test("uncertain prompt admission retains canonical recovery identity and never replays", async () => {
  const fixture = retryFixture();
  fixture.failPrompt();
  await assert.rejects(fixture.start(), (error: any) => {
    assert.deepEqual(error.recovery, { sessionId: "s", stage: "promptAdmission", promptSubmitted: null });
    return true;
  });
  fixture.retry();
  await fixture.backend.status();
  await fixture.backend.inspect(target);
  await fixture.backend.wait("s", "u");
  assert.equal(fixture.mutations().length, 1);
});
