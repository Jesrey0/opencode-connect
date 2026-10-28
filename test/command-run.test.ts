import assert from "node:assert/strict";
import test from "node:test";
import type { ShellInfo1 } from "@opencode/client";
import { CommandAdmissionError, HostBackend } from "../src/host.js";
import { nativeFixture, type NativeRequest } from "./native-fixture.js";

function commandFixture(hook?: (request: NativeRequest) => unknown | Promise<unknown>) {
  const state = { status: "exited" as ShellInfo1["status"], exit: 0, bytes: Buffer.from("hello\n") };
  const location = { directory: "/canonical" };
  const fixture = nativeFixture(async (request) => {
    const override = await hook?.(request);
    if (override !== undefined) return override;
    if (request.path === "/api/location") return { ...location, project: { id: "p", canonical: location.directory } };
    if (request.path.endsWith("/output")) {
      const start = Number(request.query.get("cursor"));
      const end = Math.min(state.bytes.length, start + Number(request.query.get("limit")));
      return { location, data: { output: state.bytes.subarray(start, end).toString("utf8"), cursor: end, size: state.bytes.length, truncated: end < state.bytes.length } };
    }
    return { location, data: {
      id: "native-shell", cwd: location.directory, status: state.status, pid: 123,
      exit: state.status === "running" ? undefined : state.exit,
      signal: state.status === "timeout" ? "SIGTERM" : undefined,
      time: { started: 1, ...(state.status === "running" ? {} : { completed: 2 }) },
      command: "private command", shell: "bash", file: "/private/output", metadata: { token: "SECRET" },
    } };
  });
  const host = new HostBackend(fixture.connect);
  return { ...fixture, host, state };
}

const input = { cwd: "/alias", command: "printf hello" };
const isGet = (request: NativeRequest) => request.method === "GET" && request.path.includes("/shell/") && !request.path.endsWith("/output");
function assertSingleStart(requests: NativeRequest[]) {
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(requests.some((r) => r.method === "DELETE" || r.method === "PATCH"), false);
}

test("run composes one native admission with fast terminal readback and safe metadata", async () => {
  const f = commandFixture();
  const result = await f.host.run(input);
  assert.equal(result.kind, "shell");
  assert.equal(result.cwd, "/canonical");
  assert.equal(result.id, "native-shell");
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.pid, 123);
  assert.deepEqual(result.time, { started: 1, completed: 2 });
  assert.equal(result.output, "hello\n");
  assert.equal(result.cursor, 6);
  assert.equal(result.size, 6);
  assert.equal(result.drained, true);
  assert.equal(result.observation.reason, "terminal");
  assert.equal(result.metadataVerified, true);
  assert.equal(result.nextCall, null);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  const create = f.requests.find((r) => r.method === "POST")!;
  assert.deepEqual(create.body, { command: input.command, cwd: "/canonical", timeout: 120000 });
  const output = f.requests.find((r) => r.path.endsWith("/output"))!;
  assert.equal(output.query.get("limit"), "12000");
  assert.ok(output.signal);
  assertSingleStart(f.requests);
});

test("nonzero exit and native process timeout remain distinct from observation timeout", async () => {
  for (const status of ["exited", "timeout", "killed"] as const) {
    const f = commandFixture();
    f.state.status = status;
    f.state.exit = 7;
    const result = await f.host.run({ ...input, timeoutMs: 23, waitMs: 1000 });
    assert.equal(result.status, status);
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, status === "timeout" ? "SIGTERM" : null);
    assert.equal(result.observation.reason, "terminal");
    assert.equal(result.drained, true);
    assert.equal(f.requests.find((r) => r.method === "POST")!.body.timeout, 23);
    assertSingleStart(f.requests);
  }
});

test("running shell returns read-only continuation when the observation budget expires", async () => {
  const f = commandFixture();
  f.state.status = "running";
  const result = await f.host.run({ ...input, waitMs: 30, timeoutMs: 5000 });
  assert.equal(result.status, "running");
  assert.equal(result.exitCode, null);
  assert.equal(result.observation.reason, "waitTimeout");
  assert.equal(result.output, "hello\n");
  assert.equal(result.drained, false);
  assert.deepEqual(result.nextCall, { tool: "command.read", arguments: { cwd: "/canonical", id: "native-shell", cursor: 6, limit: 12000 } });
  f.state.status = "exited";
  f.state.bytes = Buffer.from("hello\nfinished");
  const resumed = await f.host.read({ ...result.nextCall!.arguments, kind: "shell" });
  assert.equal(resumed.output, "finished");
  assert.equal(resumed.drained, true);
  assertSingleStart(f.requests);
});

