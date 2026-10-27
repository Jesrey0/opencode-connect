import * as z from "zod/v4";
import type { OpenCodeClient } from "@opencode/client";
import { AdmissionError, ConnectorError, SessionDeleteError, page, textPage, type PageInput } from "./bounds.js";
import { pageNextCall, queryToolName } from "./continuation.js";
import { CodexSessionsDefinition } from "./codexRpc.js";
import { runtimeDiagnostics } from "./runtime/capabilities.js";

export type Runtime = "opencode" | "codex";
export const CODEX_MODES = ["read-only", "workspace-write", "agent", "agent-full-access"] as const;
export const CODEX_ACTIONS: ReadonlySet<string> = new Set(["interrupt", "delete", "respondPermission"]);
export const CODEX_QUERY_TYPES: ReadonlySet<string> = new Set(["usage", "sessions", "runtime", "session", "permissions", "messages", "message"]);
export type CodexMode = typeof CODEX_MODES[number];
const CONTROL = /[\x00-\x1f\x7f]/;
const statuses = new Set(["idle", "inProgress", "completed", "failed", "interrupted"]);
const outcomes = new Set(["unknown", "completed", "failed", "incomplete"]);
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("Codex returned an unusable session record");
  return value as Record<string, any>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || CONTROL.test(value)) throw new ConnectorError("Codex returned an invalid native identity");
  return value;
}
function errorType(error: any): string | null {
  return typeof error?.type === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(error.type) ? error.type : null;
}
async function call(client: OpenCodeClient, method: string, input: object, signal?: AbortSignal) {
  try {
    const bound = AbortSignal.timeout(45_000);
    return record(await (client.rpc(CodexSessionsDefinition) as any)[method](input, { signal: signal ? AbortSignal.any([bound, signal]) : bound }));
  } catch (error: any) {
    if (error instanceof ConnectorError && method !== "delete") throw error;
    const type = errorType(error);
    if (method === "delete") {
      const blocked: Record<string, [string, string]> = {
        "codex-sessions.delete_active": ["DELETE_SESSION_ACTIVE", "locally supervised Codex execution or admission is active"],
        "codex-sessions.delete_pending_approval": ["DELETE_PENDING_APPROVAL", "Codex session has pending permission requests"],
        "codex-sessions.unsupported": ["DELETE_UNSUPPORTED", "Codex does not support the required native delete/list capability"],
        "codex-sessions.busy": ["DELETE_BUSY", "Codex adapter is busy"],
      };
      if (type && blocked[type]) throw new SessionDeleteError(...blocked[type]);
      if (type === "codex-sessions.unknown_session" && error.data?.catalogComplete === true) throw new SessionDeleteError("DELETE_NOT_FOUND", "native Codex session was not found before deletion");
      if (type === "codex-sessions.delete_unverified" && error.data?.mutationAttempted === false) throw new SessionDeleteError("DELETE_PREFLIGHT_FAILED", "Codex session existence could not be established before deletion");
      throw new SessionDeleteError(type === "codex-sessions.delete_unverified" ? "DELETE_UNVERIFIED" : "DELETE_FAILED", "Codex deletion has no verified absence", true);
    }
    if (method === "start" && type === "codex-sessions.admission_failed" && typeof error.data?.sessionId === "string") {
      throw new AdmissionError("Codex session exists; reconcile admission before retrying", { sessionId: id(error.data.sessionId), stage: "codexPromptAdmission", promptSubmitted: error.data.promptSubmitted === false ? false : null });
    }
    throw new ConnectorError(`Codex ${method} failed${type ? ` (${type})` : ""}; details omitted; ${["start", "interrupt", "delete", "respondPermission"].includes(method) ? "mutation may have occurred; do not retry automatically" : "retry the read, not a mutation"}`);
  }
}
function mode(value: unknown): CodexMode | null {
  if (value == null) return null;
  if (!(CODEX_MODES as readonly unknown[]).includes(value)) throw new ConnectorError("Codex returned an invalid native mode");
  return value as CodexMode;
}
function threadSetting(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 512 || CONTROL.test(value)) throw new ConnectorError(`Codex returned invalid native ${label}`);
  return value;
}
function capabilities(value: unknown) {
  const native = record(value);
  if (native.permissions !== "operator-selected" || !Array.isArray(native.modes) || native.modes.length > 16) throw new ConnectorError("Codex mode capabilities are unavailable");
  const modes = native.modes.map(raw => {
    const m = record(raw);
    return { id: mode(m.id), name: id(m.name), sandboxPolicy: id(m.sandboxPolicy), approvalPolicy: id(m.approvalPolicy), approvalsReviewer: id(m.approvalsReviewer) };
  });
  return { continuation: native.continuation === true, exactPromptWait: false, modelSelection: false, permissions: "operator-selected" as const, modes, defaultMode: mode(native.defaultMode), events: false, filesystemClient: false, terminalClient: false, ...(native.usageQuota === "codex-app-server" ? { usageQuota: "codex-app-server" as const } : {}) };
}
const packageVersion = z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const pluginIdentitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable"), reason: z.enum(["not-reported", "package-metadata-unavailable"]) }),
  z.object({
    status: z.literal("available"), packageVersion, nativeVersion: packageVersion,
    build: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), buildId: z.null(), evidence: z.literal("package-relative-source") }),
      z.object({ kind: z.literal("immutable"), buildId: z.string().regex(/^[0-9a-f]{16}$/), evidence: z.literal("package-relative-build-record") }),
      z.object({ kind: z.literal("unavailable"), buildId: z.null(), reason: z.enum(["package-layout-unrecognized", "release-record-missing", "release-record-invalid"]) }),
    ]),
  }),
]);
export type CodexPluginIdentity = z.infer<typeof pluginIdentitySchema>;
function pluginIdentity(value: unknown): CodexPluginIdentity {
  if (value === undefined) return { status: "unavailable", reason: "not-reported" };
  const parsed = pluginIdentitySchema.safeParse(value);
  if (!parsed.success) throw new ConnectorError("Codex returned invalid plugin identity metadata; details omitted");
  return parsed.data;
}
// Validate and strip unknown fields at the RPC boundary too: an older or
// misconfigured installed plugin must not turn a quota read into identity data.
const quotaLabel = (max: number) => z.string().max(max).nullable();
const quotaWindow = z.object({ usedPercent: z.number(), resetsAt: z.number().nullable(), windowDurationMins: z.number().nullable() }).nullable();
const quotaSnapshot = z.object({
  source: z.literal("codex-app-server"), scope: z.literal("chatgpt-codex-usage-quota"), readAtMs: z.number(), ordinaryUsageAllowed: z.boolean().nullable(),
  account: z.object({ type: quotaLabel(64), planType: quotaLabel(64), requiresOpenaiAuth: z.boolean().nullable() }),
  buckets: z.array(z.object({
    bucketKey: quotaLabel(128), limitId: quotaLabel(128), limitName: quotaLabel(128), planType: quotaLabel(64), primary: quotaWindow, secondary: quotaWindow,
    credits: z.object({ hasCredits: z.boolean().nullable(), unlimited: z.boolean().nullable(), balance: quotaLabel(64) }).nullable(),
    individualLimit: z.object({ limit: quotaLabel(64), used: quotaLabel(64), remainingPercent: z.number().nullable(), resetsAt: z.number().nullable() }).nullable(),
    spendControlReached: z.boolean().nullable(), rateLimitReachedType: quotaLabel(128),
  }).refine(bucket => bucket.primary !== null || bucket.secondary !== null)).min(1).max(64),
  resetCredits: z.object({ available: z.number() }).nullable(),
  refusedServerRequests: z.array(z.string().max(128).nullable()).max(16).optional(),
});
function pending(value: unknown, sessionId: string) {
  if (!Array.isArray(value) || value.length > 8) throw new ConnectorError("Codex returned invalid pending permissions");
  return value.map(raw => {
    const r = record(raw), d = record(r.details);
    if (id(r.sessionId) !== sessionId || !Array.isArray(r.options) || r.options.length > 16) throw new ConnectorError("Codex permission identity is unusable");
    const text = (v: unknown, limit: number) => { if (v == null) return null; if (typeof v !== "string" || v.length > limit) throw new ConnectorError("Codex permission detail exceeded its bound"); return v; };
    const strings = (v: unknown) => { if (!Array.isArray(v) || v.length > 32) throw new ConnectorError("Codex permission paths exceeded their bound"); return v.map(p => { if (typeof p !== "string") throw new ConnectorError("Codex permission path is invalid"); return text(p, 4096)!; }); };
    const details = { command: text(d.command, 16384), cwd: text(d.cwd, 4096), locations: strings(d.locations), content: text(d.content, 16384), truncated: d.truncated === true, truncatedFields: strings(d.truncatedFields) };
    return { requestId: id(r.requestId), sessionId, action: text(r.action, 512), resources: strings(r.resources), message: text(r.message, 16384), details, options: r.options.map(o => { const option = record(o); return { optionId: id(option.optionId), name: text(option.name, 256), kind: text(option.kind, 64) }; }), reviewable: r.reviewable === true && !details.truncated, createdAtMs: typeof r.createdAtMs === "number" ? r.createdAtMs : null };
  });
}
function project(value: Record<string, any>, sessionId?: string) {
  const nativeId = id(value.sessionId);
  if (sessionId && nativeId !== sessionId) throw new ConnectorError("Codex answered for a different native session");
  if (!statuses.has(value.status) || !outcomes.has(value.outcome)) throw new ConnectorError("Codex returned an invalid session state");
  if (typeof value.output !== "string" || value.output.length > 65_536) throw new ConnectorError("Codex output exceeded its bounded session contract");
  const known = value.executionKnown === true;
  if (value.outcomeBasis !== undefined && !["nativePromptResponse", "nativeTurnHistory", "historyReplay"].includes(value.outcomeBasis)) throw new ConnectorError("Codex returned invalid outcome provenance");
  if (known && value.outcomeBasis === "historyReplay" || !known && ["nativeTurnHistory", "nativePromptResponse"].includes(value.outcomeBasis)) throw new ConnectorError("Codex execution evidence contradicts its provenance");
  const basis = !known ? "historyReplay" as const : value.outcomeBasis === "nativeTurnHistory" ? "nativeTurnHistory" as const : "nativePromptResponse" as const;
  if (basis === "nativeTurnHistory" && ({ completed: "completed", failed: "failed", interrupted: "incomplete" } as Record<string, string>)[value.status] !== value.outcome) throw new ConnectorError("Codex historical outcome does not match native turn status");
  const finish = basis === "nativeTurnHistory" ? ({ completed: "completed", failed: "failed", interrupted: "interrupted" } as Record<string, string>)[value.status] : value.stopReason ?? (value.status === "failed" ? "failed" : null);
  return {
    sessionId: nativeId, cwd: id(value.cwd), runtime: "codex" as const,
    status: value.status as "idle" | "inProgress" | "completed" | "failed" | "interrupted",
    outcome: value.outcome as "unknown" | "completed" | "failed" | "incomplete", outcomeBasis: basis,
    executionOutcome: known ? finish : null, executionKnown: known,
    model: threadSetting(value.model, "model"), modelProvider: threadSetting(value.modelProvider, "model provider"),
    reasoningEffort: threadSetting(value.reasoningEffort, "reasoning effort"), modelVariant: null, agent: "codex",
    capabilities: capabilities(value.capabilities), title: typeof value.title === "string" ? value.title.slice(0, 512) : null,
    mode: mode(value.mode),
  };
}
export async function codexStart(client: OpenCodeClient, input: { task: string; cwd?: string; sessionId?: string; mode?: CodexMode }) {
  const value = await call(client, "start", input);
  if (input.sessionId && value.sessionId !== input.sessionId) throw new ConnectorError("Codex continued a different native session; reconcile admission before retrying");
  if (input.mode && value.mode !== input.mode) throw new ConnectorError("Codex admitted a different native mode; reconcile admission before retrying");
  if (value.status !== "inProgress" || value.messageId !== null) throw new ConnectorError("Codex returned unusable prompt admission evidence");
  return {
    runtime: "codex" as const, sessionId: id(value.sessionId), messageId: null, cwd: id(value.cwd), status: "inProgress" as const,
    model: threadSetting(value.model, "model"), modelProvider: threadSetting(value.modelProvider, "model provider"),
    reasoningEffort: threadSetting(value.reasoningEffort, "reasoning effort"), modelVariant: null, agent: "codex",
    mode: mode(value.mode), capabilities: capabilities(value.capabilities),
  };
}
export type CodexInspectInput = { sessionId: string; messageId?: string; detail?: "semantic" | "result"; textOffset?: number; textLimit?: number; textFingerprint?: string; selectionCursor?: string; candidateAssistantMessageId?: string; selectionFingerprint?: string };
function inspection(value: Record<string, any>, input: CodexInspectInput) {
  const session = project(value, input.sessionId);
  const paged = textPage(value.output, input.textOffset, input.textLimit, input.textFingerprint);
  const result = { ...paged, outcome: session.outcome, outcomeBasis: session.outcomeBasis, messageId: null, assistantMessageId: value.assistantMessageId === null ? null : id(value.assistantMessageId), correlationSupported: false as const, terminal: session.executionKnown && session.status !== "inProgress", finish: typeof value.stopReason === "string" ? value.stopReason.slice(0, 64) : null, completedAtMs: typeof value.completedAtMs === "number" ? value.completedAtMs : null, error: value.error ? { type: errorType(value.error) ?? "unavailable", messageOmitted: true } : null, outputTruncated: value.outputTruncated === true, textNextCall: pageNextCall("opencode.inspectResult", { runtime: "codex", sessionId: input.sessionId, ...(input.textLimit ? { textLimit: input.textLimit } : {}) }, paged) };
  return { session, result, pendingActions: pending(value.pendingActions, session.sessionId) };
}
export async function codexInspect(client: OpenCodeClient, input: CodexInspectInput, signal?: AbortSignal) {
  if (input.messageId || input.selectionCursor || input.candidateAssistantMessageId || input.selectionFingerprint) throw new ConnectorError("Codex exact-prompt result selection is unsupported; query native messages by ID instead");
  return inspection(await call(client, "inspect", { sessionId: input.sessionId }, signal), input);
}
export async function codexWait(client: OpenCodeClient, sessionId: string, messageId?: string, signal?: AbortSignal, waitMs = 40_000) {
  if (messageId) throw new ConnectorError("Codex wait observes the current session turn; exact-prompt waiting is unsupported");
  const value = await call(client, "wait", { sessionId, waitMs }, signal);
  const inspected = inspection(value, { sessionId });
  const state = !inspected.session.executionKnown ? "unknown" as const : inspected.session.status === "inProgress" ? "active" as const : "terminal" as const;
  return { runtime: "codex" as const, sessionId, messageId: null, state, wakeReason: state === "unknown" ? "executionUnavailable" as const : state === "active" ? inspected.pendingActions.length ? "actionRequired" as const : "timeout" as const : "terminal" as const, ...inspected };
}
export async function codexAct(client: OpenCodeClient, input: { action: string; sessionId: string; requestId?: string; optionId?: string; decision?: string; message?: string }) {
  const { action, sessionId } = input;
  if (!CODEX_ACTIONS.has(action)) throw new ConnectorError("Codex session action " + action + " is unsupported");
  if (action === "respondPermission" && (!input.optionId || !input.requestId || input.decision !== undefined || input.message !== undefined)) throw new ConnectorError("Codex permission replies require an exact native optionId and requestId");
  const value = await call(client, action, { sessionId, ...(action === "respondPermission" ? { requestId: input.requestId, optionId: input.optionId } : {}) });
  if (action === "delete") {
    if (value.sessionId !== sessionId || value.deleted !== true) throw new SessionDeleteError("DELETE_UNVERIFIED", "Codex deletion identity or absence was not confirmed", true);
    return { action: "delete" as const, runtime: "codex" as const, sessionId, deleted: true as const };
  }
  if (id(value.sessionId) !== sessionId) throw new ConnectorError("Codex answered for a different native session");
  if (action === "respondPermission") {
    if (value.accepted !== true || value.requestId !== input.requestId || value.optionId !== input.optionId) throw new ConnectorError("Codex permission response was not confirmed; reconcile the request");
    return { action: "respondPermission" as const, runtime: "codex" as const, sessionId, requestId: id(value.requestId), optionId: id(value.optionId), accepted: true as const };
  }
  if (typeof value.interrupted !== "boolean") throw new ConnectorError("Codex interruption was not confirmed");
  return { action: "interrupt" as const, runtime: "codex" as const, sessionId, interrupted: value.interrupted };
}
export async function codexStatus(client: OpenCodeClient, signal?: AbortSignal) {
  const value = await call(client, "status", {}, signal);
  if (!Array.isArray(value.sessions) || value.sessions.length > 64) throw new ConnectorError("Codex returned an invalid supervised session inventory");
  return value.sessions.map(entry => {
    const projected = project(record(entry));
    return { ...projected, pendingActions: pending(record(entry).pendingActions, projected.sessionId), retry: null, retryReadError: null, outcomeEvidence: { basis: projected.outcomeBasis }, nextCall: null };
  });
}
export async function codexQuery(client: OpenCodeClient, input: { type: string; sessionId?: string; messageId?: string; cwd?: string; cursor?: string; order?: "asc" | "desc"; searchTerm?: string; textOffset?: number; textLimit?: number; textFingerprint?: string; section?: string; field?: string } & PageInput, signal?: AbortSignal) {
  if (!CODEX_QUERY_TYPES.has(input.type)) throw new ConnectorError(`Codex query ${input.type} is unsupported`);
  if (input.type === "usage") {
    // The native Codex plugin owns App Server quota collection and redaction.
    // These quota windows are not OpenCode token totals or General Chat limits.
    const value = await call(client, "usage", {}, signal);
    const parsed = quotaSnapshot.safeParse(value);
    if (!parsed.success) throw new ConnectorError("Codex returned an unusable quota snapshot; details omitted");
    return { ...parsed.data, runtime: "codex" as const, capabilities: capabilities(value.capabilities) };
  }
  if (input.type === "sessions") {
    if (input.offset !== undefined || input.fingerprint !== undefined) throw new ConnectorError("Codex session listing uses its native cursor");
    if (input.limit !== undefined || input.order !== undefined || input.searchTerm !== undefined) throw new ConnectorError("Codex session listing uses native page size and ordering; search is unsupported");
    const value = await call(client, "list", { ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }, signal);
    if (!Array.isArray(value.sessions)) throw new ConnectorError("Codex session inventory is unavailable");
    return { runtime: "codex", sessions: value.sessions.map(raw => {
      const s = record(raw);
      // ACP list metadata has no execution/outcome or archive evidence. Its optional
      // RFC3339 update time can be normalized, never substituted with read time.
      const updated = typeof s.updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s.updatedAt) ? Date.parse(s.updatedAt) : NaN;
      const nativeOutcomes: Record<string, string> = { completed: "completed", failed: "failed", interrupted: "incomplete" };
      const verified = s.executionKnown === true && s.outcomeBasis === "nativeTurnHistory";
      if (verified && (nativeOutcomes[s.status] !== s.outcome || s.executionOutcome !== s.status)) throw new ConnectorError("Codex history outcome is inconsistent with native status");
       return {
         sessionId: id(s.sessionId), cwd: id(s.cwd), title: typeof s.title === "string" ? s.title.slice(0, 512) : null,
         runtime: "codex", capabilities: capabilities(s.capabilities),
         status: verified ? s.status as "completed" | "failed" | "interrupted" : null,
         executionOutcome: verified ? s.executionOutcome as string : null, executionKnown: verified,
         outcome: verified ? s.outcome as "completed" | "failed" | "incomplete" : "unknown" as const,
         outcomeBasis: verified ? "nativeTurnHistory" as const : "unavailable" as const,
         model: threadSetting(s.model, "model"), modelProvider: threadSetting(s.modelProvider, "model provider"),
         reasoningEffort: threadSetting(s.reasoningEffort, "reasoning effort"), modelVariant: null,
         mode: mode(s.mode), createdAtMs: null, updatedAtMs: Number.isFinite(updated) ? updated : null,
         idleAtMs: null, archivedAtMs: null,
       };
    }), cursor: { next: value.nextCursor === null ? null : id(value.nextCursor) } };
  }
  if (input.type === "runtime") {
    const value = await call(client, "status", {}, signal);
    return { runtime: "codex", diagnostics: runtimeDiagnostics("codex"), capabilities: capabilities(value.capabilities), pluginIdentity: pluginIdentity(value.pluginIdentity) };
  }
  if (input.type === "session") return (await codexInspect(client, { sessionId: id(input.sessionId) }, signal)).session;
  if (input.type === "permissions") {
    if (input.section !== "pending") throw new ConnectorError("Codex exposes native pending requests, not OpenCode permission rules");
    const sessionId = id(input.sessionId), value = await call(client, "permissions", { sessionId }, signal);
    if (id(value.sessionId) !== sessionId) throw new ConnectorError("Codex answered for a different native session");
    const requests = pending(value.pendingActions, sessionId);
    return { sessionId, runtime: "codex", ...page(requests, input) };
  }
  if (["messages", "message"].includes(input.type)) {
    if (input.cursor || input.field) throw new ConnectorError("Codex message history uses bounded fingerprint pagination and has no compaction fields");
    const value = await call(client, "messages", { sessionId: id(input.sessionId) }, signal);
    if (value.sessionId !== input.sessionId || !Array.isArray(value.messages) || value.messages.length > 128) throw new ConnectorError("Codex returned invalid native history");
    const messages = value.messages.map(raw => { const m = record(raw); if (!["user", "assistant"].includes(m.role) || typeof m.text !== "string" || m.text.length > 65_536) throw new ConnectorError("Codex returned invalid native message content"); return { id: m.id === null ? null : id(m.id), type: m.role, text: m.text, outputTruncated: m.truncated === true }; });
    if (input.type === "message") {
      const m = messages.find(m => m.id === input.messageId);
      if (!m) throw new ConnectorError("Native Codex message was not found in bounded history; no fallback was selected");
      const paged = textPage(m.text, input.textOffset, input.textLimit, input.textFingerprint);
      return { ...m, ...paged, nextCall: pageNextCall(queryToolName("message"), { runtime: "codex", sessionId: input.sessionId, messageId: input.messageId }, paged) };
    }
    const ordered = input.order === "asc" ? messages : [...messages].reverse();
    const paged = page(ordered.map(m => ({ ...m, text: m.text.slice(0, 512), previewTruncated: m.text.length > 512 })), input);
    return { ...paged, historyComplete: value.historyComplete === true };
  }
  throw new ConnectorError(`Codex query ${input.type} is unsupported`);
}
