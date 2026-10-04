import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { ConsoleObserver, fetchTranscript } from "../src/console.js";
import { emptyState, handleKey, renderFrame, transcriptLines, type ConsoleSnapshot, type TranscriptEntry } from "../src/consoleView.js";
import { nativeFixture, assistant, user } from "./native-fixture.js";

const snapshot = (): ConsoleSnapshot => ({
  ready: true, release: "2.0.22", pid: 1, observedAtMs: 0, usage: null, pending: [],
  sessions: [{ id: "s", title: "Stream", running: true, outcome: null, agent: "build", model: "openai/a", variant: null, cwd: "/tmp", updatedMs: 0 }],
});
let sequence = 0;
function textEvent(kind: "started" | "delta" | "ended", text = "", ordinal = 0, sessionID = "s", assistantMessageID = "a"): OpenCodeEvent {
  return {
    id: "evt_" + ++sequence, created: sequence, type: "session.text." + kind,
    ...(kind !== "delta" ? { durable: { aggregateID: sessionID, seq: sequence, version: 1 } } : {}),
    data: { sessionID, assistantMessageID, ordinal, ...(kind === "delta" ? { delta: text } : kind === "ended" ? { text } : {}) },
  } as OpenCodeEvent;
}
function activeMessage(text = ""): SessionMessageInfo {
  const message = assistant("a", text);
  if (message.type === "assistant") { delete message.time.completed; delete message.finish; }
  return message;
}
function observerFor(transcript: () => Promise<TranscriptEntry[]>) {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s" };
  return { state, observer: new ConsoleObserver(state, { snapshot: async () => snapshot(), transcript }, () => {}) };
}
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

test("native delta events render before the message API persists the text", async () => {
  const native = nativeFixture(() => ({ data: [activeMessage(), user("u")], cursor: { next: null } }));
  const { state, observer } = observerFor(() => fetchTranscript(native.client, "s"));
  await observer.refresh();
  assert.equal(state.transcript?.find(entry => entry.messageId === "a")?.text, "");
  observer.applyEvent(textEvent("started"));
  const answer = "line\n".repeat(30) + "LIVE_TAIL";
  assert.equal(observer.applyEvent(textEvent("delta", answer)), true);
  assert.ok(plain(renderFrame(observer.snapshot, null, state, 80, 24)).includes("LIVE_TAIL"));
  // A periodic native read still has an empty active block.
  await observer.refresh();
  assert.equal(state.transcript?.find(entry => entry.messageId === "a")?.text, answer);
});

test("text ordinals, absolute end events and persisted completion avoid duplicate answers", async () => {
  let done = false;
  const message = activeMessage("first");
  if (message.type === "assistant") message.content.push({ type: "reasoning", text: "PRIVATE_REASONING" });
  const native = nativeFixture(() => ({
    data: [done ? { ...assistant("a", "first"), content: [{ type: "text", text: "first" }, { type: "reasoning", text: "PRIVATE_REASONING" }, { type: "text", text: "second" }] } : message],
    cursor: { next: null },
  }));
  const { state, observer } = observerFor(() => fetchTranscript(native.client, "s"));
  await observer.refresh();
  observer.applyEvent(textEvent("started", "", 2));
  const delta = textEvent("delta", "partial", 2);
  observer.applyEvent(delta);
  assert.equal(observer.applyEvent(delta), false);
  observer.applyEvent(textEvent("ended", "second", 2));
  assert.equal(state.transcript?.[0].text, "first\nsecond");
  done = true;
  await observer.refresh();
  await observer.refresh();
  assert.equal(state.transcript?.length, 1);
  assert.equal(state.transcript[0].text, "first\nsecond");
  assert.equal(plain(transcriptLines(state.transcript, 80)).includes("PRIVATE_REASONING"), false);
});

test("a stale completed read cannot erase text events received during that read", async () => {
  let release!: (entries: TranscriptEntry[]) => void;
  let started!: () => void;
  const pending = new Promise<TranscriptEntry[]>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let reads = 0;
  const { state, observer } = observerFor(async () => {
    if (++reads === 1) { started(); return pending; }
    return [{ role: "assistant", messageId: "a", text: "canonical", textParts: [{ ordinal: 0, text: "canonical" }], completed: true }];
  });
  const refresh = observer.refresh();
  await reading;
  observer.applyEvent(textEvent("started"));
  observer.applyEvent(textEvent("delta", "new"));
  release([{ role: "assistant", messageId: "a", text: "old", textParts: [{ ordinal: 0, text: "old" }], completed: true }]);
  await refresh;
  assert.equal(state.transcript?.[0].text, "new");
  await observer.refresh();
  assert.equal(state.transcript?.[0].text, "canonical");
});

test("paused views keep their scroll content and resume with buffered deltas", async () => {
  const { state, observer } = observerFor(async () => []);
  await observer.refresh();
  observer.applyEvent(textEvent("started"));
  observer.applyEvent(textEvent("delta", "first"));
  observer.applyKeys([{ kind: "up" }]);
  const cached = state.transcript;
  assert.equal(observer.applyEvent(textEvent("delta", " second")), false);
  assert.equal(state.transcript, cached);
  await observer.refresh();
  assert.equal(state.transcript, cached);
  assert.equal(observer.applyKeys([{ kind: "end" }]), true);
  assert.equal(state.transcript?.[0].text, "first second");
});

