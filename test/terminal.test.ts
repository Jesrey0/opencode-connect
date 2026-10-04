import assert from "node:assert/strict";
import test from "node:test";
import { terminalSocket } from "../src/terminal.js";
import { HostBackend } from "../src/host.js";
import { nativeFixture, FakeSocket, binary, meta, session } from "./native-fixture.js";

function tokenFixture() { return nativeFixture(() => ({ location: { directory: "/tmp" }, data: { ticket: "PRIVATE-TICKET", expires_in: 10 } })); }

test("ordinary PTY replay has JS cursors, clipping preserves astral characters, detach keeps process semantics", async () => {
  const fixture = tokenFixture();
  const socket = new FakeSocket();
  const result = await terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 3, waitMs: 0 }, (url) => {
    assert.equal(url.searchParams.get("ticket"), "PRIVATE-TICKET");
    queueMicrotask(() => { socket.frame("A😀B"); socket.frame(meta(4)); });
    return socket.asWebSocket();
  });
  assert.equal(result.output, "A😀");
  assert.equal(result.cursor, 3);
  assert.equal(result.cursorUnit, "utf16CodeUnits");
  assert.equal(result.truncated, true);
  assert.equal(result.detached, true);
  assert.equal(socket.closed, true);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  const replayed = new FakeSocket();
  const resumed = await terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 3, limit: 3, waitMs: 0 }, () => {
    queueMicrotask(() => { replayed.frame("B"); replayed.frame(meta(4)); });
    return replayed.asWebSocket();
  });
  assert.equal(resumed.output, "B"); assert.equal(resumed.cursor, 4);
});

test("ordinary PTY reports lost head and exited PTYs cannot replay", async () => {
  const fixture = tokenFixture();
  const socket = new FakeSocket();
  const result = await terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 20, waitMs: 0 }, () => {
    queueMicrotask(() => { socket.frame("tail"); socket.frame(meta(104)); }); return socket.asWebSocket();
  });
  assert.equal(result.replay.availableOffset, 100); assert.equal(result.replay.truncated, true);
  const native = nativeFixture((r) => r.path === "/api/location" ? { directory: "/tmp" } : { location: { directory: "/tmp" }, data: { id: "pty", cwd: "/tmp", status: "exited", pid: 1, exitCode: 0 } });
  const exited = await new HostBackend(native.connect, () => { throw new Error("must not attach"); }).read({ kind: "pty", id: "pty", cwd: "/tmp" });
  assert.ok("replayAvailable" in exited);
  assert.equal(exited.replayAvailable, false); assert.equal(exited.drained, false); assert.equal(exited.exitCode, 0);
});

test("persistent replay keeps byte offsets and exact split UTF-8 bytes via base64", async () => {
  const fixture = tokenFixture();
  const bytes = Buffer.from("é😀Z");
  const socket = new FakeSocket();
  const result = await terminalSocket(fixture.connection, { kind: "persistentPty", cwd: "/tmp", id: "pty", cursor: 0, limit: 1, waitMs: 0 }, (url) => {
    assert.equal(url.searchParams.get("role"), "observer");
    queueMicrotask(() => {
      socket.frame(JSON.stringify({ type: "attached", replay: { requestedOffset: 0, availableOffset: 10, endOffset: 17, truncated: true } }));
      socket.frame(binary(bytes));
      socket.frame(JSON.stringify({ type: "replay_complete", endOffset: 17 }));
    }); return socket.asWebSocket();
  });
  assert.equal(result.output, null); assert.equal(result.encoding, "base64");
  assert.equal(result.data, bytes.subarray(0,1).toString("base64"));
  assert.equal(result.cursor, 11); assert.equal(result.cursorUnit, "bytes"); assert.equal(result.replay.truncated, true);
  const resumed = new FakeSocket();
  const next = await terminalSocket(fixture.connection, { kind: "persistentPty", cwd: "/tmp", id: "pty", cursor: 11, limit: 20, waitMs: 0 }, () => {
    queueMicrotask(() => {
      resumed.frame(JSON.stringify({ type: "attached", replay: { requestedOffset: 11, availableOffset: 10, endOffset: 17, truncated: false } }));
      resumed.frame(binary(bytes.subarray(1)));
      resumed.frame(JSON.stringify({ type: "replay_complete", endOffset: 17 }));
    }); return resumed.asWebSocket();
  });
  assert.deepEqual(Buffer.concat([Buffer.from(result.data!,"base64"), Buffer.from(next.data!,"base64")]), bytes);
  assert.equal(next.cursor, 17);
});

test("terminal input and Ctrl-D are unacknowledged sends; close/error before replay fails visibly", async () => {
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/location") return { directory: "/tmp" };
    if (r.path.endsWith("connect-token")) return { location: { directory: "/tmp" }, data: { ticket: "PRIVATE", expires_in: 10 } };
    return { location: { directory: "/tmp" }, data: { id: "pty", cwd: "/tmp", status: "running", pid: 1 } };
  });
  const socket = new FakeSocket();
  const host = new HostBackend(fixture.connect, () => { queueMicrotask(() => socket.frame(meta(0))); return socket.asWebSocket(); });
  const result = await host.control({ kind: "pty", cwd: "/tmp", id: "pty", action: "ctrlD" });
  assert.deepEqual(socket.sent, ["\u0004"]); assert.equal(result.acknowledged, false); assert.equal(result.inputSent, true);
  const detached = new FakeSocket();
  await assert.rejects(terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 5, waitMs: 0 }, () => {
    queueMicrotask(() => detached.end()); return detached.asWebSocket();
  }), /before replay/);
  const failed = new FakeSocket();
  await assert.rejects(terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 5, waitMs: 0 }, () => {
    queueMicrotask(() => failed.fail()); return failed.asWebSocket();
  }), /socket failed/);
});

