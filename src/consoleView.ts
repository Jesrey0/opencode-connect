// Pure console state, navigation, and rendering. No I/O: src/console.ts owns
// terminal transport, native observation, and message fetching.
import { stripVTControlCharacters } from "node:util";
import type { Runtime } from "./codex.js";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m\x1b[38;5;255m";
export const TEXT = "\x1b[38;5;252m";
export const DIM = "\x1b[38;5;245m";
export const CYAN = "\x1b[38;5;110m";
export const YELLOW = "\x1b[38;5;180m";
export const RED = "\x1b[38;5;203m";

export type ConsoleSession = {
  runtime: Runtime;
  id: string;
  title: string | null;
  running: boolean | null;
  outcome: "succeeded" | "failed" | "interrupted" | "completed" | "incomplete" | null;
  agent: string | null;
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  mode: string | null;
  variant: string | null;
  cwd: string;
  updatedMs: number | null;
};

export type ConsolePending = {
  runtime: Runtime;
  kind: "permission" | "form";
  sessionId: string;
  id: string;
  label: string;
};

export type ConsoleUsage = {
  sessions: number;
  prompts: number;
  steps: number;
  tokensTotal: number;
  costUsd: number;
  activeDays: number;
  streak: number;
  models: string[];
} | null;

export type ConsoleQuota = {
  status: "connecting" | "available" | "stale" | "unavailable";
  usage: { buckets: { bucketKey: string | null; primary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null; secondary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null }[] } | null;
  observedAtMs?: number | null;
  watcher?: "watching" | "manual";
};

export type ConsoleSnapshot = {
  ready: boolean;
  release: string;
  pid: number;
  sessions: ConsoleSession[];
  pending: ConsolePending[];
  usage: ConsoleUsage;
  observedAtMs: number;
  codexVisibility: string;
};

export type TranscriptEntry = {
  role: "user" | "assistant" | "system" | "other";
  text: string;
  messageId?: string;
  textParts?: { ordinal: number; text: string }[];
  completed?: boolean;
  tools?: { id: string; name: string; status: string }[];
  reasoningParts?: { ordinal: number; status: "active" | "ended" | "observed" }[];
  outputTruncated?: boolean;
  previewTruncated?: boolean;
};

export type CodexHistory = { historyComplete: boolean; pageComplete: boolean };
export type View = { kind: "dashboard" } | { kind: "attention" } | { kind: "session"; runtime: Runtime; sessionId: string; fromAttention?: boolean };

export type ConsoleState = {
  view: View;
  selected: number;
  attentionSelected: number;
  activeOnly: boolean;
  scope: "all" | Runtime;
  filter: string;
  filtering: boolean;
  help: boolean;
  quit: boolean;
  scroll: number;
  follow: boolean;
  pageSize: number;
  transcript: TranscriptEntry[] | null;
  transcriptError: string | null;
  codexHistory: CodexHistory | null;
};

export function emptyState(): ConsoleState {
  return { view: { kind: "dashboard" }, selected: 0, attentionSelected: 0, activeOnly: false, scope: "all", filter: "", filtering: false, help: false, quit: false, scroll: 0, follow: true, pageSize: 1, transcript: null, transcriptError: null, codexHistory: null };
}

export function visibleSessions(snapshot: ConsoleSnapshot | null, activeOnly: boolean, scope: ConsoleState["scope"] = "all", filter = ""): ConsoleSession[] {
  if (!snapshot) return [];
  const query = oneLine(filter).toLowerCase();
  return snapshot.sessions.filter((session) => (!activeOnly || session.running === true) &&
    (scope === "all" || session.runtime === scope) &&
    (!query || [session.title, session.id, session.cwd, session.model, session.modelProvider, session.model ? modelLabel(session) : null, session.variant, session.agent, session.mode, session.reasoningEffort]
      .some(value => value !== null && oneLine(value).toLowerCase().includes(query))));
}

function stateSessions(snapshot: ConsoleSnapshot | null, state: ConsoleState): ConsoleSession[] {
  return visibleSessions(snapshot, state.activeOnly, state.scope, state.filter);
}

function refilter(state: ConsoleState, snapshot: ConsoleSnapshot | null, selected: ConsoleSession | undefined): void {
  const sessions = stateSessions(snapshot, state);
  const index = selected ? sessions.findIndex(session => session.runtime === selected.runtime && session.id === selected.id) : -1;
  if (index >= 0) state.selected = index;
  else syncSelection(state, sessions);
}

// Clamp selection against the visible list so navigation state stays
// deterministic as the snapshot changes underneath it.
export function syncSelection(state: ConsoleState, sessions: ConsoleSession[]): void {
  if (sessions.length === 0) state.selected = 0;
  else state.selected = Math.max(0, Math.min(state.selected, sessions.length - 1));
}

export type InputKey =
  | { kind: "char"; value: string }
  | { kind: "enter" }
  | { kind: "backspace" }
  | { kind: "escape" }
  | { kind: "up" } | { kind: "down" } | { kind: "left" } | { kind: "right" }
  | { kind: "pageUp" } | { kind: "pageDown" }
  | { kind: "home" } | { kind: "end" };

const ESCAPE_SEQUENCE_MAX = 32;
const BRACKETED_PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
const PASTE_CANCEL = 0x03;

export class InputDecoder {
  private escape: number[] = [];
  private pasting = false;
  private pasteEndMatched = 0;
  // Any non-empty escape buffer means the terminal may still be sending the
  // rest of a sequence. Reporting it as pending lets the caller arm the flush
  // timer, so a truncated sequence is cleared instead of silently absorbing
  // every later key. Paste state is excluded: an unfinished paste has no
  // sequence to flush and must never be reinterpreted on a timer.
  pendingEscape(): boolean {
    return this.escape.length > 0;
  }
  push(byte: number): InputKey[] {
    if (this.pasting) {
      // Explicit operator recovery for a paste whose end marker never arrives.
      // Raw mode delivers Ctrl-C as a byte, so it is the only in-band escape
      // hatch. It cancels the paste and is not forwarded as input, so pasted
      // shortcuts cannot reach the view. Pasted Ctrl-C ends the paste early;
      // that trade is deliberate and is the point of the hatch.
      if (byte === PASTE_CANCEL) {
        this.pasting = false;
        this.pasteEndMatched = 0;
        return [];
      }
      // Ignore every pasted byte, including shortcuts and line breaks. Track
      // only the fixed end marker; it may be split across stdin chunks.
      if (byte === BRACKETED_PASTE_END[this.pasteEndMatched]) {
        this.pasteEndMatched++;
        if (this.pasteEndMatched === BRACKETED_PASTE_END.length) {
          this.pasting = false;
          this.pasteEndMatched = 0;
        }
      } else {
        this.pasteEndMatched = byte === BRACKETED_PASTE_END[0] ? 1 : 0;
      }
      return [];
    }
    if (this.escape.length === 0) {
      if (byte === 0x1b) { this.escape.push(byte); return []; }
      if (byte === 0x0d || byte === 0x0a) return [{ kind: "enter" }];
      if (byte === 0x7f || byte === 0x08) return [{ kind: "backspace" }];
      if (byte >= 0x20 && byte <= 0x7e) return [{ kind: "char", value: String.fromCharCode(byte) }];
      return [];
    }
    if (this.escape.length === 1) {
      if (byte === 0x5b || byte === 0x4f) { this.escape.push(byte); return []; } // [ or O
      this.escape = [];
      return [];
    }
    if (this.escape.length < ESCAPE_SEQUENCE_MAX) this.escape.push(byte);
    const complete = byte >= 0x40 && byte <= 0x7e;
    if (!complete) return [];
    const sequence = this.escape;
    this.escape = [];
    const body = sequence.slice(2).map((value) => String.fromCharCode(value)).join("");
    switch (body) {
      case "200~":
        if (sequence[1] === 0x5b) this.pasting = true;
        return [];
      case "A": return [{ kind: "up" }];
      case "B": return [{ kind: "down" }];
      case "C": return [{ kind: "right" }];
      case "D": return [{ kind: "left" }];
      case "H": case "1~": case "7~": return [{ kind: "home" }];
      case "F": case "4~": case "8~": return [{ kind: "end" }];
      case "5~": return [{ kind: "pageUp" }];
      case "6~": return [{ kind: "pageDown" }];
      default: return [];
    }
  }
  flushEscape(): InputKey[] {
    // A standalone ESC is a real key. A longer buffer is a truncated sequence
    // that carries no standalone escape, so it is dropped -- but the buffer
    // must still be cleared, otherwise the stale bytes keep consuming keys.
    const standalone = this.escape.length === 1;
    this.escape = [];
    return standalone ? [{ kind: "escape" }] : [];
  }
}

export function sessionStatus(session: ConsoleSession): string {
  if (session.running) return "running";
  if (session.running === null) return "unverified";
  return session.outcome ?? "idle";
}

export function modelLabel(session: ConsoleSession): string {
  if (!session.model) return session.runtime === "codex" ? "unavailable" : "<no model>";
  const model = session.runtime === "codex" && session.modelProvider && !session.model.startsWith(`${session.modelProvider}/`)
    ? `${session.modelProvider}/${session.model}` : session.model;
  return `${model}${session.variant ? `#${session.variant}` : ""}`;
}

function codexSettings(session: ConsoleSession): string {
  return `Mode ${session.mode ?? "unavailable"} · effort ${session.reasoningEffort ?? "unavailable"}`;
}

// Returns true when the key changed view/selection so the caller can refetch
// transcript state. Navigation logic stays deterministic and snapshot-local.
export function handleKey(state: ConsoleState, snapshot: ConsoleSnapshot | null, key: InputKey): boolean {
  if (state.view.kind === "dashboard" && state.filtering) {
    const selected = stateSessions(snapshot, state)[state.selected];
    if (key.kind === "enter") { state.filtering = false; return true; }
    if (key.kind === "escape") { state.filter = ""; state.filtering = false; refilter(state, snapshot, selected); return true; }
    if (key.kind === "backspace") state.filter = state.filter.slice(0, -1);
    else if (key.kind === "char" && /^[\x20-\x7e]$/.test(key.value) && state.filter.length < 128) state.filter += key.value;
    else return false;
    refilter(state, snapshot, selected);
    return true;
  }
  if (key.kind === "char" && key.value === "?") { state.help = !state.help; return true; }
  if (state.help) {
    if (key.kind === "escape" || (key.kind === "char" && key.value === "q")) { state.help = false; return true; }
    return false;
  }
  if (state.view.kind === "attention") {
    const pending = snapshot?.pending ?? [];
    state.attentionSelected = Math.max(0, Math.min(state.attentionSelected, pending.length - 1));
    const previous = state.attentionSelected;
    const char = key.kind === "char" ? key.value : "";
    if (key.kind === "escape" || key.kind === "left" || char === "b" || char === "q" || char === "t") { state.view = { kind: "dashboard" }; return true; }
    if (key.kind === "enter" || key.kind === "right") {
      const target = pending[state.attentionSelected];
      if (!target) return false;
      state.view = { kind: "session", runtime: target.runtime, sessionId: target.sessionId, fromAttention: true };
      state.transcript = null; state.transcriptError = null; state.codexHistory = null; state.scroll = 0; state.follow = true;
      return true;
    }
    if (key.kind === "up" || char === "k") state.attentionSelected--;
    else if (key.kind === "down" || char === "j") state.attentionSelected++;
    else if (key.kind === "pageUp") state.attentionSelected -= state.pageSize;
    else if (key.kind === "pageDown") state.attentionSelected += state.pageSize;
    else if (key.kind === "home" || char === "g") state.attentionSelected = 0;
    else if (key.kind === "end" || char === "G") state.attentionSelected = pending.length - 1;
    else return false;
    state.attentionSelected = Math.max(0, Math.min(state.attentionSelected, pending.length - 1));
    return previous !== state.attentionSelected;
  }
  const sessions = stateSessions(snapshot, state);
  syncSelection(state, sessions);
  if (state.view.kind === "dashboard") {
    const lastIndex = Math.max(0, sessions.length - 1);
    if (key.kind === "char" && key.value === "q") { state.quit = true; return true; }
    if (key.kind === "char" && key.value === "/") { state.filtering = true; return true; }
    if (key.kind === "char" && key.value === "t") { state.view = { kind: "attention" }; return true; }
    if (key.kind === "escape" && state.filter) { state.filter = ""; refilter(state, snapshot, sessions[state.selected]); return true; }
    if (key.kind === "char" && ["1", "2", "3"].includes(key.value)) {
      state.scope = key.value === "1" ? "all" : key.value === "2" ? "opencode" : "codex";
      refilter(state, snapshot, sessions[state.selected]);
      return true;
    }
    if (key.kind === "char" && key.value === "a") {
      state.activeOnly = !state.activeOnly;
      refilter(state, snapshot, sessions[state.selected]);
      return true;
    }
    const previous = state.selected;
    const char = key.kind === "char" ? key.value : "";
    switch (key.kind) {
      case "up":
        state.selected = Math.max(0, state.selected - 1); break;
      case "down":
        state.selected = Math.min(lastIndex, state.selected + 1); break;
      case "pageUp":
        state.selected = Math.max(0, state.selected - state.pageSize); break;
      case "pageDown":
        state.selected = Math.min(lastIndex, state.selected + state.pageSize); break;
      case "home":
        state.selected = 0; break;
      case "end":
        state.selected = Math.max(0, sessions.length - 1); break;
      case "char":
        if (char === "k") state.selected = Math.max(0, state.selected - 1);
        else if (char === "j") state.selected = Math.min(lastIndex, state.selected + 1);
        else if (char === "g") state.selected = 0;
        else if (char === "G") state.selected = Math.max(0, sessions.length - 1);
        else return false;
        break;
      case "enter": case "right": {
        const target = sessions[state.selected];
        if (!target) return false;
        state.view = { kind: "session", runtime: target.runtime, sessionId: target.id };
        state.transcript = null;
        state.transcriptError = null;
        state.codexHistory = null;
        state.scroll = 0;
        state.follow = true;
        return true;
      }
      default: return false;
    }
    return state.selected !== previous;
  }
  // Session transcript view.
  const char2 = key.kind === "char" ? key.value : "";
  switch (key.kind) {
    case "escape": case "left":
      state.view = state.view.fromAttention ? { kind: "attention" } : { kind: "dashboard" };
      state.transcriptError = null;
      return true;
    case "down":
      state.scroll += 1; state.follow = false; return true;
    case "pageDown":
      state.scroll += state.pageSize; state.follow = false; return true;
    case "up":
      state.scroll = Math.max(0, state.scroll - 1); state.follow = false; return true;
    case "pageUp":
      state.scroll = Math.max(0, state.scroll - state.pageSize); state.follow = false; return true;
    case "end":
      state.follow = true; return true;
    case "home":
      state.scroll = 0; state.follow = false; return true;
    case "char":
      if (char2 === "b" || char2 === "q") { state.view = state.view.fromAttention ? { kind: "attention" } : { kind: "dashboard" }; state.transcriptError = null; return true; }
      if (char2 === "j") { state.scroll += 1; state.follow = false; return true; }
      if (char2 === "k") { state.scroll = Math.max(0, state.scroll - 1); state.follow = false; return true; }
      if (char2 === "G") { state.follow = true; return true; }
      if (char2 === "g") { state.scroll = 0; state.follow = false; return true; }
      return false;
    default: return false;
  }
}

function nonnegativeCells(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function elide(text: string, width: number): string {
  width = nonnegativeCells(width);
  text = oneLine(text);
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  return takeCells(text, width - 1) + "…";
}

// Native labels and message text are untrusted terminal data. Only the renderer
// may emit escape sequences. Newlines are retained exclusively for transcript
// wrapping; metadata always goes through oneLine.
function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
}

export function oneLine(text: string): string {
  return safeText(text).replace(/\n+/g, " ");
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// Terminal cells, not UTF-16 units. Ambiguous-width characters stay narrow;
// combining sequences, CJK and emoji are never split. Terminal/font-specific
// glyph widths cannot be inferred, so use the conventional narrow locale.
function cellWidth(cluster: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(cluster)) return 0;
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3|\uFE0F/u.test(cluster)) return 2;
  const cp = cluster.codePointAt(0)!;
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)) ? 2 : 1;
}

