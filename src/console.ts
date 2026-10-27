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
  type CodexHistory,
} from "./consoleView.js";

const REFRESH_THROTTLE_MS = 750;
const REDRAW_THROTTLE_MS = 50;
const RECONNECT_MS = 1000;
const REFRESH_FALLBACK_MS = 5000;
const CODEX_HISTORY_REFRESH_MS = 5 * 60 * 1000;
// Codex history opens a native ACP metadata session. A live cold read can take >3s.
const CODEX_HISTORY_TIMEOUT_MS = 12_000;
const NATIVE_READ_TIMEOUT_MS = 10_000;
const OPTIONAL_READ_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RECENT_LIMIT = 25;
const TRANSCRIPT_LIMIT = 25;
// One payload-free admission order for both overlays. Never evict an unflushed
// message, a needed ordering anchor or terminal reasoning identity to admit more.
const LIVE_MESSAGE_LIMIT = 128;
const REASONING_PART_LIMIT = 64;

type LiveMessage = {
  text?: { parts: Map<number, string>; ended: Set<number>; revision: number };
  reasoning: Map<number, { status: "active" | "ended"; created: number; revision: number }>;
};

type CodexInventory = { sessions: ConsoleSession[]; pending: ConsolePending[]; visibility: string };

export async function observeCodex(client: OpenCodeClient, readHistory = () => codexQuery(client, { type: "sessions" }, AbortSignal.timeout(CODEX_HISTORY_TIMEOUT_MS))): Promise<CodexInventory> {
  const signal = AbortSignal.timeout(3000);
  const [history, supervised] = await Promise.allSettled([
    readHistory(),
    codexStatus(client, signal),
  ]);
  const sessions = new Map<string, ConsoleSession>();
  const pending: ConsolePending[] = [];
  const gaps: string[] = [];
  if (history.status === "fulfilled" && "sessions" in history.value && history.value.sessions && history.value.cursor) {
    for (const entry of history.value.sessions) {
      const verified = entry.outcomeBasis === "nativeTurnHistory" && entry.executionKnown === true;
      sessions.set(entry.sessionId, {
        runtime: "codex", id: entry.sessionId, title: entry.title, running: verified ? false : null,
        outcome: verified ? entry.status === "interrupted" ? "interrupted" : entry.outcome === "unknown" ? null : entry.outcome : null,
        agent: null, model: entry.model, modelProvider: entry.modelProvider, reasoningEffort: entry.reasoningEffort,
        mode: entry.mode, variant: null,
        cwd: entry.cwd, updatedMs: entry.updatedAtMs,
      });
    }
    if (history.value.cursor.next) gaps.push("more history not shown");
  } else gaps.push("history unavailable");
  if (supervised.status === "fulfilled") {
    for (const entry of supervised.value) {
      const previous = sessions.get(entry.sessionId);
      const terminalWithoutOutcome = entry.executionKnown && entry.status !== "idle" && entry.status !== "inProgress" && entry.outcome === "unknown";
      sessions.set(entry.sessionId, {
        runtime: "codex", id: entry.sessionId, title: entry.title ?? previous?.title ?? null,
        running: entry.executionKnown && !terminalWithoutOutcome ? entry.status === "inProgress" : previous?.running ?? null,
        outcome: entry.executionKnown && entry.outcome !== "unknown" ? entry.status === "interrupted" ? "interrupted" : entry.outcome : previous?.outcome ?? null,
        agent: null, model: entry.model ?? previous?.model ?? null,
        modelProvider: entry.modelProvider ?? previous?.modelProvider ?? null,
        reasoningEffort: entry.reasoningEffort ?? previous?.reasoningEffort ?? null,
        mode: entry.mode ?? previous?.mode ?? null, variant: null, cwd: entry.cwd,
        updatedMs: previous?.updatedMs ?? null,
      });
      for (const action of entry.pendingActions) pending.push({
        runtime: "codex", kind: "permission", sessionId: entry.sessionId,
        id: action.requestId, label: "native permission request",
      });
    }
  } else gaps.push("supervised status unavailable");
  if ([...sessions.values()].some(entry => entry.running === null)) gaps.push("some outcomes unverified");
  return { sessions: [...sessions.values()], pending,
    visibility: gaps.length === 2 && history.status === "rejected" && supervised.status === "rejected"
      ? "unavailable · partial visibility" : gaps.length ? `partial · ${gaps.join("; ")}` : "recent + supervised" };
}

