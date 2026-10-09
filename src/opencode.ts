import {
  isAgentNotFoundError,
  type AgentInfo,
  type FormInfo,
  type ModelInfo,
  type PermissionRequest,
  type SessionInfo,
  type SessionMessageInfo,
  type SkillInfo,
  type V2Event,
  type OpenCodeClient,
  type PermissionRule,
  type SessionPromptInput,
  type SessionInboxInfo,
} from "@opencode/client";
import { connectNative, OPENCODE_RELEASE, type Connect } from "./native.js";
import { page, textPage, type PageInput, integer, fingerprint, checkFingerprint, safeError, AdmissionError, CatalogError, TEXT_LIMIT, MESSAGE_PREVIEW_LIMIT, COMPACTION_PREVIEW_LIMIT, MESSAGE_TOOL_PREVIEW_LIMIT } from "./bounds.js";
import { nextCall, pageNextCall, queryNextCall } from "./continuation.js";
import { compactAgent, contextualPage, permissionSummary } from "./catalog.js";
export { OPENCODE_RELEASE } from "./native.js";
import { stat } from "node:fs/promises";
import { ConnectorError as Error } from "./bounds.js";

export const DEFAULT_AGENT = "build";
export const WAIT_TIMEOUT_MS = 45_000;
const CATALOG_INIT_TIMEOUT_MS = 8_000;
const CATALOG_SETTLE_MS = 200;
const RECENT_SESSION_LIMIT = 8;

type Client = OpenCodeClient;
type AgentCatalogEntry = Awaited<ReturnType<Client["agent"]["list"]>>["data"][number];
type ProviderCatalogEntry = Awaited<ReturnType<Client["provider"]["list"]>>["data"][number];
type SessionState = "inProgress" | "completed" | "failed" | "interrupted" | "idle";

async function readAgent(client: Client, agentId: string, cwd?: string) {
  try { return await client.agent.get({ agentID: agentId, ...(cwd ? { location: { directory: cwd } } : {}) }); }
  catch (error) {
    if (isAgentNotFoundError(error)) throw new CatalogError(agentId);
    throw error;
  }
}

export type StartInput = {
  task: string;
  model: string;
  cwd?: string;
  sessionId?: string;
  forkFromSessionId?: string;
  beforeMessageId?: string;
  agent?: string;
  title?: string;
  permissions?: PermissionRule[];
  variant?: string;
} & PromptAttachments;
export type PromptAttachments = Pick<SessionPromptInput, "files" | "agents" | "skills">;
type TextInput = { textOffset?: number; textLimit?: number; textFingerprint?: string };

