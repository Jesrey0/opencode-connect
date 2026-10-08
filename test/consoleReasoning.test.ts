import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { ConsoleObserver, fetchTranscript } from "../src/console.js";
import { DIM, emptyState, renderFrame, transcriptLines, type ConsoleSnapshot, type TranscriptEntry } from "../src/consoleView.js";
import { assistant, nativeFixture, user } from "./native-fixture.js";

// Pinned evidence: packages/schema/src/{session-event,session-message}.ts,
// packages/core/src/session/{message-updater,runner/publish-llm-event}.ts and
// packages/core/test/session-runner.test.ts at anomalyco/opencode v2.0.24.
// "restores durable reasoning provider metadata in the next request" and
// "keeps one durable reasoning part when reasoning closes after text" verify
// provider text/state round-trip, not a separate guaranteed-safe summary.

const snapshot = (): ConsoleSnapshot => ({
  ready: true, release: "2.0.24", pid: 1, observedAtMs: 0, usage: null, pending: [],
  sessions: [{ id: "s", title: "Activity", running: true, outcome: null, agent: "build", model: "openai/a", variant: null, cwd: "/tmp", updatedMs: 0 }],
});
type ReasoningEvent = Extract<OpenCodeEvent, { type: "session.reasoning.started" | "session.reasoning.delta" | "session.reasoning.ended" }>;
let sequence = 0;
function event(kind: "started" | "delta" | "ended", ordinal = 0, assistantMessageID = "a", sessionID = "s"): ReasoningEvent {
  return {
    id: "evt_reasoning_" + ++sequence, created: sequence, type: "session.reasoning." + kind,
    ...(kind !== "delta" ? { durable: { aggregateID: sessionID, seq: sequence, version: 1 } } : {}),
    data: { sessionID, assistantMessageID, ordinal,
      ...(kind === "delta" ? { delta: "PRIVATE_REASONING" } : kind === "ended" ? { text: "PRIVATE_REASONING" } : {}),
      ...(kind !== "delta" ? { state: { signature: "PRIVATE_STATE" } } : {}),
    },
    metadata: { request: "PRIVATE_REQUEST" },
  } as ReasoningEvent;
}
function textEvent(delta: string, assistantMessageID = "a", ordinal = 1): OpenCodeEvent {
  return { id: "text_" + ++sequence, created: sequence, type: "session.text.delta", data: { sessionID: "s", assistantMessageID, ordinal, delta } };
}
function active(): SessionMessageInfo & { type: "assistant" } {
  const message = assistant("a", "ANSWER");
  if (message.type !== "assistant") throw new Error("fixture");
  delete message.time.completed;
  delete message.finish;
  return message;
}
function observerFor(transcript: () => Promise<TranscriptEntry[]> = async () => []) {
  const state = emptyState();
  state.view = { kind: "session", sessionId: "s" };
  return { state, observer: new ConsoleObserver(state, { snapshot: async () => snapshot(), transcript }, () => {}) };
}
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const statuses = (entries: TranscriptEntry[] | null) => entries?.find(entry => entry.messageId === "a")?.reasoningParts;
function assertExcluded(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_REASONING|PRIVATE_STATE|PRIVATE_REQUEST/);
}

test("native reasoning start/delta/end shows activity only, deduplicated by event ID and content ordinal", async () => {
  const { state, observer } = observerFor();
  await observer.refresh();
  assert.equal(observer.applyEvent(event("started", 2)), true);
  const delta = event("delta", 2);
  assert.equal(observer.applyEvent(delta), false); // No status change/redraw for each fragment.
  assert.equal(observer.applyEvent(delta), false);
  observer.applyEvent(event("delta", 4)); // Late subscription may miss start.
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 2, status: "active" }, { ordinal: 4, status: "active" }]);
  observer.applyEvent(event("ended", 2));
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 2, status: "ended" }, { ordinal: 4, status: "active" }]);
  assert.equal(observer.applyEvent(event("delta", 2)), false);
  assert.equal(observer.applyEvent(event("started", 2)), false);
  const rendered = transcriptLines(state.transcript!, 80);
  assert.ok(rendered.some(line => line.startsWith(DIM) && line.includes("Reasoning · active")));
  assertExcluded(state.transcript);
  assertExcluded(rendered);
});

