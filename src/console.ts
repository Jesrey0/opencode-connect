// Native terminal console. Observes canonical runtime state through
// the native client only; pure state/render logic lives in consoleView.ts.
import { type OpenCodeClient, type OpenCodeEvent, type SessionMessageInfo } from "@opencode/client";
import { connectNative } from "./native.js";
import { observeCodexQuota } from "./codexQuota.js";
import { ConnectorError, safeError } from "./bounds.js";
import { codexQuery, codexStatus, type Runtime } from "./codex.js";
import {
  ConsoleState,
  ConsoleSnapshot,
  ConsoleSession,
  ConsoleUsage,
  ConsolePending,
  InputDecoder,
  InputKey,
  RESET,
  emptyState,
  handleKey,
  renderFrame,
  syncSelection,
  visibleSessions,
  type TranscriptEntry,
  type ConsoleQuota,
} from "./consoleView.js";

const REFRESH_THROTTLE_MS = 750;
const REDRAW_THROTTLE_MS = 50;
const RECONNECT_MS = 1000;
const REFRESH_FALLBACK_MS = 5000;
const RECENT_LIMIT = 25;
const TRANSCRIPT_LIMIT = 25;
// One payload-free admission order for both overlays. Never evict an unflushed
// message, a needed ordering anchor or terminal reasoning identity to admit more.
const LIVE_MESSAGE_LIMIT = 128;
const REASONING_PART_LIMIT = 64;

type LiveMessage = {
  text?: { parts: Map<number, string>; revision: number };
  reasoning: Map<number, { status: "active" | "ended"; created: number; revision: number }>;
};

type CodexInventory = { sessions: ConsoleSession[]; pending: ConsolePending[]; visibility: string };

export async function observeCodex(client: OpenCodeClient): Promise<CodexInventory> {
  const signal = AbortSignal.timeout(3000);
  const [history, supervised] = await Promise.allSettled([
    codexQuery(client, { type: "sessions" }, signal),
    codexStatus(client, signal),
  ]);
  const sessions = new Map<string, ConsoleSession>();
  const pending: ConsolePending[] = [];
  const gaps: string[] = [];
  if (history.status === "fulfilled" && "sessions" in history.value && history.value.sessions && history.value.cursor) {
    for (const entry of history.value.sessions) sessions.set(entry.sessionId, {
      runtime: "codex", id: entry.sessionId, title: entry.title, running: null,
      outcome: null, agent: "codex", model: null, variant: null,
      cwd: entry.cwd, updatedMs: entry.updatedAtMs,
    });
    if (history.value.cursor.next) gaps.push("more history not shown");
  } else gaps.push("history unavailable");
  if (supervised.status === "fulfilled") {
    for (const entry of supervised.value) {
      const previous = sessions.get(entry.sessionId);
      sessions.set(entry.sessionId, {
        runtime: "codex", id: entry.sessionId, title: entry.title ?? previous?.title ?? null,
        running: entry.executionKnown ? entry.status === "inProgress" : null,
        outcome: entry.executionKnown && entry.outcome !== "unknown" ? entry.outcome : null,
        agent: "codex", model: null, variant: null, cwd: entry.cwd,
        updatedMs: previous?.updatedMs ?? null,
      });
      for (const action of entry.pendingActions) pending.push({
        runtime: "codex", kind: "permission", sessionId: entry.sessionId,
        id: action.requestId, label: action.action ?? "native permission request",
      });
    }
  } else gaps.push("supervised status unavailable");
  return { sessions: [...sessions.values()], pending,
    visibility: gaps.length === 2 && history.status === "rejected" && supervised.status === "rejected"
      ? "unavailable · partial visibility" : gaps.length ? `partial · ${gaps.join("; ")}` : "recent + supervised · history status may be unknown" };
}