test("stream overlays belong only to the selected session and exact opened view", async () => {
  const { state, observer } = observerFor(async () => []);
  await observer.refresh();
  assert.equal(observer.applyEvent(textEvent("delta", "other session", 0, "other")), false);
  observer.applyEvent(textEvent("delta", "old view"));
  observer.applyKeys([{ kind: "escape" }, { kind: "enter" }]);
  await observer.refresh();
  assert.equal(state.transcript?.length, 0);
  observer.applyEvent(textEvent("delta", "new view"));
  assert.equal(state.transcript?.[0].text, "new view");
});

test("full multiline answers retain their tail and scroll from the followed position", () => {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s" };
  state.transcript = [{ role: "assistant", text: "FIRST\n\n" + "x".repeat(600) + "\n" + "line\n".repeat(30) + "LAST" }];
  const transcript = plain(transcriptLines(state.transcript, 80));
  assert.ok(transcript.includes("FIRST\n  \n"));
  assert.ok(transcript.endsWith("LAST\n"));
  assert.ok(plain(renderFrame(snapshot(), null, state, 80, 24)).includes("LAST"));
  const tail = state.scroll;
  assert.ok(tail > 0);
  assert.ok(state.pageSize > 1);
  handleKey(state, snapshot(), { kind: "up" });
  assert.equal(state.scroll, tail - 1);
  assert.equal(state.follow, false);
});

test("the pinned native SSE client delivers text deltas to the console observer", async () => {
  const answer = "STREAMED\n" + "line\n".repeat(25) + "WIRE_TAIL";
  const events = [textEvent("started"), textEvent("delta", answer)];
  const wire = events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("");
  const native = nativeFixture(request => {
    if (request.path === "/api/event") return new Response(wire, { headers: { "content-type": "text/event-stream" } });
    return { data: [activeMessage()], cursor: { next: null } };
  });
  const { state, observer } = observerFor(() => fetchTranscript(native.client, "s"));
  await observer.refresh();
  const abort = new AbortController();
  try {
    for await (const event of native.client.event.subscribe({ signal: abort.signal })) {
      observer.applyEvent(event);
      if (event.type === "session.text.delta") break;
    }
  } finally { abort.abort(); }
  assert.ok(plain(renderFrame(observer.snapshot, null, state, 80, 24)).includes("WIRE_TAIL"));
});

test("refresh retains loaded operator history when native recent pages roll forward", async () => {
  let later = false;
  const { state, observer } = observerFor(async () => later
    ? [{ role: "assistant", messageId: "a", text: "new response", completed: true }]
    : [{ role: "user", messageId: "u", text: "ORIGINAL_OPERATOR_CONTEXT" }]);
  await observer.refresh();
  later = true;
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["u", "a"]);
  assert.ok(plain(renderFrame(observer.snapshot, null, state, 100, 30)).includes("ORIGINAL_OPERATOR_CONTEXT"));
});

test("a missing persisted assistant does not erase its already streamed text", async () => {
  const { state, observer } = observerFor(async () => []);
  await observer.refresh();
  observer.applyEvent(textEvent("started"));
  observer.applyEvent(textEvent("delta", "LIVE_UNFLUSHED_TEXT"));
  await observer.refresh();
  assert.equal(state.transcript?.[0].text, "LIVE_UNFLUSHED_TEXT");
});

test("tool-only assistant steps remain visible without inputs, outputs or reasoning", async () => {
  const message = activeMessage();
  if (message.type !== "assistant") throw new Error("fixture");
  message.content.push({ type: "tool", id: "t", name: "shell", executed: true,
    state: { status: "running", input: { secret: "PRIVATE_INPUT" } }, time: { created: 1 } } as never);
  message.content.push({ type: "reasoning", text: "PRIVATE_REASONING" });
  const native = nativeFixture(() => ({ data: [message, user("u")], cursor: { next: null } }));
  const entries = await fetchTranscript(native.client, "s");
  const rendered = plain(transcriptLines(entries, 100));
  assert.ok(rendered.includes("shell"));
  assert.ok(rendered.includes("running"));
  assert.equal(rendered.includes("PRIVATE_INPUT"), false);
  assert.equal(rendered.includes("PRIVATE_REASONING"), false);
});

test("opening a tool-heavy session reads back to its operator prompt using native cursors", async () => {
  const native = nativeFixture(request => {
    if (request.query.has("cursor")) {
      assert.equal(request.query.has("order"), false);
      return { data: [{ ...user("u"), text: "OPERATOR_ANCHOR" }], cursor: { next: null } };
    }
    return { data: [activeMessage()], cursor: { next: "older" } };
  });
  const entries = await fetchTranscript(native.client, "s");
  assert.equal(entries[0].messageId, "u");
  assert.equal(entries[0].text, "OPERATOR_ANCHOR");
});