test("reasoning handlers never access text, delta, state or metadata payloads", async () => {
  const { state, observer } = observerFor();
  await observer.refresh();
  for (const kind of ["started", "delta", "ended"] as const) {
    const native = event(kind);
    for (const key of ["delta", "text", "state"]) Object.defineProperty(native.data, key, { get() { throw new Error("payload accessed"); } });
    Object.defineProperty(native, "metadata", { get() { throw new Error("metadata accessed"); } });
    observer.applyEvent(native);
  }
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
});

test("persisted reasoning projects only timing evidence, not text or provider state", async () => {
  const message = active();
  message.content.push(
    { type: "reasoning", text: "PRIVATE_REASONING", state: { signature: "PRIVATE_STATE" }, time: { created: 0 } },
    { type: "reasoning", text: "PRIVATE_REASONING", time: { created: 0, completed: 0 } },
    { type: "reasoning", text: "PRIVATE_REASONING" },
  );
  const native = nativeFixture(() => ({ data: [message, user("u")], cursor: { next: null } }));
  const entries = await fetchTranscript(native.client, "s");
  assert.deepEqual(statuses(entries), [
    { ordinal: 1, status: "active" }, { ordinal: 2, status: "ended" }, { ordinal: 3, status: "observed" },
  ]);
  assert.equal(entries[1].text, "ANSWER");
  assertExcluded(entries);
  message.time.completed = 1;
  const completed = await fetchTranscript(native.client, "s");
  assert.deepEqual(statuses(completed)?.map(part => part.status), ["observed", "ended", "observed"]);
});

test("a missing persisted part retains activity until native end timing reconciles it", async () => {
  let persisted = false;
  const message = active();
  const native = nativeFixture(() => ({ data: [message], cursor: { next: null } }));
  const { state, observer } = observerFor(() => persisted ? fetchTranscript(native.client, "s") : Promise.resolve([]));
  await observer.refresh();
  observer.applyEvent(event("delta", 1));
  await observer.refresh();
  assert.equal(statuses(state.transcript)?.[0].status, "active");
  observer.applyEvent(event("ended", 1));
  message.content.push({ type: "reasoning", text: "PRIVATE_REASONING", time: { created: 0, completed: 1 } });
  persisted = true;
  await observer.refresh();
  await observer.refresh();
  assert.equal(state.transcript?.length, 1);
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 1, status: "ended" }]);
  assert.equal(observer.applyEvent(event("delta", 1)), false);
  assertExcluded(state.transcript);
});

test("stale reads cannot erase reasoning events received in flight; next read is authoritative", async () => {
  let release!: (entries: TranscriptEntry[]) => void;
  let started!: () => void;
  const pending = new Promise<TranscriptEntry[]>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let reads = 0;
  const { state, observer } = observerFor(async () => {
    if (++reads === 1) { started(); return pending; }
    return [{ role: "assistant", messageId: "a", text: "DONE", completed: true }];
  });
  const refresh = observer.refresh();
  await reading;
  observer.applyEvent(event("delta"));
  release([{ role: "assistant", messageId: "a", text: "OLD", completed: true }]);
  await refresh;
  assert.equal(statuses(state.transcript)?.[0].status, "active");
  await observer.refresh();
  assert.equal(statuses(state.transcript), undefined);
  assert.equal(observer.applyEvent(event("delta")), false);
  assert.equal(state.transcript?.[0].text, "DONE");
});

test("persisted end timing always beats a reasoning delta received while that read is in flight", async () => {
  let release!: (entries: TranscriptEntry[]) => void;
  let started!: () => void;
  const pending = new Promise<TranscriptEntry[]>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const { state, observer } = observerFor(async () => { started(); return pending; });
  const refresh = observer.refresh();
  await reading;
  observer.applyEvent(event("delta"));
  observer.applyEvent(textEvent("LIVE_ANSWER"));
  release([{ role: "assistant", messageId: "a", text: "", completed: false, reasoningParts: [{ ordinal: 0, status: "ended" }] }]);
  await refresh;
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
  assert.equal(state.transcript?.[0].text, "LIVE_ANSWER");
  assert.equal(observer.applyEvent(event("started")), false);
  assert.equal(observer.applyEvent(event("delta")), false);
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
  assertExcluded(inspect(observer, { depth: null }));
});

