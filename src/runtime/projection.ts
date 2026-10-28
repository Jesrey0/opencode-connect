// Canonical projections from native OpenCode client entities into the connector's
// stable result shapes. Everything here is pure: no I/O, no runtime dispatch, no
// policy. Runtime code composes these; it never reimplements them.
//
// Outcome evidence lives here because worker/session projections consume it and
// `latestResult` produces it, so keeping the shape beside its projections avoids
// a cycle between the projection and result-selection layers.
import {
  type AgentInfo,
  type FormInfo,
  type PermissionRequest,
  type SessionInfo,
  type SessionInboxInfo,
  type SessionMessageInfo,
  type SkillInfo,
  type V2Event,
} from "@opencode/client";
import { page, textPage, fingerprint, ConnectorError as Error, TEXT_LIMIT, COMPACTION_PREVIEW_LIMIT, MESSAGE_TOOL_PREVIEW_LIMIT } from "../bounds.js";
import { nextCall, pageNextCall } from "../continuation.js";

export type SessionState = "inProgress" | "completed" | "failed" | "interrupted" | "idle";

export type ResultOutcome = "completed" | "failed" | "incomplete" | "unknown";
export type OutcomeEvidence = { basis: "selectedAssistantMessage"; outcome: ResultOutcome; assistantMessageId: string | null; finish: string | null; error: { type: string; status: number | null; messageOmitted: boolean } | null; selectionComplete: boolean; terminal: boolean; completedAtMs: number | null; unavailable: boolean; readError: string | null };

