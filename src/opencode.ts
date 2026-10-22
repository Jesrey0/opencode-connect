import {
  type SessionInfo,
  type OpenCodeClient,
  type PermissionRule,
  type SessionPromptInput,
} from "@opencode/client";
import { connectNative, type Connect } from "./native.js";
import { codexStart, codexInspect, codexWait, codexAct, codexQuery, codexStatus, type Runtime, type CodexMode } from "./codex.js";
import { safeError, AdmissionError, CatalogError, SessionDeleteError, MESSAGE_PREVIEW_LIMIT } from "./bounds.js";
import { nextCall, queryNextCall } from "./continuation.js";
import { resolveNativeQuery, type NativeQueryInput } from "./runtime/query.js";
import { latestResult, resultEvidence, type ResultSelectionInput } from "./runtime/result.js";
import {
  modelKey,
  parseModelRef,
  projectMessage,
  projectSession,
  projectWorker,
  projectPermission,
  projectForm,
  projectInbox,
  currentRetry,
  unknownEvidence,
  eventSessionId,
} from "./runtime/projection.js";
import { stat } from "node:fs/promises";
import { ConnectorError as Error } from "./bounds.js";

export const WAIT_TIMEOUT_MS = 45_000;
const RECENT_SESSION_LIMIT = 8;

type Client = OpenCodeClient;