export function displayWidth(text: string): number {
  text = oneLine(text);
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let cells = 0;
  for (const { segment } of graphemes.segment(text)) cells += cellWidth(segment);
  return cells;
}

function takeCells(text: string, width: number): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text.slice(0, Math.max(0, width));
  let result = "";
  let cells = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = cellWidth(segment);
    if (cells + size > width) break;
    result += segment;
    cells += size;
  }
  return result;
}

// Keep the directory's meaningful tail instead of repeatedly showing only the
// shared /home/... prefix. This also works for long single path components.
export function pathLabel(path: string, width: number): string {
  width = nonnegativeCells(width);
  path = oneLine(path);
  if (width <= 0) return "";
  if (displayWidth(path) <= width) return path;
  const tail = [...graphemes.segment(path)].map(part => part.segment).reverse();
  let result = "";
  let cells = 1;
  for (const segment of tail) {
    const size = cellWidth(segment);
    if (cells + size > width) break;
    result = segment + result;
    cells += size;
  }
  return "…" + result;
}

export function row(text: string, width: number): string {
  width = nonnegativeCells(width);
  const fitted = elide(text, width);
  return fitted + " ".repeat(Math.max(0, width - displayWidth(fitted)));
}

export function rowLeftRight(left: string, right: string, width: number): string {
  width = nonnegativeCells(width);
  right = elide(right, Math.max(0, width));
  const room = width - displayWidth(right) - 1;
  if (room <= 0) return row(right, width);
  left = elide(left, room);
  return left + " ".repeat(width - displayWidth(left) - displayWidth(right)) + right;
}

