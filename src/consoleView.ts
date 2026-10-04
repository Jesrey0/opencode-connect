// Pure console state, navigation, and rendering. No I/O: src/console.ts owns
// terminal transport, native observation, and message fetching.

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m\x1b[38;5;255m";
export const TEXT = "\x1b[38;5;252m";
export const DIM = "\x1b[38;5;245m";
export const CYAN = "\x1b[38;5;250m";
export const YELLOW = "\x1b[38;5;180m";
export const RED = "\x1b[38;5;203m";

export type ConsoleSession = {
  id: string;
  title: string | null;
  running: boolean;
  outcome: "succeeded" | "failed" | "interrupted" | null;
  agent: string | null;
  model: string | null;
  variant: string | null;
  cwd: string;
  updatedMs: number;
};

export type ConsolePending = {
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

export type ConsoleSnapshot = {
  ready: boolean;
  release: string;
  pid: number;
  sessions: ConsoleSession[];
  pending: ConsolePending[];
  usage: ConsoleUsage;
  observedAtMs: number;
};

export type TranscriptEntry = {
  role: "user" | "assistant" | "system" | "other";
  text: string;
  messageId?: string;
  textParts?: { ordinal: number; text: string }[];
  completed?: boolean;
  tools?: { id: string; name: string; status: string }[];
  reasoningParts?: { ordinal: number; status: "active" | "ended" | "observed" }[];
};

export type View = { kind: "dashboard" } | { kind: "session"; sessionId: string };

export type ConsoleState = {
  view: View;
  selected: number;
  activeOnly: boolean;
  help: boolean;
  quit: boolean;
  scroll: number;
  follow: boolean;
  pageSize: number;
  transcript: TranscriptEntry[] | null;
  transcriptError: string | null;
};

export function emptyState(): ConsoleState {
  return { view: { kind: "dashboard" }, selected: 0, activeOnly: false, help: false, quit: false, scroll: 0, follow: true, pageSize: 1, transcript: null, transcriptError: null };
}

export function visibleSessions(snapshot: ConsoleSnapshot | null, activeOnly: boolean): ConsoleSession[] {
  if (!snapshot) return [];
  return snapshot.sessions.filter((session) => !activeOnly || session.running);
}

// Clamp selection against the visible list so navigation state stays
// deterministic as the snapshot changes underneath it.
export function syncSelection(state: ConsoleState, sessions: ConsoleSession[]): void {
  if (sessions.length === 0) state.selected = 0;
  else state.selected = Math.min(state.selected, sessions.length - 1);
}

export type InputKey =
  | { kind: "char"; value: string }
  | { kind: "enter" }
  | { kind: "escape" }
  | { kind: "up" } | { kind: "down" } | { kind: "left" } | { kind: "right" }
  | { kind: "pageUp" } | { kind: "pageDown" }
  | { kind: "home" } | { kind: "end" };

const ESCAPE_SEQUENCE_MAX = 32;

export class InputDecoder {
  private escape: number[] = [];
  pendingEscape(): boolean {
    return this.escape.length > 0;
  }
  push(byte: number): InputKey[] {
    if (this.escape.length === 0) {
      if (byte === 0x1b) { this.escape.push(byte); return []; }
      if (byte === 0x0d || byte === 0x0a) return [{ kind: "enter" }];
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
    const standalone = this.escape.length === 1;
    this.escape = [];
    return standalone ? [{ kind: "escape" }] : [];
  }
}

export function sessionStatus(session: ConsoleSession): string {
  if (session.running) return "running";
  return session.outcome ?? "idle";
}

export function modelLabel(session: ConsoleSession): string {
  return session.model ? `${session.model}${session.variant ? `#${session.variant}` : ""}` : "<no model>";
}

// Returns true when the key changed view/selection so the caller can refetch
// transcript state. Navigation logic stays deterministic and snapshot-local.
export function handleKey(state: ConsoleState, snapshot: ConsoleSnapshot | null, key: InputKey): boolean {
  if (key.kind === "char" && key.value === "?") { state.help = !state.help; return true; }
  if (state.help) {
    if (key.kind === "escape" || (key.kind === "char" && key.value === "q")) { state.help = false; return true; }
    return false;
  }
  const sessions = visibleSessions(snapshot, state.activeOnly);
  syncSelection(state, sessions);
  if (state.view.kind === "dashboard") {
    if (key.kind === "char" && key.value === "q") { state.quit = true; return true; }
    if (key.kind === "char" && key.value === "a") {
      state.activeOnly = !state.activeOnly;
      syncSelection(state, visibleSessions(snapshot, state.activeOnly));
      return true;
    }
    const previous = state.selected;
    const char = key.kind === "char" ? key.value : "";
    switch (key.kind) {
      case "up":
        state.selected = Math.max(0, state.selected - 1); break;
      case "down":
        state.selected = Math.min(sessions.length - 1, state.selected + 1); break;
      case "pageUp":
        state.selected = Math.max(0, state.selected - state.pageSize); break;
      case "pageDown":
        state.selected = Math.min(sessions.length - 1, state.selected + state.pageSize); break;
      case "home":
        state.selected = 0; break;
      case "end":
        state.selected = Math.max(0, sessions.length - 1); break;
      case "char":
        if (char === "k") state.selected = Math.max(0, state.selected - 1);
        else if (char === "j") state.selected = Math.min(sessions.length - 1, state.selected + 1);
        else if (char === "g") state.selected = 0;
        else if (char === "G") state.selected = Math.max(0, sessions.length - 1);
        else return false;
        break;
      case "enter": case "right": {
        const target = sessions[state.selected];
        if (!target) return false;
        state.view = { kind: "session", sessionId: target.id };
        state.transcript = null;
        state.transcriptError = null;
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
      state.view = { kind: "dashboard" };
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
      if (char2 === "b" || char2 === "q") { state.view = { kind: "dashboard" }; state.transcriptError = null; return true; }
      if (char2 === "j") { state.scroll += 1; state.follow = false; return true; }
      if (char2 === "k") { state.scroll = Math.max(0, state.scroll - 1); state.follow = false; return true; }
      if (char2 === "G") { state.follow = true; return true; }
      if (char2 === "g") { state.scroll = 0; state.follow = false; return true; }
      return false;
    default: return false;
  }
}

export function elide(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return text.slice(0, width - 1) + "…";
}

export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

export function row(text: string, width: number): string {
  return elide(text, width).padEnd(Math.max(0, width));
}

export function rowLeftRight(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - left.length - right.length);
  return elide(left + " ".repeat(gap) + right, width).padEnd(Math.max(0, width));
}

export function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
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
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line) lines.push("");
    for (let offset = 0; offset < line.length; offset += width) lines.push(line.slice(offset, offset + width));
  }
  return lines;
}

export function transcriptLines(entries: TranscriptEntry[], width: number): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.text && !entry.tools?.length && !entry.reasoningParts?.length) continue;
    const label = entry.role === "user" ? "0xOperator" : entry.role === "assistant" ? "OpenCode worker" : entry.role === "system" ? "System" : "Event";
    lines.push(styled(` ${label}`, DIM));
    for (const part of entry.reasoningParts ?? []) lines.push(styled(row(`  Reasoning · ${part.status}`, width), DIM));
    for (const line of wrapText(entry.text, Math.max(8, width - 2))) lines.push(`  ${line}`);
    for (const tool of entry.tools ?? []) lines.push(styled(`  ${oneLine(tool.name)} · ${tool.status}`, DIM));
    lines.push("");
  }
  return lines;
}

