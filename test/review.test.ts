import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBackend } from "../src/host.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { fingerprint, AdmissionError } from "../src/bounds.js";
import { outputSchemas } from "../src/results.js";
import { nativeFixture, session, assistant, FakeSocket, binary, meta } from "./native-fixture.js";
import type { SessionInboxInfo, SessionMessageInfo, SessionMessageAssistantTool } from "@opencode/client";

test("PTY exit/removal and daemon-loss races preserve captured replay and last confirmed metadata", async () => {
  for (const kind of ["pty", "persistentPty"] as const) for (const failure of ["PtyNotFoundError", "ServiceUnavailableError"] as const) {
    let reads = 0;
    const info = { id: "pty", cwd: "/tmp", status: "running", pid: 1, sessionID: "s", size: { rows: 24, cols: 80 }, output: { head: 10, tail: 20 } };
    const fixture = nativeFixture((r) => {
      if (r.path === "/api/location") return { directory: "/tmp" };
      if (r.path === "/api/session/s") return { data: session() };
      if (r.path.endsWith("connect-token")) return { location: { directory: "/tmp" }, data: { ticket: "PRIVATE", expires_in: 10 } };
      if (++reads > 1) return Response.json({ _tag: failure, message: "PRIVATE provider/env error" }, { status: failure === "PtyNotFoundError" ? 404 : 503 });
      return { location: { directory: "/tmp" }, data: info };
    });
    const socket = new FakeSocket();
    const host = new HostBackend(fixture.connect, () => {
      queueMicrotask(() => {
        if (kind === "pty") { socket.frame("é😀"); socket.frame(meta(13)); }
        else {
          socket.frame(JSON.stringify({ type: "attached", replay: { requestedOffset: 0, availableOffset: 10, endOffset: 16, truncated: true } }));
          socket.frame(binary(Buffer.from("é😀")));
          socket.frame(JSON.stringify({ type: "replay_complete" }));
        }
        socket.end();
      });
      return socket.asWebSocket();
    });
    const result = await host.read({ kind, cwd: "/tmp", id: "pty", waitMs: 0 });
    outputSchemas.commandRead.parse(result);
    assert.equal(result.output, "é😀"); assert.equal(result.status, "running"); assert.equal(result.drained, false);
    assert.ok("metadataVerified" in result); assert.equal(result.metadataVerified, false);
    assert.equal(result.handleAvailable, failure === "PtyNotFoundError" ? false : null);
    assert.equal(result.cursor, kind === "pty" ? 13 : 16);
    assert.equal(result.replayComplete, true); assert.equal(result.detached, true);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    if (kind === "persistentPty") assert.deepEqual(result.lastConfirmedInfo.output, { head: 10, tail: 20 });
  }
});

test("native terminal screen and snapshot are bounded rendered views, not byte replay", async () => {
  const info = { id: "pty", cwd: "/tmp", status: "running", pid: 1, sessionID: "s", size: { rows: 24, cols: 80 }, output: { head: 0, tail: 999 } };
  const text = "\uFEFF😀界".repeat(5000);
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/location") return { directory: r.query.get("location[directory]") };
    if (r.path === "/api/session/s") return { data: session() };
    if (r.path.endsWith("/terminal/read")) return { data: { ptyID: "pty", screen: { text, rows: 24, cols: 80, cursor: { x: 2, y: 3 } } } };
    if (r.path.endsWith("/snapshot")) return { data: { info, text, cursor: { x: 2, y: 3 }, checkpoint: "PRIVATE" } };
    return { data: info };
  });
  const host = new HostBackend(fixture.connect);
  for (const type of ["terminalScreen", "terminalSnapshot"] as const) {
    const first = await host.inspect({ type, cwd: "/tmp", sessionId: "s", id: "pty" });
    outputSchemas.hostInspect.parse(first);
    assert.ok("textPaging" in first);
    const next = await host.inspect({ type, cwd: "/tmp", sessionId: "s", id: "pty", textOffset: first.textPaging.nextOffset!, textFingerprint: first.textPaging.fingerprint });
    assert.equal(first.text + next.text, text); assert.equal("replay" in first, false);
    assert.equal(JSON.stringify(first).includes("PRIVATE"), false);
    await assert.rejects(host.inspect({ type, cwd: "/other", sessionId: "s", id: "pty" }), /location/);
  }
  await assert.rejects(host.inspect({ type: "terminalScreen", cwd: "/tmp", sessionId: "s", lines: 1001 }), /integer/);
});