export function rule(width: number): string {
  return "─".repeat(nonnegativeCells(width));
}

export function styled(text: string, code: string): string {
  return `${code}${text}${RESET}`;
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const line of safeText(text).split("\n")) {
    if (!line) lines.push("");
    if (/^[\x20-\x7e]*$/.test(line)) {
      for (let start = 0; start < line.length;) {
        let end = Math.min(line.length, start + width);
        if (end < line.length) {
          const space = line.slice(start, end).lastIndexOf(" ");
          if (space > 0) end = start + space + 1;
        }
        lines.push(line.slice(start, end));
        start = end;
      }
      continue;
    }
    // Segment once per logical line, not once per remaining suffix on every
    // wrapped row. Long streamed answers should not acquire quadratic work.
    const parts = [...graphemes.segment(line)].map(({ segment }) => ({ text: segment, cells: cellWidth(segment) }));
    for (let start = 0; start < parts.length;) {
      let end = start;
      let cells = 0;
      let space = -1;
      while (end < parts.length && cells + parts[end].cells <= width) {
        cells += parts[end].cells;
        if (parts[end].text === " ") space = end;
        end++;
      }
      if (end === start) { lines.push("…"); start++; continue; }
      if (end < parts.length && space > start) end = space + 1;
      lines.push(parts.slice(start, end).map(part => part.text).join(""));
      start = end;
    }
  }
  return lines;
}