export function parseModelRef(value: string): { providerID: string; id: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("model must use the canonical provider/model form");
  }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function modelKey(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`;
}

export function sessionState(session: SessionInfo, active: Record<string, unknown>): SessionState {
  if (active[session.id]) return "inProgress";
  if (session.outcome === "succeeded") return "completed";
  if (session.outcome === "failed") return "failed";
  if (session.outcome === "interrupted") return "interrupted";
  return "idle";
}

export function projectRetry(message: Extract<SessionMessageInfo, { type: "assistant" }>) {
  const retry = message.retry;
  return retry ? {
    assistantMessageId: message.id,
    attempt: retry.attempt,
    nextAttemptAtMs: retry.at,
    error: { type: retry.error.type, status: retry.error.status ?? null, messageOmitted: true as const },
  } : null;
}

// Descending native history only: never borrow retry state from an older prompt
// or assistant. The native projector clears retry when the next step starts.
export function currentRetry(messages: SessionMessageInfo[]) {
  for (const message of messages) {
    if (message.type === "user" || message.type === "idle") break;
    if (message.type === "assistant") return projectRetry(message);
  }
  return null;
}

export function projectSession(session: SessionInfo, active: Record<string, unknown>, evidence?: Pick<OutcomeEvidence, "outcome">) {
  return {
    sessionId: session.id,
    runtime: "opencode" as const,
    parentSessionId: session.parentID ?? null,
    forkedFromSessionId: session.fork?.sessionID ?? null,
    cwd: session.location.directory,
    title: session.title ?? null,
    status: sessionState(session, active),
    executionOutcome: session.outcome ?? null,
    outcome: evidence?.outcome ?? "unknown",
    outcomeBasis: "selectedAssistantMessage",
    model: session.model ? modelKey(session.model) : null,
    agent: session.agent ?? null,
    modelVariant: session.model?.variant ?? null,
    permissionsConfigured: session.permissions !== undefined,
    permissionRuleCount: session.permissions?.length ?? 0,
    createdAtMs: session.time.created,
    updatedAtMs: session.time.updated,
    idleAtMs: session.time.idle ?? null,
    archivedAtMs: session.time.archived ?? null,
    cost: session.cost,
    tokens: session.tokens,
    usageBasis: "cumulativeSessionTotals" as const,
    contextOccupancy: "unknown" as const,
  };
}

export function projectWorker(session: SessionInfo, active: Record<string, unknown>, evidence: OutcomeEvidence, continuation?: ReturnType<typeof nextCall> | null) {
  const status = sessionState(session, active);
  return {
    sessionId: session.id,
    cwd: session.location.directory,
    status,
    executionOutcome: session.outcome ?? null,
    outcome: evidence.outcome,
    outcomeBasis: evidence.basis,
    outcomeEvidence: evidence,
    nextCall: continuation ?? nextCall("opencode.result", { sessionId: session.id }),
    title: session.title ?? null,
    model: session.model ? modelKey(session.model) : null,
    modelVariant: session.model?.variant ?? null,
    agent: session.agent ?? null,
    terminalAtMs: (status === "inProgress" || status === "idle") ? null : (session.time.idle ?? session.time.updated),
    lastActivityAtMs: session.time.updated,
  };
}

export function projectPermission(request: PermissionRequest) {
  return {
    type: "permission" as const,
    requestId: request.id,
    sessionId: request.sessionID,
    action: request.action,
    resources: request.resources,
    message: request.message ?? null,
  };
}

export function projectForm(form: FormInfo) {
  return {
    type: "form" as const,
    formId: form.id,
    sessionId: form.sessionID,
    title: form.title,
    fields: form.fields,
  };
}

export function assistantText(message: Extract<SessionMessageInfo, { type: "assistant" }>): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function projectMessage(message: SessionMessageInfo, offset?: number, limit?: number, expected?: string, sessionId?: string, preview = false) {
  const text = message.type === "user" ? message.text : message.type === "assistant" ? assistantText(message) : null;
  const paged = text === null ? null : textPage(text, offset, limit, expected);
  // Inventory previews page the remainder at the full on-demand width so a long
  // message recovers in few roundtrips; an explicit type:message textLimit is
  // preserved instead.
  const continuation = paged && sessionId ? pageNextCall("opencode.message", { sessionId, messageId: message.id, ...(preview ? { textLimit: TEXT_LIMIT } : limit === undefined ? {} : { textLimit: limit }) }, paged) : null;
  if (message.type === "user") {
    return { id: message.id, type: message.type, createdAtMs: message.time.created, ...paged, nextCall: continuation };
  }
  if (message.type === "assistant") {
    const toolCount = message.content.filter((part) => part.type === "tool").length;
    return {
      id: message.id,
      type: message.type,
      createdAtMs: message.time.created,
      completedAtMs: message.time.completed ?? null,
      agent: message.agent,
      model: modelKey(message.model),
      finish: message.finish ?? null,
      retry: projectRetry(message),
      ...paged, nextCall: continuation,
      error: message.error ? { type: message.error.type, status: message.error.status ?? null, messageOmitted: true } : null,
      requestTokens: message.tokens ?? null,
      requestCost: message.cost ?? null,
      requestUsageBasis: message.tokens ? "nativeAssistantRequest" as const : "unavailable" as const,
      contextOccupancy: "unknown" as const,
      tools: message.content
        .filter((part) => part.type === "tool")
        .slice(0, MESSAGE_TOOL_PREVIEW_LIMIT).map((part) => ({ id: part.id, name: part.name, status: part.state.status })),
      toolCount,
      toolsTruncated: toolCount > MESSAGE_TOOL_PREVIEW_LIMIT,
    };
  }
  if (message.type === "idle") {
    return { id: message.id, type: message.type, createdAtMs: message.time.created, outcome: message.outcome };
  }
  if (message.type === "compaction") {
    const summary = "summary" in message ? textPage(message.summary, 0, COMPACTION_PREVIEW_LIMIT) : null;
    const recent = "recent" in message ? textPage(message.recent, 0, COMPACTION_PREVIEW_LIMIT) : null;
    return {
      id: message.id,
      type: message.type,
      createdAtMs: message.time.created,
      status: message.status,
      reason: message.reason,
      error: "error" in message && message.error ? { type: message.error.type, messageOmitted: true } : null,
      model: "model" in message && message.model ? modelKey(message.model) : null,
      ...("summary" in message ? { summaryPreview: summary, summaryFingerprint: fingerprint(message.summary), summarySize: message.summary.length } : {}),
      ...("recent" in message ? { recentPreview: recent, recentFingerprint: fingerprint(message.recent), recentSize: message.recent.length } : {}),
      summaryNextCall: summary && sessionId ? pageNextCall("opencode.message", { sessionId, messageId: message.id, field: "summary", textLimit: TEXT_LIMIT }, summary) : null,
      recentNextCall: recent && sessionId ? pageNextCall("opencode.message", { sessionId, messageId: message.id, field: "recent", textLimit: TEXT_LIMIT }, recent) : null,
      requestTokens: "tokens" in message ? (message.tokens ?? null) : null,
      requestCost: "cost" in message ? (message.cost ?? null) : null,
      requestUsageBasis: ("tokens" in message && message.tokens ? "nativeCompactionRequest" : "unavailable") as "nativeCompactionRequest" | "unavailable",
      inboxCorrelationSupported: true as const,
    };
  }
  return {
    id: message.id,
    type: message.type,
    createdAtMs: message.time.created,
  };
}

export function unknownEvidence(terminal: boolean, readError: string | null = null): OutcomeEvidence {
  return { basis: "selectedAssistantMessage", outcome: "unknown", assistantMessageId: null, finish: null, error: null, selectionComplete: false, terminal, completedAtMs: null, unavailable: readError !== null, readError };
}

export function projectAgent(agent: AgentInfo) {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    description: textPage(agent.description ?? ""),
    system: textPage(agent.system ?? ""),
    steps: agent.steps ?? null,
    permissions: page(agent.permissions),
    model: agent.model ? modelKey(agent.model) : null,
  };
}

export function projectSkill(skill: SkillInfo) {
  return {
    id: skill.id,
    name: skill.name,
    description: textPage(skill.description ?? ""),
    path: skill.path ?? null,
  };
}

export function projectInbox(inbox: SessionInboxInfo) {
  return { inboxId: inbox.id, sessionId: inbox.sessionID, type: inbox.type, createdAtMs: inbox.time.created, delivery: inbox.delivery, status: "pending", ...( "text" in inbox.payload ? { preview: textPage(inbox.payload.text, 0, 512), textFingerprint: fingerprint(inbox.payload.text), textSize: inbox.payload.text.length } : {}) };
}

export function projectToolFile(content: { uri: string; mime: string; name?: string | null }) {
  const mime = content.mime.slice(0, 256);
  const name = content.name == null ? null : content.name.slice(0, 4096);
  return { text: "", file: { mime, name, metadataTruncated: mime !== content.mime || name !== (content.name ?? null), encoding: "metadataOnly", uriOmitted: true } };
}

export function secretProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(secretProjection);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /secret|token|password|credential|authorization|api.?key|cookie|provider.?state|request|config|env/i.test(key) ? "[omitted]" : secretProjection(entry)]));
  return value;
}

// Native event envelopes carry the session identity at different depths
// depending on whether the event body wraps a form, so identity extraction has
// to accept both shapes without inventing one.
export function eventSessionId(event: V2Event): string | undefined {
  if (!("data" in event) || !event.data || typeof event.data !== "object") return undefined;
  if ("sessionID" in event.data && typeof event.data.sessionID === "string") return event.data.sessionID;
  if ("form" in event.data && event.data.form && typeof event.data.form === "object" && "sessionID" in event.data.form && typeof event.data.form.sessionID === "string") {
    return event.data.form.sessionID;
  }
  return undefined;
}

export function eventLocationDirectory(event: V2Event): string | undefined {
  const location = (event as unknown as { location?: { directory?: unknown } }).location;
  return typeof location?.directory === "string" ? location.directory : undefined;
}

// A catalog read that carries no explicit location still resolves against the
// directory the native service settled on; queries must use the same directory
// the catalog was actually read from.
export function catalogLocation(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("location" in value)) return undefined;
  const location = (value as { location?: { directory?: unknown } }).location;
  return typeof location?.directory === "string" ? location.directory : undefined;
}