test("native write: UTF-8/BOM/base64 readback, explicit updates, changed fingerprints and new-file symlink containment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-review-write-"));
  const outside = await mkdtemp(join(tmpdir(), "opencode-review-outside-"));
  try {
    await symlink(outside, `${cwd}/escape`); await symlink(`${outside}/missing`, `${cwd}/dangling`);
    const fixture = nativeFixture(async (r) => {
      if (r.path === "/api/location") return { directory: cwd };
      if (r.path.startsWith("/api/fs/read/")) return new Response(await readFile(decodeURIComponent(r.path.slice("/api/fs/read/".length))));
      if (r.path === "/api/experimental/fs/write") {
        assert.ok(r.bytes); await writeFile(r.query.get("path")!, r.bytes);
        return { location: { directory: cwd }, data: { path: r.query.get("path") } };
      }
      throw new Error("unexpected native write contract");
    });
    const host = new HostBackend(fixture.connect);
    const data = "\uFEFFAé😀界\uFEFF";
    const created = await host.write({ cwd, path: "new", encoding: "utf8", data, overwrite: false });
    assert.equal(created.created, true); assert.equal(created.atomicCAS, false);
    assert.deepEqual(await readFile(`${cwd}/new`), Buffer.from(data));
    const handle = { cwd, path: "new", encoding: "base64" as const, data: Buffer.from("\uFEFFnext😀").toString("base64"), overwrite: true };
    await assert.rejects(host.write(handle), /expectedFingerprint/);
    await assert.rejects(host.write({ ...handle, overwrite: false }), /overwrite/);
    await writeFile(`${cwd}/new`, "racing edit");
    await assert.rejects(host.write({ ...handle, expectedFingerprint: created.fingerprint }), /changed/);
    const updated = await host.write({ ...handle, expectedFingerprint: fingerprint(Buffer.from("racing edit")) });
    assert.equal(updated.persisted, true); assert.equal(updated.fingerprint, fingerprint(Buffer.from(handle.data, "base64")));
    for (const path of ["escape/new", "../new", "dangling"]) await assert.rejects(host.write({ cwd, path, encoding: "utf8", data: "x", overwrite: false }));
    await assert.rejects(host.write({ cwd, path: "big", encoding: "utf8", data: "界".repeat(30000), overwrite: false }), /64 KiB/);
    await assert.rejects(host.write({ cwd, path: "invalid", encoding: "base64", data: "Zh==", overwrite: false }), /base64/);
    await assert.rejects(host.write({ cwd, path: "invalid", encoding: "utf8", data: "\uD800", overwrite: false }), /surrogate/);
    assert.equal(fixture.requests.filter((r) => r.method === "POST").length, 2);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("worktree ownership comes from native project/location and mutations read back native inventory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-review-worktree-"));
  try {
    let list = [{ directory: cwd }];
    const fixture = nativeFixture(async (r) => {
      if (r.path === "/api/location") return { directory: cwd, project: { id: "native-project", directory: cwd, canonical: cwd } };
      if (r.path === "/api/worktree" && r.method === "GET") { assert.equal(r.query.get("projectID"), "native-project"); return list; }
      assert.equal(r.body.projectID, "native-project");
      if (r.path === "/api/worktree/refresh") return;
      const directory = String(r.body.directory);
      if (r.method === "POST") { assert.equal(r.body.from, cwd); await mkdir(directory); list.push({ directory }); return { directory }; }
      if (r.method === "DELETE") { assert.equal(r.body.force, false); list = list.filter((entry) => entry.directory !== directory); return; }
      throw new Error("unexpected worktree contract");
    });
    const host = new HostBackend(fixture.connect);
    assert.equal((await host.worktree({ action: "list", cwd })).projectId, "native-project");
    await assert.rejects(host.worktree({ action: "refresh", cwd, projectId: "wrong" }), /projectId/);
    await assert.rejects(host.worktree({ action: "remove", cwd, directory: cwd, force: false }), /canonical project root/);
    const directory = `${cwd}/child`;
    const created = await host.worktree({ action: "create", cwd, directory, branch: "review" });
    outputSchemas.hostWorktree.parse(created);
    assert.equal(created.persisted, true);
    outputSchemas.hostWorktree.parse(await host.worktree({ action: "refresh", cwd }));
    const removed = await host.worktree({ action: "remove", cwd, directory, force: false });
    outputSchemas.hostWorktree.parse(removed);
    assert.equal(removed.removed, true);
    await assert.rejects(host.worktree({ action: "remove", cwd, directory, force: false }), /owned/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("fresh variant persists before first structured prompt; resume inherits and rejects overrides", async () => {
  const state = session(); let prompted = false;
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/session/active") return { data: {} };
    if (r.path === "/api/model") return { data: [{ id: "a", providerID: "openai", enabled: true, variants: [{ id: "high" }] }] };
    if (r.path === "/api/agent") return { data: [{ id: "build" }] };
    if (r.path === "/api/skill") return { data: [{ id: "skill-id", name: "Skill", content: "native" }] };
    if (r.path === "/api/session" && r.method === "POST") { state.model = r.body.model as typeof state.model; return { data: state }; }
    if (r.path === "/api/session/s") return { data: state };
    if (r.path.endsWith("/model")) { assert.equal(prompted, false); state.model = r.body.model as typeof state.model; return; }
    if (r.path.endsWith("/prompt")) {
      assert.equal(state.model?.variant, "high"); prompted = true;
      assert.deepEqual(r.body.skills, [{ id: "skill-id", mention: { start: 0, end: 5, text: "@test" } }]);
      assert.deepEqual(r.body.files, [{ uri: "data:text/plain;base64,77u/8J+YgA==" }]);
      return { data: { id: "canonical-user", type: "user", sessionID: "s" } };
    }
    throw new Error("unexpected prompt contract");
  });
  const backend = new OpenCodeBackend(fixture.connect);
  const attachments = { files: [{ uri: "data:text/plain;base64,77u/8J+YgA==" }], agents: [{ name: "build" }], skills: [{ id: "skill-id", mention: { start: 0, end: 5, text: "@test" } }] };
  const started = await backend.start({ task: "@test task", model: "openai/a", cwd: "/tmp", variant: "high", ...attachments });
  assert.equal(started.messageId, "canonical-user"); assert.equal(started.modelVariant, "high");
  await assert.rejects(backend.start({ task: "task", model: "openai/a", sessionId: "s", variant: "high" }), /reject overrides/);
  const resumed = await backend.start({ task: "@test task", model: "openai/a", sessionId: "s", ...attachments });
  assert.equal(resumed.modelVariant, "high");
  const before = fixture.requests.filter((r) => r.method !== "GET").length;
  await assert.rejects(backend.start({ task: "task", model: "openai/a", cwd: "/tmp", agents: [{ name: "Administrator" }] }), /canonical/);
  await assert.rejects(backend.start({ task: "task", model: "openai/a", cwd: "/tmp", skills: [{ id: "missing" }] }), /canonical/);
  await assert.rejects(backend.start({ task: "task", model: "openai/a", cwd: "/tmp", variant: "missing" }), /variant/);
  assert.equal(fixture.requests.filter((r) => r.method !== "GET").length, before);
});