function reasoningLabel(entry: TranscriptEntry): string {
  const parts = entry.reasoningParts ?? [];
  if (parts.length === 0) return "";
  const status = !entry.completed && parts.some(part => part.status === "active") ? "active"
    : parts.every(part => part.status === "ended") ? "ended" : "observed";
  return `Reasoning · ${status}`;
}

function toolLines(tools: NonNullable<TranscriptEntry["tools"]>, width: number): string[] {
  const groups = new Map<string, { name: string; status: string; count: number }>();
  for (const tool of tools) {
    const name = oneLine(tool.name);
    const status = oneLine(tool.status);
    const key = JSON.stringify([name, status]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { name, status, count: 1 });
  }
  // Active/failing work is more useful than historical successes when the
  // two-row budget is full. Sorting is stable within each priority group.
  const ordered = [...groups.values()].sort((a, b) => toolPriority(b.status) - toolPriority(a.status));
  const rows: string[] = [];
  const prefix = "  Tools ";
  const budget = Math.max(1, width - displayWidth(prefix));
  const limit = width < 44 ? 1 : 2;
  let current: { chip: string; name: string; status: string; count: number }[] = [];
  const joined = () => current.map(item => item.chip).join(" ");
  for (let index = 0; index < ordered.length; index++) {
    const group = ordered[index];
    const size = Math.min(budget, Math.max(24, Math.floor(budget / 2)));
    const chip = toolChip(group, size);
    if (current.length && displayWidth(joined() + " " + chip) > budget) {
      if (rows.length === limit - 1) {
        let count = ordered.slice(index).reduce((sum, group) => sum + group.count, 0);
        while (current.length > 1 && displayWidth(joined() + ` +${count} tools`) > budget) count += current.pop()!.count;
        if (current.length && displayWidth(joined() + ` +${count} tools`) > budget) {
          current[0].chip = toolChip(current[0], Math.max(0, budget - displayWidth(` +${count} tools`)));
        }
        rows.push(row(prefix + joined() + ` +${count} tools`, width));
        return rows;
      }
      rows.push(row(prefix + joined(), width));
      current = [];
    }
    current.push({ chip, ...group });
  }
  if (current.length) rows.push(row(prefix + joined(), width));
  return rows;
}

function toolChip(group: { name: string; status: string; count: number }, width: number): string {
  const suffix = `: ${group.status}${group.count > 1 ? ` x${group.count}` : ""}]`;
  return elide(`[${elide(group.name, width - displayWidth(suffix) - 1)}${suffix}`, width);
}

function toolPriority(status: string): number {
  return status === "running" || status === "pending" ? 2 : status === "error" ? 1 : 0;
}