test("late end cannot be reopened by an older start/delta or overwritten by an incomplete read", async () => {
  const { state, observer } = observerFor(async () => [{ role: "assistant", messageId: "a", text: "ANSWER", reasoningParts: [{ ordinal: 0, status: "active" }] }]);
  await observer.refresh();
  const older = event("delta");
  observer.applyEvent(event("ended"));
  assert.equal(observer.applyEvent(older), false);
  await observer.refresh();
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
});

test("native end remains authoritative when delivered after a fragment with a later timestamp", async () => {
  const { state, observer } = observerFor();
  await observer.refresh();
  const ended = event("ended");
  observer.applyEvent(event("delta"));
  assert.equal(observer.applyEvent(ended), true);
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
});

test("activity and normal text remain independent while follow is paused and resumed", async () => {
  const { state, observer } = observerFor();
  await observer.refresh();
  observer.applyEvent(textEvent("ANSWER"));
  observer.applyEvent(event("started"));
  observer.applyKeys([{ kind: "home" }]);
  const cached = state.transcript;
  const scroll = state.scroll;
  observer.applyEvent(event("ended"));
  observer.applyEvent(textEvent("_TAIL"));
  await observer.refresh();
  assert.equal(state.transcript, cached);
  assert.equal(state.scroll, scroll);
  assert.equal(observer.applyKeys([{ kind: "end" }]), true);
  assert.equal(state.transcript?.[0].text, "ANSWER_TAIL");
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
  const frame = plain(renderFrame(observer.snapshot, null, state, 44, 14));
  assert.ok(frame.includes("Reasoning · ended"));
  assert.ok(frame.includes("ANSWER_TAIL"));
  assertExcluded(frame);
});

test("reasoning state belongs to the selected session and exact opened view, including late reads", async () => {
  let release!: (entries: TranscriptEntry[]) => void;
  let started!: () => void;
  const pending = new Promise<TranscriptEntry[]>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const { state, observer } = observerFor(async () => { started(); return pending; });
  const refresh = observer.refresh();
  await reading;
  assert.equal(observer.applyEvent(event("started", 0, "a", "other")), false);
  observer.applyEvent(event("started"));
  observer.applyKeys([{ kind: "escape" }, { kind: "enter" }]);
  release([{ role: "assistant", messageId: "a", text: "OLD", reasoningParts: [{ ordinal: 0, status: "active" }] }]);
  await refresh;
  assert.equal(state.transcript, null);
  observer.applyEvent(event("ended"));
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
  state.quit = true;
  assert.equal(observer.applyEvent(event("started", 1)), false);
});

test("reasoning event memory is bounded by assistants, parts and dedup IDs without retaining payload bytes", async () => {
  const { state, observer } = observerFor();
  await observer.refresh();
  observer.applyEvent(event("ended"));
  for (let message = 0; message < 140; message++) observer.applyEvent(event("delta", 0, "a" + message));
  assert.equal(state.transcript?.length, 128);
  assert.equal(state.transcript?.[0].messageId, "a");
  for (let ordinal = 1; ordinal < 2200; ordinal++) observer.applyEvent(event("delta", ordinal));
  assert.equal(state.transcript?.length, 128);
  assert.equal(statuses(state.transcript)?.length, 64);
  assert.deepEqual(statuses(state.transcript)?.[0], { ordinal: 0, status: "ended" });
  assert.equal(statuses(state.transcript)?.at(-1)?.ordinal, 63);
  // Both message/part admission pressure and dedup-ID eviction must leave the
  // native terminal identity intact, even for newly framed stale fragments.
  assert.equal(observer.applyEvent(event("started")), false);
  assert.equal(observer.applyEvent(event("delta")), false);
  assert.deepEqual(statuses(state.transcript)?.[0], { ordinal: 0, status: "ended" });
  const retained = inspect(observer, { depth: null, maxArrayLength: null });
  assert.equal((retained.match(/evt_reasoning_/g) ?? []).length, 2048);
  assertExcluded(retained); // Inspect Maps too; JSON serialization would omit them.
  assertExcluded(state.transcript);
});