test("persistent handle rejects wrong location before transport; resize/remove preserve native identity", async () => {
  let removed = false;
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/location") return { directory: r.query.get("location[directory]") };
    if (r.path === "/api/session/s") return { data: session() };
    if (r.method === "DELETE") { removed = true; return; }
    return { data: { id: "pty", cwd: "/tmp", sessionID: "s", status: "running", pid: 1, output: { head: 0, tail: 0 }, size: { rows: 24, cols: 80 } } };
  });
  const host = new HostBackend(fixture.connect);
  await assert.rejects(host.read({ kind: "persistentPty", cwd: "/other", id: "pty" }), /location/);
  await host.control({ kind: "persistentPty", cwd: "/tmp", id: "pty", action: "resize", rows: 30, cols: 90 });
  assert.deepEqual(fixture.requests.find((r) => r.method === "PUT")?.body.size, { rows: 30, cols: 90 });
  await host.control({ kind: "persistentPty", cwd: "/tmp", id: "pty", action: "remove" });
  assert.equal(removed, true);
});

test("persistent input refuses observer downgrade and ordinary too-small Unicode pages fail instead of stalling", async () => {
  const fixture = tokenFixture();
  const observer = new FakeSocket();
  await assert.rejects(terminalSocket(fixture.connection, { kind: "persistentPty", cwd: "/tmp", id: "pty", cursor: 0, limit: 1, waitMs: 0, input: "x" }, () => {
    queueMicrotask(() => observer.frame(JSON.stringify({ type: "attached", role: "observer", replay: { requestedOffset: 0, availableOffset: 0, endOffset: 0, truncated: false } })));
    return observer.asWebSocket();
  }), /controller unavailable/);
  assert.equal(observer.sent.length, 0);
  const small = new FakeSocket();
  await assert.rejects(terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 1, waitMs: 0 }, () => {
    queueMicrotask(() => small.frame("😀")); return small.asWebSocket();
  }), /cannot contain/);
});

test("clipped ordinary replay returns before live output can skip its unread Unicode tail; control can discard replay", async () => {
  const fixture = tokenFixture();
  const socket = new FakeSocket();
  const read = await terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 2, waitMs: 100 }, () => {
    queueMicrotask(() => { socket.frame("A😀B"); socket.frame(meta(4)); socket.frame("X"); }); return socket.asWebSocket();
  });
  assert.equal(read.output,"A"); assert.equal(read.cursor,1); assert.equal(read.truncated,true);
  const control = new FakeSocket();
  const sent = await terminalSocket(fixture.connection, {kind:"pty",cwd:"/tmp",id:"pty",cursor:0,limit:1,waitMs:0,input:"\u0003"}, ()=>{
    queueMicrotask(()=>{control.frame("😀");control.frame(meta(2));});return control.asWebSocket();
  });
  assert.equal(sent.inputSent,true);assert.deepEqual(control.sent,["\u0003"]);
});

test("multiple ordinary replay frames preserve a contiguous prefix after surrogate-safe clipping", async () => {
  const fixture = tokenFixture();
  const prefix = "A".repeat(11999);
  const tail = "😀" + "B".repeat(65536 - 12001) + "Z";
  const socket = new FakeSocket();
  const first = await terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: 0, limit: 12000, waitMs: 0 }, () => {
    queueMicrotask(() => { socket.frame(prefix + tail.slice(0, -1)); socket.frame("Z"); socket.frame(meta(65537)); });
    return socket.asWebSocket();
  });
  assert.equal(first.output, prefix); assert.equal(first.cursor, prefix.length); assert.equal(first.truncated, true);
  const resumed = new FakeSocket();
  const second = await terminalSocket(fixture.connection, { kind: "pty", cwd: "/tmp", id: "pty", cursor: first.cursor, limit: 65536, waitMs: 0 }, () => {
    queueMicrotask(() => { resumed.frame(tail); resumed.frame(meta(65537)); }); return resumed.asWebSocket();
  });
  assert.equal(first.output + second.output, prefix + tail); assert.equal(second.cursor, 65537);
});

test("persistent byte replay preserves BOM bytes at a continuation boundary", async () => {
  const fixture = tokenFixture();
  const bytes = Buffer.from("\uFEFFA");
  const socket = new FakeSocket();
  const result = await terminalSocket(fixture.connection, { kind: "persistentPty", cwd: "/tmp", id: "pty", cursor: 2, limit: 20, waitMs: 0 }, () => {
    queueMicrotask(() => {
      socket.frame(JSON.stringify({ type: "attached", replay: { requestedOffset: 2, availableOffset: 0, endOffset: 6, truncated: false } }));
      socket.frame(binary(bytes)); socket.frame(JSON.stringify({ type: "replay_complete", endOffset: 6 }));
    }); return socket.asWebSocket();
  });
  assert.equal(result.encoding, "utf8"); assert.deepEqual(Buffer.from(result.output!, "utf8"), bytes); assert.equal(result.cursor, 6);
});