export function transcriptLines(entries: TranscriptEntry[], width: number, running = false, agent: string | null = null, runtime: Runtime = "opencode"): string[] {
  width = nonnegativeCells(width);
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry.text && !entry.tools?.length && !entry.reasoningParts?.length && !entry.outputTruncated && !entry.previewTruncated && entry.completed !== false) continue;
    const operator = entry.role === "user";
    const label = operator ? "0xOperator" : entry.role === "assistant" ? `${runtime === "codex" ? "Codex" : "OpenCode"} worker${runtime === "opencode" && agent && width >= 60 ? ` · ${oneLine(agent)}` : ""}` : entry.role === "system" ? "System" : "Event";
    const live = running && index === entries.length - 1 && entry.role === "assistant" && entry.completed === false;
    const reasoning = reasoningLabel(entry);
    const activity = reasoning || (live ? "live" : "");
    const heading = ` ${label}`;
    const separator = " " + rule(Math.max(0, width - displayWidth(heading) - 1));
    lines.push(styled(activity ? rowLeftRight(heading, activity + " ", width) : row(heading + separator, width), operator ? CYAN : BOLD));
    for (const line of toolLines(entry.tools ?? [], width)) lines.push(styled(line, DIM));
    const prefix = operator ? "  | " : "  ";
    if (entry.text) for (const line of wrapText(entry.text, Math.max(1, width - prefix.length))) {
      // Wrapping already sanitized and fitted the body. Pad only the visible
      // viewport, rather than repeatedly measuring every cached history row.
      lines.push(styled(width <= prefix.length ? elide(prefix + line, width) : prefix + line, operator ? CYAN : TEXT));
    }
    if (entry.outputTruncated) lines.push(styled(row("  [native output truncated]", width), YELLOW));
    if (entry.previewTruncated) lines.push(styled(row("  [preview truncated]", width), YELLOW));
    lines.push("");
  }
  return lines;
}

function quotaLine(quota: ConsoleQuota | null, width: number): string {
  if (!quota || (quota.status === "connecting" && !quota.usage)) return "Codex quota · connecting…";
  if (quota.status === "unavailable") return "Codex quota · unavailable · press r to retry";
  const bucket = quota.usage?.buckets.find(entry => entry.bucketKey === "codex");
  if (!bucket) {
    const label = width < 32
      ? quota.status === "stale" ? "Codex stale · no bucket" : "Codex · no Codex bucket"
      : `Codex quota · no codex-labeled bucket${quota.status === "stale" ? " · stale" : ""}`;
    return `${label}${quota.watcher === "manual" ? " · r refresh" : ""}`;
  }
  const window = (duration: number) => {
    const item = [bucket?.primary, bucket?.secondary].find(entry => entry?.windowDurationMins === duration);
    if (!item) return null;
    return item.usedPercent === null ? "?%" : `${item.usedPercent}%`;
  };
  const fiveHour = window(300) ?? "unavailable";
  const weekly = window(10080) ?? "unavailable";
  const age = quota.observedAtMs === null || quota.observedAtMs === undefined ? "unknown age" : `${Math.max(0, Math.floor((Date.now() - quota.observedAtMs) / 1000))}s old`;
  const freshness = quota.status === "available" ? age : `stale · ${age}`;
  return `Codex quota${quota.status !== "available" ? " stale" : ""} · 5h ${fiveHour} · wk ${weekly} · ${freshness}${quota.watcher === "manual" ? " · manual · r refresh" : ""}`;
}

function scopeLabel(state: ConsoleState, compact = false): string {
  return ([["1", "all", "All"], ["2", "opencode", compact ? "OC" : "OpenCode"], ["3", "codex", "Codex"]] as const)
    .map(([key, scope, label]) => state.scope === scope ? `[${key} ${label}]` : `${key} ${label}`).join(" ");
}

function filterLabel(state: ConsoleState): string {
  return `${state.filtering ? "/" : "Filter: "}${oneLine(state.filter)}${state.activeOnly ? " · running only" : ""}`;
}

function dashboardFooter(state: ConsoleState, width: number): string {
  const choices = state.filtering
    ? [" Enter apply · Esc clear · Backspace edit", "Enter apply · Esc clear", "Enter · Esc"]
    : [" 1/2/3 scope · / filter · t attention · a running · ↑/↓ select · Enter open · r refresh · ? help · q exit",
      " 1/2/3 scope · / filter · t attention · ↑/↓ select · Enter open · ? help · q exit",
      "↑/↓ Enter · t attention · / · ?", "↑/↓ Enter · t · / · ?"];
  return choices.find(label => displayWidth(label) <= width) ?? choices.at(-1)!;
}

function attentionFooter(width: number): string {
  return [" ↑/↓ select · Enter inspect · Esc back · ? help", "↑/↓ Enter · Esc back · ?", "Enter · Esc back"].find(label => displayWidth(label) <= width) ?? "Enter · Esc";
}

function sessionFooter(state: ConsoleState, width: number): string {
  const choices = [` ${state.follow ? "Latest · following" : "Paused · G latest"} · ↑/↓ scroll · Esc back · ? help`,
    `${state.follow ? "Latest" : "Paused · G latest"} · Esc back · ? help`, "Esc back · ? help"];
  return choices.find(label => displayWidth(label) <= width) ?? choices.at(-1)!;
}

