import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  BOLD, CYAN, TEXT, InputDecoder, displayWidth, elide, emptyState, handleKey,
  oneLine, pathLabel, renderFrame, row, rowLeftRight, transcriptLines,
  type ConsoleSnapshot, type ConsoleState, type TranscriptEntry,
} from "../src/consoleView.js";

function snapshot(): ConsoleSnapshot {
  return {
    codexVisibility: "recent + supervised", ready: true, release: "2.0.24", pid: 7, observedAtMs: 0,
    sessions: [
      { runtime: "opencode", id: "s1", title: "Refine the console", running: true, outcome: null, agent: "build", model: "openai/gpt-6.1-sol", variant: "high", cwd: "/home/operator/projects/opencode-connect", updatedMs: 3 },
      { runtime: "opencode", id: "s2", title: "Verify the parser", running: false, outcome: "succeeded", agent: "build", model: "openai/gpt-6.1-sol", variant: null, cwd: "/home/operator/projects/parser", updatedMs: 2 },
      { runtime: "opencode", id: "s3", title: "Review native events", running: false, outcome: "failed", agent: "review", model: "anthropic/claude-sonnet-4-6", variant: null, cwd: "/home/operator/projects/events", updatedMs: 1 },
    ],
    pending: [{ runtime: "opencode", kind: "permission", sessionId: "s1", id: "p1", label: "native permission request" }],
    usage: { sessions: 12, prompts: 48, steps: 136, tokensTotal: 234500, costUsd: 2.34, activeDays: 4, streak: 3,
      models: ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro"] },
  };
}

const plain = (lines: string[]) => lines.map(line => stripVTControlCharacters(line).trimEnd());
const rule = (width: number) => "─".repeat(width);
const splitRow = (left: string, right: string, width: number) => left + " ".repeat(width - left.length - right.length) + right.trimEnd();

function sessionState(entries: TranscriptEntry[]): ConsoleState {
  const state = emptyState();
  state.view = { kind: "session", runtime: "opencode", sessionId: "s1" };
  state.transcript = entries;
  return state;
}

function assertFrame(lines: string[], width: number, height: number): void {
  assert.equal(lines.length, height);
  for (const line of lines) {
    // Generated SGR is the only terminal control allowed, never CSI/OSC from
    // native data. Every row must fit without physical terminal auto-wrapping.
    const text = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    assert.equal(displayWidth(text), width, JSON.stringify(text));
  }
}

for (const [width, height] of [[80, 24], [120, 32]]) {
  test(`dashboard golden hierarchy at ${width}x${height}`, () => {
    const state = emptyState();
    const frame = renderFrame(snapshot(), null, state, width, height);
    assertFrame(frame, width, height);
    const expected = [
      splitRow("  opencode connect", "observer · connected · read-only ", width),
      rule(width),
      splitRow(" 1 running · 1 pending", "opencode 2.0.24 · pid 7 ", width),
      " Codex · recent + supervised",
      " Needs 0xOperator · permission: native permission request",
      splitRow(" Usage  234.5k tokens · $2.34 · 48 prompts · 136 steps", "4 days · 3 streak ", width),
      " Models openai/gpt-6.1-sol, anthropic/claude-sonnet-4-6, google/gemini-3.1-pro",
      "",
      splitRow(" Sessions", "3 recent ", width),
      splitRow("> opencode running     Refine the console", "pending ", width),
      "  opencode succeeded   Verify the parser",
      "  opencode failed      Review native events",
      " 1–3 of 3 · selected 1",
    ];
    while (expected.length < height - 6) expected.push("");
    expected.push(rule(width), " Model  openai/gpt-6.1-sol#high",
      splitRow(" Agent  build", "s1 ", width), " Cwd    /home/operator/projects/opencode-connect", rule(width),
      width === 80 ? " ↑/↓ select · Enter open · a active/all · ? help · q exit"
        : " ↑/↓ select · Enter open · a active/all · PgUp/PgDn page · ? help · q exit");
    assert.deepEqual(plain(frame), expected);
    assert.deepEqual(renderFrame(snapshot(), null, state, width, height), frame);
    assert.ok(state.pageSize >= 8);
  });
}

test("40x10 tiny dashboard keeps status, selected context and navigation", () => {
  const state = emptyState();
  const frame = renderFrame(snapshot(), null, state, 40, 10);
  assertFrame(frame, 40, 10);
  assert.deepEqual(plain(frame), [
    "opencode connect · read-only",
    "3 sessions · 1 running · 1 pending",
    "> opencode · running · Refine the conso…",
    "Model openai/gpt-6.1-sol#high",
    "Cwd …/operator/projects/opencode-connect",
    "Codex · recent + supervised", "", "", "", "↑/↓ select · Enter open · ? help",
  ]);
  assert.equal(state.pageSize, 1);
  handleKey(state, snapshot(), { kind: "down" });
  assert.ok(plain(renderFrame(snapshot(), null, state, 40, 10)).some(line => line.startsWith("> opencode · succeeded · Verify")));
});

test("empty inventory navigation keeps a valid selection", () => {
  const state = emptyState();
  for (const key of [{ kind: "down" }, { kind: "pageDown" }, { kind: "char", value: "j" }] as const) {
    handleKey(state, null, key);
    assert.equal(state.selected, 0);
  }
  const snap = snapshot();
  snap.sessions = [];
  state.selected = -4;
  assertFrame(renderFrame(snap, null, state, 80, 24), 80, 24);
  assert.equal(state.selected, 0);
});

test("bracketed paste ignores shortcuts and recognizes split end markers", () => {
  const decoder = new InputDecoder();
  const feed = (chunk: string) => [...Buffer.from(chunk)].flatMap(byte => decoder.push(byte));
  // Pasted bytes, including shortcut characters and line breaks, are never
  // emitted as keys. The end marker may be split across stdin chunks, and a
  // near-miss marker such as ESC[201x stays paste content.
  assert.deepEqual(feed("\x1b[200~qra?\r\n\x1b[201x"), []);
  assert.deepEqual(feed("\x1b[20"), []);
  // A paste in progress holds no escape sequence, so nothing is ever pending
  // for the caller's flush timer to reinterpret as a key.
  assert.equal(decoder.pendingEscape(), false);
  assert.deepEqual(decoder.flushEscape(), []);
  assert.deepEqual(feed("1~j"), [{ kind: "char", value: "j" }]);
  assert.deepEqual(feed("\x1b[200~\x1b[201~q"), [{ kind: "char", value: "q" }]);
});

test("a truncated escape sequence is flushed instead of swallowing later keys", () => {
  const decoder = new InputDecoder();
  const feed = (chunk: string) => [...Buffer.from(chunk)].flatMap(byte => decoder.push(byte));
  // Any incomplete sequence counts as pending so the caller arms its flush
  // timer; a longer pending buffer is not a standalone escape.
  assert.deepEqual(feed("\x1b[20"), []);
  assert.equal(decoder.pendingEscape(), true);
  assert.deepEqual(decoder.flushEscape(), []);
  assert.equal(decoder.pendingEscape(), false);
  // The stale bytes must not go on consuming keys.
  assert.deepEqual(feed("q"), [{ kind: "char", value: "q" }]);
  assert.deepEqual(feed("\x1b["), []);
  assert.equal(decoder.pendingEscape(), true);
  assert.deepEqual(decoder.flushEscape(), []);
  assert.deepEqual(feed("q"), [{ kind: "char", value: "q" }]);
  // Flushing with nothing pending stays inert.
  assert.deepEqual(decoder.flushEscape(), []);
});

test("Ctrl-C recovers a paste whose end marker never arrives", () => {
  const decoder = new InputDecoder();
  const feed = (chunk: string) => [...Buffer.from(chunk)].flatMap(byte => decoder.push(byte));
  assert.deepEqual(feed("\x1b[200~qqq"), []);
  assert.deepEqual(feed("jk\r\n?"), []);
  // Ctrl-C is the operator recovery path: it cancels the paste without leaking
  // a key, and no pasted shortcut ever reached the view.
  assert.deepEqual(feed("\x03"), []);
  assert.deepEqual(feed("q"), [{ kind: "char", value: "q" }]);
  // Match state is reset, so a later paste still ends on its own marker.
  assert.deepEqual(feed("\x1b[200~z"), []);
  assert.deepEqual(feed("\x1b[201~"), []);
  assert.deepEqual(feed("q"), [{ kind: "char", value: "q" }]);
  // Outside a paste Ctrl-C remains inert rather than becoming a shortcut key.
  assert.deepEqual(feed("\x03"), []);
  assert.deepEqual(feed("q"), [{ kind: "char", value: "q" }]);
});

test("invalid and fractional terminal dimensions cannot break frame rendering", () => {
  for (const [width, height] of [[NaN, 10], [Infinity, 10], [44, Infinity], [44, NaN], [-1, 10], [44, -1], [0, 10], [0, 0]]) {
    assert.deepEqual(renderFrame(snapshot(), null, emptyState(), width, height), []);
  }
  assertFrame(renderFrame(snapshot(), null, emptyState(), 40.9, 8.9), 40, 8);
  assert.equal(row("text", Infinity), "");
  assert.equal(rowLeftRight("left", "right", NaN), "");
});

test("tiny startup and not-ready frames disclose connection state", () => {
  const connecting = plain(renderFrame(null, null, emptyState(), 40, 10));
  assert.match(connecting[0], /connecting/);
  assert.ok(connecting.some(line => line.includes("No sessions observed yet")));
  assert.match(plain(renderFrame(null, null, emptyState(), 40, 1))[0], /connecting/);
  const snap = snapshot();
  snap.ready = false;
  assert.match(plain(renderFrame(snap, null, emptyState(), 40, 10))[0], /not ready/);
  const help = emptyState();
  help.help = true;
  assert.match(plain(renderFrame(snap, null, help, 24, 3)).at(-1)!, /close help/);
});

test("Codex rows and details identify unverified execution outcomes", () => {
  const snap = snapshot();
  snap.pending = [];
  snap.sessions = [{ ...snap.sessions[0], runtime: "codex", title: "Historical Codex", running: null, outcome: null }];
  const dashboard = plain(renderFrame(snap, null, emptyState(), 80, 24));
  assert.match(dashboard.join("\n"), /> codex\s+unverified\s+Historical Codex/);
  assert.ok(dashboard.some(line => line.includes("Codex · execution outcome unverified")));
  const tiny = plain(renderFrame(snap, null, emptyState(), 40, 10));
  assert.ok(tiny.some(line => line.includes("codex · unverified")));
  const narrow = plain(renderFrame(snap, null, emptyState(), 24, 8));
  assert.ok(narrow.some(line => line.startsWith("> Historical Codex")));
  assert.ok(narrow.some(line => line.includes("codex · unverified")));
  const degraded = plain(renderFrame(snap, "Disconnected", emptyState(), 24, 6, { status: "connecting", usage: null }));
  assert.ok(degraded.some(line => line.startsWith("> Historical Codex")));
  assert.ok(degraded.some(line => line.includes("codex · unverified")));
  assert.ok(degraded.some(line => line.includes("Stale: Disconnected")));
  const detail = sessionState([]);
  detail.view = { kind: "session", runtime: "codex", sessionId: "s1" };
  assert.ok(plain(renderFrame(snap, null, detail, 80, 24)).some(line => line.includes("Codex · execution outcome unverified")));
});

test("the dashboard renders sanitized Codex quota windows and labels retained data stale", () => {
  const quota = {
    status: "stale" as const,
    usage: { buckets: [{
      bucketKey: "codex",
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 72, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    }] },
  };
  const frame = renderFrame(snapshot(), null, emptyState(), 80, 24, quota);
  const text = plain(frame).join("\n");
  assert.match(text, /Codex stale · 5h 31% · wk 72% · stale · unknown age/);
  assert.equal(frame.length, 24);
});

test("unavailable Codex quota always offers the working manual retry", () => {
  for (const watcher of ["watching", "manual"] as const) {
    const frame = plain(renderFrame(snapshot(), null, emptyState(), 80, 24,
      { status: "unavailable", usage: null, watcher }));
    assert.ok(frame.some(line => line.includes("Codex quota · unavailable · press r to retry")));
  }
});

test("combined dashboard quota never attributes another bucket to Codex", () => {
  for (const [width, height] of [[24, 8], [40, 10], [44, 14], [80, 24], [120, 32]]) {
    for (const bucketKey of ["other", null, "codex"]) {
      const quota = { status: "available" as const, usage: { buckets: [{
        bucketKey, primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: null },
      }] } };
      const frame = renderFrame(snapshot(), null, emptyState(), width, height, quota);
      assertFrame(frame, width, height);
      const text = plain(frame).join("\n");
      if (bucketKey === "codex") assert.match(text, /Codex · 5h 31%/);
      else {
        assert.match(text, width < 32 ? /Codex · no Codex bucket/ : /Codex quota · no codex-labeled bucket/);
        assert.doesNotMatch(text, /31%|72%/);
      }
      if (width >= 44) assert.match(text, /Usage/);
    }
  }
});

