import assert from "node:assert/strict";
import test from "node:test";
import type { V2Event } from "@opencode/client";
import { OpenCodeBackend } from "../src/opencode.js";
import { nativeFixture, session, user, assistant } from "./native-fixture.js";

function waitFixture(timeoutMs = 500) {
  let active = true;
  let pending = false;
  const state = session();
  let inspections = 0;
  let permissionReads = 0;
  const checkpoints: { target: number; resolve: () => void }[] = [];
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/session/s") { inspections++; return { data: state }; }
    if (r.path === "/api/session/active") return { data: active ? { s: {} } : {} };
    if (r.path.endsWith("/message/u")) return { data: user("u") };
    if (r.path.endsWith("/message")) return { data: [assistant("a", "finished"), user("u")], cursor: {} };
    if (r.path.endsWith("/form")) return { data: [] };
    if (r.path.endsWith("/permission")) {
      permissionReads++;
      for (const checkpoint of checkpoints) if (permissionReads >= checkpoint.target) checkpoint.resolve();
      return { data: pending ? [{ id: "request", sessionID: "s", action: "edit", resources: ["a"] }] : [] };
    }
    throw new Error(`unexpected ${r.path}`);
  });
  const events: V2Event[] = [];
  let wake: (() => void) | undefined;
  const client = { ...fixture.client, event: { subscribe: ({ signal }: {signal?:AbortSignal} = {}) => ({
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
  return {
    backend: new OpenCodeBackend(async () => ({ ...fixture.connection, client }), timeoutMs),
    emit: (type: string, sessionID = "s") => { events.push({ type, data: { sessionID } } as V2Event); wake?.(); },
    complete: () => { active = false; },
    requireAction: () => { pending = true; },
    inspections: () => inspections,
    checkpoint: (target: number) => permissionReads >= target ? Promise.resolve() : new Promise<void>((resolve) => checkpoints.push({target, resolve})),
  };
}

test("stale terminal and unrelated hints never override canonical active state; later canonical completion wins", async () => {
  const fixture = waitFixture();
  const wait = fixture.backend.wait("s", "u");
  await fixture.checkpoint(2); // Initial and post-subscription reconciliation were active.
  fixture.emit("session.execution.succeeded");
  fixture.emit("session.idle", "unrelated");
  await fixture.checkpoint(3); // Stale terminal hint was rechecked against active state.
  fixture.complete(); fixture.emit("session.idle");
  const result = await wait;
  assert.equal(result.state, "terminal"); assert.equal(result.wakeReason, "terminal");
  assert.equal(result.session.status, "completed"); assert.ok(fixture.inspections() >= 4);
});

test("timeout reconciles persisted completion when terminal event was missed", async () => {
  const fixture = waitFixture(100);
  const wait = fixture.backend.wait("s", "u");
  await fixture.checkpoint(2);
  fixture.complete(); // No stream event is delivered after the canonical active recheck.
  const result = await wait;
  assert.equal(result.state, "terminal"); assert.equal(result.wakeReason, "terminal"); assert.equal(result.session.status, "completed");
});

test("stale permission hint keeps waiting; real pending action is selected from canonical state", async () => {
  const fixture = waitFixture();
  const wait = fixture.backend.wait("s", "u");
  await fixture.checkpoint(2);
  fixture.emit("permission.asked");
  await fixture.checkpoint(3);
  fixture.requireAction(); fixture.emit("permission.asked");
  const result = await wait;
  assert.equal(result.state, "active"); assert.equal(result.wakeReason, "actionRequired");
  assert.ok("pendingActions" in result); assert.equal(result.pendingActions.length, 1);
});

test("active session at timeout remains active, without invented terminal state", async () => {
  const result = await waitFixture(100).backend.wait("s", "u");
  assert.equal(result.state, "active"); assert.equal(result.wakeReason, "timeout"); assert.equal(result.session.status, "inProgress");
});