export function renderTiny(snapshot: ConsoleSnapshot | null, error: string | null, state: ConsoleState, width: number, height: number, quota: ConsoleQuota | null = null): string[] {
  width = nonnegativeCells(width);
  height = nonnegativeCells(height);
  if (width <= 0 || height <= 0) return [];
  const connection = error ? "stale" : !snapshot ? "connecting" : snapshot.ready ? "" : "not ready";
  const lines = [styled(row(`opencode connect${connection ? ` · ${connection}` : ""} · read-only`, width), BOLD)];
  if (height === 1) return lines;
  const room = Math.max(0, height - 2);
  if (state.help) {
    const labels = width < 32 ? ["1 all · 2 OC · 3 Codex", "/ filter · Enter apply", "Esc clear · Backspace", "t attention · Enter inspect", "↑/↓ select · Enter open", "a running · r refresh", "? help · q exit"]
      : ["1 all · 2 OpenCode · 3 Codex", "/ filter · Enter apply · Esc clear", "t attention · Enter inspect only", "↑/↓ select · Enter open · a running", "r refresh · ? help · q exit"];
    for (const label of labels) lines.push(row(label, width));
  } else if (state.view.kind === "session") {
    renderSessionView(lines, state, snapshot, width, room, true, !error && Boolean(snapshot?.ready));
  } else if (state.view.kind === "attention") {
    renderAttention(lines, state, snapshot, width, room, Boolean(error || (snapshot && !snapshot.ready)));
  } else {
    const sessions = stateSessions(snapshot, state);
    syncSelection(state, sessions);
    if (snapshot && !(error && height <= 6)) {
      const oc = snapshot.sessions.filter(s => s.runtime === "opencode").length;
      const codex = snapshot.sessions.filter(s => s.runtime === "codex").length;
      const running = snapshot.sessions.filter(s => s.running === true).length;
      lines.push(styled(row(width < 32 ? `OC:${oc} C:${codex} run:${running} pend:${snapshot.pending.length}` : `OC ${oc} · Codex ${codex} · ${running} running · ${snapshot.pending.length} pending`, width), TEXT));
    }
    lines.push(styled(row(scopeLabel(state, width < 32), width), BOLD));
    if (state.filter || state.filtering || state.activeOnly) lines.push(styled(row(filterLabel(state), width), CYAN));
    if (error) lines.push(styled(row(`Stale: ${error}`, width), RED));
    const selected = sessions[state.selected];
    if (selected) {
      if (width < 32) {
        lines.push(styled(row(`> ${selected.title ?? "Untitled"}`, width), BOLD));
        lines.push(styled(row(`  ${selected.runtime} · ${sessionStatus(selected)}`, width), DIM));
      } else {
        lines.push(styled(row(`> ${selected.runtime} · ${sessionStatus(selected)} · ${selected.title ?? "Untitled"}`, width), BOLD));
      }
    } else {
      lines.push(styled(row(state.scope !== "all" || state.activeOnly || state.filter ? "No sessions match active filters" : "No sessions observed yet", width), DIM));
    }
    if (quota) lines.push(styled(row(quotaLine(quota, width), width), quota.status !== "available" ? YELLOW : DIM));
    if (selected) {
      lines.push(styled(row(`Model ${modelLabel(selected)}`, width), DIM));
      if (selected.runtime === "codex") lines.push(styled(row(codexSettings(selected), width), DIM));
      lines.push(styled(row(`Cwd ${pathLabel(selected.cwd, width - 4)}`, width), DIM));
    }
    if (snapshot) lines.push(styled(row(`Codex · ${snapshot.codexVisibility}`, width), DIM));
    state.pageSize = 1;
  }
  lines.length = Math.min(lines.length, height - 1);
  while (lines.length < height - 1) lines.push(row("", width));
  const footer = state.help ? "? / Esc close help"
    : state.view.kind === "session" ? sessionFooter(state, width)
      : state.view.kind === "attention" ? attentionFooter(width)
      : dashboardFooter(state, width);
  lines.push(styled(row(footer, width), DIM));
  return lines;
}

export function renderFrame(snapshot: ConsoleSnapshot | null, error: string | null, state: ConsoleState, width: number, height: number, quota: ConsoleQuota | null = null): string[] {
  width = nonnegativeCells(width);
  height = nonnegativeCells(height);
  const sessions = stateSessions(snapshot, state);
  syncSelection(state, sessions);
  if (width < 44 || height < 14) return renderTiny(snapshot, error, state, width, height, quota);

  const connection = snapshot && !error ? snapshot.ready ? "connected" : "not ready" : snapshot ? "stale · reconnecting" : "connecting";
  const lines: string[] = [
    styled(rowLeftRight("  opencode connect", `observer · ${connection} · read-only `, width), BOLD),
    styled(rule(width), DIM),
  ];
  const bodyHeight = Math.max(0, height - 4 - (error ? 2 : 0));
  const bodyStart = lines.length;

  if (state.help) {
    for (const label of [
      " shortcuts",
      " 1 all · 2 OpenCode · 3 Codex · a running",
      " t attention · inspect pending requests only",
      " / filter · Enter apply · Esc clear",
      " Backspace edit · ↑/↓ or j/k select",
      " Enter open · PgUp/PgDn page",
      " Home/g first · End/G last",
      " transcript ↑/↓ scroll · PgUp/PgDn page",
      " Home/g start · End/G follow latest",
      " Esc/←/b/q back · r refresh on dashboard",
      " ? close help · q exit from dashboard",
    ]) {
      lines.push(styled(row(label, width), label === " shortcuts" ? BOLD : TEXT));
    }
  } else if (state.view.kind === "session") {
    renderSessionView(lines, state, snapshot, width, bodyHeight, false, !error && Boolean(snapshot?.ready));
  } else if (state.view.kind === "attention") {
    renderAttention(lines, state, snapshot, width, bodyHeight, Boolean(error || (snapshot && !snapshot.ready)));
  } else {
    renderDashboard(lines, state, snapshot, sessions, width, bodyHeight, quota);
  }

  lines.length = Math.min(lines.length, bodyStart + bodyHeight);
  while (lines.length < bodyStart + bodyHeight) lines.push(row("", width));

  if (error) {
    lines.push(styled(rule(width), RED));
    lines.push(styled(row(` Read error · ${oneLine(error)}`, width), RED));
  }
  lines.push(styled(rule(width), DIM));
  const footer = state.help
    ? " ? / Esc close help"
    : state.view.kind === "session"
      ? sessionFooter(state, width)
      : state.view.kind === "attention" ? attentionFooter(width)
      : dashboardFooter(state, width);
  lines.push(styled(row(footer, width), DIM));
  return lines;
}