test("selected details stay pinned, sessions page by one row and paths retain their tail", () => {
  const snap = snapshot();
  snap.sessions = Array.from({ length: 25 }, (_, index) => ({ ...snap.sessions[0], id: `s${index}`, title: `Task ${index}`, running: index === 0,
    cwd: "/home/operator/" + "long-parent/".repeat(15) + "console-界面" }));
  const state = emptyState();
  const first = renderFrame(snap, null, state, 80, 24);
  handleKey(state, snap, { kind: "pageDown" });
  assert.equal(state.selected, state.pageSize);
  const second = renderFrame(snap, null, state, 80, 24);
  assertFrame(second, 80, 24);
  assert.equal(plain(first)[21], plain(second)[21]);
  assert.match(plain(second)[21], /^ Cwd    ….*console-界面$/);
  assert.equal(plain(second).filter(line => /^> /.test(line)).length, 1);
  assert.ok(plain(second).some(line => line.includes(`Task ${state.selected}`)));
});

test("display-cell helpers preserve graphemes, suffixes and right-side evidence", () => {
  assert.equal(displayWidth("界面"), 4);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("👩🏽‍💻🇺🇸1️⃣"), 6);
  assert.equal(displayWidth("A·─…"), 4);
  assert.equal(elide("界面abc", 5), "界面…");
  assert.equal(elide("e\u0301界abc", 4), "e\u0301界…");
  assert.equal(elide("👩🏽‍💻abcdef", 3), "👩🏽‍💻…");
  assert.equal(elide("界", 1), "…");
  assert.equal(elide("x", 0), "");
  assert.equal(row("界e\u0301", 5), "界e\u0301  ");
  assert.equal(rowLeftRight("long 界面 title", "live", 12), "long …  live");
  assert.equal(pathLabel("/a/long-parent/界面", 6), "…/界面");
  assert.equal(pathLabel("/a", 0), "");
});