export function renderTiny(snapshot: ConsoleSnapshot | null, error: string | null, state: ConsoleState, width: number, height: number): string[] {
  if (width === 0 || height === 0) return [];
  const labels: string[] = ["opencode connect · read-only"];
  if (error) labels.push(`Backend: ${oneLine(error)}`);
  if (state.view.kind === "session") {
    if (state.transcriptError) labels.push(`Transcript stale: ${oneLine(state.transcriptError)}`);
    labels.push(`${state.transcript?.length ?? 0} messages · ${state.follow ? "following" : "paused"}`);
  } else {
    const sessions = visibleSessions(snapshot, state.activeOnly);
    labels.push(`${sessions.length} sessions · ${snapshot?.pending.length ?? 0} pending`);
    const selected = sessions[state.selected];
    if (selected) labels.push(`Selected ${shortId(selected.id)} · ${sessionStatus(selected)}`);
  }
  if (state.help) labels.push("↑/↓ select · Enter open · a filter · Esc back · q exit");
  labels.push("? help · Ctrl-C exit");
  return labels.slice(0, height).map((line) => elide(oneLine(line), width));
}

export function renderFrame(snapshot: ConsoleSnapshot | null, error: string | null, state: ConsoleState, width: number, height: number): string[] {
  const sessions = visibleSessions(snapshot, state.activeOnly);
  syncSelection(state, sessions);
  if (width < 44 || height < 14) return renderTiny(snapshot, error, state, width, height);

  const connection = snapshot && !error ? "live" : snapshot ? "stale · reconnecting" : "connecting";
  const lines: string[] = [
    styled(rowLeftRight("  opencode connect", `observer · ${connection} · read-only `, width), BOLD),
    styled(rule(width), DIM),
  ];
  const bodyHeight = Math.max(0, height - 4 - (error ? 2 : 0));
  const bodyStart = lines.length;

  if (state.help) {
    for (const label of [
      " shortcuts",
      "",
      " sessions  ↑/↓ or j/k select · Enter open",
      "           a active/all · Home/End or g/G first/last",
      "           PgUp/PgDn move one page",
      " transcript ↑/↓ or j/k scroll · PgUp/PgDn page",
      "           Home/g start · End/G follow latest",
      "           Esc/←/b/q back to sessions",
      " general   ? help · q exit from sessions · Ctrl-C exit",
      "",
      " read-only resolve actions through ChatGPT or the native client",
    ]) {
      lines.push(styled(row(label, width), label === " shortcuts" ? BOLD : TEXT));
    }
  } else if (state.view.kind === "session") {
    renderSessionView(lines, state, snapshot, width, bodyHeight);
  } else {
    renderDashboard(lines, state, snapshot, sessions, width, bodyHeight);
  }

  lines.length = Math.min(lines.length, bodyStart + bodyHeight);
  while (lines.length < bodyStart + bodyHeight) lines.push(row("", width));

  if (error) {
    lines.push(styled(rule(width), RED));
    lines.push(styled(row(` Read error · ${oneLine(error)}`, width), RED));
  }
  lines.push(styled(rule(width), DIM));
  const footer = state.help
    ? " ? / Esc close help · Ctrl-C exit"
    : state.view.kind === "session"
      ? ` ${state.follow ? "Following" : "Paused · G follow"} · ↑/↓ scroll · Esc back · ? help`
      : width >= 90
        ? " ↑/↓ select · Enter open · a active/all · PgUp/PgDn page · ? help · q exit"
        : " ↑/↓ select · Enter open · ? help · q exit";
  lines.push(styled(row(footer, width), DIM));
  return lines;
}