test("terminal identities survive persisted reconciliation and absent later pages under cache pressure", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(event("ended"));
  entries = [{ role: "assistant", messageId: "a", text: "", completed: false, reasoningParts: [{ ordinal: 0, status: "ended" }] }];
  await observer.refresh();
  entries = [];
  for (let message = 0; message < 140; message++) observer.applyEvent(event("delta", 0, "other" + message));
  for (let ordinal = 1; ordinal < 70; ordinal++) observer.applyEvent(event("delta", ordinal));
  await observer.refresh();
  assert.equal(observer.applyEvent(event("started")), false);
  assert.equal(observer.applyEvent(event("delta")), false);
  assert.deepEqual(statuses(state.transcript)?.[0], { ordinal: 0, status: "ended" });
  assertExcluded(state.transcript);
});

for (const pressure of ["messages", "parts"] as const) {
  test(`ended reasoning cannot reopen after ${pressure} exceed the live admission bound`, async () => {
    const { state, observer } = observerFor();
    await observer.refresh();
    observer.applyEvent(event("ended"));
    for (let index = 1; index < 150; index++) {
      observer.applyEvent(pressure === "messages" ? event("delta", 0, "a" + index) : event("delta", index));
    }
    assert.equal(observer.applyEvent(event("started")), false);
    assert.equal(observer.applyEvent(event("delta")), false);
    assert.deepEqual(statuses(state.transcript)?.[0], { ordinal: 0, status: "ended" });
    assert.ok((state.transcript?.length ?? 0) <= 128);
    assert.ok((statuses(state.transcript)?.length ?? 0) <= 64);
    assertExcluded(inspect(observer, { depth: null }));
  });
}

test("appending persisted parts beyond the projection bound cannot evict previously observed end timing", async () => {
  const message = active();
  message.content.push({ type: "reasoning", text: "PRIVATE_REASONING", time: { created: 0, completed: 1 } });
  const native = nativeFixture(() => ({ data: [message], cursor: { next: null } }));
  const { state, observer } = observerFor(() => fetchTranscript(native.client, "s"));
  await observer.refresh();
  for (let ordinal = 2; ordinal < 100; ordinal++) message.content.push({ type: "reasoning", text: "PRIVATE_REASONING", time: { created: ordinal } });
  await observer.refresh();
  assert.equal(observer.applyEvent(event("started", 1)), false);
  assert.equal(observer.applyEvent(event("delta", 1)), false);
  assert.deepEqual(statuses(state.transcript)?.[0], { ordinal: 1, status: "ended" });
  assert.equal(statuses(state.transcript)?.length, 64);
  assert.equal(state.transcript?.[0].text, "ANSWER");
  assertExcluded(state.transcript);
});

test("cache saturation keeps unflushed text, while native completion frees slots without reopening reasoning", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(textEvent("UNFLUSHED", "a0"));
  for (let message = 0; message < 128; message++) observer.applyEvent(event("ended", 0, "a" + message));
  assert.equal(observer.applyEvent(textEvent("SKIPPED", "new")), false);
  assert.equal(observer.applyEvent(event("delta", 0, "new")), false);
  assert.equal(state.transcript?.length, 128);
  assert.equal(state.transcript?.[0].text, "UNFLUSHED");
  entries = [{ role: "assistant", messageId: "a0", text: "PERSISTED", completed: true, reasoningParts: [{ ordinal: 0, status: "ended" }] }];
  await observer.refresh();
  assert.equal(observer.applyEvent(event("started", 0, "a0")), false);
  assert.equal(observer.applyEvent(event("delta", 0, "a0")), false);
  assert.equal(observer.applyEvent(textEvent("NEW_ANSWER", "new")), true);
  assert.equal(state.transcript?.[0].text, "PERSISTED");
  assert.equal(state.transcript?.at(-1)?.text, "NEW_ANSWER");
  assertExcluded(state.transcript);
});