test("native metadata and transcript cannot inject terminal controls or extra rows", () => {
  const injected = "safe\nsecond\rthird\x1b[2J\x1b[31mred\x1b[0m\x1b]0;PRIVATE_TITLE\x07\x1b]8;;https://bad\x1b\\link\x1b]8;;\x1b\\\x9b2J\b\u202e";
  assert.equal(oneLine(injected), "safe second thirdredlink");
  const snap = snapshot();
  snap.sessions[0] = { ...snap.sessions[0], title: injected, model: injected, variant: injected, cwd: injected, agent: injected, id: injected };
  snap.pending[0].label = injected;
  snap.usage!.models = [injected];
  for (const [width, height] of [[80, 24], [120, 32], [40, 10], [1, 1], [43, 14], [44, 14]]) {
    assertFrame(renderFrame(snap, injected, emptyState(), width, height), width, height);
    const state = sessionState([{ role: "user", text: injected }, { role: "assistant", text: injected,
      tools: [{ id: "t", name: injected, status: injected }] }]);
    state.view = { kind: "session", runtime: "opencode", sessionId: injected };
    state.transcriptError = injected;
    const frame = renderFrame(snap, injected, state, width, height);
    assertFrame(frame, width, height);
    assert.doesNotMatch(plain(frame).join("\n"), /PRIVATE_TITLE|https:\/\/bad/);
  }
});