export async function observe(client: OpenCodeClient, readCodex = () => observeCodex(client), signal?: AbortSignal): Promise<ConsoleSnapshot> {
  const nativeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(NATIVE_READ_TIMEOUT_MS)]) : AbortSignal.timeout(NATIVE_READ_TIMEOUT_MS);
  const statsSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(OPTIONAL_READ_TIMEOUT_MS)]) : AbortSignal.timeout(OPTIONAL_READ_TIMEOUT_MS);
  const codexRead = Promise.resolve().then(readCodex).catch(() => ({ sessions: [], pending: [], visibility: "unavailable · partial visibility" }));
  const [info, active, list, stats] = await Promise.all([
    client.server.info({ signal: nativeSignal }),
    client.session.active({ signal: nativeSignal }),
    client.session.list({ limit: RECENT_LIMIT, order: "desc" }, { signal: nativeSignal }),
    client.session.stats(undefined, { signal: statsSignal }).catch(() => null),
  ]);
  nativeSignal.throwIfAborted();
  const optionalSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(OPTIONAL_READ_TIMEOUT_MS)]) : AbortSignal.timeout(OPTIONAL_READ_TIMEOUT_MS);
  const recentIds = new Set(list.data.map(session => session.id));
  const missingActiveIds = Object.keys(active).filter(id => !recentIds.has(id));
  const missingActive = new Map<string, typeof list.data[number]>();
  // The recent page is capped, while the native active inventory is not.
  // Resolve only missing identities and keep one bad metadata read from
  // blanking every other session on the dashboard.
  for (let index = 0; index < missingActiveIds.length && !optionalSignal.aborted; index += 8) {
    const ids = missingActiveIds.slice(index, index + 8);
    const batch = await Promise.allSettled(ids
      .map(sessionID => client.session.get({ sessionID }, { signal: optionalSignal })));
    for (let item = 0; item < batch.length; item++) {
      const result = batch[item];
      if (result.status === "fulfilled" && result.value.id === ids[item]) missingActive.set(ids[item], result.value);
    }
  }
  const sessions: ConsoleSession[] = [...list.data, ...missingActive.values()]
    .map((session) => ({
      id: session.id,
      runtime: "opencode" as const,
      title: session.title ?? null,
      running: Boolean(active[session.id]),
      outcome: session.outcome ?? null,
      agent: session.agent ?? null,
      model: session.model ? `${session.model.providerID}/${session.model.id}` : null,
      modelProvider: null,
      reasoningEffort: null,
      mode: null,
      variant: session.model?.variant ?? null,
      cwd: session.location.directory,
      updatedMs: session.time.updated,
    }));
  for (const id of missingActiveIds) if (!missingActive.has(id)) sessions.push({
    runtime: "opencode", id, title: `${id} · metadata unavailable`, running: true,
    outcome: null, agent: null, model: null, modelProvider: null, reasoningEffort: null, mode: null,
    variant: null, cwd: "<unavailable>", updatedMs: null,
  });
  const pending: ConsolePending[] = [];
  for (const session of sessions.filter((entry) => entry.running && !optionalSignal.aborted)) {
    try {
      const [permissions, forms] = await Promise.all([
        client.permission.list({ sessionID: session.id }, { signal: optionalSignal }),
        client.session.form.list({ sessionID: session.id }, { signal: optionalSignal }),
      ]);
      for (const permission of permissions) pending.push({ runtime: "opencode", kind: "permission", sessionId: session.id, id: permission.id, label: "native permission request" });
      for (const form of forms) pending.push({ runtime: "opencode", kind: "form", sessionId: session.id, id: form.id, label: "native form request" });
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
  signal?.throwIfAborted();
  const nativeObservedAtMs = Date.now();
  const codex = await codexRead;
  signal?.throwIfAborted();
  sessions.push(...codex.sessions);
  sessions.sort((a, b) => (b.updatedMs ?? -Infinity) - (a.updatedMs ?? -Infinity));
  const ordered = sessions.filter((entry) => entry.running);
  const opencodeRecent = sessions.filter((entry) => !entry.running && entry.runtime === "opencode");
  const codexRecent = sessions.filter((entry) => !entry.running && entry.runtime === "codex");
  // Fair presentation after running rows: missing native timestamps must not
  // bury a runtime below the viewport. Stable sorting keeps equal/unknown times
  // in inventory order; interleaving changes no session evidence or identity.
  for (let index = 0; index < Math.max(opencodeRecent.length, codexRecent.length); index++) {
    if (opencodeRecent[index]) ordered.push(opencodeRecent[index]);
    if (codexRecent[index]) ordered.push(codexRecent[index]);
  }
  pending.push(...codex.pending);
  return { ready: true, release: info.version, pid: info.pid, sessions: ordered, pending, usage, codexVisibility: codex.visibility, observedAtMs: nativeObservedAtMs };
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

export async function fetchTranscript(client: OpenCodeClient, sessionId: string, includePrompt = true, signal?: AbortSignal): Promise<TranscriptEntry[]> {
  const nativeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(NATIVE_READ_TIMEOUT_MS)]) : AbortSignal.timeout(NATIVE_READ_TIMEOUT_MS);
  const messages: SessionMessageInfo[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // Only opening a view looks back to its operator prompt. Following refreshes
  // read one recent page and merge it with the history already loaded.
  for (let page = 0; page < 20; page += 1) {
    const response = await client.message.list({ sessionID: sessionId, limit: TRANSCRIPT_LIMIT, ...(cursor ? { cursor } : { order: "desc" as const }) }, { signal: nativeSignal });
    nativeSignal.throwIfAborted();
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
  nativeSignal.throwIfAborted();
  return entries.reverse();
}

type TranscriptRead = TranscriptEntry[] | { entries: TranscriptEntry[]; history: CodexHistory };

export async function fetchRuntimeTranscript(client: OpenCodeClient, runtime: Runtime, sessionId: string, includePrompt = true, signal?: AbortSignal): Promise<TranscriptRead> {
  if (runtime === "opencode") return fetchTranscript(client, sessionId, includePrompt, signal);
  const querySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  const history = await codexQuery(client, { type: "messages", sessionId, limit: TRANSCRIPT_LIMIT }, querySignal);
  if (!("data" in history) || !("historyComplete" in history) || !("nextOffset" in history)) throw new ConnectorError("Codex history unavailable");
  // Native messages are bounded previews, not live activity or completion evidence.
  const entries = history.data.map((entry): TranscriptEntry => {
    if (!("text" in entry) || !("previewTruncated" in entry)) throw new ConnectorError("Codex history unavailable");
    return {
      role: entry.type as "user" | "assistant",
      text: entry.text, previewTruncated: entry.previewTruncated, outputTruncated: entry.outputTruncated,
      ...(entry.id ? { messageId: entry.id } : {}),
    };
  }).reverse();
  return { entries, history: { historyComplete: history.historyComplete, pageComplete: history.nextOffset === null } };
}

export type ConsoleReads = {
  snapshot: (refreshHistory?: boolean, signal?: AbortSignal) => Promise<ConsoleSnapshot>;
  transcript: (sessionId: string, includePrompt: boolean, runtime: Runtime, signal?: AbortSignal) => Promise<TranscriptRead>;
};

// OpenCode events may refresh the dashboard frequently. Codex has no event API:
// Supervised status follows the fallback cadence; expensive history listing
// reuses both successful and failed reads for longer, unless manually refreshed.
export function consoleReads(client: OpenCodeClient, now = Date.now): ConsoleReads {
  let history: { readAt: number; result: ReturnType<typeof codexQuery> } | undefined;
  let inventory: { readAt: number; result: Promise<CodexInventory>; settled: boolean } | undefined;
  let transcript: { sessionId: string; readAt: number; result: Promise<TranscriptRead>; signal?: AbortSignal } | undefined;
  const readHistory = () => {
    if (!history || now() - history.readAt >= CODEX_HISTORY_REFRESH_MS) {
      history = { readAt: now(), result: codexQuery(client, { type: "sessions" }, AbortSignal.timeout(CODEX_HISTORY_TIMEOUT_MS)) };
    }
    return history.result;
  };
  const readCodex = () => {
    if (!inventory || (inventory.settled && now() - inventory.readAt >= REFRESH_FALLBACK_MS)) {
      const current = { readAt: now(), result: observeCodex(client, readHistory), settled: false };
      inventory = current;
      void current.result.then(() => { current.settled = true; }, () => { current.settled = true; });
    }
    return inventory.result;
  };
  return {
    snapshot: (refreshHistory = false, signal) => {
      if (refreshHistory) { history = undefined; inventory = undefined; }
      return observe(client, readCodex, signal);
    },
    transcript: (sessionId, includePrompt, runtime, signal) => {
      if (runtime === "opencode") return fetchTranscript(client, sessionId, includePrompt, signal);
      if (!transcript || transcript.signal?.aborted || transcript.sessionId !== sessionId || now() - transcript.readAt >= REFRESH_FALLBACK_MS) {
        const result = fetchRuntimeTranscript(client, runtime, sessionId, includePrompt, signal);
        transcript = { sessionId, readAt: now(), result, signal };
        void result.catch(() => { if (signal?.aborted && transcript?.result === result) transcript = undefined; });
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
  streamError: string | null = null;
  private refreshing: Promise<void> | undefined;
  private trailingRefresh: ReturnType<typeof setTimeout> | undefined;
  private refreshQueued = false;
  private refreshHistory = false;
  private transcriptView: ConsoleState["view"] | undefined;
  private transcriptBase: TranscriptEntry[] | null = null;
  private messageOrder = new Set<string>();
  private liveMessages = new Map<string, LiveMessage>();
  private eventRevision = 0;
  private seenEvents = new Set<string>();
  private readonly abort = new AbortController();
  private transcriptAbort = new AbortController();

  constructor(
    private readonly state: ConsoleState,
    private readonly reads: ConsoleReads,
    private readonly redraw: () => void,
  ) {}

  get displayError(): string | null {
    return this.error ?? this.streamError;
  }

  private syncTranscriptView(): void {
    if (this.transcriptView === this.state.view) return;
    this.transcriptAbort.abort();
    this.transcriptAbort = new AbortController();
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
    const saved = this.transcriptBase?.find(entry => entry.messageId === assistantMessageID);
    if (saved?.completed) return false;
    // A native snapshot may contain a partial text block. Only ignore a
    // redundant start; subsequent deltas and the authoritative end still apply.
    if (event.type === "session.text.started" && saved?.textParts?.some(part => part.ordinal === ordinal && part.text.length > 0)) return false;
    const message = this.liveMessage(assistantMessageID);
    if (!message) return false;
    let live = message.text;
    if (!live) {
      live = { parts: new Map(), ended: new Set(), revision: 0 };
      message.text = live;
    }
    if (live.ended.has(ordinal) || (event.type === "session.text.started" && live.parts.has(ordinal))) return false;
    live.revision = ++this.eventRevision;
    if (event.type === "session.text.started") live.parts.set(ordinal, "");
    else if (event.type === "session.text.ended") { live.parts.set(ordinal, event.data.text); live.ended.add(ordinal); }
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
      if (this.trailingRefresh) clearTimeout(this.trailingRefresh);
      this.trailingRefresh = undefined;
      this.refreshing = this.drain().finally(() => {
        this.refreshing = undefined;
        if (this.refreshQueued && !this.state.quit) {
          this.trailingRefresh = setTimeout(() => {
            this.trailingRefresh = undefined;
            void this.refresh();
          }, REFRESH_THROTTLE_MS);
        }
      });
    }
    return this.refreshing;
  }

  stop(): void {
    this.abort.abort();
    this.transcriptAbort.abort();
    this.refreshQueued = false;
    if (this.trailingRefresh) clearTimeout(this.trailingRefresh);
    this.trailingRefresh = undefined;
  }

  private async drain(): Promise<void> {
    // One read plus one coalesced follow-up. Never wait for an event stream to
    // become quiet: callers must settle even if the second read queues more.
    // The delayed trailing batch yields to input/rendering and bounds read rate.
    for (let pass = 0; pass < 2 && this.refreshQueued && !this.state.quit; pass++) {
      this.refreshQueued = false;
      await this.readOnce();
    }
  }

  private async readOnce(): Promise<void> {
    try {
      const refreshHistory = this.refreshHistory;
      this.refreshHistory = false;
      const snapshot = await this.reads.snapshot(refreshHistory, this.abort.signal);
      if (this.state.quit) return;
      const selected = visibleSessions(this.snapshot, this.state.activeOnly, this.state.scope, this.state.filter)[this.state.selected];
      const selectedPending = this.snapshot?.pending[this.state.attentionSelected];
      this.snapshot = snapshot;
      const visible = visibleSessions(snapshot, this.state.activeOnly, this.state.scope, this.state.filter);
      const selectedIndex = selected && visible.findIndex(session => session.runtime === selected.runtime && session.id === selected.id);
      if (selectedIndex !== undefined && selectedIndex >= 0) this.state.selected = selectedIndex;
      else syncSelection(this.state, visible);
      const pendingIndex = selectedPending ? snapshot.pending.findIndex(action => action.runtime === selectedPending.runtime && action.sessionId === selectedPending.sessionId && action.kind === selectedPending.kind && action.id === selectedPending.id) : -1;
      this.state.attentionSelected = pendingIndex >= 0 ? pendingIndex : Math.max(0, Math.min(this.state.attentionSelected, snapshot.pending.length - 1));
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
        const transcriptSignal = AbortSignal.any([this.abort.signal, this.transcriptAbort.signal]);
        const result = await this.reads.transcript(view.sessionId, this.transcriptBase === null, view.runtime, transcriptSignal);
        const entries = Array.isArray(result) ? result : result.entries;
        if (!this.state.quit && this.state.view === view) {
          if (view.runtime === "codex") {
            // Replace each bounded snapshot: null message IDs cannot be merged
            // by identity, and history replay does not provide live deltas.
            this.transcriptBase = entries;
            this.state.codexHistory = Array.isArray(result) ? null : result.history;
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
    let manualRefresh = false;
    for (const key of keys) {
      if (!this.state.help && !this.state.filtering && this.state.view.kind === "dashboard" && key.kind === "char" && key.value.toLowerCase() === "r") {
        this.refreshHistory = true;
        manualRefresh = true;
      }
      changed = handleKey(this.state, this.snapshot, key) || changed;
    }
    this.syncTranscriptView();
    if (!following && this.state.follow && this.state.view === view && this.liveMessages.size > 0) this.publishTranscript();
    if (changed && !this.state.quit) this.redraw();
    return manualRefresh || (changed && this.state.view.kind === "session" &&
      (this.state.view !== view || (!following && this.state.follow)));
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
  const screen = new ScreenGuard();
  const state: ConsoleState = emptyState();
  const paintConnecting = () => screen.draw(renderFrame(null, null, state,
    process.stdout.columns ?? 80, process.stdout.rows ?? 24, { status: "connecting", usage: null }));
  const removeStartupListeners = () => {
    process.off("SIGINT", onStartupSigint);
    process.stdout.off("resize", paintConnecting);
  };
  const onStartupSigint = () => {
    removeStartupListeners();
    screen.leave();
    process.exit(130);
  };
  process.on("SIGINT", onStartupSigint);
  process.stdout.on("resize", paintConnecting);
  let connection: Awaited<ReturnType<typeof connectNative>>;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    screen.enter();
    paintConnecting();
    connection = await Promise.race([
      connectNative(),
      new Promise<never>((_resolve, reject) => {
        connectTimer = setTimeout(() => reject(new ConnectorError("native OpenCode connection timed out")), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (cause) {
    removeStartupListeners();
    screen.leave();
    throw cause;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
  }
  const client = connection.client;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  const eventAbort = new AbortController();
  let quota: ConsoleQuota = { status: "connecting", usage: null };
  let quotaObserver: ReturnType<typeof observeCodexQuota> | undefined;

  const redraw = () => {
    const columns = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    screen.draw(renderFrame(observer.snapshot, observer.displayError, state, columns, rows, quota));
  };
  const observer = new ConsoleObserver(state, consoleReads(client), redraw);
  // Paint before event/quota subscriptions or the first potentially slow read.
  redraw();

  const scheduleRefresh = () => {
    if (state.quit || refreshTimer) return;
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
          if (observer.streamError) {
            observer.streamError = null;
            redraw();
          }
          if (observer.applyEvent(event)) scheduleRedraw();
          if (event.type !== "session.text.delta" && event.type !== "session.reasoning.delta" && event.type !== "session.tool.input.delta") scheduleRefresh();
        }
        if (state.quit) break;
        observer.streamError = "event stream ended; reconnecting";
      } catch (cause) {
        if (state.quit) break;
        observer.streamError = safeError(cause);
      }
      redraw();
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  })();
  void events.catch(() => {});

  const decoder = new InputDecoder();
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const applyKeys = (keys: InputKey[]) => {
    let needsRefresh = false;
    let refreshQuota = false;
    for (const key of keys) {
      if (!state.help && !state.filtering && state.view.kind === "dashboard" && key.kind === "char" && key.value.toLowerCase() === "r") refreshQuota = true;
      needsRefresh = observer.applyKeys([key]) || needsRefresh;
      if (state.quit) break;
    }
    if (refreshQuota) void quotaObserver?.refresh();
    if (state.quit) {
      void shutdown(0);
      return;
    }
    if (needsRefresh) scheduleRefresh();
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.quit = true;
    observer.stop();
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
  removeStartupListeners();
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
    process.stdin.setRawMode(true);
    process.stdin.resume();
    quotaObserver = observeCodexQuota({
      onChange: (next) => {
        quota = next;
        if (!state.quit) redraw();
      },
    });
    await observer.refresh();
    syncSelection(state, visibleSessions(observer.snapshot, state.activeOnly, state.scope, state.filter));
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