for (const reasoningFirst of [true, false]) {
  test(`missing assistant overlays preserve first-activity order (${reasoningFirst ? "reasoning" : "text"} first) across refresh and follow`, async () => {
    let entries: TranscriptEntry[] = [];
    const { state, observer } = observerFor(async () => entries);
    await observer.refresh();
    observer.applyKeys([{ kind: "home" }]);
    if (reasoningFirst) {
      observer.applyEvent(event("started", 0, "a1"));
      observer.applyEvent(textEvent("SECOND", "a2"));
    } else {
      observer.applyEvent(textEvent("FIRST", "a1"));
      observer.applyEvent(event("started", 0, "a2"));
    }
    observer.applyKeys([{ kind: "end" }]);
    assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
    // Adding the other payload to each message must not move its identity.
    observer.applyEvent(textEvent("ANSWER", reasoningFirst ? "a1" : "a2"));
    observer.applyEvent(event("ended", 0, reasoningFirst ? "a2" : "a1"));
    await observer.refresh();
    assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
    // A partial native page containing only the newer message anchors the
    // missing older overlay before it, instead of appending by payload type.
    entries = [{ role: "assistant", messageId: "a2", text: "", completed: false }];
    await observer.refresh();
    assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
    entries = [{ role: "user", messageId: "u", text: "TASK" },
      { role: "assistant", messageId: "a1", text: "FIRST", completed: true },
      { role: "assistant", messageId: "a2", text: "SECOND", completed: true }];
    await observer.refresh();
    assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["u", "a1", "a2"]);
    assertExcluded(state.transcript);
  });
}

test("reasoning a1 stays before text a2 when only completed a2 is persisted and its overlay is freed", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(event("started", 0, "a1"));
  observer.applyEvent(textEvent("SECOND", "a2"));
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  entries = [{ role: "assistant", messageId: "a2", text: "PERSISTED_SECOND", completed: true }];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  assert.equal(state.transcript?.[1].text, "PERSISTED_SECOND");
  // Inspect the exact owning layers: the anchor survives without retaining the
  // completed overlay/payload, and both structures remain within the bound.
  const cache = observer as unknown as { messageOrder: Set<string>; liveMessages: Map<string, unknown> };
  assert.deepEqual([...cache.messageOrder], ["a1", "a2"]);
  assert.equal(cache.liveMessages.has("a2"), false);
  assert.ok(cache.messageOrder.size <= 128);
  assertExcluded(inspect(observer, { depth: null }));
  entries = [];
  await observer.refresh();
  observer.applyKeys([{ kind: "home" }]);
  observer.applyEvent(event("ended", 0, "a1"));
  observer.applyKeys([{ kind: "end" }]);
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  entries = [{ role: "assistant", messageId: "a1", text: "FIRST", completed: true }];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  assert.equal(cache.messageOrder.size, 0);
  assert.equal(cache.liveMessages.size, 0);
});

test("payload-free completion anchors stay bounded while their older predecessor is missing", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  const cache = observer as unknown as { messageOrder: Set<string>; liveMessages: Map<string, unknown> };
  await observer.refresh();
  observer.applyEvent(event("started", 0, "a0"));
  for (let index = 1; index < 140; index++) {
    const messageId = "a" + index;
    assert.equal(observer.applyEvent(textEvent("STREAM", messageId)), index < 128);
    entries = [{ role: "assistant", messageId, text: "PERSISTED", completed: true }];
    await observer.refresh();
    assert.ok(cache.messageOrder.size <= 128);
    assert.equal(cache.liveMessages.size, 1);
    assert.equal(state.transcript?.[0].messageId, "a0");
  }
  assert.equal(cache.messageOrder.size, 128);
  assert.equal(observer.applyEvent(textEvent("SKIPPED", "next")), false);
  entries = [{ role: "assistant", messageId: "a0", text: "FIRST", completed: true }];
  await observer.refresh();
  assert.equal(cache.messageOrder.size, 0);
  assert.equal(cache.liveMessages.size, 0);
  assert.equal(state.transcript?.[0].messageId, "a0");
  assert.equal(observer.applyEvent(textEvent("NEW", "next")), true);
  assertExcluded(inspect(observer, { depth: null }));
});