for (const [width, height] of [[80, 24], [120, 32], [40, 10]]) {
  test(`streaming roles, compact safe activity and completion at ${width}x${height}`, () => {
    const snap = snapshot();
    snap.pending = [];
    const assistant: TranscriptEntry = { role: "assistant", text: "Partial response", completed: false,
      reasoningParts: Array.from({ length: 32 }, (_, ordinal) => ({ ordinal, status: "active" })),
      tools: [
        { id: "t1", name: "read", status: "completed" }, { id: "t2", name: "read", status: "completed" },
        { id: "t3", name: "shell", status: "running" }, { id: "t4", name: "grep", status: "completed" },
      ] };
    const state = sessionState([{ role: "user", text: "Keep the console read-only." }, assistant]);
    const frame = renderFrame(snap, null, state, width, height);
    assertFrame(frame, width, height);
    const blocks = transcriptLines(state.transcript!, width, true, "build");
    assert.ok(blocks.some(line => line.startsWith(CYAN) && line.includes("0xOperator")));
    assert.ok(blocks.some(line => line.startsWith(CYAN) && line.includes("| Keep the console")));
    assert.ok(blocks.some(line => line.startsWith(BOLD) && line.includes("OpenCode worker")));
    assert.ok(blocks.some(line => line.startsWith(TEXT) && line.includes("Partial response")));
    assert.equal(blocks.filter(line => line.includes("Reasoning · active")).length, 1);
    assert.ok(plain(frame)[width < 44 ? 1 : 2].includes("running · live · reasoning"));
    assert.ok(blocks.some(line => line.includes("shell: running")));
    if (width >= 44) assert.ok(blocks.some(line => line.includes("read: completed x2")));
    else assert.ok(blocks.some(line => line.includes("+3 tools")));
    assert.ok(blocks.filter(line => line.includes("Tools")).length <= (width < 44 ? 1 : 2));

    // Completion changes status in place, not row count or content positions.
    assistant.completed = true;
    assistant.reasoningParts!.forEach(part => { part.status = "ended"; });
    assistant.tools!.forEach(tool => { tool.status = "completed"; });
    snap.sessions[0].running = false;
    snap.sessions[0].outcome = "succeeded";
    const completed = renderFrame(snap, null, state, width, height);
    assertFrame(completed, width, height);
    assert.doesNotMatch(plain(completed).join("\n"), /\blive\b|Reasoning · active/);
    assert.ok(plain(completed).some(line => line.includes("Partial response")));
    assert.equal(transcriptLines(state.transcript!, width).length, blocks.length);
    assert.equal(plain(completed).findIndex(line => line.includes("Partial response")), plain(frame).findIndex(line => line.includes("Partial response")));
  });
}