function renderAttention(lines: string[], state: ConsoleState, snapshot: ConsoleSnapshot | null, width: number, height: number, stale: boolean): void {
  const start = lines.length;
  const pending = snapshot?.pending ?? [];
  state.attentionSelected = Math.max(0, Math.min(state.attentionSelected, pending.length - 1));
  lines.push(styled(row(` Attention${stale ? " stale" : ""} · ${snapshot ? pending.length : "?"} observed`, width), BOLD));
  lines.push(styled(row(width >= 60 ? " Partial visibility · OpenCode active only · Codex supervised only · inspect only" : " Partial · inspect only", width), YELLOW));
  if (!snapshot) lines.push(styled(row(" Pending requests unavailable", width), DIM));
  else if (!pending.length) lines.push(styled(row(" No pending requests observed", width), DIM));
  else {
    const capacity = Math.max(1, height - (lines.length - start));
    state.pageSize = capacity;
    const first = Math.max(0, Math.min(state.attentionSelected - capacity + 1, pending.length - capacity));
    for (let index = first; index < Math.min(first + capacity, pending.length); index++) {
      const item = pending[index];
      const session = snapshot.sessions.find(entry => entry.runtime === item.runtime && entry.id === item.sessionId);
      const label = width < 32 ? `${item.runtime === "opencode" ? "OC" : "Codex"} ${item.kind} ${session?.title ?? item.sessionId}` : `${item.runtime} · ${item.kind} · ${session?.title ?? item.sessionId}`;
      lines.push(styled(row(`${index === state.attentionSelected ? ">" : " "} ${label}`, width), index === state.attentionSelected ? BOLD : TEXT));
    }
  }
}

function renderDashboard(lines: string[], state: ConsoleState, snapshot: ConsoleSnapshot | null, sessions: ConsoleSession[], width: number, height: number, quota: ConsoleQuota | null): void {
  const start = lines.length;
  const pending = snapshot?.pending ?? [];
  const running = snapshot?.sessions.filter(session => session.running === true).length ?? 0;
  const summary = snapshot ? ` ${width < 50 ? "OC" : "OpenCode"} ${snapshot.sessions.filter(s => s.runtime === "opencode").length} · Codex ${snapshot.sessions.filter(s => s.runtime === "codex").length} · ${running} running · ${pending.length} pending` : " Connecting…";
  lines.push(styled(rowLeftRight(summary, snapshot && width >= 90 ? `opencode ${snapshot.release} · pid ${snapshot.pid} ` : "", width), pending.length ? YELLOW : BOLD));
  if (snapshot) lines.push(styled(row(` Codex · ${snapshot.codexVisibility}`, width), DIM));
  if (pending.length) {
    const first = pending[0];
    lines.push(styled(row(` Needs 0xOperator · ${first.kind}: ${first.label}${pending.length > 1 ? ` (+${pending.length - 1} more)` : ""}`, width), YELLOW));
  }
  if (snapshot?.usage) {
    const usage = snapshot.usage;
    lines.push(styled(rowLeftRight(` OpenCode usage ${compactNumber(usage.tokensTotal)} tokens · $${usage.costUsd.toFixed(2)} · ${compactNumber(usage.prompts)} prompts · ${compactNumber(usage.steps)} steps`, width >= 90 ? `${usage.activeDays} days · ${usage.streak} streak ` : "", width), TEXT));
    if (usage.models.length && height >= 14) {
      const models: string[] = [];
      const rankedModels = [...new Set(usage.models.map(oneLine))];
      const prefix = " Models ";
      for (const [index, model] of rankedModels.entries()) {
        const suffix = index < rankedModels.length - 1 ? `  +${rankedModels.length - index - 1} more` : "";
        const candidate = [...models, model].join(", ");
        if (displayWidth(prefix + candidate + suffix) > width && models.length) break;
        models.push(elide(model, width - displayWidth(prefix + suffix)));
      }
      const more = rankedModels.length - models.length;
      lines.push(styled(row(prefix + models.join(", ") + (more ? `  +${more} more` : ""), width), DIM));
    }
  } else {
    lines.push(styled(row(" OpenCode usage · unavailable", width), DIM));
  }
  lines.push(quota ? styled(row(` ${quotaLine(quota, width)}`, width), quota.status !== "available" ? YELLOW : DIM) : row("", width));
  lines.push(styled(row(` Sessions  ${scopeLabel(state)} · ${sessions.length} shown`, width), BOLD));
  if (state.filter || state.filtering || state.activeOnly) lines.push(styled(row(` ${filterLabel(state)}`, width), CYAN));
  if (sessions.length === 0) {
    lines.push(styled(row(state.scope !== "all" || state.activeOnly || state.filter ? " No sessions match active filters." : " No sessions observed yet. Start work through ChatGPT or the native client.", width), DIM));
    return;
  }
  const selected = sessions[state.selected];
  const detail: string[] = selected ? [
    ...(selected.runtime === "codex" && selected.running === null
      ? [styled(row(" Codex · execution outcome unverified", width), YELLOW)] : []),
    selected.runtime === "codex"
      ? styled(rowLeftRight(` Model  ${modelLabel(selected)}`, `${shortId(selected.id)} `, width), TEXT)
      : styled(row(` Model  ${modelLabel(selected)}`, width), TEXT),
    ...(selected.runtime === "codex"
      ? [styled(row(` ${codexSettings(selected)}`, width), DIM)]
      : [styled(rowLeftRight(` Agent  ${selected.agent ?? "<unset>"}`, `${shortId(selected.id)} `, width), DIM)]),
    styled(row(` Cwd    ${pathLabel(selected.cwd, width - 8)}`, width), DIM),
  ] : [];
  const available = height - (lines.length - start);
  // In shorter terminals, keep the inventory useful before reserving a detail pane.
  const detailHeight = available >= detail.length + Math.min(4, sessions.length) + 2 ? detail.length + 1 : 0;
  const capacity = Math.max(1, available - detailHeight - 1);
  state.pageSize = capacity;
  const first = Math.max(0, Math.min(state.selected - capacity + 1, sessions.length - capacity));
  for (let index = first; index < Math.min(first + capacity, sessions.length); index += 1) {
    const session = sessions[index];
    const selectedRow = index === state.selected;
    const marker = selectedRow ? ">" : " ";
    const title = session.title ?? "Untitled";
    const waiting = pending.some((action) => action.runtime === session.runtime && action.sessionId === session.id);
    const label = `${marker} ${session.runtime.padEnd(8)} ${sessionStatus(session).padEnd(11)} ${title}`;
    lines.push(styled(waiting ? rowLeftRight(label, "pending ", width) : row(label, width), selectedRow ? BOLD : session.running ? TEXT : DIM));
  }
  lines.push(styled(row(` ${first + 1}–${Math.min(first + capacity, sessions.length)} of ${sessions.length} · selected ${state.selected + 1}`, width), DIM));
  if (detailHeight > 0) {
    while (lines.length - start < height - detailHeight) lines.push(row("", width));
    lines.push(styled(rule(width), DIM));
    lines.push(...detail);
  }
}