test("an authoritative native page overrides first-observed activity order when both identities are available", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(event("started", 0, "a1"));
  observer.applyEvent(textEvent("SECOND", "a2"));
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  // Event observation can be late; it is not an independent native chronology.
  entries = [{ role: "assistant", messageId: "a2", text: "OLDER", completed: true },
    { role: "assistant", messageId: "a1", text: "NEWER", completed: true }];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a2", "a1"]);
});

test("native co-observation corrects provisional order after completed a2 and a1 persist on separate pages", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(event("started", 0, "a1"));
  observer.applyEvent(textEvent("SECOND", "a2"));
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  const a1: TranscriptEntry = { role: "assistant", messageId: "a1", text: "NEWER", completed: true };
  const a2: TranscriptEntry = { role: "assistant", messageId: "a2", text: "OLDER", completed: true };
  entries = [a2];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  entries = [a1];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "a2"]);
  const cache = observer as unknown as { messageOrder: Set<string>; liveMessages: Map<string, unknown> };
  assert.equal(cache.messageOrder.size, 0);
  assert.equal(cache.liveMessages.size, 0);
  entries = [a2, a1];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a2", "a1"]);
  assert.deepEqual(state.transcript?.map(entry => entry.text), ["OLDER", "NEWER"]);
  // Once corrected, singleton/missing pages cannot revive old activity order.
  entries = [a1];
  await observer.refresh();
  entries = [];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a2", "a1"]);
  assertExcluded(state.transcript);
});

test("native subset order reorders existing slots without losing unrelated loaded history or inserting duplicates", async () => {
  let entries: TranscriptEntry[] = [
    { role: "user", messageId: "u", text: "OPERATOR_HISTORY" },
    { role: "assistant", messageId: "a1", text: "OLD_A1", completed: true },
    { role: "assistant", messageId: "retained", text: "UNRELATED_HISTORY", completed: true },
    { role: "assistant", messageId: "a2", text: "OLD_A2", completed: true },
    { role: "user", messageId: "tail", text: "RETAINED_TAIL" },
  ];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  entries = [
    { role: "assistant", messageId: "newBefore", text: "BEFORE", completed: true },
    { role: "assistant", messageId: "a2", text: "UPDATED_A2", completed: true },
    { role: "assistant", messageId: "a1", text: "UPDATED_A1", completed: true },
    { role: "assistant", messageId: "newAfter", text: "AFTER", completed: true },
  ];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["u", "newBefore", "a2", "retained", "a1", "newAfter", "tail"]);
  assert.deepEqual(state.transcript?.filter(entry => entries.some(native => native.messageId === entry.messageId)).map(entry => entry.messageId), ["newBefore", "a2", "a1", "newAfter"]);
  assert.equal(state.transcript?.find(entry => entry.messageId === "retained")?.text, "UNRELATED_HISTORY");
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["u", "newBefore", "a2", "retained", "a1", "newAfter", "tail"]);
});

test("native chronology supersedes provisional persisted rows while missing overlays still use bounded native anchors", async () => {
  let entries: TranscriptEntry[] = [];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(event("started", 0, "a1"));
  observer.applyEvent(event("started", 0, "missing"));
  observer.applyEvent(textEvent("SECOND", "a2"));
  const a1: TranscriptEntry = { role: "assistant", messageId: "a1", text: "NEWER", completed: true };
  const a2: TranscriptEntry = { role: "assistant", messageId: "a2", text: "OLDER", completed: true };
  entries = [a2];
  await observer.refresh();
  entries = [a1];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a1", "missing", "a2"]);
  entries = [a2, a1];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["missing", "a2", "a1"]);
  assert.equal(state.transcript?.[0].reasoningParts?.[0].status, "active");
  observer.applyKeys([{ kind: "home" }]);
  const cached = state.transcript;
  observer.applyEvent(event("ended", 0, "missing"));
  await observer.refresh();
  assert.equal(state.transcript, cached);
  observer.applyKeys([{ kind: "end" }]);
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["missing", "a2", "a1"]);
  assert.equal(state.transcript?.[0].reasoningParts?.[0].status, "ended");
  entries = [{ role: "assistant", messageId: "missing", text: "PERSISTED", completed: true }, a2, a1];
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["missing", "a2", "a1"]);
  const cache = observer as unknown as { messageOrder: Set<string>; liveMessages: Map<string, unknown> };
  assert.equal(cache.messageOrder.size, 0);
  assert.equal(cache.liveMessages.size, 0);
  assertExcluded(inspect(observer, { depth: null }));
});