test("tool inventory is independently paged and exact evidence excludes provider state/reasoning and native errors", async () => {
  const message = assistant("a", "summary") as Extract<SessionMessageInfo, { type: "assistant" }>;
  const text = "\uFEFF😀界".repeat(5000);
  message.content.push(...Array.from({ length: 60 }, (_, i): SessionMessageAssistantTool => ({ type: "tool", id: `tool-${i}`, name: "native", time: { created: 1, ran: 2, completed: 3 }, providerState: { request: "PRIVATE" }, state: { status: "completed", input: { text: "input", apiKey: "PRIVATE", env: { token: "PRIVATE" } }, content: [{ type: "text", text }, { type: "file", uri: "https://user:PRIVATE@example.invalid/evidence?token=PRIVATE", mime: "text/plain", name: "evidence" }] } })));
  message.content.push({ type: "reasoning", text: "PRIVATE" });
  const fixture = nativeFixture(() => ({ data: message }));
  const backend = new OpenCodeBackend(fixture.connect);
  const inventory = await backend.query([{ type: "tools", sessionId: "s", messageId: "a", limit: 50 }]);
  const first = inventory.results[0].result as { data: { id: string }[]; nextOffset: number; fingerprint: string };
  const rest = await backend.query([{ type: "tools", sessionId: "s", messageId: "a", offset: first.nextOffset, fingerprint: first.fingerprint }]);
  assert.equal(first.data.length + (rest.results[0].result as { data: unknown[] }).data.length, 60);
  const target = { type: "tool" as const, sessionId: "s", messageId: "a", toolId: "tool-59", field: "content" as const };
  const detail = (await backend.query([target])).results[0].result as { text: string; textPaging: { nextOffset: number; fingerprint: string } };
  const tail = (await backend.query([{ ...target, textOffset: detail.textPaging.nextOffset, textFingerprint: detail.textPaging.fingerprint }])).results[0].result as { text: string };
  assert.equal(detail.text + tail.text, text);
  const safe = await backend.query([{ ...target, field: "input" }, { ...target, contentIndex: 1 }]);
  assert.equal(JSON.stringify([inventory, rest, safe]).includes("PRIVATE"), false);
  const missing = await backend.query([{ ...target, toolId: "absent" }]);
  assert.match(String(missing.results[0].error), /absent/);
});