test("terminal output paging preserves unread bytes and canonical continuation", async () => {
  const f = commandFixture();
  f.state.bytes = Buffer.from("abcdefgh");
  const first = await f.host.run({ ...input, limit: 3 });
  assert.equal(first.output, "abc");
  assert.equal(first.cursor, 3);
  assert.equal(first.size, 8);
  assert.equal(first.drained, false);
  assert.equal(first.nextCall?.tool, "command.read");
  const second = await f.host.read({ ...first.nextCall!.arguments, kind: "shell" });
  const third = await f.host.read({ ...first.nextCall!.arguments, kind: "shell", cursor: second.cursor as number });
  assert.equal(first.output + second.output + third.output, "abcdefgh");
  assert.equal(third.drained, true);
  assertSingleStart(f.requests);
});

test("byte limit is native source bytes and exposes independent UTF-8 page decoding", async () => {
  const f = commandFixture();
  f.state.bytes = Buffer.from("éZ");
  const first = await f.host.run({ ...input, limit: 1 });
  assert.equal(first.output, "�");
  assert.equal(first.cursor, 1);
  assert.equal(first.size, 3);
  assert.equal(first.encoding, "nativeUtf8");
  assert.equal(first.cursorUnit, "bytes");
  assert.match(first.decodingLimit, /split multibyte/);
  assert.equal(first.nextCall?.arguments.cursor, 1);
});

test("zero budget admits once, retains admission metadata, and performs no observation IO", async () => {
  const f = commandFixture();
  const result = await f.host.run({ ...input, waitMs: 0 });
  assert.equal(result.id, "native-shell");
  assert.equal(result.metadataSource, "admission");
  assert.equal(result.metadataVerified, false);
  assert.equal(result.size, null);
  assert.equal(result.truncated, null);
  assert.equal(result.cursor, 0);
  assert.equal(result.drained, false);
  assert.equal(result.observation.reason, "waitTimeout");
  assert.equal(result.nextCall?.arguments.cursor, 0);
  assert.equal(f.requests.length, 2);
  assertSingleStart(f.requests);
});

test("running output stops at the total byte budget without reading ahead", async () => {
  let outputs = 0;
  const f = commandFixture((request) => {
    if (request.path.endsWith("/output") && ++outputs === 2) f.state.bytes = Buffer.from("abcdefgh");
  });
  f.state.status = "running";
  f.state.bytes = Buffer.from("ab");
  const result = await f.host.run({ ...input, limit: 5, waitMs: 1000 });
  assert.equal(result.output, "abcde");
  assert.equal(result.cursor, 5);
  assert.equal(result.size, 8);
  assert.equal(result.observation.reason, "outputLimit");
  assert.equal(result.drained, false);
  assert.equal(result.nextCall?.arguments.cursor, 5);
  assert.deepEqual(f.requests.filter((r) => r.path.endsWith("/output")).map((r) => [r.query.get("cursor"), r.query.get("limit")]), [["0", "5"], ["2", "3"]]);
  assertSingleStart(f.requests);
});

test("cancellation before admission never starts a command", async () => {
  const f = commandFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.host.run(input, controller.signal), { name: "AbortError" });
  assert.equal(f.requests.length, 0);
  const duringLocation = new AbortController();
  const g = commandFixture((r) => { if (r.path === "/api/location") duringLocation.abort(); });
  await assert.rejects(g.host.run(input, duringLocation.signal));
  assert.equal(g.requests.some((r) => r.method === "POST"), false);
});

test("cancellation after admission stops observation, retains the handle, and never kills or restarts", async () => {
  const controller = new AbortController();
  let nativeSignal: AbortSignal | undefined;
  const f = commandFixture((request) => {
    if (isGet(request)) {
      nativeSignal = request.signal;
      controller.abort();
      return new Promise(() => {});
    }
  });
  f.state.status = "running";
  const result = await f.host.run(input, controller.signal);
  assert.equal(result.observation.reason, "cancelled");
  assert.equal(result.id, "native-shell");
  assert.equal(result.status, "running");
  assert.equal(result.drained, false);
  assert.equal(result.metadataSource, "admission");
  assert.equal(result.nextCall?.tool, "command.read");
  assert.equal(nativeSignal?.aborted, true);
  assertSingleStart(f.requests);
});

