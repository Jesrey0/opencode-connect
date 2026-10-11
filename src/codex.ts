import * as z from "zod/v4";
import type { OpenCodeClient } from "@opencode/client";
import { AdmissionError, ConnectorError, page, textPage, type PageInput } from "./bounds.js";
import { pageNextCall } from "./continuation.js";

export type Runtime = "opencode" | "codex";
const RPC_ID = "codex-sessions";
const definition = { id: RPC_ID, methods: Object.fromEntries(["start", "inspect", "wait", "interrupt", "delete", "messages", "list", "status"].map(method => [method, { input: z.unknown(), output: z.unknown() }])), events: {} };
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
    return record(await (client.rpc(definition) as any)[method](input, { signal: signal ? AbortSignal.any([bound, signal]) : bound }));
  } catch (error: any) {
    if (error instanceof ConnectorError) throw error;
    const type = errorType(error);
    if (method === "start" && type === "codex-sessions.admission_failed" && typeof error.data?.sessionId === "string") {
      throw new AdmissionError("Codex session exists; reconcile admission before retrying", { sessionId: id(error.data.sessionId), stage: "codexPromptAdmission", promptSubmitted: error.data.promptSubmitted === false ? false : null });
    }
    throw new ConnectorError(`Codex ${method} failed${type ? ` (${type})` : ""}; details omitted; ${["start", "interrupt", "delete"].includes(method) ? "mutation may have occurred; do not retry automatically" : "retry the read, not a mutation"}`);
  }
}
function capabilities(value: unknown) {
  const native = record(value);
  return { continuation: native.continuation === true, exactPromptWait: false, modelSelection: false, permissions: "read-only" as const, events: false };
}
function project(value: Record<string, any>, sessionId?: string) {
  const nativeId = id(value.sessionId);
  if (sessionId && nativeId !== sessionId) throw new ConnectorError("Codex answered for a different native session");
  if (!statuses.has(value.status) || !outcomes.has(value.outcome)) throw new ConnectorError("Codex returned an invalid session state");
  if (typeof value.output !== "string" || value.output.length > 65_536) throw new ConnectorError("Codex output exceeded its bounded session contract");
  const basis = value.executionKnown === true ? "nativePromptResponse" as const : "historyReplay" as const;
  return { sessionId: nativeId, cwd: id(value.cwd), runtime: "codex" as const, status: value.status as "idle" | "inProgress" | "completed" | "failed" | "interrupted", outcome: value.outcome as "unknown" | "completed" | "failed" | "incomplete", outcomeBasis: basis, executionOutcome: value.executionKnown === true ? value.stopReason ?? (value.status === "failed" ? "failed" : null) : null, executionKnown: value.executionKnown === true, model: null, modelVariant: null, agent: "codex", capabilities: capabilities(value.capabilities), title: typeof value.title === "string" ? value.title.slice(0, 512) : null };
}
export async function codexStart(client: OpenCodeClient, input: { task: string; cwd?: string; sessionId?: string }) {
  const value = await call(client, "start", input);
  if (input.sessionId && value.sessionId !== input.sessionId) throw new ConnectorError("Codex continued a different native session; reconcile admission before retrying");
  if (value.status !== "inProgress" || value.messageId !== null) throw new ConnectorError("Codex returned unusable prompt admission evidence");
  return { runtime: "codex" as const, sessionId: id(value.sessionId), messageId: null, cwd: id(value.cwd), status: "inProgress" as const, model: null, modelVariant: null, agent: "codex", capabilities: capabilities(value.capabilities) };
}
export type CodexInspectInput = { sessionId: string; messageId?: string; detail?: "semantic" | "result"; textOffset?: number; textLimit?: number; textFingerprint?: string; selectionCursor?: string; candidateAssistantMessageId?: string; selectionFingerprint?: string };
function inspection(value: Record<string, any>, input: CodexInspectInput) {
  const session = project(value, input.sessionId);
  const paged = textPage(value.output, input.textOffset, input.textLimit, input.textFingerprint);
  const result = { ...paged, outcome: session.outcome, outcomeBasis: session.outcomeBasis, messageId: null, assistantMessageId: value.assistantMessageId === null ? null : id(value.assistantMessageId), correlationSupported: false as const, terminal: session.executionKnown && session.status !== "inProgress", finish: typeof value.stopReason === "string" ? value.stopReason.slice(0, 64) : null, completedAtMs: typeof value.completedAtMs === "number" ? value.completedAtMs : null, error: value.error ? { type: errorType(value.error) ?? "unavailable", messageOmitted: true } : null, outputTruncated: value.outputTruncated === true, textNextCall: pageNextCall("opencode.inspect", { runtime: "codex", sessionId: input.sessionId, detail: "result", ...(input.textLimit ? { textLimit: input.textLimit } : {}) }, paged) };
  return { session, result };
}
export async function codexInspect(client: OpenCodeClient, input: CodexInspectInput) {
  if (input.messageId || input.selectionCursor || input.candidateAssistantMessageId || input.selectionFingerprint) throw new ConnectorError("Codex exact-prompt result selection is unsupported; query native messages by ID instead");
  return inspection(await call(client, "inspect", { sessionId: input.sessionId }), input);
}
export async function codexWait(client: OpenCodeClient, sessionId: string, messageId?: string, signal?: AbortSignal, waitMs = 40_000) {
  if (messageId) throw new ConnectorError("Codex wait observes the current session turn; exact-prompt waiting is unsupported");
  const value = await call(client, "wait", { sessionId, waitMs }, signal);
  const inspected = inspection(value, { sessionId });
  const state = !inspected.session.executionKnown ? "unknown" as const : inspected.session.status === "inProgress" ? "active" as const : "terminal" as const;
  return { runtime: "codex" as const, sessionId, messageId: null, state, wakeReason: state === "unknown" ? "executionUnavailable" as const : state === "active" ? "timeout" as const : "terminal" as const, ...inspected };
}
export async function codexAct(client: OpenCodeClient, action: string, sessionId: string) {
  if (!["interrupt", "delete"].includes(action)) throw new ConnectorError(`Codex session action ${action} is unsupported`);
  const value = await call(client, action, { sessionId });
  if (id(value.sessionId) !== sessionId) throw new ConnectorError("Codex answered for a different native session");
  if (action === "delete") {
    if (value.deleted !== true) throw new ConnectorError("Codex deletion was not confirmed");
    return { action: "delete" as const, runtime: "codex" as const, sessionId, deleted: true as const };
  }
  if (typeof value.interrupted !== "boolean") throw new ConnectorError("Codex interruption was not confirmed");
  return { action: "interrupt" as const, runtime: "codex" as const, sessionId, interrupted: value.interrupted };
}
export async function codexStatus(client: OpenCodeClient) {
  const value = await call(client, "status", {});
  if (!Array.isArray(value.sessions) || value.sessions.length > 64) throw new ConnectorError("Codex returned an invalid supervised session inventory");
  return value.sessions.map(entry => ({ ...project(record(entry)), retry: null, retryReadError: null, outcomeEvidence: { basis: record(entry).executionKnown ? "nativePromptResponse" : "historyReplay" }, nextCall: null }));
}
export async function codexQuery(client: OpenCodeClient, input: { type: string; sessionId?: string; messageId?: string; cwd?: string; cursor?: string; order?: "asc" | "desc"; searchTerm?: string; textOffset?: number; textLimit?: number; textFingerprint?: string; section?: string; field?: string } & PageInput) {
  if (input.type === "sessions") {
    if (input.offset !== undefined || input.fingerprint !== undefined) throw new ConnectorError("Codex session listing uses its native cursor");
    if (input.limit !== undefined || input.order !== undefined || input.searchTerm !== undefined) throw new ConnectorError("Codex session listing uses native page size and ordering; search is unsupported");
    const value = await call(client, "list", { ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) });
    if (!Array.isArray(value.sessions)) throw new ConnectorError("Codex session inventory is unavailable");
    return { sessions: value.sessions.map(raw => { const s = record(raw); return { sessionId: id(s.sessionId), cwd: id(s.cwd), title: typeof s.title === "string" ? s.title.slice(0, 512) : null, runtime: "codex", capabilities: capabilities(s.capabilities), updatedAt: typeof s.updatedAt === "string" ? s.updatedAt.slice(0, 64) : null }; }), cursor: { next: value.nextCursor === null ? null : id(value.nextCursor) } };
  }
  if (input.type === "runtime") return { runtime: "codex", capabilities: capabilities((await call(client, "status", {})).capabilities) };
  if (input.type === "session") return (await codexInspect(client, { sessionId: id(input.sessionId) })).session;
  if (input.type === "permissions") {
    if (input.section && input.section !== "summary") throw new ConnectorError("Codex exposes adapter policy only; OpenCode permission-rule operations are unsupported");
    await codexInspect(client, { sessionId: id(input.sessionId) });
    return { sessionId: input.sessionId, runtime: "codex", source: "adapter", mode: "read-only", permissionRequests: "deny", filesystemClient: false, terminalClient: false };
  }
  if (["messages", "message"].includes(input.type)) {
    if (input.cursor || input.field) throw new ConnectorError("Codex message history uses bounded fingerprint pagination and has no compaction fields");
    const value = await call(client, "messages", { sessionId: id(input.sessionId) });
    if (value.sessionId !== input.sessionId || !Array.isArray(value.messages) || value.messages.length > 128) throw new ConnectorError("Codex returned invalid native history");
    const messages = value.messages.map(raw => { const m = record(raw); if (!["user", "assistant"].includes(m.role) || typeof m.text !== "string" || m.text.length > 65_536) throw new ConnectorError("Codex returned invalid native message content"); return { id: m.id === null ? null : id(m.id), type: m.role, text: m.text, outputTruncated: m.truncated === true }; });
    if (input.type === "message") {
      const m = messages.find(m => m.id === input.messageId);
      if (!m) throw new ConnectorError("Native Codex message was not found in bounded history; no fallback was selected");
      const paged = textPage(m.text, input.textOffset, input.textLimit, input.textFingerprint);
      return { ...m, ...paged, nextCall: pageNextCall("opencode.query", { runtime: "codex", type: "message", sessionId: input.sessionId, messageId: input.messageId }, paged) };
    }
    const ordered = input.order === "asc" ? messages : [...messages].reverse();
    const paged = page(ordered.map(m => ({ ...m, text: m.text.slice(0, 512), previewTruncated: m.text.length > 512 })), input);
    return { ...paged, historyComplete: value.historyComplete === true };
  }
  throw new ConnectorError(`Codex query ${input.type} is unsupported`);
}