test("an incomplete historical message or a connected idle backend never implies live generation", () => {
  const snap = snapshot();
  snap.sessions[0].running = false;
  const state = sessionState([{ role: "assistant", completed: false, text: "Unfinished", reasoningParts: [{ ordinal: 0, status: "active" }] }]);
  assert.doesNotMatch(plain(renderFrame(snap, null, state, 80, 24)).join("\n"), /\blive\b/);
  assert.doesNotMatch(plain(renderFrame(snap, null, emptyState(), 80, 24)).join("\n"), /\blive\b/);
  assert.doesNotMatch(plain(transcriptLines(state.transcript!, 80)).join("\n"), /\blive\b/);
});

test("stale or not-ready snapshots never advertise live generation, including tiny transcripts", () => {
  const snap = snapshot();
  const state = sessionState([{ role: "assistant", text: "Cached answer", completed: false }]);
  for (const [width, height] of [[80, 24], [40, 10]]) {
    const stale = renderFrame(snap, "Backend unavailable", state, width, height);
    assertFrame(stale, width, height);
    assert.match(plain(stale).join("\n"), /stale/);
    assert.doesNotMatch(plain(stale).join("\n"), /\blive\b/);
    assertFrame(renderFrame(snap, "Backend unavailable", emptyState(), width, height), width, height);
    snap.ready = false;
    assert.doesNotMatch(plain(renderFrame(snap, null, state, width, height)).join("\n"), /\blive\b/);
    snap.ready = true;
  }
});

test("failed transcript without cached messages reports unavailable rather than loading", () => {
  for (const [width, height] of [[80, 24], [40, 10]]) {
    const state = sessionState([]);
    state.transcript = null;
    state.transcriptError = "Read failed";
    const frame = plain(renderFrame(snapshot(), null, state, width, height)).join("\n");
    assert.match(frame, /Transcript unavailable: Read failed/);
    assert.doesNotMatch(frame, /Loading transcript|No messages recorded/);
  }
  const cached = sessionState([{ role: "assistant", text: "Cached answer", completed: true }]);
  cached.transcriptError = "Read failed";
  const frame = plain(renderFrame(snapshot(), null, cached, 80, 24)).join("\n");
  assert.match(frame, /Transcript stale: Read failed/);
  assert.match(frame, /Cached answer/);
});

