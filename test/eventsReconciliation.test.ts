import test from "node:test";
import assert from "node:assert/strict";
import type { OpenCodeBackend } from "../src/opencode.js";
import { EventReconciler } from "../src/eventsReconciliation.js";

const target = { sessionId: "s1", messageId: "u1" };
function harness(inspect: (input: Parameters<OpenCodeBackend["inspect"]>[0]) => Promise<unknown>, targets: { sessionId: string; messageId: string }[]) {
  const reads: unknown[] = []; const queued: unknown[][] = []; const failures: unknown[][] = [];
  const reconciler = new EventReconciler({ inspect: async (input: Parameters<OpenCodeBackend["inspect"]>[0]) => {
    reads.push(input);
    return inspect(input);
  } } as never, { targets: () => targets, observe: async (...args: unknown[]) => { queued.push(args); }, lifecycle: { record: (stage: string, fields: object = {}) => { failures.push([stage, fields]); } } } as never);
  return { reconciler, reads, queued, failures };
}
test("terminal reconciliation carries native selection across bounded passes before queueing exact completion", async () => {
  const { reconciler, reads, queued } = harness(async (input) => {
    const page = Number(input.selectionCursor ?? 0);
    return { session: { executionOutcome: "succeeded" }, result: {
      terminal: true, selectionComplete: page === 5, outcome: "completed", completedAtMs: 1234,
      nextCall: page === 5 ? null : { tool: "opencode.inspect", arguments: { ...target, detail: "result", selectionCursor: String(page + 1), selectionFingerprint: "native-fingerprint", candidateAssistantMessageId: "assistant" } },
    } };
  }, [target]);
  await reconciler.reconcile();
  assert.equal(reads.length, 4); assert.equal(queued.length, 0);
  await reconciler.reconcile();
  assert.equal((reads[4] as { selectionCursor: string }).selectionCursor, "4");
  assert.equal((reads[4] as { selectionFingerprint: string }).selectionFingerprint, "native-fingerprint");
  assert.equal((reads[4] as { candidateAssistantMessageId: string }).candidateAssistantMessageId, "assistant");
  assert.deepEqual(queued, [["s1", "u1", "completed", new Date(1234).toISOString()]]);
});

test("reconciliation refuses active or cross-prompt continuations and clears watches removed from inventory", async () => {
  let active = false; let different = true; let watched = true;
  const reads: unknown[] = []; const queued: unknown[][] = [];
  const dynamic = new EventReconciler({ inspect: async (input: Parameters<OpenCodeBackend["inspect"]>[0]) => {
    reads.push(input);
    return { result: { terminal: !active, selectionComplete: false, nextCall: {
      tool: "opencode.inspect", arguments: { ...target, messageId: different ? "other" : "u1", detail: "result", selectionCursor: "next", selectionFingerprint: "fingerprint" },
    } } };
  } } as never, { targets: () => watched ? [target] : [], observe: async (...args: unknown[]) => { queued.push(args); }, lifecycle: { record: () => {} } } as never);
  await dynamic.reconcile(); assert.equal(reads.length, 1);
  different = false; active = true;
  await dynamic.reconcile(); assert.equal(reads.length, 2);
  active = false; await dynamic.reconcile(); assert.equal(reads.length, 6);
  watched = false; await dynamic.reconcile();
  watched = true; await dynamic.reconcile();
  assert.equal((reads[6] as { selectionCursor?: string }).selectionCursor, undefined);
  assert.equal(queued.length, 0);
});

test("a stale continuation fails closed, records sanitized evidence, and restarts selection next pass", async () => {
  let stale = false;
  const { reconciler, reads, queued, failures } = harness(async (input) => {
    if (stale && input.selectionCursor !== undefined) throw new Error("content changed; restart pagination");
    const page = Number(input.selectionCursor ?? -1) + 1;
    if (page >= 4) {
      return { session: { executionOutcome: "succeeded" }, result: { terminal: true, selectionComplete: true, outcome: "completed", completedAtMs: 7, nextCall: null } };
    }
    return { session: { executionOutcome: "succeeded" }, result: {
      terminal: true, selectionComplete: false, outcome: "unknown",
      nextCall: { tool: "opencode.inspect", arguments: { ...target, detail: "result", selectionCursor: String(page), selectionFingerprint: "fp", candidateAssistantMessageId: "a" } },
    } };
  }, [target]);
  await reconciler.reconcile();
  assert.equal(reads.length, 4); assert.equal(queued.length, 0);
  stale = true;
  await reconciler.reconcile();
  assert.equal(reads.length, 5);
  assert.equal(queued.length, 0);
  assert.deepEqual(failures, [["reconciliationFailed", { sessionId: "s1", messageId: "u1", reason: "internal" }]]);
  assert.equal(JSON.stringify(failures).includes("content changed"), false);
  stale = false;
  await reconciler.reconcile();
  assert.equal((reads[5] as { selectionCursor?: string }).selectionCursor, undefined);
  await reconciler.reconcile();
  assert.deepEqual(queued, [["s1", "u1", "completed", new Date(7).toISOString()]]);
});

test("an inspect failure never escapes reconcile and never blocks other targets", async () => {
  const other = { sessionId: "s2", messageId: "u2" };
  const { reconciler, reads, queued, failures } = harness(async (input) => {
    if (input.sessionId === "s1") throw new Error("native operation failed (status 500); details omitted; reconcile persisted state before retrying a mutation");
    return { session: { executionOutcome: "succeeded" }, result: { terminal: true, selectionComplete: true, outcome: "completed", completedAtMs: 9, nextCall: null } };
  }, [target, other]);
  await reconciler.reconcile();
  assert.deepEqual(queued, [["s2", "u2", "completed", new Date(9).toISOString()]]);
  assert.deepEqual(failures, [["reconciliationFailed", { sessionId: "s1", messageId: "u1", reason: "internal" }]]);
  assert.equal(JSON.stringify({ reads, failures }).includes("status 500"), false);
  await reconciler.reconcile();
  assert.equal((reads.at(-2) as { sessionId: string }).sessionId, "s1");
  assert.equal((reads.at(-2) as { selectionCursor?: string }).selectionCursor, undefined);
  assert.equal(queued.length, 2);
});