function renderSessionView(lines: string[], state: ConsoleState, snapshot: ConsoleSnapshot | null, width: number, height: number, compact: boolean, fresh: boolean): void {
  const start = lines.length;
  const session = snapshot?.sessions.find((entry) => state.view.kind === "session" && entry.runtime === state.view.runtime && entry.id === state.view.sessionId);
  const runtime = state.view.kind === "session" ? state.view.runtime : "opencode";
  const running = session?.running ?? false;
  const live = runtime === "opencode" && Boolean(running) && fresh;
  const latest = state.transcript?.at(-1);
  const phase = latest?.role === "assistant" && latest.completed === false
    ? latest.reasoningParts?.some(part => part.status === "active") ? " · reasoning"
      : latest.tools?.some(tool => tool.status === "running" || tool.status === "pending") ? " · tools" : ""
    : "";
  lines.push(styled(rowLeftRight(` ${runtime} · ${session?.title ?? (state.view.kind === "session" ? state.view.sessionId : "?")}`, live ? `running · live${phase} ` : `${session ? sessionStatus(session) : "unavailable"}${session && !fresh ? " · stale" : ""} `, width), BOLD));
  if (runtime === "codex") {
    lines.push(styled(row(" Bounded history previews · no live deltas", width), DIM));
    lines.push(styled(row(` Execution evidence · ${!session ? "unavailable" : session.running === null ? "unknown" : "verified"}${session && !fresh ? " · stale" : ""}`, width), DIM));
    const history = state.codexHistory;
    const status = history ? `native ${history.historyComplete ? "complete" : "incomplete"} · page ${history.pageComplete ? "complete" : "limited"}` : state.transcriptError ? "unavailable" : "loading";
    lines.push(styled(row(` History · ${status}${history && state.transcriptError ? " · stale" : ""}`, width), DIM));
    if (state.transcript && !compact) {
      const output = state.transcript.filter(entry => entry.outputTruncated).length;
      const preview = state.transcript.filter(entry => entry.previewTruncated).length;
      lines.push(styled(row(` Page truncation · native output ${output} · preview ${preview}`, width), DIM));
    }
  }
  if (!compact && runtime === "codex" && session?.running === null) {
    lines.push(styled(row(" Codex · execution outcome unverified", width), YELLOW));
  }
  if (session) {
    const identity = session.runtime === "codex"
      ? `${modelLabel(session)} · ${codexSettings(session).toLowerCase()}`
      : `${modelLabel(session)}${compact ? "" : ` · agent ${session.agent ?? "<unset>"}`}`;
    lines.push(styled(row(` ${identity}`, width), DIM));
    if (!compact) lines.push(styled(row(` Cwd ${pathLabel(session.cwd, width - 5)}`, width), DIM));
  }
  const pending = (snapshot?.pending ?? []).filter((action) => session && action.runtime === session.runtime && action.sessionId === session.id);
  if (pending.length) lines.push(styled(row(` Pending ${pending.length} · ${pending[0].kind}: ${pending[0].label}`, width), YELLOW));
  if (state.transcriptError) {
    lines.push(styled(row(` Transcript ${state.transcript !== null ? "stale" : "unavailable"}: ${oneLine(state.transcriptError)}`, width), RED));
  }
  if (!compact) lines.push(styled(rule(width), DIM));
  const rendered = transcriptLines(state.transcript ?? [], width, live, session?.agent ?? null, runtime);
  const room = Math.max(0, height - (lines.length - start));
  const maxScroll = Math.max(0, rendered.length - room);
  const offset = state.follow ? maxScroll : Math.min(state.scroll, maxScroll);
  state.scroll = offset;
  state.pageSize = Math.max(1, room);
  const shown = rendered.slice(offset, offset + room);
  if (shown.length === 0) {
    if (!state.transcriptError) {
      lines.push(styled(row(state.transcript === null ? " Loading transcript…" : runtime === "codex" ? " No messages in this bounded replay." : " No messages recorded yet.", width), DIM));
    }
  } else {
    for (const line of shown) {
      lines.push(line + " ".repeat(Math.max(0, width - displayWidth(line))));
    }
  }
  lines.length = Math.min(lines.length, start + height);
}