test("failed or cancelled admission is explicitly ambiguous, without an invented ID or retry", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const f = commandFixture((r) => {
      if (r.method === "POST") {
        if (cancel) controller.abort();
        throw new Error("private transport details");
      }
    });
    await assert.rejects(f.host.run(input, controller.signal), (error: unknown) => {
      assert.ok(error instanceof CommandAdmissionError);
      assert.equal(error.mutationMayHaveOccurred, true);
      assert.equal(error.admission, "mayHaveOccurred");
      assert.equal(error.cwd, "/canonical");
      assert.equal("id" in error, false);
      assert.equal(error.message.includes("private"), false);
      return true;
    });
    assertSingleStart(f.requests);
  }
});

for (const stage of ["get", "output"] as const) {
  test(`${stage} observation failure preserves known metadata and a read-only continuation`, async () => {
    const f = commandFixture((r) => {
      if (stage === "get" ? isGet(r) : r.path.endsWith("/output")) throw new Error("private transport details");
    });
    const result = await f.host.run(input);
    assert.equal(result.id, "native-shell");
    assert.equal(result.observation.reason, "observationError");
    assert.equal(result.observation.stage, stage);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(result.metadataSource, stage === "get" ? "admission" : "get");
    assert.equal(result.metadataVerified, stage === "output");
    assert.equal(result.size, null);
    assert.equal(result.drained, false);
    assert.equal(result.nextCall?.arguments.cursor, 0);
    assertSingleStart(f.requests);
  });

  test(`stalled ${stage} IO is cancelled within the observation budget`, { timeout: 2000 }, async () => {
    let nativeSignal: AbortSignal | undefined;
    const f = commandFixture((r) => {
      if (stage === "get" ? isGet(r) : r.path.endsWith("/output")) {
        nativeSignal = r.signal;
        return new Promise(() => {}); // Deliberately does not settle on abort.
      }
    });
    f.state.status = "running";
    const started = performance.now();
    const result = await f.host.run({ ...input, waitMs: 30 });
    assert.ok(performance.now() - started < 1000);
    assert.equal(nativeSignal?.aborted, true);
    assert.equal(result.observation.reason, "waitTimeout");
    assert.equal(result.observation.stage, stage);
    assert.equal(result.status, "running");
    assert.equal(result.drained, false);
    assert.equal(result.nextCall?.tool, "command.read");
    assertSingleStart(f.requests);
  });
}

test("a later terminal status cannot drain a stale running output snapshot", async () => {
  let outputs = 0;
  const f = commandFixture((r) => {
    if (isGet(r) && outputs > 0) f.state.status = "exited";
    if (r.path.endsWith("/output") && ++outputs === 2) throw new Error("output unavailable");
  });
  f.state.status = "running";
  const result = await f.host.run({ ...input, waitMs: 1000 });
  assert.equal(result.status, "exited");
  assert.equal(result.output, "hello\n");
  assert.equal(result.cursor, result.size);
  assert.equal(result.observation.reason, "observationError");
  assert.equal(result.drained, false);
  assert.equal(result.nextCall?.arguments.cursor, 6);
  assertSingleStart(f.requests);
});

test("input bounds are enforced before admission", async () => {
  for (const invalid of [{ timeoutMs: 0 }, { timeoutMs: 86400001 }, { waitMs: -1 }, { waitMs: 20001 }, { waitMs: 0.5 }, { limit: 0 }, { limit: 65537 }]) {
    const f = commandFixture();
    await assert.rejects(f.host.run({ ...input, ...invalid }), /must be an integer/);
    assert.equal(f.requests.length, 0);
  }
  const f = commandFixture();
  const result = await f.host.run({ ...input, timeoutMs: 86400000, waitMs: 20000, limit: 65536 });
  assert.equal(result.drained, true);
  assertSingleStart(f.requests);
});

test("a lost admission transport that ignores abort still returns bounded uncertainty without replay", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const f = commandFixture(r => { if (r.method === "POST") { setTimeout(() => controller.abort(), 10); return new Promise(() => {}); } });
  await assert.rejects(f.host.run(input, controller.signal), (error: unknown) => error instanceof CommandAdmissionError && error.mutationMayHaveOccurred && !("id" in error));
  assertSingleStart(f.requests);
});