export type InspectInput = {
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

export type QueryInput =
  | ({ type: "sessionDiff"; sessionId: string; from?: string; to?: string; context?: number; file?: string } & PageInput & TextInput)
  | ({ type: "inbox"; sessionId: string; inboxId?: string } & PageInput & TextInput)
  | ({ type: "skill"; cwd?: string; skillId: string } & TextInput)
  | ({ type: "tools"; sessionId: string; messageId: string } & PageInput)
  | ({ type: "tool"; sessionId: string; messageId: string; toolId: string; field: "input" | "content" | "error"; contentIndex?: number } & TextInput)
  | ({ type: "models"; cwd?: string; view?: "compact" | "full" } & PageInput)
  | ({ type: "agents"; cwd?: string; view?: "compact" | "full"; includeHidden?: boolean; includePermissionsSummary?: boolean } & PageInput)
  | ({ type: "agent"; cwd?: string; agentId: string; field?: "system" | "description" | "permissions" | "permissionSummary"; textOffset?: number; textLimit?: number; textFingerprint?: string } & PageInput)
  | { type: "messages"; sessionId: string; cursor?: string; limit?: number; order?: "asc" | "desc" }
  | { type: "message"; sessionId: string; messageId: string; field?: "summary" | "recent"; textOffset?: number; textLimit?: number; textFingerprint?: string }
  | ({ type: "permissions"; sessionId: string; section?: "rules" | "pending" | "summary" } & PageInput)
  | ({ type: "savedApprovals"; sessionId: string } & PageInput)
  | ({ type: "runtime"; cwd: string } & PageInput)
  | ({ type: "skills"; cwd?: string } & PageInput)
  | ({ type: "providers"; cwd?: string } & PageInput)
  | { type: "usage" }
  | { type: "sessions"; cursor?: string; limit?: number; cwd?: string; searchTerm?: string }
  | { type: "session"; sessionId: string };

export type ActInput =
  | ({ action: "steer"; sessionId: string; instruction: string } & PromptAttachments)
  | { action: "cancelInbox"; sessionId: string; inboxId: string }
  | { action: "updateInbox"; sessionId: string; inboxId: string; delivery: "steer" | "queue" }
  | { action: "compact"; sessionId: string; delivery?: "steer" | "queue" }
  | ({ action: "command"; sessionId: string; name: string; text: string; delivery?: "steer" | "queue" } & PromptAttachments)
  | { action: "invokeSkill"; sessionId: string; skillId: string; resume?: boolean }
  | { action: "interrupt"; sessionId: string }
  | { action: "respondPermission"; sessionId: string; requestId: string; decision: "once" | "always" | "reject"; message?: string }
  | { action: "respondForm"; sessionId: string; formId: string; answer: Record<string, string | number | boolean | string[]> }
  | { action: "cancelForm"; sessionId: string; formId: string }
  | { action: "delete"; sessionId: string }
  | { action: "revertStage"; sessionId: string; messageId: string; files?: boolean }
  | { action: "revertClear"; sessionId: string }
  | { action: "revertCommit"; sessionId: string }
  | { action: "switchModel"; sessionId: string; model: string; variant?: string }
  | { action: "switchAgent"; sessionId: string; agent: string }
  | { action: "setPermissions"; sessionId: string; permissions: PermissionRule[] }
  | { action: "removeSavedApproval"; sessionId: string; approvalId: string }
  | { action: "synthetic"; sessionId: string; text: string; description?: string; delivery?: "steer" | "queue"; resume?: boolean };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseModelRef(value: string): { providerID: string; id: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("model must use the canonical provider/model form");
  }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

function modelKey(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`;
}

export function isZeroCostModel(model: Pick<ModelInfo, "cost">): boolean {
  return Array.isArray(model.cost) && model.cost.length > 0 && model.cost.every((tier) =>
    tier?.input === 0 &&
    tier?.output === 0 &&
    tier?.cache?.read === 0 &&
    tier?.cache?.write === 0
  );
}

async function assertDirectory(cwd: string): Promise<void> {
  if (!cwd.startsWith("/")) throw new Error("cwd must be an absolute path");
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("cwd must point to a directory");
}

function sessionState(session: SessionInfo, active: Record<string, unknown>): SessionState {
  if (active[session.id]) return "inProgress";
  if (session.outcome === "succeeded") return "completed";
  if (session.outcome === "failed") return "failed";
  if (session.outcome === "interrupted") return "interrupted";
  return "idle";
}

type ResultOutcome = "completed" | "failed" | "incomplete" | "unknown";
type OutcomeEvidence = { basis: "selectedAssistantMessage"; outcome: ResultOutcome; assistantMessageId: string | null; finish: string | null; error: { type: string; status: number | null; messageOmitted: boolean } | null; selectionComplete: boolean; terminal: boolean; completedAtMs: number | null; unavailable: boolean; readError: string | null };

function projectRetry(message: Extract<SessionMessageInfo, { type: "assistant" }>) {
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
function currentRetry(messages: SessionMessageInfo[]) {
  for (const message of messages) {
    if (message.type === "user" || message.type === "idle") break;
    if (message.type === "assistant") return projectRetry(message);
  }
  return null;
}

function projectSession(session: SessionInfo, active: Record<string, unknown>, evidence?: Pick<OutcomeEvidence, "outcome">) {
  return {
    sessionId: session.id,
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
    cost: session.cost,
    tokens: session.tokens,
    usageBasis: "cumulativeSessionTotals" as const,
    contextOccupancy: "unknown" as const,
  };
}

function projectWorker(session: SessionInfo, active: Record<string, unknown>, evidence: OutcomeEvidence, continuation?: ReturnType<typeof nextCall> | null) {
  const status = sessionState(session, active);
  return {
    sessionId: session.id,
    cwd: session.location.directory,
    status,
    executionOutcome: session.outcome ?? null,
    outcome: evidence.outcome,
    outcomeBasis: evidence.basis,
    outcomeEvidence: evidence,
    nextCall: continuation ?? nextCall("opencode.inspect", { sessionId: session.id, detail: "result" }),
    title: session.title ?? null,
    model: session.model ? modelKey(session.model) : null,
    modelVariant: session.model?.variant ?? null,
    agent: session.agent ?? null,
    terminalAtMs: (status === "inProgress" || status === "idle") ? null : (session.time.idle ?? session.time.updated),
    lastActivityAtMs: session.time.updated,
  };
}

function projectPermission(request: PermissionRequest) {
  return {
    type: "permission" as const,
    requestId: request.id,
    sessionId: request.sessionID,
    action: request.action,
    resources: request.resources,
    message: request.message ?? null,
  };
}

function projectForm(form: FormInfo) {
  return {
    type: "form" as const,
    formId: form.id,
    sessionId: form.sessionID,
    title: form.title,
    fields: form.fields,
  };
}

function assistantText(message: Extract<SessionMessageInfo, { type: "assistant" }>): string {
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
  const continuation = paged && sessionId ? pageNextCall("opencode.query", { type: "message", sessionId, messageId: message.id, ...(preview ? { textLimit: TEXT_LIMIT } : limit === undefined ? {} : { textLimit: limit }) }, paged) : null;
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
      summaryNextCall: summary && sessionId ? pageNextCall("opencode.query", { type: "message", sessionId, messageId: message.id, field: "summary", textLimit: TEXT_LIMIT }, summary) : null,
      recentNextCall: recent && sessionId ? pageNextCall("opencode.query", { type: "message", sessionId, messageId: message.id, field: "recent", textLimit: TEXT_LIMIT }, recent) : null,
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

function eventSessionId(event: V2Event): string | undefined {
  if (!("data" in event) || !event.data || typeof event.data !== "object") return undefined;
  if ("sessionID" in event.data && typeof event.data.sessionID === "string") return event.data.sessionID;
  if ("form" in event.data && event.data.form && typeof event.data.form === "object" && "sessionID" in event.data.form && typeof event.data.form.sessionID === "string") {
    return event.data.form.sessionID;
  }
  return undefined;
}

function eventLocationDirectory(event: V2Event): string | undefined {
  const location = (event as unknown as { location?: { directory?: unknown } }).location;
  return typeof location?.directory === "string" ? location.directory : undefined;
}

function catalogLocation(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("location" in value)) return undefined;
  const location = (value as { location?: { directory?: unknown } }).location;
  return typeof location?.directory === "string" ? location.directory : undefined;
}

async function currentActions(client: Client, sessionId: string, signal?: AbortSignal) {
  const [permissions, forms] = await Promise.all([
    client.permission.list({ sessionID: sessionId }, { signal }),
    client.session.form.list({ sessionID: sessionId }, { signal }),
  ]);
  return [
    ...permissions.map(projectPermission),
    ...forms.map(projectForm),
  ];
}

export async function latestResult(client: Client, input: InspectInput, terminal: boolean, signal?: AbortSignal) {
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
  const continuation = cursor && messageId ? nextCall("opencode.inspect", { sessionId, messageId, detail: "result", selectionCursor: cursor, selectionFingerprint, ...(assistant ? { candidateAssistantMessageId: assistant.id } : {}), ...(input.textLimit === undefined ? {} : { textLimit: input.textLimit }) })
    : cursor ? nextCall("opencode.query", { queries: [{ type: "messages", sessionId, cursor, limit: 50 }] }) : null;
  const textNextCall = selectionComplete && assistant ? pageNextCall("opencode.query", { type: "message", sessionId, messageId: assistant.id, ...(input.textLimit === undefined ? {} : { textLimit: input.textLimit }) }, paged) : null;
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

function unknownEvidence(terminal: boolean, readError: string | null = null): OutcomeEvidence {
  return { basis: "selectedAssistantMessage", outcome: "unknown", assistantMessageId: null, finish: null, error: null, selectionComplete: false, terminal, completedAtMs: null, unavailable: readError !== null, readError };
}

function resultEvidence(result: Awaited<ReturnType<typeof latestResult>>): OutcomeEvidence {
  return { basis: "selectedAssistantMessage", outcome: result.outcome, assistantMessageId: result.assistantMessageId, finish: result.finish, error: result.error, selectionComplete: result.selectionComplete, terminal: result.terminal, completedAtMs: result.completedAtMs, unavailable: false, readError: null };
}

export class OpenCodeBackend {
  constructor(
    private readonly connect: Connect = connectNative,
    private readonly waitTimeoutMs = WAIT_TIMEOUT_MS,
    private readonly catalogInitTimeoutMs = CATALOG_INIT_TIMEOUT_MS,
    private readonly catalogSettleMs = CATALOG_SETTLE_MS,
  ) {}

  async health() {
    const { info } = await this.connect();
    return {
      ready: true,
      opencodeRelease: info.version,
      serverPid: info.pid,
    };
  }

  private async stableCatalog<T, R extends { data: T[] }>(
    client: Client,
    read: () => Promise<R>,
    eventType: "agent.updated" | "model.updated" | "provider.updated",
    key: (entry: T) => string,
    label: string,
    cwd?: string,
    allowEmptyAfterTimeout = false,
  ): Promise<R> {
    const same = (left: R, right: R) => {
      const leftKeys = left.data.map(key).sort();
      const rightKeys = right.data.map(key).sort();
      return leftKeys.length === rightKeys.length && leftKeys.every((value, index) => value === rightKeys[index]);
    };
    const confirm = async (candidate: R): Promise<R | null> => {
      if (candidate.data.length === 0) return null;
      if (this.catalogSettleMs > 0) await sleep(this.catalogSettleMs);
      const current = await read();
      return current.data.length > 0 && same(candidate, current) ? current : null;
    };

    let current = await read();
    const initial = await confirm(current);
    if (initial) return initial;
    if (this.catalogInitTimeoutMs <= 0) {
      if (allowEmptyAfterTimeout) return current;
      throw new Error("OpenCode " + label + " catalog did not stabilize");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.catalogInitTimeoutMs);
    const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const nextEvent = () => {
      const promise = iterator.next();
      void promise.catch(() => {});
      return promise;
    };
    try {
      let next = nextEvent();
      current = await read();
      const caughtUp = await confirm(current);
      if (caughtUp) return caughtUp;
      while (!controller.signal.aborted) {
        const item = await next;
        if (item.done) break;
        next = nextEvent();
        const event = item.value;
        if (event.type !== eventType) continue;
        const target = cwd ?? catalogLocation(current);
        const directory = eventLocationDirectory(event);
        if (target && directory && target !== directory) continue;
        current = await read();
        const settled = await confirm(current);
        if (settled) return settled;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      await iterator.return?.();
    }

    if (allowEmptyAfterTimeout) return await read();
    throw new Error("OpenCode " + label + " catalog did not stabilize before native location initialization completed");
  }

  private async stableModels(client: Client, cwd?: string): Promise<ModelInfo[]> {
    const response = await this.stableCatalog(
      client,
      async () => {
        const current = await client.model.list(cwd ? { location: { directory: cwd } } : undefined);
        return { ...current, data: current.data.filter((model) => model.enabled).sort((a, b) => modelKey(a).localeCompare(modelKey(b))) };
      },
      "model.updated",
      modelKey,
      "model",
      cwd,
    );
    return response.data;
  }

  private async stableAgentCatalog(client: Client, cwd?: string, allowEmptyAfterTimeout = false) {
    return this.stableCatalog(
      client,
      () => client.agent.list(cwd ? { location: { directory: cwd } } : undefined),
      "agent.updated",
      (agent: AgentCatalogEntry) => agent.id,
      "agent",
      cwd,
      allowEmptyAfterTimeout,
    );
  }

  private async stableAgents(client: Client, cwd?: string): Promise<AgentInfo[]> {
    return (await this.stableAgentCatalog(client, cwd)).data;
  }

  private async stableProviders(client: Client, cwd?: string, allowEmptyAfterTimeout = false) {
    return this.stableCatalog(
      client,
      () => client.provider.list(cwd ? { location: { directory: cwd } } : undefined),
      "provider.updated",
      (provider: ProviderCatalogEntry) => provider.id,
      "provider",
      cwd,
      allowEmptyAfterTimeout,
    );
  }

  private async validateModelAndAgent(client: Client, cwd: string, model: string, agent: string): Promise<void> {
    const [models, agents] = await Promise.all([
      this.stableModels(client, cwd),
      this.stableAgents(client, cwd),
    ]);
    if (!models.some((entry) => modelKey(entry) === model)) {
      throw new Error(`OpenCode model is not available at ${cwd}: ${model}`);
    }
    if (!agents.some((entry) => entry.id === agent)) {
      throw new Error(`OpenCode agent is not available at ${cwd}: ${agent}`);
    }
  }

  async status() {
    const { client, info } = await this.connect();
    const [active, recent] = await Promise.all([
      client.session.active(),
      client.session.list({ limit: RECENT_SESSION_LIMIT, order: "desc" }),
    ]);
    const activeIds = Object.keys(active);
    const activeSessions = await Promise.all(activeIds.map((sessionId) => client.session.get({ sessionID: sessionId })));
    const sessions = new Map<string, SessionInfo>();
    for (const session of [...activeSessions, ...recent.data]) sessions.set(session.id, session);
    const workers = await Promise.all([...sessions.values()]
      .sort((a, b) => {
        const aActive = active[a.id] ? 1 : 0;
        const bActive = active[b.id] ? 1 : 0;
        return bActive - aActive || b.time.updated - a.time.updated;
      })
      .map(async (session) => {
        if (active[session.id]) {
          try {
            const messages = await client.message.list({ sessionID: session.id, limit: 20, order: "desc" });
            return { ...projectWorker(session, active, unknownEvidence(false)), retry: currentRetry(messages.data), retryReadError: null };
          } catch (error) {
            return { ...projectWorker(session, active, unknownEvidence(false)), retry: null, retryReadError: safeError(error) };
          }
        }
        try {
          const result = await latestResult(client, { sessionId: session.id, textLimit: 512 }, true);
          return { ...projectWorker(session, active, resultEvidence(result), result.nextCall), retry: null, retryReadError: null };
        } catch (error) {
          return { ...projectWorker(session, active, unknownEvidence(true, safeError(error))), retry: null, retryReadError: null };
        }
      }));
    const pendingActions = (await Promise.all(activeIds.map((id) => currentActions(client, id)))).flat();
    return {
      ready: true,
      opencodeRelease: info.version,
      serverPid: info.pid,
      workers,
      pendingActions,
    };
  }

  async start(input: StartInput) {
    if (!input.task.trim()) throw new Error("task must not be empty");
    if (!input.model.trim()) throw new Error("opencode.start requires an explicit model");
    if (input.sessionId && input.forkFromSessionId) throw new Error("sessionId and forkFromSessionId are mutually exclusive");
    if (input.beforeMessageId && !input.forkFromSessionId) throw new Error("beforeMessageId requires forkFromSessionId");
    if (!input.sessionId && !input.forkFromSessionId && !input.cwd) throw new Error("fresh opencode.start requires an explicit cwd");
    if ((input.sessionId || input.forkFromSessionId) && input.cwd) throw new Error("resume and fork inherit cwd and reject cwd overrides");
    if ((input.sessionId || input.forkFromSessionId) && input.permissions) throw new Error("permissions are only valid for fresh sessions");
    if ((input.sessionId || input.forkFromSessionId) && input.variant !== undefined) throw new Error("resume and fork inherit canonical variant and reject overrides");
    checkPromptSize(input.task, input);

    const { client } = await this.connect();
    const active = await client.session.active();
    let session: SessionInfo | undefined;
    let stage = "sessionAdmission";
    let promptSubmitted: false | null = false;
    try {
    if (input.sessionId) {
      session = await client.session.get({ sessionID: input.sessionId });
      if (active[session.id]) throw new Error("session is already running; use opencode.act steer or interrupt");
      if (!session.model || modelKey(session.model) !== input.model) {
        throw new Error(`resume model must match canonical session model ${session.model ? modelKey(session.model) : "<unset>"}`);
      }
      if (input.agent && session.agent !== input.agent) throw new Error(`resume agent must match canonical session agent ${session.agent ?? "<unset>"}`);
    } else if (input.forkFromSessionId) {
      const source = await client.session.get({ sessionID: input.forkFromSessionId });
      if (!source.model || modelKey(source.model) !== input.model) {
        throw new Error(`fork model must match canonical source model ${source.model ? modelKey(source.model) : "<unset>"}`);
      }
      if (input.agent && source.agent !== input.agent) throw new Error(`fork agent must match canonical source agent ${source.agent ?? "<unset>"}`);
      await this.validateAttachments(client, source.location.directory, input.task, input);
      if (input.beforeMessageId) await client.session.message.get({ sessionID: source.id, messageID: input.beforeMessageId });
      session = await client.session.fork({ sessionID: source.id, before: input.beforeMessageId });
      if (session.location.directory !== source.location.directory || !session.model || modelKey(session.model) !== modelKey(source.model) || session.model.variant !== source.model.variant || session.agent !== source.agent) throw new Error("fork canonical state readback mismatch; prompt not submitted");
    } else {
      const cwd = input.cwd!;
      await assertDirectory(cwd);
      const agent = input.agent ?? DEFAULT_AGENT;
      await this.validateModelAndAgent(client, cwd, input.model, agent);
      await this.validateAttachments(client, cwd, input.task, input);
      if (input.variant !== undefined) {
        const models = await this.stableModels(client, cwd);
        if (!models.find((entry) => modelKey(entry) === input.model)?.variants.some((entry) => entry.id === input.variant)) throw new Error("model variant is not available");
      }
      const model = { ...parseModelRef(input.model), ...(input.variant !== undefined ? { variant: input.variant } : {}) };
      session = await client.session.create({
        title: input.title,
        location: { directory: cwd },
        model,
        agent,
        permissions: input.permissions,
      });
    }

    if (input.sessionId) await this.validateAttachments(client, session.location.directory, input.task, input);
    stage = "configurationReadback";
    if (!input.sessionId && !input.forkFromSessionId) {
      session = await client.session.get({ sessionID: session.id });
      if (!session.model || modelKey(session.model) !== input.model || session.agent !== (input.agent ?? DEFAULT_AGENT) || (input.variant !== undefined && session.model.variant !== input.variant)) throw new Error("initial session configuration readback mismatch; prompt not submitted");
      if (!session.location.directory) throw new Error("initial session location missing; prompt not submitted");
    }
    if (input.permissions) {
      const persisted = await client.session.get({ sessionID: session.id });
      if (JSON.stringify(persisted.permissions) !== JSON.stringify(input.permissions)) throw new Error("session permission readback mismatch");
      session = persisted;
    }
    stage = "promptAdmission";
    promptSubmitted = null;
    const prompt = await client.session.prompt({ sessionID: session.id, text: input.task, ...attachments(input), delivery: "steer", resume: true });
    return {
      sessionId: session.id,
      messageId: prompt.id,
      cwd: session.location.directory,
      model: session.model ? modelKey(session.model) : input.model,
      modelVariant: session.model?.variant ?? null,
      agent: session.agent ?? input.agent ?? DEFAULT_AGENT,
      status: "inProgress",
    };
    } catch (error) {
      if (session) throw new AdmissionError(safeError(error), { sessionId: session.id, stage, promptSubmitted });
      throw error;
    }
  }
  private async validateAttachments(client: Client, cwd: string, text: string, input: PromptAttachments) {
    checkPromptSize(text, input);
    if (input.agents?.length) {
      const catalog = (await client.agent.list({ location: { directory: cwd } })).data;
      for (const mention of input.agents) if (!catalog.some((entry) => entry.id === mention.name)) throw new Error("agent mention must use a canonical available agent ID");
    }
    if (input.skills?.length) {
      const catalog = (await client.skill.list({ location: { directory: cwd } })).data;
      for (const mention of input.skills) if (!catalog.some((entry) => entry.id === mention.id)) throw new Error("skill mention must match canonical skill ID");
    }
  }

  private async inspectSemantic(client: Client, session: SessionInfo, active: Record<string, unknown>, messageId?: string, signal?: AbortSignal) {
    const [messages, pendingActions] = await Promise.all([
      client.message.list({ sessionID: session.id, limit: 20, order: "desc" }, { signal }),
      currentActions(client, session.id, signal),
    ]);
    let result: Awaited<ReturnType<typeof latestResult>> | null = null;
    let evidence = unknownEvidence(!active[session.id]);
    if (!active[session.id]) {
      try {
        result = await latestResult(client, { sessionId: session.id, ...(messageId ? { messageId } : {}), textLimit: 512 }, true, signal);
        evidence = resultEvidence(result);
      } catch (error) {
        signal?.throwIfAborted();
        if (messageId) throw error; // Exact requested targets never fall back.
        evidence = unknownEvidence(true, safeError(error));
      }
    }
    return {
      session: projectSession(session, active, evidence),
      retry: active[session.id] ? currentRetry(messages.data) : null,
      outcomeEvidence: evidence,
      nextCall: result?.nextCall ?? null,
      textNextCall: result?.textNextCall ?? null,
      currentActivity: messages.data[0] ? projectMessage(messages.data[0], 0, MESSAGE_PREVIEW_LIMIT, undefined, session.id, true) : null,
      recentMessages: messages.data.map((message) => projectMessage(message, 0, MESSAGE_PREVIEW_LIMIT, undefined, session.id, true)),
      pendingActions,
    };
  }

  async inspect(input: InspectInput) {
    const { client } = await this.connect();
    const session = await client.session.get({ sessionID: input.sessionId });
    const active = await client.session.active();
    if ((input.detail ?? "semantic") === "result") {
      const terminal = !active[session.id];
      const result = await latestResult(client, input, terminal);
      return { session: projectSession(session, active, result), result };
    }
    if (active[session.id] && input.messageId) {
      const target = await client.session.message.get({ sessionID: session.id, messageID: input.messageId });
      if (target.type !== "user") throw new Error("result messageId must identify a canonical user prompt");
    }
    return this.inspectSemantic(client, session, active, input.messageId);
  }

  async wait(sessionId: string, messageId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { client } = await this.connect();
    signal?.throwIfAborted();
    const target = await client.session.message.get({ sessionID: sessionId, messageID: messageId }, { signal });
    if (target.type !== "user") throw new Error("wait messageId must identify a canonical user prompt");
    const synchronize = async () => {
      signal?.throwIfAborted();
      const session = await client.session.get({ sessionID: sessionId }, { signal });
      const active = await client.session.active({ signal });
      if (!active[sessionId]) {
        const result = await latestResult(client, { sessionId, messageId, detail: "result" }, true, signal);
        // A new execution may start while result selection is reading persisted messages.
        const after = await client.session.active({ signal });
        if (after[sessionId]) return { kind: "waiting" as const, semantic: await this.inspectSemantic(client, await client.session.get({ sessionID: sessionId }, { signal }), after, undefined, signal) };
        return { kind: "terminal" as const, response: { sessionId, messageId, state: "terminal" as const, wakeReason: "terminal" as const, session: projectSession(session, after, result), result } };
      }
      const semantic = await this.inspectSemantic(client, session, active, messageId, signal);
      if (semantic.pendingActions.length > 0) return { kind: "action" as const, response: { sessionId, messageId, state: "active" as const, wakeReason: "actionRequired" as const, ...semantic } };
      return { kind: "waiting" as const, semantic };
    };
    const initial = await synchronize();
    if (initial.kind !== "waiting") return initial.response;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.waitTimeoutMs);
    const observerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const iterator = client.event.subscribe({ signal: observerSignal })[Symbol.asyncIterator]();
    // Register rejection handling even when canonical reconciliation returns before this next resolves.
    const nextEvent = () => { const promise = iterator.next(); void promise.catch(() => {}); return promise; };
    try {
      let next = nextEvent();
      const afterSubscribe = await synchronize();
      if (afterSubscribe.kind !== "waiting") return afterSubscribe.response;
      while (!observerSignal.aborted) {
        const item = await next;
        if (item.done) break;
        next = nextEvent();
        const event = item.value;
        if (eventSessionId(event) === sessionId && [
          "permission.asked", "form.created", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle",
        ].includes(event.type)) {
          const canonical = await synchronize();
          if (canonical.kind !== "waiting") return canonical.response;
          // Stale hints never override canonical active state; keep the bounded wait open.
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      await iterator.return?.();
    }
    signal?.throwIfAborted();
    const final = await synchronize();
    if (final.kind !== "waiting") return final.response;
    return { sessionId, messageId, state: "active" as const, wakeReason: "timeout" as const, ...final.semantic };
  }

  async query(queries: QueryInput[]) {
    const { client } = await this.connect();
    const results = [];
    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      try {
        if (query.type === "skill") {
          const skills = (await client.skill.list(query.cwd ? { location: { directory: query.cwd } } : undefined)).data;
          const skill = skills.find((entry) => entry.id === query.skillId);
          if (!skill) throw new Error("canonical skill absent from catalog");
          results.push({ index, type: query.type, result: { ...projectSkill(skill), ...textPage(skill.content, query.textOffset, query.textLimit, query.textFingerprint) } });
          continue;
        }
        if (query.type === "sessionDiff") {
          const session = await client.session.get({ sessionID: query.sessionId });
          for (const id of [query.from, query.to]) if (id) await client.session.message.get({ sessionID: session.id, messageID: id });
          const diff = await client.session.diff({ sessionID: session.id, from: query.from, to: query.to, context: integer(query.context, 3, 1000) });
          const file = query.file ? diff.find((entry) => entry.file === query.file) : undefined;
          if (query.file && !file) throw new Error("file absent from native session diff");
          results.push({ index, type: query.type, result: { sessionId: session.id, from: query.from ?? null, to: query.to ?? null, ...(file ? { file: file.file, additions: file.additions, deletions: file.deletions, status: file.status, ...textPage(file.patch, query.textOffset, query.textLimit, query.textFingerprint) } : page(diff.map(({ patch, ...entry }) => ({ ...entry, patchSize: patch.length, patchFingerprint: fingerprint(patch) })), query)) } });
          continue;
        }
        if (query.type === "inbox") {
          await client.session.get({ sessionID: query.sessionId });
          const inbox = await client.session.inbox.list({ sessionID: query.sessionId });
          const selected = query.inboxId ? inbox.find((entry) => entry.id === query.inboxId) : undefined;
          if (query.inboxId && !selected) throw new Error("inbox entry not pending in targeted session");
          results.push({ index, type: query.type, result: selected ? { ...projectInbox(selected), ...textPage("text" in selected.payload ? selected.payload.text : "", query.textOffset, query.textLimit, query.textFingerprint) } : page(inbox.map(projectInbox), query) });
          continue;
        }
        if (query.type === "tools" || query.type === "tool") {
          const message = await client.session.message.get({ sessionID: query.sessionId, messageID: query.messageId });
          if (message.type !== "assistant") throw new Error("tool evidence requires canonical assistant message");
          const tools = message.content.filter((part) => part.type === "tool");
          const identity = { sessionId: query.sessionId, messageId: message.id };
          if (query.type === "tools") results.push({ index, type: query.type, result: { ...identity, ...page(tools.map((part) => ({ id: part.id, name: part.name, status: part.state.status, time: part.time, executed: part.executed ?? null })), query) } });
          else {
            const tool = tools.find((entry) => entry.id === query.toolId);
            if (!tool) throw new Error("canonical tool absent from targeted message");
            const state = tool.state;
            let text = "";
            let contentType: string | null = null;
            let contentTotal = 0;
            let file: { mime: string; name: string | null; encoding: string; uriOmitted: boolean } | null = null;
            if (query.field === "input") text = typeof state.input === "string" ? state.input : JSON.stringify(secretProjection(state.input));
            if (query.field === "error" && state.status === "error") text = JSON.stringify({ type: state.error.type, status: state.error.status ?? null, messageOmitted: true });
            if (query.field === "content") {
              const content = "content" in state ? state.content ?? [] : [];
              contentTotal = content.length;
              const selected = content[integer(query.contentIndex, 0, Number.MAX_SAFE_INTEGER)];
              if (!selected) throw new Error("tool content index absent");
              contentType = selected.type;
              if (selected.type === "text") text = selected.text;
              else {
                const projected = projectToolFile(selected);
                text = projected.text;
                file = projected.file;
              }
            }
            results.push({ index, type: query.type, result: { ...identity, toolId: tool.id, name: tool.name, status: state.status, time: tool.time, executed: tool.executed ?? null, field: query.field, contentType, contentTotal, contentIndex: query.contentIndex ?? 0, file, ...textPage(text, query.textOffset, query.textLimit, query.textFingerprint) } });
          }
          continue;
        }
        if (query.type === "models") {
          const models = await this.stableModels(client, query.cwd);
          const data = models.map((model) => ({
            id: modelKey(model),
            free: isZeroCostModel(model),
            enabled: model.enabled,
            modalities: model.capabilities.input,
            variants: model.variants.map((variant) => variant.id),
            ...(query.view === "compact" ? {} : {
            name: model.name,
            providerId: model.providerID,
            family: model.family ?? null,
            canonical: model.canonical ?? null,
            status: model.status,
            capabilities: model.capabilities,
            compatibility: model.compatibility ?? null,
            releasedAtMs: model.time.released,
            contextWindow: model.limit.context,
            inputLimit: model.limit.input ?? null,
            outputLimit: model.limit.output,
            }),
          }));
          results.push({ index, type: query.type, result: { view: query.view ?? "full", ...page(data, query) } });
          continue;
        }
        if (query.type === "agents") {
          const response = await this.stableAgentCatalog(client, query.cwd, true);
          const location = response.location;
          const view = query.view ?? "compact";
          const includeHidden = query.includeHidden ?? false;
          const agents = response.data.filter((agent) => includeHidden || !agent.hidden);
          const data = agents.map((agent) => {
            const summary = query.includePermissionsSummary ? permissionSummary(agent.permissions, { type: "agent", agentId: agent.id, location }) : undefined;
            return view === "full" ? { ...projectAgent(agent), ...(summary ? { permissionSummary: summary } : {}) } : compactAgent(agent, summary);
          });
          results.push({ index, type: query.type, result: {
            location, catalog: "effective", provenanceAvailable: false, view, includesBuiltins: true, includesHidden: includeHidden,
            hiddenCount: response.data.filter((agent) => agent.hidden).length,
            ...contextualPage(data, query, { location, view, includeHidden, includePermissionsSummary: query.includePermissionsSummary ?? false }),
          } });
          continue;
        }
        if (query.type === "skills") {
          const response = await client.skill.list(query.cwd ? { location: { directory: query.cwd } } : undefined);
          results.push({ index, type: query.type, result: page(response.data.map(projectSkill), query) });
          continue;
        }
        if (query.type === "providers") {
          const response = await this.stableProviders(client, query.cwd, true);
          results.push({ index, type: query.type, result: page(response.data.map((provider) => ({ id: provider.id, name: provider.name, activation: provider.activation })), query) });
          continue;
        }
        if (query.type === "usage") {
          results.push({ index, type: query.type, result: await client.session.stats() });
          continue;
        }
        if (query.type === "sessions") {
          const [response, active] = await Promise.all([
            client.session.list({ limit: integer(query.limit, 25, 50, 1), ...(query.cursor ? { cursor: query.cursor } : { order: "desc" as const }), directory: query.cwd, search: query.searchTerm }),
            client.session.active(),
          ]);
          results.push({ index, type: query.type, result: { sessions: response.data.map((session) => projectSession(session, active)), cursor: response.cursor } });
          continue;
        }
        if (query.type === "agent") {
          const response = await readAgent(client, query.agentId, query.cwd);
          const agent = response.data;
          const field = query.field ?? "system";
          const context = { type: "agent" as const, agentId: agent.id, location: response.location };
          results.push({ index, type: query.type, result: field === "permissionSummary"
            ? { id: agent.id, location: response.location, field, permissionSummary: permissionSummary(agent.permissions, context, query) }
            : { ...projectAgent(agent), location: response.location, field, ...(field === "permissions" ? { permissions: page(agent.permissions, query) } : textPage(agent[field] ?? "", query.textOffset, query.textLimit, query.textFingerprint)) } });
          continue;
        }
        if (query.type === "messages") {
          if (query.cursor && query.order) throw new Error("native message cursor cannot be combined with order");
          const response = await client.message.list({ sessionID: query.sessionId, limit: integer(query.limit, 25, 50, 1), ...(query.cursor ? { cursor: query.cursor } : { order: query.order ?? "desc" }) });
          results.push({ index, type: query.type, result: { messages: response.data.map((message) => projectMessage(message, 0, MESSAGE_PREVIEW_LIMIT, undefined, query.sessionId, true)), cursor: response.cursor } });
          continue;
        }
        if (query.type === "message") {
          const message = await client.session.message.get({ sessionID: query.sessionId, messageID: query.messageId });
          if (query.field) {
            if (message.type !== "compaction") throw new Error("field recovery requires a canonical compaction message");
            const full = query.field === "summary" && "summary" in message ? message.summary
              : query.field === "recent" && "recent" in message ? message.recent : null;
            if (full === null) throw new Error("compaction message has no such native text field");
            const paged = textPage(full, query.textOffset, query.textLimit, query.textFingerprint);
            results.push({ index, type: query.type, result: { id: message.id, type: message.type, createdAtMs: message.time.created, status: message.status, reason: message.reason, field: query.field, ...paged, nextCall: pageNextCall("opencode.query", { type: "message", sessionId: query.sessionId, messageId: message.id, field: query.field, ...(query.textLimit === undefined ? {} : { textLimit: query.textLimit }) }, paged) } });
            continue;
          }
          results.push({ index, type: query.type, result: projectMessage(message, query.textOffset, query.textLimit, query.textFingerprint, query.sessionId) });
          continue;
        }
        if (query.type === "permissions") {
          const session = await client.session.get({ sessionID: query.sessionId });
          if (query.section === "summary") {
            if (!session.agent) throw new Error("session has no persisted agent; cannot summarize its permission rules");
            const agent = (await readAgent(client, session.agent, session.location.directory)).data;
            results.push({ index, type: query.type, result: { sessionId: session.id, agentId: agent.id, location: session.location,
              permissionSummary: permissionSummary([...agent.permissions, ...(session.permissions ?? [])], { type: "session", agentId: agent.id, sessionId: session.id, location: session.location }, query),
            } });
            continue;
          }
          const requests = query.section === "pending" ? await client.permission.list({ sessionID: session.id }) : [];
          results.push({ index, type: query.type, result: { sessionId: session.id, defaultPolicyPreserved: session.permissions === undefined, section: query.section ?? "rules", ...((query.section ?? "rules") === "rules" ? { rules: page(session.permissions ?? [], query) } : { pending: page(requests.map(projectPermission), query) }), precedence: "session rules follow agent rules; omission preserves native default policy; explicit deny beats saved approval" } });
          continue;
        }
        if (query.type === "savedApprovals") {
          const session = await client.session.get({ sessionID: query.sessionId });
          const saved = await client.permission.saved.list({ projectID: session.projectID });
          results.push({ index, type: query.type, result: { projectId: session.projectID, ...page(saved, query) } });
          continue;
        }
        if (query.type === "runtime") {
          const location = { directory: query.cwd };
          const [runtime, plugins, mcp, commands] = await Promise.all([client.location.get({ location }), client.plugin.list({ location }), client.mcp.list({ location }), client.command.list({ location })]);
          const inventory = [
            ...plugins.data.map((plugin) => ({ type: "plugin", id: plugin.id ?? null, sourceType: plugin.source.type, features: plugin.features, status: plugin.state.status })),
            ...mcp.data.map((server) => ({ type: "mcp", name: server.name, status: server.status.status })),
            ...commands.data.map((command) => ({ type: "command", name: command.name })),
          ];
          results.push({ index, type: query.type, result: { location: { directory: runtime.directory }, projectId: runtime.project.id, opencodeRelease: OPENCODE_RELEASE, ...page(inventory, query), capabilities: { files: true, fileWrite: true, worktrees: true, sessionDiff: true, inbox: true, toolEvidence: true, skillContent: true, modelVariant: true, promptAttachments: true, sessionCommands: true, skillInvoke: true, compactionAdmission: true, vcs: true, shells: true, pty: true, persistentPty: "experimental", terminalScreen: true, terminalSnapshot: true, contentSearch: "native shell rg", patch: "native shell git apply", liveLsp: false, symbols: false, formatter: false } } });
          continue;
        }
        const [session, active] = await Promise.all([
          client.session.get({ sessionID: query.sessionId }),
          client.session.active(),
        ]);
        results.push({ index, type: query.type, result: projectSession(session, active) });
      } catch (error) {
        results.push({ index, type: query.type, error: safeError(error), errorCode: error instanceof CatalogError ? error.code : null, agentId: error instanceof CatalogError ? error.agentId : null });
      }
    }
    return { results: results.map((entry) => "result" in entry && entry.result && typeof entry.result === "object"
      ? { ...entry, result: { ...entry.result, nextCall: queryNextCall(queries[entry.index], entry.result) } } : entry) };
  }

  async act(input: ActInput) {
    const { client } = await this.connect();
    const session = await client.session.get({ sessionID: input.sessionId });
    if (input.action === "cancelInbox" || input.action === "updateInbox") {
      const before = await client.session.inbox.list({ sessionID: session.id });
      if (!before.some((entry) => entry.id === input.inboxId && entry.sessionID === session.id)) throw new Error("inbox entry not pending in targeted session");
      if (input.action === "cancelInbox") await client.session.inbox.cancel({ sessionID: session.id, inboxID: input.inboxId });
      else await client.session.inbox.update({ sessionID: session.id, inboxID: input.inboxId, delivery: input.delivery });
      const after = (await client.session.inbox.list({ sessionID: session.id })).find((entry) => entry.id === input.inboxId);
      if (input.action === "cancelInbox" && after) throw new Error("inbox cancel readback mismatch; mutation may have occurred");
      if (input.action === "updateInbox" && after && after.delivery !== input.delivery) throw new Error("inbox update readback mismatch; mutation may have occurred");
      return { action: input.action, sessionId: session.id, inboxId: input.inboxId, pending: !!after, delivery: after?.delivery ?? null, status: after ? "pending" : "absentFromPendingInbox", mutationSubmitted: true, persisted: input.action === "cancelInbox" || !!after, deliveryVerified: input.action === "updateInbox" ? !!after : null };
    }
    if (input.action === "compact") {
      const admitted = await client.session.compact({ sessionID: session.id, delivery: input.delivery });
      return {
        action: input.action,
        ...projectInbox(admitted),
        status: "admitted",
        completed: false,
        correlationSupported: true,
        completionNote: "read the exact native compaction message by inbox ID; a missing message or inbox absence does not prove completion",
        verifyNextCall: nextCall("opencode.query", { queries: [{ type: "message", sessionId: session.id, messageId: admitted.id }] }),
      };
    }
    if (input.action === "revertStage") {
      const revert = await client.session.revert.stage({ sessionID: session.id, messageID: input.messageId, files: input.files });
      return { action: input.action, sessionId: session.id, revert: { messageId: revert.messageID, partId: revert.partID ?? null, files: (revert.files ?? []).map(({ file, additions, deletions, status }) => ({ file, additions, deletions, status })) } };
    }
    if (input.action === "revertClear") {
      await client.session.revert.clear({ sessionID: session.id });
      return { action: input.action, sessionId: session.id, cleared: true };
    }
    if (input.action === "revertCommit") {
      await client.session.revert.commit({ sessionID: session.id });
      return { action: input.action, sessionId: session.id, committed: true };
    }
    if (input.action === "command") {
      await this.validateAttachments(client, session.location.directory, input.text, input);
      const commands = (await client.command.list({ location: session.location })).data;
      if (!commands.some((entry) => entry.name === input.name)) throw new Error("native session command absent from catalog");
      await client.session.command({ sessionID: session.id, name: input.name, text: input.text, delivery: input.delivery, ...attachments(input) });
      return { action: input.action, sessionId: session.id, name: input.name, submitted: true, identitySupplied: false };
    }
    if (input.action === "invokeSkill") {
      const skills = (await client.skill.list({ location: session.location })).data;
      if (!skills.some((entry) => entry.id === input.skillId)) throw new Error("canonical skill absent from catalog");
      await client.session.skill({ sessionID: session.id, id: input.skillId, resume: input.resume });
      return { action: input.action, sessionId: session.id, skillId: input.skillId, submitted: true, identitySupplied: false };
    }
    if (input.action === "switchModel" || input.action === "switchAgent" || input.action === "setPermissions") {
      const before = await client.session.get({ sessionID: input.sessionId });
      if (input.action === "switchModel") {
        const models = await this.stableModels(client, before.location.directory);
        const model = models.find((entry) => modelKey(entry) === input.model);
        if (!model) throw new Error(`OpenCode model is not available: ${input.model}`);
        if (input.variant && !model.variants.some((entry) => entry.id === input.variant)) throw new Error("model variant is not available");
        await client.session.switchModel({ sessionID: before.id, model: { ...parseModelRef(input.model), ...(input.variant ? { variant: input.variant } : {}) } });
      } else if (input.action === "switchAgent") {
        const agents = await this.stableAgents(client, before.location.directory);
        if (!agents.some((entry) => entry.id === input.agent)) throw new Error(`OpenCode agent is not available: ${input.agent}`);
        await client.session.switchAgent({ sessionID: before.id, agent: input.agent });
      } else await client.session.update({ sessionID: before.id, permissions: input.permissions });
      const after = await client.session.get({ sessionID: before.id });
      if (input.action === "switchModel" && (!after.model || modelKey(after.model) !== input.model || (input.variant !== undefined && after.model.variant !== input.variant))) throw new Error("model switch readback mismatch");
      if (input.action === "switchAgent" && after.agent !== input.agent) throw new Error("agent switch readback mismatch");
      if (input.action === "setPermissions" && JSON.stringify(after.permissions) !== JSON.stringify(input.permissions)) throw new Error("permission readback mismatch");
      return { action: input.action, session: projectSession(after, await client.session.active()), persisted: true };
    }
    if (input.action === "removeSavedApproval") {
      const projectId = session.projectID;
      const before = await client.permission.saved.list({ projectID: projectId });
      if (!before.some((entry) => entry.id === input.approvalId && entry.projectID === projectId)) throw new Error("saved approval absent from targeted project");
      await client.permission.saved.remove({ id: input.approvalId });
      const after = await client.permission.saved.list({ projectID: projectId });
      if (after.some((entry) => entry.id === input.approvalId)) throw new Error("saved approval removal readback mismatch; mutation may have occurred");
      return { action: input.action, sessionId: session.id, projectId, approvalId: input.approvalId, removed: true, persisted: true };
    }
    if (input.action === "synthetic") {
      if (Buffer.byteLength(input.text) > 12_000 || Buffer.byteLength(input.description ?? "") > 2000) throw new Error("synthetic input exceeds bounds");
      const inbox = await client.session.synthetic({ sessionID: input.sessionId, text: input.text, description: input.description, delivery: input.delivery, resume: input.resume });
      return { action: input.action, sessionId: inbox.sessionID, inboxId: inbox.id, type: inbox.type, createdAtMs: inbox.time.created, delivery: inbox.delivery };
    }
    if (input.action === "steer") {
      const active = await client.session.active();
      if (!active[input.sessionId]) throw new Error("steer requires an active session; use opencode.start to continue an idle session");
      await this.validateAttachments(client, session.location.directory, input.instruction, input);
      const prompt = await client.session.prompt({ sessionID: input.sessionId, text: input.instruction, ...attachments(input), delivery: "steer", resume: true });
      return { action: input.action, sessionId: input.sessionId, messageId: prompt.id };
    }
    if (input.action === "interrupt") {
      const result = await client.session.interrupt({ sessionID: input.sessionId, resume: false });
      return { action: input.action, sessionId: input.sessionId, interrupted: result.interrupted };
    }
    if (input.action === "respondPermission") {
      if (!(await client.permission.list({ sessionID: session.id })).some((entry) => entry.id === input.requestId && entry.sessionID === session.id)) throw new Error("permission request absent from targeted session");
      await client.permission.reply({ sessionID: input.sessionId, requestID: input.requestId, decision: input.decision, message: input.message });
      return { action: input.action, sessionId: input.sessionId, requestId: input.requestId, accepted: true };
    }
    if (input.action === "respondForm") {
      if (!(await client.session.form.list({ sessionID: session.id })).some((entry) => entry.id === input.formId && entry.sessionID === session.id)) throw new Error("form absent from targeted session");
      await client.session.form.reply({ sessionID: input.sessionId, formID: input.formId, answer: input.answer });
      return { action: input.action, sessionId: input.sessionId, formId: input.formId, accepted: true };
    }
    if (input.action === "cancelForm") {
      if (!(await client.session.form.list({ sessionID: session.id })).some((entry) => entry.id === input.formId && entry.sessionID === session.id)) throw new Error("form absent from targeted session");
      await client.session.form.cancel({ sessionID: input.sessionId, formID: input.formId });
      return { action: input.action, sessionId: input.sessionId, formId: input.formId, cancelled: true };
    }
    await client.session.remove({ sessionID: input.sessionId });
    return { action: input.action, sessionId: input.sessionId, deleted: true };
  }
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

function projectSkill(skill: SkillInfo) {
  return {
    id: skill.id,
    name: skill.name,
    description: textPage(skill.description ?? ""),
    path: skill.path ?? null,
  };
}

function attachments(input: PromptAttachments): PromptAttachments {
  return { files: input.files, agents: input.agents, skills: input.skills };
}
function checkPromptSize(text: string, input: PromptAttachments) {
  if (Buffer.byteLength(text) > 65_536 || Buffer.byteLength(JSON.stringify(attachments(input))) > 131_072) throw new Error("prompt exceeds text or attachment input bounds");
  for (const list of [input.files, input.agents, input.skills]) {
    if (list && list.length > 20) throw new Error("prompt attachment count exceeds 20 per kind");
    for (const entry of list ?? []) {
      const mention = entry.mention;
      if (mention && (!Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end) || mention.start < 0 || mention.end < mention.start || mention.end > text.length || text.slice(mention.start, mention.end) !== mention.text)) throw new Error("mention must identify the exact UTF-16 prompt range");
    }
  }
  for (const file of input.files ?? []) {
    if (file.uri.length > 90_000) throw new Error("prompt file URI exceeds input bound");
    let uri: URL;
    try { uri = new URL(file.uri); } catch { throw new Error("prompt file requires an absolute URI"); }
    if (uri.username || uri.password) throw new Error("prompt file URI must not embed credentials");
    if (uri.protocol === "data:") {
      const comma = file.uri.indexOf(",");
      const data = file.uri.slice(comma + 1);
      if (comma < 0 || !file.uri.slice(0, comma).endsWith(";base64") || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, "base64").toString("base64") !== data) throw new Error("inline prompt file requires canonical base64 data URI");
      if (Buffer.from(data, "base64").length > 65_536) throw new Error("prompt file exceeds 64 KiB");
    }
  }
}
function projectInbox(inbox: SessionInboxInfo) {
  return { inboxId: inbox.id, sessionId: inbox.sessionID, type: inbox.type, createdAtMs: inbox.time.created, delivery: inbox.delivery, status: "pending", ...( "text" in inbox.payload ? { preview: textPage(inbox.payload.text, 0, 512), textFingerprint: fingerprint(inbox.payload.text), textSize: inbox.payload.text.length } : {}) };
}
function projectToolFile(content: { uri: string; mime: string; name?: string | null }) {
  const mime = content.mime.slice(0, 256);
  const name = content.name == null ? null : content.name.slice(0, 4096);
  return { text: "", file: { mime, name, metadataTruncated: mime !== content.mime || name !== (content.name ?? null), encoding: "metadataOnly", uriOmitted: true } };
}
function secretProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(secretProjection);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /secret|token|password|credential|authorization|api.?key|cookie|provider.?state|request|config|env/i.test(key) ? "[omitted]" : secretProjection(entry)]));
  return value;
}
