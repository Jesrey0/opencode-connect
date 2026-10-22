import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeBackend, type QueryInput } from "../src/opencode.js";
import { nativeFixture, session } from "./native-fixture.js";

const queries: QueryInput[] = [
  { type: "models" },
  { type: "sessionDiff", sessionId: "s", from: "u" },
  { type: "runtime", cwd: "/tmp" },
  { runtime: "codex", type: "runtime", cwd: "/tmp" },
  { runtime: "codex", type: "session", sessionId: "s" },
  { runtime: "codex", type: "permissions", section: "pending", sessionId: "s" },
];
for (const query of queries) {
  test(`${query.runtime ?? "opencode"} ${query.type} cancellation aborts in-flight reads and stops the batch`, { timeout: 5_000 }, async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled the read");
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const cleanup: Array<() => void> = [];
    const native = nativeFixture(request => {
      // Exercise a follow-up read, not just signal forwarding to the first call.
      if (query.type === "sessionDiff" && request.path === "/api/session/s") return { data: session() };
      started();
      return new Promise((_resolve, reject) => {
        cleanup.push(() => reject(reason));
        request.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
      });
    });
    const pending = new OpenCodeBackend(native.connect).query([query, { type: "usage" }], controller.signal);
    void pending.catch(() => {});
    try {
      await ready;
      controller.abort(reason);
      const requests = native.requests.slice();
      assert.ok(requests.length > 0);
      for (const request of requests) assert.equal(request.signal?.aborted, true, request.path);
      await assert.rejects(pending, error => error === reason);
      assert.equal(native.requests.length, requests.length, "no later query is dispatched");
      assert.equal(native.requests.every(request => request.method === "GET" || request.path.startsWith("/api/rpc/")), true);
      assert.equal(native.requests.some(request => /interrupt|prompt|permission.*reply/.test(request.path)), false);
    } finally {
      controller.abort(reason);
      cleanup.forEach(release => release());
      await pending.catch(() => {});
    }
  });
}

test("a pre-cancelled batch never connects or dispatches reads", async () => {
  const controller = new AbortController();
  controller.abort();
  const backend = new OpenCodeBackend(async () => { assert.fail("cancelled request must not connect"); });
  await assert.rejects(backend.query([{ type: "usage" }], controller.signal), { name: "AbortError" });
});