test("long model summaries disclose overflow instead of cutting off the last model silently", () => {
  const snap = snapshot();
  snap.usage!.models = ["provider/" + "long-model-name-".repeat(8), "openai/gpt-6.1-sol", "google/gemini-3.1-pro"];
  for (const width of [80, 120]) {
    const frame = renderFrame(snap, null, emptyState(), width, 24);
    assertFrame(frame, width, 24);
    assert.match(plain(frame)[6], /^ Models provider\/.*…  \+2 more$/);
    assert.match(plain(frame)[5], /234\.5k tokens.*\$2\.34.*48 prompts.*136 steps.*4 days.*3 streak/);
  }
});

test("many tools stay within two rows and prioritize current work with an explicit overflow count", () => {
  const tools = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, name: `historical-tool-${index}`, status: "completed" }));
  tools.push({ id: "active", name: "a-very-long-active-tool-name-界面".repeat(3), status: "running" });
  for (const width of [80, 40]) {
    const lines = transcriptLines([{ role: "assistant", text: "Answer", tools }], width);
    const chips = plain(lines).filter(line => line.includes("Tools"));
    assert.equal(chips.length, width === 80 ? 2 : 1);
    assert.ok(chips[0].includes(": running]"));
    assert.match(chips.at(-1)!, /\+\d+ tools$/);
    const shown = chips.join(" ").match(/\[(?:[^\]]+)\]/g)?.length ?? 0;
    const hidden = Number(chips.at(-1)!.match(/\+(\d+) tools/)?.[1]);
    assert.equal(shown + hidden, 31);
  }
});

for (const [width, height] of [[80, 24], [120, 32], [40, 10]]) {
  test(`a small text delta changes only its body row at ${width}x${height}`, () => {
    const snap = snapshot();
    snap.pending = [];
    const entry: TranscriptEntry = { role: "assistant", text: "Partial", completed: false,
      reasoningParts: [{ ordinal: 0, status: "active" }] };
    const state = sessionState([{ role: "user", text: "Review the console." }, entry]);
    const before = renderFrame(snap, null, state, width, height);
    entry.text += " response";
    const after = renderFrame(snap, null, state, width, height);
    assertFrame(after, width, height);
    const changed = after.filter((line, index) => line !== before[index]);
    assert.equal(changed.length, 1);
    assert.ok(changed[0].includes("Partial response"));
    assert.equal(state.follow, true);
  });

  test(`long Unicode transcript preserves tail and stable paused viewport at ${width}x${height}`, () => {
    const snap = snapshot();
    snap.pending = [];
    const entry: TranscriptEntry = { role: "assistant", text: "FIRST\n" + "界面 e\u0301 👩🏽‍💻 long words ".repeat(300) + "\nTAIL", completed: false };
    const state = sessionState([entry]);
    const followed = renderFrame(snap, null, state, width, height);
    assertFrame(followed, width, height);
    assert.ok(plain(followed).includes("  TAIL"));
    handleKey(state, snap, { kind: "pageUp" });
    const paused = renderFrame(snap, null, state, width, height);
    const scroll = state.scroll;
    entry.text += "\nNEW_LATEST";
    assert.deepEqual(renderFrame(snap, null, state, width, height), paused);
    assert.equal(state.scroll, scroll);
    handleKey(state, snap, { kind: "end" });
    const latest = renderFrame(snap, null, state, width, height);
    assertFrame(latest, width, height);
    assert.ok(plain(latest).includes("  NEW_LATEST"));
    assert.ok(state.scroll > scroll);
  });
}

test("wrapping preserves multiline spacing and word boundaries without splitting graphemes", () => {
  const lines = plain(transcriptLines([{ role: "assistant", text: "alpha beta gamma delta\n\n界面e\u0301👩🏽‍💻🇺🇸" }], 14));
  assert.deepEqual(lines.slice(1), ["  alpha beta", "  gamma delta", "", "  界面e\u0301👩🏽‍💻🇺🇸", ""]);
});

// Native top-model statistics may repeat one model across separate variants.
test("usage model summary does not repeat identical model labels", () => {
  const data = snapshot();
  data.usage!.models = ["openai/gpt-6.1-sol", "openai/gpt-6.1-sol", "opencode/space-bunny-free"];
  const frame = plain(renderFrame(data, null, emptyState(), 120, 32));
  const modelRow = frame.find(line => line.startsWith(" Models "))!;
  assert.equal(modelRow.match(/openai\/gpt-6\.1-sol/g)?.length, 1);
  assert.match(modelRow, /opencode\/space-bunny-free/);
  assert.doesNotMatch(modelRow, /\+\d+ more/);
});