export type StartInput = {
  runtime?: Runtime;
  mode?: CodexMode;
  task: string;
  model?: string;
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
export type InspectInput = ResultSelectionInput & { runtime?: Runtime };

// The facade adds runtime routing to the native query contract.
export type QueryInput = NativeQueryInput & { runtime?: Runtime };

export type ActInput = (
  | ({ action: "steer"; sessionId: string; instruction: string } & PromptAttachments)
  | { action: "cancelInbox"; sessionId: string; inboxId: string }
  | { action: "updateInbox"; sessionId: string; inboxId: string; delivery: "steer" | "queue" }
  | { action: "compact"; sessionId: string; delivery?: "steer" | "queue" }
  | ({ action: "command"; sessionId: string; name: string; text: string; delivery?: "steer" | "queue" } & PromptAttachments)
  | { action: "invokeSkill"; sessionId: string; skillId: string; resume?: boolean }
  | { action: "interrupt"; sessionId: string }
  | { action: "respondPermission"; sessionId: string; requestId: string; decision?: "once" | "always" | "reject"; message?: string; optionId?: string }
  | { action: "respondForm"; sessionId: string; formId: string; answer: Record<string, string | number | boolean | string[]> }
  | { action: "cancelForm"; sessionId: string; formId: string }
  | { action: "delete"; runtime: Runtime; sessionId: string }
  | { action: "revertStage"; sessionId: string; messageId: string; files?: boolean }
  | { action: "revertClear"; sessionId: string }
  | { action: "revertCommit"; sessionId: string }
  | { action: "switchModel"; sessionId: string; model: string; variant?: string }
  | { action: "switchAgent"; sessionId: string; agent: string }
  | { action: "setPermissions"; sessionId: string; permissions: PermissionRule[] }
  | { action: "removeSavedApproval"; sessionId: string; approvalId: string }
  | { action: "synthetic"; sessionId: string; text: string; description?: string; delivery?: "steer" | "queue"; resume?: boolean }
  ) & { runtime?: Runtime };

async function assertDirectory(cwd: string): Promise<void> {
  if (!cwd.startsWith("/")) throw new Error("cwd must be an absolute path");
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("cwd must point to a directory");
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

export class OpenCodeBackend {
  constructor(
    private readonly connect: Connect = connectNative,
    private readonly waitTimeoutMs = WAIT_TIMEOUT_MS,
  ) {}

  async health() {
    const { info } = await this.connect();
    return {
      ready: true,
      opencodeRelease: info.version,
      serverPid: info.pid,
    };
  }

  async status(runtime: "codex"): Promise<{ ready: true; opencodeRelease: string; serverPid: number; workers: Awaited<ReturnType<typeof codexStatus>>; pendingActions: Array<Record<string, unknown>> }>;
  async status(runtime?: "opencode"): Promise<Awaited<ReturnType<OpenCodeBackend["statusNative"]>>>;
  async status(runtime?: Runtime): Promise<Awaited<ReturnType<OpenCodeBackend["statusNative"]>> | { ready: true; opencodeRelease: string; serverPid: number; workers: Awaited<ReturnType<typeof codexStatus>>; pendingActions: Array<Record<string, unknown>> }>;
  async status(runtime: Runtime = "opencode"): Promise<Awaited<ReturnType<OpenCodeBackend["statusNative"]>> | { ready: true; opencodeRelease: string; serverPid: number; workers: Awaited<ReturnType<typeof codexStatus>>; pendingActions: Array<Record<string, unknown>> }> {
    if (runtime !== "codex") return this.statusNative();
    const { client, info } = await this.connect();
    const workers = await codexStatus(client);
    return { ready: true as const, opencodeRelease: info.version, serverPid: info.pid, workers, pendingActions: workers.flatMap(worker => worker.pendingActions) };
  }
  private async statusNative() {
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

  async start(input: StartInput & { runtime: "codex" }): Promise<Awaited<ReturnType<typeof codexStart>>>;
  async start(input: StartInput & { runtime?: "opencode" }): Promise<Awaited<ReturnType<OpenCodeBackend["startNative"]>>>;
  async start(input: StartInput): Promise<Awaited<ReturnType<typeof codexStart>> | Awaited<ReturnType<OpenCodeBackend["startNative"]>>>;
  async start(input: StartInput) {
    if (input.runtime === "codex") {
      for (const field of ["model", "agent", "variant", "permissions", "forkFromSessionId", "beforeMessageId", "title", "files", "agents", "skills"] as const) if (input[field] !== undefined) throw new Error(`Codex start field ${field} is unsupported`);
      if (input.cwd) await assertDirectory(input.cwd);
      const { client } = await this.connect();
      return codexStart(client, { task: input.task, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.mode !== undefined ? { mode: input.mode } : {}) });
    }
    if (input.mode !== undefined) throw new Error("mode selects a Codex preset; OpenCode uses canonical permission rules");
    return this.startNative(input);
  }
  private async startNative(input: StartInput) {
    if (!input.task.trim()) throw new Error("task must not be empty");
    if (input.sessionId && input.forkFromSessionId) throw new Error("sessionId and forkFromSessionId are mutually exclusive");
    if (input.beforeMessageId && !input.forkFromSessionId) throw new Error("beforeMessageId requires forkFromSessionId");
    if (!input.sessionId && !input.forkFromSessionId && !input.cwd) throw new Error("fresh opencode.start requires an explicit cwd");
    if ((input.sessionId || input.forkFromSessionId) && input.cwd) throw new Error("resume and fork inherit cwd and reject cwd overrides");
    if ((input.sessionId || input.forkFromSessionId) && input.permissions) throw new Error("permissions are only valid for fresh sessions");
    if ((input.sessionId || input.forkFromSessionId) && input.variant !== undefined) throw new Error("resume and fork inherit canonical variant and reject overrides");
    if (input.variant !== undefined && input.model === undefined) throw new Error("variant requires an explicit model");
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
      if (input.model !== undefined && (!session.model || modelKey(session.model) !== input.model)) {
        throw new Error(`resume model must match canonical session model ${session.model ? modelKey(session.model) : "<unset>"}`);
      }
      if (input.agent !== undefined && session.agent !== input.agent) throw new Error(`resume agent must match canonical session agent ${session.agent ?? "<unset>"}`);
    } else if (input.forkFromSessionId) {
      const source = await client.session.get({ sessionID: input.forkFromSessionId });
      if (input.model !== undefined && (!source.model || modelKey(source.model) !== input.model)) {
        throw new Error(`fork model must match canonical source model ${source.model ? modelKey(source.model) : "<unset>"}`);
      }
      if (input.agent !== undefined && source.agent !== input.agent) throw new Error(`fork agent must match canonical source agent ${source.agent ?? "<unset>"}`);
      if (input.beforeMessageId) await client.session.message.get({ sessionID: source.id, messageID: input.beforeMessageId });
      session = await client.session.fork({ sessionID: source.id, before: input.beforeMessageId });
      if (session.location.directory !== source.location.directory || (session.model ? modelKey(session.model) : null) !== (source.model ? modelKey(source.model) : null) || session.model?.variant !== source.model?.variant || session.agent !== source.agent) throw new Error("fork canonical state readback mismatch; prompt not submitted");
    } else {
      const cwd = input.cwd!;
      await assertDirectory(cwd);
      session = await client.session.create({
        title: input.title,
        location: { directory: cwd },
        ...(input.model !== undefined ? { model: { ...parseModelRef(input.model), ...(input.variant !== undefined ? { variant: input.variant } : {}) } } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        permissions: input.permissions,
      });
    }

    stage = "configurationReadback";
    if (!input.sessionId && !input.forkFromSessionId) {
      session = await client.session.get({ sessionID: session.id });
      if ((input.model !== undefined && (!session.model || modelKey(session.model) !== input.model)) || (input.agent !== undefined && session.agent !== input.agent) || (input.variant !== undefined && session.model?.variant !== input.variant)) throw new Error("initial session configuration readback mismatch; prompt not submitted");
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
    stage = "selectionReadback";
    session = await client.session.get({ sessionID: session.id });
    return {
      sessionId: session.id,
      messageId: prompt.id,
      cwd: session.location.directory,
      model: session.model ? modelKey(session.model) : null,
      modelVariant: session.model?.variant ?? null,
      agent: session.agent ?? null,
      status: "inProgress",
    };
    } catch (error) {
      if (session) throw new AdmissionError(safeError(error), { sessionId: session.id, stage, promptSubmitted });
      throw error;
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

  async inspect(input: InspectInput & { runtime: "codex" }): Promise<Awaited<ReturnType<typeof codexInspect>>>;
  async inspect(input: InspectInput & { runtime?: "opencode" }): Promise<Awaited<ReturnType<OpenCodeBackend["inspectNative"]>>>;
  async inspect(input: InspectInput): Promise<Awaited<ReturnType<typeof codexInspect>> | Awaited<ReturnType<OpenCodeBackend["inspectNative"]>>>;
  async inspect(input: InspectInput) {
    if (input.runtime !== "codex") return this.inspectNative(input);
    return codexInspect((await this.connect()).client, input);
  }
  private async inspectNative(input: InspectInput) {
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

  async wait(sessionId: string, messageId: string | undefined, signal: AbortSignal | undefined, runtime: "codex"): Promise<Awaited<ReturnType<typeof codexWait>>>;
  async wait(sessionId: string, messageId: string, signal?: AbortSignal, runtime?: "opencode"): Promise<Awaited<ReturnType<OpenCodeBackend["waitNative"]>>>;
  async wait(sessionId: string, messageId?: string, signal?: AbortSignal, runtime?: Runtime): Promise<Awaited<ReturnType<typeof codexWait>> | Awaited<ReturnType<OpenCodeBackend["waitNative"]>>>;
  async wait(sessionId: string, messageId?: string, signal?: AbortSignal, runtime: Runtime = "opencode") {
    if (runtime === "codex") return codexWait((await this.connect()).client, sessionId, messageId, signal, Math.min(this.waitTimeoutMs, 40_000));
    if (!messageId) throw new Error("OpenCode wait requires a canonical user messageId");
    return this.waitNative(sessionId, messageId, signal);
  }
  private async waitNative(sessionId: string, messageId: string, signal?: AbortSignal) {
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

  // Request envelope only: runtime dispatch, per-entry error capture, and
  // continuation attachment. Each query type resolves in runtime/query.ts.
  async query(queries: QueryInput[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { client } = await this.connect();
    const results: Array<{ index: number; type: QueryInput["type"]; result?: unknown; error?: string; errorCode?: string | null; agentId?: string | null }> = [];
    for (let index = 0; index < queries.length; index += 1) {
      signal?.throwIfAborted();
      const query = queries[index];
      try {
        const result = query.runtime === "codex"
          ? await codexQuery(client, query, signal)
          : await resolveNativeQuery(client, query, signal);
        signal?.throwIfAborted();
        results.push({ index, type: query.type, result });
      } catch (error) {
        signal?.throwIfAborted();
        results.push({ index, type: query.type, error: safeError(error), errorCode: error instanceof CatalogError ? error.code : null, agentId: error instanceof CatalogError ? error.agentId : null });
      }
    }
    return { results: results.map((entry) => "result" in entry && entry.result && typeof entry.result === "object"
      ? { ...entry, result: { ...entry.result, nextCall: queryNextCall(queries[entry.index], entry.result) } } : entry) };
  }

  async act(input: ActInput & { runtime: "codex" }): Promise<Awaited<ReturnType<typeof codexAct>>>;
  async act(input: ActInput & { runtime?: "opencode" }): Promise<Awaited<ReturnType<OpenCodeBackend["actNative"]>>>;
  async act(input: ActInput): Promise<Awaited<ReturnType<typeof codexAct>> | Awaited<ReturnType<OpenCodeBackend["actNative"]>>>;
  async act(input: ActInput) {
    if (input.action === "delete" && input.runtime !== "opencode" && input.runtime !== "codex") throw new SessionDeleteError("DELETE_RUNTIME_REQUIRED", "explicit opencode or codex runtime is required");
    if (input.runtime !== "codex") return this.actNative(input);
    return codexAct((await this.connect()).client, input);
  }
  private async actNative(input: ActInput) {
    if (input.action === "delete") {
      await this.deleteNative(input.sessionId);
      return { action: "delete" as const, runtime: "opencode" as const, sessionId: input.sessionId, deleted: true as const };
    }
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
        verifyNextCall: nextCall("opencode.message", { sessionId: session.id, messageId: admitted.id }),
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
      checkPromptSize(input.text, input);
      await client.session.command({ sessionID: session.id, name: input.name, text: input.text, delivery: input.delivery, ...attachments(input) });
      return { action: input.action, sessionId: session.id, name: input.name, submitted: true, identitySupplied: false };
    }
    if (input.action === "invokeSkill") {
      await client.session.skill({ sessionID: session.id, id: input.skillId, resume: input.resume });
      return { action: input.action, sessionId: session.id, skillId: input.skillId, submitted: true, identitySupplied: false };
    }
    if (input.action === "switchModel" || input.action === "switchAgent" || input.action === "setPermissions") {
      const before = await client.session.get({ sessionID: input.sessionId });
      if (input.action === "switchModel") {
        await client.session.switchModel({ sessionID: before.id, model: { ...parseModelRef(input.model), ...(input.variant ? { variant: input.variant } : {}) } });
      } else if (input.action === "switchAgent") {
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
      checkPromptSize(input.instruction, input);
      const prompt = await client.session.prompt({ sessionID: input.sessionId, text: input.instruction, ...attachments(input), delivery: "steer", resume: true });
      return { action: input.action, sessionId: input.sessionId, messageId: prompt.id };
    }
    if (input.action === "interrupt") {
      const result = await client.session.interrupt({ sessionID: input.sessionId, resume: false });
      return { action: input.action, sessionId: input.sessionId, interrupted: result.interrupted };
    }
    if (input.action === "respondPermission") {
      if (!input.decision || input.optionId !== undefined) throw new Error("OpenCode permission replies require decision, not optionId");
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
    throw new Error("unsupported native session action");
  }

  private async deleteNative(sessionId: string) {
    let client: OpenCodeClient;
    try {
      client = (await this.connect()).client;
      const session = await client.session.get({ sessionID: sessionId }).catch(error => {
        if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") throw new SessionDeleteError("DELETE_NOT_FOUND", "native session was not found before deletion");
        throw error;
      });
      if (session.id !== sessionId) throw new SessionDeleteError("DELETE_PREFLIGHT_FAILED", "native session identity could not be established");
      const [active, permissions, forms, inbox] = await Promise.all([
        client.session.active(), client.permission.list({ sessionID: sessionId }),
        client.session.form.list({ sessionID: sessionId }), client.session.inbox.list({ sessionID: sessionId }),
      ]);
      if (!active || typeof active !== "object" || Array.isArray(active) || !Array.isArray(permissions) || !Array.isArray(forms) || !Array.isArray(inbox)) throw new SessionDeleteError("DELETE_PREFLIGHT_FAILED", "native session safety state is unusable");
      if (active[sessionId]) throw new SessionDeleteError("DELETE_SESSION_ACTIVE", "native session execution is active");
      if (permissions.length) throw new SessionDeleteError("DELETE_PENDING_APPROVAL", "native session has pending permission requests");
      if (forms.length) throw new SessionDeleteError("DELETE_PENDING_FORM", "native session has pending forms");
      if (inbox.length) throw new SessionDeleteError("DELETE_PENDING_INBOX", "native session has pending inbox work");
    } catch (error) {
      if (error instanceof SessionDeleteError) throw error;
      // Native pending-permission/form queries resolve the session's original
      // location. A retired worktree makes those checks unreadable even when
      // session.get succeeds; never assume missing location means no approvals.
      if (error && typeof error === "object" && "_tag" in error && error._tag === "LocationNotFoundError")
        throw new SessionDeleteError("DELETE_LOCATION_UNAVAILABLE", "the session's original location is missing; restore that location to verify native pending actions before deletion");
      throw new SessionDeleteError("DELETE_PREFLIGHT_FAILED", "native session safety state could not be established");
    }
    try { await client.session.remove({ sessionID: sessionId }); }
    catch (error) {
      if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionBusyError") throw new SessionDeleteError("DELETE_SESSION_ACTIVE", "native runtime refused busy session deletion");
      throw new SessionDeleteError("DELETE_FAILED", "native deletion failed without confirmed absence", true);
    }
    try { await client.session.get({ sessionID: sessionId }); }
    catch (error) {
      if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") return;
      throw new SessionDeleteError("DELETE_UNVERIFIED", "native absence readback failed", true);
    }
    throw new SessionDeleteError("DELETE_UNVERIFIED", "native session remains visible after deletion", true);
  }
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