test("native reordering of active messages preserves streamed text, tool status, reasoning end evidence and paused follow", async () => {
  const a1: TranscriptEntry = { role: "assistant", messageId: "a1", text: "", completed: false };
  const a2: TranscriptEntry = { role: "assistant", messageId: "a2", text: "", completed: false,
    tools: [{ id: "t", name: "shell", status: "running" }] };
  let entries = [a1, a2];
  const { state, observer } = observerFor(async () => entries);
  await observer.refresh();
  observer.applyEvent(event("started", 0, "a1"));
  observer.applyEvent(textEvent("STREAMED", "a2"));
  entries = [a2, { ...a1, reasoningParts: [{ ordinal: 0, status: "ended" }] }];
  observer.applyKeys([{ kind: "home" }]);
  const cached = state.transcript;
  await observer.refresh();
  assert.equal(state.transcript, cached);
  assert.equal(state.scroll, 0);
  observer.applyKeys([{ kind: "end" }]);
  await observer.refresh();
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a2", "a1"]);
  assert.equal(state.transcript?.[0].text, "STREAMED");
  assert.deepEqual(state.transcript?.[0].tools, [{ id: "t", name: "shell", status: "running" }]);
  assert.deepEqual(state.transcript?.[1].reasoningParts, [{ ordinal: 0, status: "ended" }]);
  observer.applyEvent(textEvent("_TAIL", "a2"));
  assert.deepEqual(state.transcript?.map(entry => entry.messageId), ["a2", "a1"]);
  assert.equal(state.transcript?.[0].text, "STREAMED_TAIL");
  assert.equal(observer.applyEvent(event("delta", 0, "a1")), false);
  assertExcluded(inspect(observer, { depth: null }));
});

test("persisted reasoning activity is bounded even for a part-heavy native message", async () => {
  const message = active();
  for (let part = 0; part < 100; part++) message.content.push({ type: "reasoning", text: "PRIVATE_REASONING", time: { created: part, completed: part } });
  const native = nativeFixture(() => ({ data: [message], cursor: { next: null } }));
  const entries = await fetchTranscript(native.client, "s");
  assert.equal(statuses(entries)?.length, 64);
  assert.equal(statuses(entries)?.[0].ordinal, 1);
  assert.equal(statuses(entries)?.at(-1)?.ordinal, 64);
  assert.equal(entries[0].text, "ANSWER");
  assertExcluded(entries);
});

test("the pinned SSE client delivers reasoning events without projecting their payloads", async () => {
  const events = [event("started"), event("delta"), event("ended")];
  const wire = events.map(value => "data: " + JSON.stringify(value) + "\n\n").join("");
  const native = nativeFixture(request => request.path === "/api/event"
    ? new Response(wire, { headers: { "content-type": "text/event-stream" } })
    : { data: [], cursor: { next: null } });
  const { state, observer } = observerFor();
  await observer.refresh();
  const abort = new AbortController();
  try {
    for await (const value of native.client.event.subscribe({ signal: abort.signal })) {
      observer.applyEvent(value);
      if (value.type === "session.reasoning.ended") break;
    }
  } finally { abort.abort(); }
  assert.deepEqual(statuses(state.transcript), [{ ordinal: 0, status: "ended" }]);
  assertExcluded(state.transcript);
});