function renderDashboard(lines: string[], state: ConsoleState, snapshot: ConsoleSnapshot | null, sessions: ConsoleSession[], width: number, height: number): void {
  const start = lines.length;
  const ready = snapshot?.ready ?? false;
  lines.push(styled(rowLeftRight(` ${ready ? "●" : "○"}  ${snapshot ? `opencode ${snapshot.release} · pid ${snapshot.pid}` : "connecting…"}`, `sessions ${sessions.filter((s) => s.running).length} running · ${sessions.length} shown `, width), ready ? DIM : RED));
  if (snapshot?.usage) {
    const usage = snapshot.usage;
    lines.push(styled(row(` Usage · ${usage.sessions} sessions · ${usage.prompts} prompts · ${usage.steps} steps · ${compactNumber(usage.tokensTotal)} tok · $${usage.costUsd.toFixed(2)} · ${usage.activeDays} active days · streak ${usage.streak}`, width), TEXT));
    if (usage.models.length > 0) lines.push(styled(row(` Models · ${usage.models.slice(0, 4).join(", ")}`, width), DIM));
  } else {
    lines.push(styled(row(" Usage · unavailable", width), DIM));
  }
  const pending = snapshot?.pending ?? [];
  if (pending.length > 0) {
    lines.push(styled(row(` Needs 0xOperator · ${pending.length} pending · resolve through ChatGPT or the native client`, width), YELLOW));
    if (height - (lines.length - start) >= 8) {
      const first = pending[0];
      lines.push(styled(row(` ${first.kind} · session ${shortId(first.sessionId)} · ${first.label}`, width), YELLOW));
    }
  }
  if (height - (lines.length - start) >= 6) lines.push(row("", width));
  lines.push(styled(rowLeftRight(` sessions  ${sessions.filter((s) => s.running).length} running · ${sessions.length} shown`, `${state.activeOnly ? "active only" : "all"} `, width), BOLD));
  if (sessions.length === 0) {
    lines.push(styled(row(state.activeOnly ? " No running sessions. Press a to show recent work." : " No sessions observed yet. Start work through ChatGPT or the native client.", width), DIM));
    return;
  }
  const selected = sessions[state.selected];
  const detail: string[] = selected ? [
    styled(row(` ${selected.id}`, width), DIM),
    styled(row(` ${modelLabel(selected)} · agent ${selected.agent ?? "<unset>"}`, width), DIM),
    styled(row(` ${selected.cwd}`, width), DIM),
  ] : [];
  const available = height - (lines.length - start);
  const detailHeight = available >= detail.length + 6 ? detail.length + 1 : 0;
  const capacity = Math.max(1, Math.floor((available - detailHeight - 1) / 2));
  state.pageSize = capacity;
  const first = Math.max(0, Math.min(state.selected - capacity + 1, sessions.length - capacity));
  for (let index = first; index < Math.min(first + capacity, sessions.length); index += 1) {
    const session = sessions[index];
    const selectedRow = index === state.selected;
    const marker = selectedRow ? "▸" : " ";
    const title = session.title ?? "<untitled>";
    const waiting = pending.some((action) => action.sessionId === session.id);
    lines.push(styled(row(`${marker} ${title}${waiting ? " ⚠" : ""}`, width), selectedRow ? BOLD : TEXT));
    lines.push(styled(row(`    ${sessionStatus(session)} · ${modelLabel(session)} · ${session.agent ?? "<unset>"} · ${session.cwd}`, width), selectedRow ? CYAN : DIM));
  }
  lines.push(styled(row(` ${first + 1}–${Math.min(first + capacity, sessions.length)} of ${sessions.length} · selected ${state.selected + 1}`, width), DIM));
  if (detailHeight > 0) {
    while (lines.length - start < height - detailHeight) lines.push(row("", width));
    lines.push(styled(rule(width), DIM));
    lines.push(...detail);
  }
}