export async function observe(client: OpenCodeClient, readCodex = () => observeCodex(client)): Promise<ConsoleSnapshot> {
  const [info, active, list, stats, codex] = await Promise.all([
    client.server.info(),
    client.session.active(),
    client.session.list({ limit: RECENT_LIMIT, order: "desc" }),
    client.session.stats().catch(() => null),
    readCodex().catch(() => ({ sessions: [], pending: [], visibility: "unavailable · partial visibility" })),
  ]);
  const sessions: ConsoleSession[] = list.data
    .map((session) => ({
      id: session.id,
      runtime: "opencode" as const,
      title: session.title ?? null,
      running: Boolean(active[session.id]),
      outcome: session.outcome ?? null,
      agent: session.agent ?? null,
      model: session.model ? `${session.model.providerID}/${session.model.id}` : null,
      variant: session.model?.variant ?? null,
      cwd: session.location.directory,
      updatedMs: session.time.updated,
    }));
  const pending: ConsolePending[] = [];
  for (const session of sessions.filter((entry) => entry.running)) {
    try {
      const [permissions, forms] = await Promise.all([
        client.permission.list({ sessionID: session.id }),
        client.session.form.list({ sessionID: session.id }),
      ]);
      for (const permission of permissions) pending.push({ runtime: "opencode", kind: "permission", sessionId: session.id, id: permission.id, label: `${permission.action} · ${permission.resources.join(", ")}` });
      for (const form of forms) pending.push({ runtime: "opencode", kind: "form", sessionId: session.id, id: form.id, label: form.title });
    } catch {
      // Pending-action evidence is best-effort; a disconnected session must not
      // blank the whole dashboard.
    }
  }
  let usage: ConsoleUsage = null;
  if (stats) {
    const top = [...stats.models].sort((a, b) => b.steps - a.steps).map((entry) => `${entry.model.providerID}/${entry.model.id}`);
    usage = {
      sessions: stats.sessions,
      prompts: stats.prompts,
      steps: stats.steps,
      tokensTotal: stats.tokens.input + stats.tokens.output + stats.tokens.reasoning + stats.tokens.cache.read + stats.tokens.cache.write,
      costUsd: stats.cost,
      activeDays: stats.activeDays,
      streak: stats.streak,
      models: top.slice(0, 4),
    };
  }
  sessions.push(...codex.sessions);
  sessions.sort((a, b) => Number(b.running) - Number(a.running) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
  pending.push(...codex.pending);
  return { ready: true, release: info.version, pid: info.pid, sessions, pending, usage, codexVisibility: codex.visibility, observedAtMs: Date.now() };
}

export function messageToEntry(message: SessionMessageInfo): TranscriptEntry | null {
  if (message.type === "user") return { role: "user", text: message.text };
  if (message.type === "assistant") {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n")
      .trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

export async function fetchTranscript(client: OpenCodeClient, sessionId: string, includePrompt = true): Promise<TranscriptEntry[]> {
  const messages: SessionMessageInfo[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // Only opening a view looks back to its operator prompt. Following refreshes
  // read one recent page and merge it with the history already loaded.
  for (let page = 0; page < 20; page += 1) {
    const response = await client.message.list({ sessionID: sessionId, limit: TRANSCRIPT_LIMIT, ...(cursor ? { cursor } : { order: "desc" as const }) });
    messages.push(...response.data);
    if (!includePrompt || messages.some(message => message.type === "user") || !response.cursor.next) break;
    cursor = response.cursor.next;
    if (cursors.has(cursor)) throw new ConnectorError("native transcript cursor repeated; earlier history unavailable");
    cursors.add(cursor);
  }
  const seen = new Set<string>();
  const entries = messages.filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  }).map((message): TranscriptEntry | null => {
    const entry = messageToEntry(message) ?? (message.type === "assistant" ? { role: "assistant", text: "" } : null);
    if (!entry) return null;
    return {
      ...entry, messageId: message.id,
      ...(message.type === "assistant" ? {
        textParts: message.content.flatMap((part, ordinal) => part.type === "text" ? [{ ordinal, text: part.text }] : []),
        completed: message.time.completed !== undefined,
        tools: message.content.flatMap(part => part.type === "tool" ? [{ id: part.id, name: part.name, status: part.state.status }] : []),
        reasoningParts: message.content.flatMap((part, ordinal) => part.type === "reasoning" ? [{
          ordinal,
          status: part.time?.completed !== undefined ? "ended" as const
            : part.time && message.time.completed === undefined ? "active" as const : "observed" as const,
        }] : []).slice(0, REASONING_PART_LIMIT),
      } : {}),
    };
  }).filter((entry): entry is TranscriptEntry => entry !== null);
  return entries.reverse();
}

export async function fetchRuntimeTranscript(client: OpenCodeClient, runtime: Runtime, sessionId: string, includePrompt = true): Promise<TranscriptEntry[]> {
  if (runtime === "opencode") return fetchTranscript(client, sessionId, includePrompt);
  const history = await codexQuery(client, { type: "messages", sessionId, limit: TRANSCRIPT_LIMIT }, AbortSignal.timeout(3000));
  if (!("data" in history)) throw new ConnectorError("Codex history unavailable");
  // Native messages are bounded previews, not live activity or completion evidence.
  return history.data.map((entry): TranscriptEntry => {
    if (!("text" in entry) || !("previewTruncated" in entry)) throw new ConnectorError("Codex history unavailable");
    return {
      role: entry.type as "user" | "assistant",
      text: entry.text + (entry.previewTruncated || entry.outputTruncated ? "\n[preview truncated]" : ""),
      ...(entry.id ? { messageId: entry.id } : {}),
    };
  }).reverse();
}

export type ConsoleReads = {
  snapshot: () => Promise<ConsoleSnapshot>;
  transcript: (sessionId: string, includePrompt: boolean, runtime: Runtime) => Promise<TranscriptEntry[]>;
};

// OpenCode events may refresh the dashboard frequently. Codex has no event API:
// reuse both successful and failed reads until the existing slow fallback is due.
export function consoleReads(client: OpenCodeClient, now = Date.now): ConsoleReads {
  let inventory: { readAt: number; result: Promise<CodexInventory> } | undefined;
  let transcript: { sessionId: string; readAt: number; result: Promise<TranscriptEntry[]> } | undefined;
  const readCodex = () => {
    if (!inventory || now() - inventory.readAt >= REFRESH_FALLBACK_MS) {
      inventory = { readAt: now(), result: observeCodex(client) };
    }
    return inventory.result;
  };
  return {
    snapshot: () => observe(client, readCodex),
    transcript: (sessionId, includePrompt, runtime) => {
      if (runtime === "opencode") return fetchTranscript(client, sessionId, includePrompt);
      if (!transcript || transcript.sessionId !== sessionId || now() - transcript.readAt >= REFRESH_FALLBACK_MS) {
        transcript = { sessionId, readAt: now(), result: fetchRuntimeTranscript(client, runtime, sessionId, includePrompt) };
      }
      return transcript.result;
    },
  };
}

// Coalesce events while a read is in flight. A result belongs to the exact
// opened view, including when the user leaves and reopens the same session.
export class ConsoleObserver {
  snapshot: ConsoleSnapshot | null = null;
  error: string | null = null;
  private refreshing: Promise<void> | undefined;
  private refreshQueued = false;
  private transcriptView: ConsoleState["view"] | undefined;
  private transcriptBase: TranscriptEntry[] | null = null;
  private messageOrder = new Set<string>();
  private liveMessages = new Map<string, LiveMessage>();
  private eventRevision = 0;
  private seenEvents = new Set<string>();

  constructor(
    private readonly state: ConsoleState,
    private readonly reads: ConsoleReads,
    private readonly redraw: () => void,
  ) {}

  private syncTranscriptView(): void {
    if (this.transcriptView === this.state.view) return;
    this.transcriptView = this.state.view;
    this.transcriptBase = this.state.transcript;
    this.messageOrder.clear();
    this.liveMessages.clear();
    this.seenEvents.clear();
    this.eventRevision = 0;
  }

  private publishTranscript(): void {
    const entries = [...(this.transcriptBase ?? [])];
    // Native persisted order stays authoritative. Insert missing messages in
    // shared first-activity order, before the next already-persisted anchor.
    let insertAt = entries.length;
    for (const messageId of [...this.messageOrder].reverse()) {
      const index = entries.findIndex(entry => entry.messageId === messageId);
      if (index >= 0) insertAt = index;
      else entries.splice(insertAt, 0, { role: "assistant", messageId, text: "", completed: false });
    }
    this.state.transcript = entries.map(entry => {
      const message = entry.messageId ? this.liveMessages.get(entry.messageId) : undefined;
      if (!message) return entry;
      const live = message.text;
      let projected = entry;
      if (live) {
        const parts = new Map(entry.textParts?.map((part) => [part.ordinal, part.text]));
        for (const [ordinal, text] of live.parts) parts.set(ordinal, text);
        const textParts = [...parts].sort(([a], [b]) => a - b).map(([ordinal, text]) => ({ ordinal, text }));
        projected = { ...entry, textParts, text: textParts.map((part) => part.text).join("\n").trim() };
      }
      if (message.reasoning.size > 0) {
        const parts = new Map(entry.reasoningParts?.map(part => [part.ordinal, part]));
        for (const [ordinal, part] of message.reasoning) {
          if (parts.get(ordinal)?.status !== "ended") parts.set(ordinal, { ordinal, status: part.status });
        }
        projected = { ...projected, reasoningParts: [...parts.values()].sort((a, b) => a.ordinal - b.ordinal).slice(0, REASONING_PART_LIMIT) };
      }
      return projected;
    });
  }

  private liveMessage(messageId: string): LiveMessage | undefined {
    if (!this.messageOrder.has(messageId)) {
      if (this.messageOrder.size >= LIVE_MESSAGE_LIMIT) return undefined;
      this.messageOrder.add(messageId);
    }
    let message = this.liveMessages.get(messageId);
    if (!message) {
      message = { reasoning: new Map() };
      this.liveMessages.set(messageId, message);
    }
    return message;
  }

  // 2.0.24 Reasoning.{Started,Delta,Ended} share canonical assistant/ordinal
  // identity. Delta is provider reasoning, not a guaranteed safe summary. Do
  // not read/copy delta, text, state, metadata or any other provider payload.
  private applyReasoningEvent(event: Extract<OpenCodeEvent, { type: "session.reasoning.started" | "session.reasoning.delta" | "session.reasoning.ended" }>): boolean {
    const { assistantMessageID, ordinal } = event.data;
    const saved = this.transcriptBase?.find(entry => entry.messageId === assistantMessageID);
    if (saved?.completed || saved?.reasoningParts?.some(part => part.ordinal === ordinal && part.status === "ended")) return false;
    const parts = this.liveMessage(assistantMessageID)?.reasoning;
    if (!parts) return false;
    const previous = parts.get(ordinal);
    // End is the native full-value boundary for this immutable content ordinal;
    // a delayed fragment must not outweigh it, even with a later timestamp.
    if (previous?.status === "ended" || (event.type !== "session.reasoning.ended" && previous && previous.created > event.created)) return false;
    // Admission saturation is deliberately fail-closed: terminal identities
    // cannot be forgotten and then mistaken for new activity on a late event.
    if (!previous && parts.size >= REASONING_PART_LIMIT) return false;
    const status = event.type === "session.reasoning.ended" ? "ended" : "active";
    parts.set(ordinal, { status, created: event.created, revision: ++this.eventRevision });
    if (!this.state.follow || previous?.status === status) return false;
    this.publishTranscript();
    return true;
  }

  // Native deltas are transient: message.list does not contain a text block
  // until text.ended. Keep only this view's display overlay, keyed by canonical
  // assistant ID and content ordinal; persisted completion replaces it.
  applyEvent(event: OpenCodeEvent): boolean {
    if (this.state.quit || this.state.view.kind !== "session" || this.state.view.runtime !== "opencode") return false;
    if (event.type !== "session.text.started" && event.type !== "session.text.delta" && event.type !== "session.text.ended" &&
      event.type !== "session.reasoning.started" && event.type !== "session.reasoning.delta" && event.type !== "session.reasoning.ended") return false;
    if (event.data.sessionID !== this.state.view.sessionId) return false;
    this.syncTranscriptView();
    if (this.seenEvents.has(event.id)) return false;
    this.seenEvents.add(event.id);
    if (this.seenEvents.size > 2048) this.seenEvents.delete(this.seenEvents.values().next().value!);
    if (event.type === "session.reasoning.started" || event.type === "session.reasoning.delta" || event.type === "session.reasoning.ended") return this.applyReasoningEvent(event);
    const { assistantMessageID, ordinal } = event.data;
    const message = this.liveMessage(assistantMessageID);
    if (!message) return false;
    let live = message.text;
    if (!live) {
      live = { parts: new Map(), revision: 0 };
      message.text = live;
    }
    live.revision = ++this.eventRevision;
    if (event.type === "session.text.started") live.parts.set(ordinal, "");
    else if (event.type === "session.text.ended") live.parts.set(ordinal, event.data.text);
    else {
      const saved = this.transcriptBase?.find((entry) => entry.messageId === assistantMessageID)?.textParts?.find((part) => part.ordinal === ordinal)?.text ?? "";
      live.parts.set(ordinal, (live.parts.get(ordinal) ?? saved) + event.data.delta);
    }
    if (!this.state.follow) return false;
    this.publishTranscript();
    return true;
  }

  refresh(): Promise<void> {
    if (this.state.quit) return Promise.resolve();
    this.refreshQueued = true;
    if (!this.refreshing) {
      this.refreshing = this.drain().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async drain(): Promise<void> {
    do {
      this.refreshQueued = false;
      await this.readOnce();
    } while (this.refreshQueued && !this.state.quit);
  }

  private async readOnce(): Promise<void> {
    try {
      const snapshot = await this.reads.snapshot();
      if (this.state.quit) return;
      this.snapshot = snapshot;
      this.error = null;
    } catch (cause) {
      if (this.state.quit) return;
      this.error = safeError(cause);
    }
    const view = this.state.view;
    this.syncTranscriptView();
    if (view.kind === "session" && (this.state.follow || this.state.transcript === null || this.state.transcriptError !== null)) {
      try {
        const readRevision = this.eventRevision;
        const entries = await this.reads.transcript(view.sessionId, this.transcriptBase === null, view.runtime);
        if (!this.state.quit && this.state.view === view) {
          if (view.runtime === "codex") {
            // Replace each bounded snapshot: null message IDs cannot be merged
            // by identity, and history replay does not provide live deltas.
            this.transcriptBase = entries;
            this.publishTranscript();
            this.state.transcriptError = null;
            this.redraw();
            return;
          }
          const retained = (this.transcriptBase ?? []).filter(entry => entry.messageId);
          // Fill this page's previously loaded slots in native page order,
          // including newly read identities beside their native neighbors.
          // Replacing by ID in place would preserve provisional order forever.
          const pageIds = new Set(entries.map(entry => entry.messageId));
          const retainedIds = new Set(retained.map(entry => entry.messageId));
          const reconciled: TranscriptEntry[] = [];
          let pageIndex = 0;
          let insertAt: number | undefined;
          for (const saved of retained) {
            if (pageIds.has(saved.messageId)) {
              while (pageIndex < entries.length) {
                const entry = entries[pageIndex++];
                reconciled.push(entry);
                if (retainedIds.has(entry.messageId)) break;
              }
              insertAt = reconciled.length;
            } else reconciled.push(saved);
          }
          if (insertAt === undefined) {
            // No shared native identity yet: activity can provisionally place
            // this page before a later native anchor, but never order its rows.
            insertAt = reconciled.length;
            const order = [...this.messageOrder];
            const activityIndex = order.indexOf(entries.at(-1)?.messageId ?? "");
            if (activityIndex >= 0) {
              const next = order.slice(activityIndex + 1).find(id => retainedIds.has(id));
              if (next) insertAt = reconciled.findIndex(saved => saved.messageId === next);
            }
          }
          reconciled.splice(insertAt, 0, ...entries.slice(pageIndex));
          this.transcriptBase = reconciled;
          for (const [messageId, message] of this.liveMessages) {
            const entry = entries.find((entry) => entry.messageId === messageId);
            if (message.text && message.text.revision <= readRevision && entry?.completed) message.text = undefined;
            for (const [ordinal, part] of message.reasoning) {
              if (entry?.reasoningParts?.some(saved => saved.ordinal === ordinal && saved.status === "ended")) {
                // End timing is authoritative even for deltas received during
                // this read. Keep the terminal identity, not an active overlay.
                part.status = "ended";
              } else if (part.revision <= readRevision && entry?.completed) message.reasoning.delete(ordinal);
            }
            // A completed persisted assistant already guards all its ordinals;
            // otherwise retain terminal identities until this view is closed.
            if (entry?.completed && !message.text && [...message.reasoning.values()].every(part => part.revision <= readRevision)) this.liveMessages.delete(messageId);
          }
          // Free completed payloads above, but retain their order anchors if
          // any earlier identity is still missing. Otherwise a partial page
          // could append the older overlay after its completed newer neighbor.
          const persisted = new Set(this.transcriptBase.map(entry => entry.messageId));
          for (const messageId of this.messageOrder) {
            if (!persisted.has(messageId)) break;
            if (!this.liveMessages.has(messageId)) this.messageOrder.delete(messageId);
          }
          this.publishTranscript();
          this.state.transcriptError = null;
        }
      } catch (cause) {
        if (!this.state.quit && this.state.view === view) {
          this.state.transcriptError = safeError(cause);
        }
      }
    }
    if (!this.state.quit) this.redraw();
  }

  // Scrolling/help only redraw cached content. Opening a view or resuming
  // follow requests fresh data without clearing the last successful read.
  applyKeys(keys: InputKey[]): boolean {
    const view = this.state.view;
    const following = this.state.follow;
    let changed = false;
    for (const key of keys) changed = handleKey(this.state, this.snapshot, key) || changed;
    this.syncTranscriptView();
    if (!following && this.state.follow && this.state.view === view && this.liveMessages.size > 0) this.publishTranscript();
    if (changed && !this.state.quit) this.redraw();
    return changed && this.state.view.kind === "session" &&
      (this.state.view !== view || (!following && this.state.follow));
  }
}

class ScreenGuard {
  private lines: string[] = [];
  private size: [number, number] = [0, 0];
  enter(): void {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H");
  }
  draw(lines: string[]): void {
    const columns = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    let out = "";
    if (this.size[0] !== columns || this.size[1] !== rows) {
      out += "\x1b[2J";
      this.lines = [];
      this.size = [columns, rows];
    }
    for (let index = 0; index < lines.length; index += 1) {
      if (this.lines[index] !== lines[index]) out += `\x1b[${index + 1};1H\x1b[2K${lines[index]}`;
    }
    if (lines.length < this.lines.length) out += `\x1b[${lines.length + 1};1H\x1b[J`;
    process.stdout.write(out);
    this.lines = lines;
  }
  leave(): void {
    process.stdout.write(`${RESET}\x1b[?2004l\x1b[?25h\x1b[?1049l`);
  }
}

export async function run(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new ConnectorError("the console requires an interactive terminal");
  }
  const connection = await connectNative();
  const client = connection.client;
  const screen = new ScreenGuard();
  screen.enter();
  const state: ConsoleState = emptyState();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  const eventAbort = new AbortController();
  let quota: ConsoleQuota = { status: "connecting", usage: null };
  let quotaObserver: ReturnType<typeof observeCodexQuota> | undefined;

  const redraw = () => {
    const columns = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    screen.draw(renderFrame(observer.snapshot, observer.error, state, columns, rows, quota));
  };
  const observer = new ConsoleObserver(state, consoleReads(client), redraw);

  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void observer.refresh();
    }, REFRESH_THROTTLE_MS);
  };

  const scheduleRedraw = () => {
    if (redrawTimer) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = undefined;
      if (!state.quit) redraw();
    }, REDRAW_THROTTLE_MS);
  };

  // A slow fallback also recovers failed reads when an idle session emits no
  // more events. Events continue to request throttled, coalesced refreshes.
  const fallbackTimer = setInterval(scheduleRefresh, REFRESH_FALLBACK_MS);
  const events = (async () => {
    while (!state.quit) {
      try {
        for await (const event of client.event.subscribe({ signal: eventAbort.signal })) {
          if (state.quit) break;
          if (observer.applyEvent(event)) scheduleRedraw();
          if (event.type !== "session.text.delta" && event.type !== "session.reasoning.delta" && event.type !== "session.tool.input.delta") scheduleRefresh();
        }
        if (state.quit) break;
        observer.error = "event stream ended; reconnecting";
      } catch (cause) {
        if (state.quit) break;
        observer.error = safeError(cause);
      }
      redraw();
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  })();
  void events.catch(() => {});

  const decoder = new InputDecoder();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const applyKeys = (keys: InputKey[]) => {
    if (state.view.kind === "dashboard" && keys.some(key => key.kind === "char" && key.value.toLowerCase() === "r")) void quotaObserver?.refresh();
    const needsRefresh = observer.applyKeys(keys);
    if (state.quit) {
      void shutdown(0);
    }
    if (needsRefresh) scheduleRefresh();
  };
  const cleanup = () => {
    state.quit = true;
    eventAbort.abort();
    if (refreshTimer) clearTimeout(refreshTimer);
    if (redrawTimer) clearTimeout(redrawTimer);
    clearInterval(fallbackTimer);
    if (escapeTimer) clearTimeout(escapeTimer);
    process.stdin.off("data", onInput);
    process.stdout.off("resize", redraw);
    process.off("SIGINT", onSigint);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    screen.leave();
  };
  const shutdown = async (code: number) => {
    cleanup();
    await quotaObserver?.close();
    process.exit(code);
  };
  const onSigint = () => { void shutdown(130); };
  process.on("SIGINT", onSigint);
  process.stdout.on("resize", redraw);

  const onInput = (chunk: Buffer) => {
    let keys: InputKey[] = [];
    for (const byte of chunk) keys = keys.concat(decoder.push(byte));
    if (decoder.pendingEscape()) {
      if (escapeTimer) clearTimeout(escapeTimer);
      escapeTimer = setTimeout(() => applyKeys(decoder.flushEscape()), 50);
    }
    if (keys.length > 0) applyKeys(keys);
  };
  process.stdin.on("data", onInput);

  try {
    quotaObserver = observeCodexQuota({
      onChange: (next) => {
        quota = next;
        if (!state.quit) redraw();
      },
    });
    await observer.refresh();
    syncSelection(state, visibleSessions(observer.snapshot, state.activeOnly));
    redraw();
    // Keep the loop alive until quit; raw stdin and timers hold the event loop.
    await new Promise<void>(() => {});
  } catch (cause) {
    cleanup();
    await quotaObserver?.close();
    throw cause;
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  run().catch((cause) => {
    console.error(safeError(cause));
    process.exit(1);
  });
}