test("session diffs use session-local native boundaries and skill content stays recoverable", async () => {
  const patch = "diff😀\n".repeat(4000);
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/skill") return { data: [{ id: "canonical", name: "Skill", path: "/native/skill", content: patch }] };
    if (r.path === "/api/session/s") return { data: session() };
    if (r.path.includes("/message/")) { assert.ok(r.path.startsWith("/api/session/s/")); return { data: { id: r.path.split("/").at(-1), type: "user" } }; }
    if (r.path.endsWith("/diff")) { assert.equal(r.query.get("from"), "u1"); assert.equal(r.query.get("to"), "u2"); return { data: [{ file: "only-s", status: "modified", additions: 1, deletions: 0, patch }] }; }
    throw new Error("unexpected session diff contract");
  });
  const backend = new OpenCodeBackend(fixture.connect);
  const query = { type: "sessionDiff" as const, sessionId: "s", from: "u1", to: "u2" };
  const inventory = await backend.query([query]); assert.equal(JSON.stringify(inventory).includes(patch), false);
  const direct = await backend.query([{ ...query, file: "only-s", textOffset: 12000, textFingerprint: fingerprint(patch) }, { type: "skill", skillId: "canonical", textOffset: 12000, textFingerprint: fingerprint(patch) }]);
  assert.equal(direct.results.some((entry) => "error" in entry), false);
  assert.equal((direct.results[0].result as { text: string }).text, (direct.results[1].result as { text: string }).text);
  const changed = await backend.query([{ ...query, file: "only-s", textOffset: 12000, textFingerprint: fingerprint("old") }]);
  assert.match(String(changed.results[0].error), /changed/);
});

