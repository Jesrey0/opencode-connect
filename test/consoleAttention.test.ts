import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ConsoleObserver } from "../src/console.js";
import { displayWidth, emptyState, handleKey, renderFrame, type ConsoleSnapshot } from "../src/consoleView.js";

const session = (runtime: "opencode" | "codex", id: string) => ({
  runtime, id, title: `Task ${id}`, running: null, outcome: null, agent: null, model: null,
  modelProvider: null, reasoningEffort: null, mode: null, variant: null, cwd: "/work", updatedMs: null,
});
const snapshot = (): ConsoleSnapshot => ({
  ready: true, release: "2.0.24", pid: 1, observedAtMs: 1, codexVisibility: "partial · supervised status unavailable", usage: null,
  sessions: [session("opencode", "same"), session("codex", "same")],
  pending: [
    { runtime: "opencode", sessionId: "same", id: "p", kind: "permission", label: "native permission request" },
    { runtime: "opencode", sessionId: "same", id: "f", kind: "form", label: "native form request" },
    { runtime: "codex", sessionId: "same", id: "p", kind: "permission", label: "native permission request" },
  ],
});
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

test("attention is an observed request list, inspect-only, independent of session filters", () => {
  const snap = snapshot();
  const state = emptyState();
  state.scope = "opencode"; state.filter = "does not match";
  handleKey(state, snap, { kind: "char", value: "t" });
  const text = plain(renderFrame(snap, null, state, 100, 24));
  assert.match(text, /Attention · 3 observed/);
  assert.match(text, /Partial visibility · OpenCode active only · Codex supervised only · inspect only/);
  assert.match(text, /opencode · form/);
  assert.match(text, /codex · permission/);
  handleKey(state, snap, { kind: "end" });
  assert.equal(state.attentionSelected, 2);
  assert.equal(handleKey(state, snap, { kind: "char", value: "y" }), false);
  handleKey(state, snap, { kind: "enter" });
  assert.deepEqual(state.view, { kind: "session", runtime: "codex", sessionId: "same", fromAttention: true });
  handleKey(state, snap, { kind: "escape" });
  assert.equal(state.view.kind, "attention");
  assert.equal(state.attentionSelected, 2);
  handleKey(state, snap, { kind: "escape" });
  assert.equal(state.view.kind, "dashboard");
  assert.equal(state.scope, "opencode");
  assert.equal(state.filter, "does not match");
});

test("attention viewport keeps selection visible at narrow widths, and empty/stale states are honest", () => {
  const snap = snapshot();
  snap.pending = Array.from({ length: 15 }, (_, index) => ({ runtime: "opencode", sessionId: `s${index}`, id: `p${index}`, kind: "permission", label: "native permission request" }));
  for (const [width, height] of [[24, 8], [40, 10], [44, 14], [80, 24]]) {
    const state = emptyState();
    state.view = { kind: "attention" };
    renderFrame(snap, null, state, width, height);
    handleKey(state, snap, { kind: "end" });
    const frame = renderFrame(snap, "disconnected", state, width, height);
    assert.equal(frame.length, height);
    for (const line of frame) assert.equal(displayWidth(line), width);
    assert.match(plain(frame), width < 32 ? /> OC permission s14/ : /> opencode · permission · s14/);
    assert.match(plain(frame), /stale/);
    handleKey(state, snap, { kind: "home" });
    assert.match(plain(renderFrame(snap, null, state, width, height)), width < 32 ? /> OC permission s0/ : /> opencode · permission · s0/);
  }
  snap.pending = [];
  const state = emptyState(); state.view = { kind: "attention" };
  assert.match(plain(renderFrame(snap, null, state, 80, 24)), /No pending requests observed/);
  assert.equal(handleKey(state, snap, { kind: "enter" }), false);
  assert.match(plain(renderFrame(null, null, state, 80, 24)), /Pending requests unavailable/);
});

test("refresh preserves request identity across reordering and clamps removed requests", async () => {
  let snap = snapshot();
  const state = emptyState();
  const observer = new ConsoleObserver(state, { snapshot: async () => snap, transcript: async () => [] }, () => {});
  await observer.refresh();
  observer.applyKeys([{ kind: "char", value: "t" }, { kind: "end" }]);
  snap = { ...snap, pending: [snap.pending[2], snap.pending[0], snap.pending[1]] };
  await observer.refresh();
  assert.equal(state.attentionSelected, 0);
  assert.equal(snap.pending[state.attentionSelected].runtime, "codex");
  snap = { ...snap, pending: [] };
  await observer.refresh();
  assert.equal(state.attentionSelected, 0);
  assert.equal(observer.applyKeys([{ kind: "enter" }]), false);
  observer.stop();
});

test("search consumes attention shortcuts and Esc clears before navigation", () => {
  const state = emptyState(); const snap = snapshot();
  handleKey(state, snap, { kind: "char", value: "/" });
  for (const value of "t?1rq") handleKey(state, snap, { kind: "char", value });
  assert.equal(state.filter, "t?1rq");
  assert.equal(state.view.kind, "dashboard");
  assert.equal(state.help, false);
  assert.equal(state.quit, false);
  handleKey(state, snap, { kind: "escape" });
  assert.equal(state.filter, "");
  assert.equal(state.view.kind, "dashboard");
  handleKey(state, snap, { kind: "char", value: "t" });
  assert.equal(state.view.kind, "attention");
});
