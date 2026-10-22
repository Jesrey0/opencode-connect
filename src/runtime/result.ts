// Canonical assistant-message result selection over native OpenCode history.
//
// Selection is bounded and side-effect free: it walks native pagination, pins a
// fingerprint at entry, re-verifies it at exit, and hands back caller-retained
// continuation rather than holding any local selection state across calls.
import type { SessionMessageInfo } from "@opencode/client";
import { fingerprint, checkFingerprint, textPage, ConnectorError as Error } from "../bounds.js";
import { nextCall, pageNextCall } from "../continuation.js";
import { assistantText, projectRetry, type OutcomeEvidence, type ResultOutcome } from "./projection.js";

type Client = import("@opencode/client").OpenCodeClient;

// The canonical selection/inspection contract. The backend adds only runtime
// routing, keeping this layer independent of the backend surface.
export type ResultSelectionInput = {
  sessionId: string;
  messageId?: string;
  detail?: "semantic" | "result";
  selectionCursor?: string;
  selectionFingerprint?: string;
  candidateAssistantMessageId?: string;
  textOffset?: number;
  textLimit?: number;
  textFingerprint?: string;
};

export async function latestResult(client: Client, input: ResultSelectionInput, terminal: boolean, signal?: AbortSignal) {
  const { sessionId, messageId } = input;
  if (input.selectionCursor && !messageId) throw new Error("selectionCursor requires the original user messageId");
  if (input.candidateAssistantMessageId && !input.selectionCursor) throw new Error("candidate requires selectionCursor");
  if (messageId) {
    const target = await client.session.message.get({ sessionID: sessionId, messageID: messageId }, { signal });
    if (target.type !== "user") throw new Error("result messageId must identify a canonical user prompt");
  }
  const initialSession = await client.session.get({ sessionID: sessionId }, { signal });
  const selectionFingerprint = fingerprint({ id: initialSession.id, time: initialSession.time, outcome: initialSession.outcome });
  checkFingerprint(selectionFingerprint, input.selectionFingerprint, input.selectionCursor ? 1 : 0);
  let assistant: Extract<SessionMessageInfo, { type: "assistant" }> | undefined;
  if (input.candidateAssistantMessageId) {
    const candidate = await client.session.message.get({ sessionID: sessionId, messageID: input.candidateAssistantMessageId }, { signal });
    if (candidate.type !== "assistant") throw new Error("candidate must be an assistant message");
    assistant = candidate;
  }
  let cursor = input.selectionCursor;
  let found = !messageId;
  let exhausted = false;
  let scanned = 0;
  let latestUserBoundary = false;
  // Bounded native pagination, with caller-retained continuation rather than local result state.
  for (let count = 0; count < 10; count += 1) {
    signal?.throwIfAborted();
    const response = await client.message.list({ sessionID: sessionId, limit: 50, ...(cursor ? { cursor } : { order: "desc" as const }) }, { signal });
    scanned += response.data.length;
    if (response.data.length === 0) { exhausted = true; cursor = undefined; break; }
    for (const message of response.data) {
      if (!messageId && message.type === "user") { latestUserBoundary = true; break; }
      if (message.id === messageId) { found = true; break; }
      if (message.type === "user" && messageId) assistant = undefined;
      if (message.type === "assistant" && !assistant) assistant = message;
      if (!messageId && assistant) break;
    }
    if (latestUserBoundary || (found && (messageId || assistant))) { cursor = undefined; break; }
    const next = response.cursor.next ?? undefined;
    if (!next) { exhausted = true; cursor = undefined; break; }
    if (next === cursor) throw new Error("native message pagination did not advance");
    cursor = next;
  }
  const finalSession = await client.session.get({ sessionID: sessionId }, { signal });
  const finalActive = await client.session.active({ signal });
  terminal = terminal && !finalActive[sessionId];
  if (fingerprint({ id: finalSession.id, time: finalSession.time, outcome: finalSession.outcome }) !== selectionFingerprint) throw new Error("session changed during result selection; restart pagination");
  if (messageId && exhausted && !found) throw new Error("canonical user target is absent from paginated history");
  const selected = found && !cursor;
  const text = selected && assistant ? assistantText(assistant) : "";
  const selectionComplete = selected && terminal;
  const outcome: ResultOutcome = !selectionComplete || !assistant ? "unknown"
    : assistant.error || assistant.finish === "error" ? "failed"
    : assistant.time.completed === undefined || assistant.finish !== "stop" ? "incomplete" : "completed";
  const paged = textPage(text, input.textOffset, input.textLimit, input.textFingerprint);
  const continuation = cursor && messageId ? nextCall("opencode.inspectResult", { sessionId, messageId, selectionCursor: cursor, selectionFingerprint, ...(assistant ? { candidateAssistantMessageId: assistant.id } : {}), ...(input.textLimit === undefined ? {} : { textLimit: input.textLimit }) })
    : cursor ? nextCall("opencode.messages", { sessionId, cursor, limit: 50 }) : null;
  const textNextCall = selectionComplete && assistant ? pageNextCall("opencode.message", { sessionId, messageId: assistant.id, ...(input.textLimit === undefined ? {} : { textLimit: input.textLimit }) }, paged) : null;
  return {
    outcomeBasis: "selectedAssistantMessage" as const,
    outcome,
    messageId: messageId ?? null,
    assistantMessageId: selected ? assistant?.id ?? null : null,
    selectionComplete,
    selectionCursor: cursor ?? null,
    selectionFingerprint,
    candidateAssistantMessageId: cursor ? assistant?.id ?? null : null,
    scannedMessages: scanned,
    targetFound: found,
    exhausted,
    terminal,
    ...paged,
    nextCall: continuation,
    textNextCall,
    completedAtMs: selected ? assistant?.time.completed ?? null : null,
    finish: selected ? assistant?.finish ?? null : null,
    retry: selected && assistant ? projectRetry(assistant) : null,
    error: selected && assistant?.error ? { type: assistant.error.type, status: assistant.error.status ?? null, messageOmitted: true } : null,
  };
}

export function resultEvidence(result: Awaited<ReturnType<typeof latestResult>>): OutcomeEvidence {
  return { basis: "selectedAssistantMessage", outcome: result.outcome, assistantMessageId: result.assistantMessageId, finish: result.finish, error: result.error, selectionComplete: result.selectionComplete, terminal: result.terminal, completedAtMs: result.completedAtMs, unavailable: false, readError: null };
}