test("inbox mutations preserve targeted identity, reconcile pending state, and void actions never invent user IDs", async () => {
  let inbox: SessionInboxInfo[] = [{ id: "native-inbox", sessionID: "s", type: "synthetic", delivery: "queue", time: { created: 1 }, payload: { text: "context" } }];
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/session/s") return { data: session() };
    if (r.path.endsWith("/inbox")) return { data: inbox };
    if (r.path.endsWith("/inbox/native-inbox")) {
      if (r.method === "DELETE") inbox = [];
      else inbox[0].delivery = r.body.delivery as "steer" | "queue";
      return;
    }
    if (r.path === "/api/command") return { data: [{ name: "native-command" }] };
    if (r.path === "/api/skill") return { data: [{ id: "canonical", name: "Skill" }] };
    if (r.path.endsWith("/compact")) return { data: { id: "compact-id", sessionID: "s", type: "compaction", delivery: "queue", time: { created: 2 }, payload: {} } };
    if (r.path.endsWith("/command") || r.path.endsWith("/skill")) return;
    throw new Error("unexpected inbox contract");
  });
  const backend = new OpenCodeBackend(fixture.connect);
  const inspection = await backend.query([{ type: "inbox", sessionId: "s", limit: 1 }]);
  assert.equal((inspection.results[0].result as { data: { inboxId: string }[] }).data[0].inboxId, "native-inbox");
  await assert.rejects(backend.act({ action: "cancelInbox", sessionId: "s", inboxId: "wrong" }), /targeted/);
  const updated = await backend.act({ action: "updateInbox", sessionId: "s", inboxId: "native-inbox", delivery: "steer" });
  outputSchemas.act.parse(updated);
  assert.equal(updated.inboxId, "native-inbox"); assert.equal(updated.deliveryVerified, true);
  const cancelled = await backend.act({ action: "cancelInbox", sessionId: "s", inboxId: "native-inbox" });
  outputSchemas.act.parse(cancelled);
  assert.equal(cancelled.pending, false); assert.equal("messageId" in cancelled, false);
  const compact = await backend.act({ action: "compact", sessionId: "s" });
  outputSchemas.act.parse(compact);
  assert.equal(compact.inboxId, "compact-id"); assert.ok("completed" in compact); assert.equal(compact.completed, false); assert.equal("messageId" in compact, false);
  for (const action of [{ action: "command" as const, sessionId: "s", name: "native-command", text: "args" }, { action: "invokeSkill" as const, sessionId: "s", skillId: "canonical" }]) {
    const result = await backend.act(action); outputSchemas.act.parse(result); assert.equal(result.identitySupplied, false); assert.equal("messageId" in result, false);
  }
  await assert.rejects(backend.act({ action: "command", sessionId: "s", name: "raw-rpc", text: "" }), /catalog/);
  assert.equal(fixture.requests.some((r) => /config|credential|rpc/.test(r.path)), false);
});

test("failed admission preserves known native session identity without retrying uncertain prompts", async () => {
  for (const failAt of ["configurationReadback", "promptAdmission"]) {
    const state = session();
    const fixture = nativeFixture((r) => {
      if (r.path === "/api/session/active") return { data: {} };
      if (r.path === "/api/model") return { data: [{ id: "a", providerID: "openai", enabled: true, variants: [] }] };
      if (r.path === "/api/agent") return { data: [{ id: "build" }] };
      if (r.path === "/api/session") return { data: state };
      if (r.path === "/api/session/s" && failAt === "promptAdmission") return { data: state };
      return Response.json({ _tag: "ServiceUnavailableError", message: "PRIVATE" }, { status: 503 });
    });
    await assert.rejects(new OpenCodeBackend(fixture.connect).start({ cwd: "/tmp", model: "openai/a", task: "bounded" }), (error: unknown) => {
      assert.ok(error instanceof AdmissionError);
      assert.equal(error.recovery.sessionId, "s");
      assert.equal(error.recovery.stage, failAt);
      assert.equal(error.recovery.promptSubmitted, failAt === "promptAdmission" ? null : false);
      assert.equal(error.message.includes("PRIVATE"), false);
      return true;
    });
    assert.equal(fixture.requests.filter((r) => r.path.endsWith("/prompt")).length, failAt === "promptAdmission" ? 1 : 0);
  }
});

test("ordinary connection fails without starting or replacing a missing native service", async () => {
  const { mock } = await import("node:test");
  const { Service } = await import("@opencode/client/service");
  const { connectNative } = await import("../src/native.js");
  let ensured = false;
  const discovery = mock.method(Service, "discover", async () => undefined);
  const ensure = mock.method(Service, "ensure", async () => { ensured = true; throw new Error("unexpected lifecycle mutation"); });
  try {
    await assert.rejects(connectNative(), /ordinary calls do not start/);
    assert.equal(ensured, false);
  } finally { discovery.mock.restore(); ensure.mock.restore(); }
});