function renderSessionView(lines: string[], state: ConsoleState, snapshot: ConsoleSnapshot | null, width: number, height: number): void {
  const start = lines.length;
  const session = snapshot?.sessions.find((entry) => state.view.kind === "session" && entry.id === state.view.sessionId);
  lines.push(styled(row(` ${session?.title ?? (state.view.kind === "session" ? state.view.sessionId : "?")}`, width), BOLD));
  if (session) {
    lines.push(styled(row(` ${sessionStatus(session)} · ${modelLabel(session)} · agent ${session.agent ?? "<unset>"} · ${session.cwd}`, width), DIM));
  }
  const pending = (snapshot?.pending ?? []).filter((action) => session && action.sessionId === session.id);
  for (const action of pending) lines.push(styled(row(` ⚠ ${action.kind} · ${action.label}`, width), YELLOW));
  if (state.transcriptError) lines.push(styled(row(` Transcript stale: ${oneLine(state.transcriptError)}`, width), RED));
  const rendered = transcriptLines(state.transcript ?? [], width);
  const room = Math.max(0, height - (lines.length - start));
  const maxScroll = Math.max(0, rendered.length - room);
  const offset = state.follow ? maxScroll : Math.min(state.scroll, maxScroll);
  state.scroll = offset;
  state.pageSize = Math.max(1, room);
  const shown = rendered.slice(offset, offset + room);
  if (shown.length === 0) {
    lines.push(styled(row(state.transcript === null ? " Loading transcript…" : " No messages recorded yet.", width), DIM));
  } else {
    for (const line of shown) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
      lines.push(visible.length <= width ? line + " ".repeat(width - visible.length) : elide(visible, width));
    }
  }
  lines.length = Math.min(lines.length, start + height);
}
