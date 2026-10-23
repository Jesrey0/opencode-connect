import { EventErrorCode } from "./eventsErrors.js";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { OpenCodeBackend, type QueryInput } from "./opencode.js";
import { HostBackend } from "./host.js";
import { exposedUnion, variantsOf, withoutFields } from "./schema.js";
import { VERSION } from "./version.js";
import { loadBuildInfo } from "./buildInfo.js";
import { safeError, AdmissionError, ConnectorError, SessionDeleteError } from "./bounds.js";
import { ProtocolErrorCode, ProtocolError } from "@modelcontextprotocol/server";
import { Events, EVENT_NAME, eventArgumentsSchema } from "./events.js";
import type { ServerContext, ContentBlock } from "@modelcontextprotocol/server";
import { errorOutputSchema, outputSchemas, outputVariant, queryOutputSchema } from "./results.js";
import { CODEX_MODES, CODEX_ACTIONS, CODEX_QUERY_TYPES } from "./codex.js";
import { BrowserBackend } from "./browser/backend.js";
import { registerBrowserTools } from "./browser/tools.js";

const runtimeSchema = z.enum(["opencode", "codex"]).optional().describe("Session runtime; omission selects OpenCode. Codex uses native ACP session IDs and advertises its narrower capabilities.");
const opencodeRuntimeSchema = z.literal("opencode").optional().describe("OpenCode-only operation; omission selects OpenCode.");
const codexUnsupportedStartFields = ["model", "agent", "variant", "permissions", "forkFromSessionId", "beforeMessageId", "title", "files", "agents", "skills"] as const;

const pageShape = { offset: z.number().int().min(0).optional().meta({ default: 0 }), limit: z.number().int().min(1).max(50).optional().describe("Page size: integer 1..50; defaults to 25.").meta({ default: 25 }), fingerprint: z.string().min(1).optional() };
const textShape = { textOffset: z.number().int().min(0).optional().describe("UTF-16 text offset; nonzero continuation requires textFingerprint.").meta({ default: 0 }), textLimit: z.number().int().min(1).max(12000).optional().meta({ default: 12000 }), textFingerprint: z.string().min(1).optional() };
const mentionSchema = z.object({ start: z.number().int().min(0), end: z.number().int().min(0), text: z.string().max(65536) }).strict();
const attachmentShape = {
  files: z.array(z.object({ uri: z.string().min(1).max(90000), name: z.string().max(4096).optional(), description: z.string().max(2000).optional(), mention: mentionSchema.optional() }).strict()).max(20).optional(),
  agents: z.array(z.object({ name: z.string().min(1).max(256).describe("Canonical catalog agent ID used as prompt context, not executing selection or delegated child admission."), mention: mentionSchema.optional() }).strict()).max(20).optional().describe("Native agent prompt context; does not select the executing agent or admit child execution."),
  skills: z.array(z.object({ id: z.string().min(1).max(4096), mention: mentionSchema.optional() }).strict()).max(20).optional(),
};
export const permissionsSchema = z.array(z.object({ action: z.string().min(1).max(256), resource: z.string().min(1).max(4096), effect: z.enum(["allow", "deny", "ask"]) }).strict()).max(100);

export const hostInspectSchema = exposedUnion("type", [
  z.object({ type: z.literal("list").describe("List directory entries; continue with the returned fingerprint."), cwd: z.string().min(1), path: z.string().optional(), ...pageShape }),
  z.object({ type: z.literal("read").describe("Read bounded file bytes; offset continuation requires the returned fingerprint. image selects one small signature-checked image."), cwd: z.string().min(1), path: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(65536).optional(), fingerprint: z.string().min(1).optional(), image: z.boolean().optional() }),
  z.object({ type: z.literal("find").describe("Search filenames only (not file contents); results cap at 50."), cwd: z.string().min(1), query: z.string().min(1), fileType: z.enum(["file", "directory"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
  z.object({ type: z.literal("vcs"), cwd: z.string().min(1) }),
  z.object({ type: z.literal("vcsStatus"), cwd: z.string().min(1), ...pageShape }),
  z.object({ type: z.literal("vcsBranch").describe("List native branch names; optional search filters natively and pages are fingerprinted."), cwd: z.string().min(1), search: z.string().min(1).max(256).optional(), ...pageShape }),
  z.object({ type: z.literal("vcsDiff"), cwd: z.string().min(1), mode: z.enum(["working", "branch", "committed"]).optional(), base: z.string().min(1).optional(), file: z.string().min(1).optional(), ...pageShape, ...textShape }),
  z.object({ type: z.literal("commands"), cwd: z.string().min(1), sessionId: z.string().min(1).optional(), ...pageShape }),
  z.object({ type: z.literal("terminalScreen").describe("Read a rendered screen owned by the session; this is not byte replay or proof of process success."), cwd: z.string().min(1), sessionId: z.string().min(1), lines: z.number().int().min(1).max(1000).optional(), ...textShape }).strict(),
  z.object({ type: z.literal("terminalSnapshot").describe("Read a rendered persistent-PTY snapshot by canonical handle; checkpoint bytes are excluded."), cwd: z.string().min(1), id: z.string().min(1), ...textShape }).strict(),
]);
export const hostWriteSchema = z.object({ cwd: z.string().min(1), path: z.string().min(1), encoding: z.enum(["utf8", "base64"]), data: z.string().max(90000), overwrite: z.boolean(), expectedFingerprint: z.string().min(1).optional() }).strict();
export const worktreeSchema = exposedUnion("action", [
  z.object({ action: z.literal("list").describe("List project worktrees; only this operation has pagination."), cwd: z.string().min(1), projectId: z.string().min(1).optional(), ...pageShape }).strict(),
  z.object({ action: z.literal("create").describe("Create at an explicit absolute destination; branch selects an existing Git ref, while name asks native code to create a branch."), cwd: z.string().min(1), projectId: z.string().min(1).optional(), directory: z.string().min(1), branch: z.string().max(256).optional(), name: z.string().max(256).optional() }).strict(),
  z.object({ action: z.literal("remove").describe("Remove an inventoried project worktree; force is an explicit native removal choice."), cwd: z.string().min(1), projectId: z.string().min(1).optional(), directory: z.string().min(1), force: z.boolean() }).strict(),
  z.object({ action: z.literal("refresh").describe("Refresh native project worktree inventory."), cwd: z.string().min(1), projectId: z.string().min(1).optional() }).strict(),
]);
const handleShape = { kind: z.enum(["shell", "pty", "persistentPty"]), cwd: z.string().min(1), id: z.string().min(1) };
const ptyHandleShape = { ...handleShape, kind: z.enum(["pty", "persistentPty"]) };
const commandShape = { cwd: z.string().min(1), command: z.string().min(1).max(65536), title: z.string().max(2000).optional() };
export const commandStartSchema = exposedUnion("kind", [
  z.object({ kind: z.literal("shell").describe("Run a shell command string; timeout applies and exited output is not attachable after exit."), ...commandShape, timeoutMs: z.number().int().min(1).max(86400000).optional() }),
  z.object({ kind: z.literal("pty").describe("Run an executable with separate args in an ordinary PTY; replay attachment ends at exit."), ...commandShape, args: z.array(z.string().max(4096)).max(100).optional() }),
  z.object({ kind: z.literal("persistentPty").describe("Experimental session-bound PTY; cwd must match the session and native retention/observer cleanup applies."), ...commandShape, sessionId: z.string().min(1), args: z.array(z.string().max(4096)).max(100).optional(), rows: z.number().int().min(1).max(1000).optional(), cols: z.number().int().min(1).max(1000).optional() }),
]);
export const commandControlSchema = exposedUnion("action", [
  z.object({ ...handleShape, action: z.literal("remove").describe("Terminate and forget this native handle.") }),
  z.object({ ...ptyHandleShape, action: z.literal("resize").describe("Resize a PTY; dimensions are required."), rows: z.number().int().min(1).max(1000), cols: z.number().int().min(1).max(1000) }),
  z.object({ ...ptyHandleShape, action: z.literal("input").describe("Send PTY input without durable acknowledgement; do not retry uncertain input."), text: z.string().max(16384), takeover: z.boolean().optional() }),
  z.object({ ...ptyHandleShape, action: z.literal("interrupt").describe("Send Ctrl-C to a PTY."), takeover: z.boolean().optional() }),
  z.object({ ...ptyHandleShape, action: z.literal("ctrlD").describe("Send Ctrl-D as a terminal character; it is not pipe EOF."), takeover: z.boolean().optional() }),
]);
export const querySchema = exposedUnion("type", [
  z.object({ runtime: runtimeSchema, type: z.literal("sessionDiff"), sessionId: z.string().min(1), from: z.string().min(1).optional(), to: z.string().min(1).optional(), context: z.number().int().min(0).max(1000).optional(), file: z.string().min(1).optional(), ...pageShape, ...textShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("inbox"), sessionId: z.string().min(1), inboxId: z.string().min(1).optional(), ...pageShape, ...textShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("skill"), cwd: z.string().min(1).optional(), skillId: z.string().min(1), ...textShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("tools"), sessionId: z.string().min(1), messageId: z.string().min(1), ...pageShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("tool"), sessionId: z.string().min(1), messageId: z.string().min(1), toolId: z.string().min(1), field: z.enum(["input", "content", "error"]), contentIndex: z.number().int().min(0).optional(), ...textShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("models"), cwd: z.string().min(1).optional(), view: z.enum(["compact", "full"]).optional().describe("Compact retains native IDs, enabled state, pricing, input modalities and variants; full adds model specifications. Defaults to full."), ...pageShape }),
  z.object({ runtime: runtimeSchema, type: z.literal("agents"), cwd: z.string().min(1).optional().describe("Select project context; response returns the native resolved location."), view: z.enum(["compact", "full"]).optional().describe("Defaults to compact catalog; full includes instructions and raw permission pages."), includeHidden: z.boolean().optional().describe("Defaults to false; true includes native internal agents."), ...pageShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("agent"), cwd: z.string().min(1).optional(), agentId: z.string().min(1), field: z.enum(["system", "description", "permissions"]).optional(), ...textShape, ...pageShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("messages"), ...pageShape, sessionId: z.string().min(1), cursor: z.string().min(1).optional(), order: z.enum(["asc", "desc"]).optional(), limit: z.number().int().min(1).max(50).optional() }).refine((input) => !input.cursor || !input.order, { message: "native message cursor cannot be combined with order", path: ["order"] }).meta({ not: { required: ["cursor", "order"] } }),
  z.object({ runtime: runtimeSchema, type: z.literal("message"), sessionId: z.string().min(1), messageId: z.string().min(1), field: z.enum(["summary", "recent"]).optional().describe("Compaction only: page the full native summary or recent text instead of the bounded preview."), ...textShape }),
  z.object({ runtime: runtimeSchema, type: z.literal("permissions"), sessionId: z.string().min(1), section: z.enum(["rules", "pending"]).optional().describe("Read raw ordered session rules or native pending requests."), ...pageShape }).strict(),
  z.object({ runtime: runtimeSchema, type: z.literal("savedApprovals"), sessionId: z.string().min(1), ...pageShape }),
  z.object({ runtime: runtimeSchema, type: z.literal("runtime"), cwd: z.string().min(1), ...pageShape }),
  z.object({ runtime: runtimeSchema, type: z.literal("skills"), cwd: z.string().min(1).optional(), ...pageShape }),
  z.object({ runtime: runtimeSchema, type: z.literal("providers"), cwd: z.string().min(1).optional(), ...pageShape }),
  z.object({ runtime: runtimeSchema, type: z.literal("usage") }),
  z.object({ runtime: runtimeSchema,
    type: z.literal("sessions"),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional().describe("OpenCode-only page size; defaults to 25. Codex uses its native page size."),
    cwd: z.string().min(1).optional(),
    searchTerm: z.string().min(1).optional(),
  }),
  z.object({ runtime: runtimeSchema, type: z.literal("session"), sessionId: z.string().min(1) }),
]);

const formValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export const actSchema = exposedUnion("action", [
  z.object({ runtime: runtimeSchema, action: z.literal("steer"), sessionId: z.string().min(1), instruction: z.string().min(1).max(65536), ...attachmentShape }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("cancelInbox"), sessionId: z.string().min(1), inboxId: z.string().min(1) }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("updateInbox"), sessionId: z.string().min(1), inboxId: z.string().min(1), delivery: z.enum(["steer", "queue"]) }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("compact"), sessionId: z.string().min(1), delivery: z.enum(["steer", "queue"]).optional() }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("command").describe("Admit a catalogued native session command; upstream returns no message identity."), sessionId: z.string().min(1), name: z.string().min(1).max(256), text: z.string().max(65536), delivery: z.enum(["steer", "queue"]).optional().describe("Native steer or queue delivery."), ...attachmentShape }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("invokeSkill"), sessionId: z.string().min(1), skillId: z.string().min(1), resume: z.boolean().optional() }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("interrupt"), sessionId: z.string().min(1) }),
  z.object({ runtime: runtimeSchema,
    action: z.literal("respondPermission"),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(["once", "always", "reject"]).optional(),
    optionId: z.string().min(1).max(512).optional().describe("Codex only: an exact optionId advertised by this pending native request."),
    message: z.string().optional(),
  }).refine(input => input.runtime === "codex" ? !!input.optionId && input.decision === undefined && input.message === undefined : !!input.decision && input.optionId === undefined, { message: "Codex requires optionId; OpenCode requires decision" }).meta({ if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { required: ["optionId"], not: { anyOf: [{ required: ["decision"] }, { required: ["message"] }] } }, else: { required: ["decision"], not: { required: ["optionId"] } } }),
  z.object({ runtime: runtimeSchema,
    action: z.literal("respondForm"),
    sessionId: z.string().min(1),
    formId: z.string().min(1),
    answer: z.record(z.string(), formValueSchema).refine(answer => Object.entries(answer).reduce((count, [, value]) => count + 1 + (Array.isArray(value) ? value.length : 1), 0) <= 4092, { message: "Form answer exceeds the maximum of 4096 elements" }),
  }),
  z.object({ runtime: runtimeSchema, action: z.literal("cancelForm"), sessionId: z.string().min(1), formId: z.string().min(1) }),
  z.object({ runtime: z.enum(["opencode", "codex"]).describe("Required for destructive deletion; no default runtime."), action: z.literal("delete"), sessionId: z.string().min(1) }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("revertStage").describe("Stage native session revert for a canonical message; this does not restore files until commit."), sessionId: z.string().min(1), messageId: z.string().min(1), files: z.boolean().optional().describe("Pass the native file-revert option; omitted preserves OpenCode default.") }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("revertClear").describe("Clear a staged native session revert without committing it."), sessionId: z.string().min(1) }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("revertCommit").describe("Commit the currently staged native session revert."), sessionId: z.string().min(1) }).strict(),
  z.object({ runtime: runtimeSchema, action: z.literal("switchModel"), sessionId: z.string().min(1), model: z.string().min(1), variant: z.string().min(1).optional() }),
  z.object({ runtime: runtimeSchema, action: z.literal("switchAgent"), sessionId: z.string().min(1), agent: z.string().min(1).describe("Executing canonical agent ID from the effective catalog; persisted session selection is read back. This does not create or edit an agent.") }),
  z.object({ runtime: runtimeSchema, action: z.literal("setPermissions"), sessionId: z.string().min(1), permissions: permissionsSchema }),
  z.object({ runtime: runtimeSchema, action: z.literal("removeSavedApproval").describe("Remove one project saved approval by exact ID with absent-target readback; never retry uncertain removal."), sessionId: z.string().min(1), approvalId: z.string().min(1) }),
  z.object({ runtime: runtimeSchema, action: z.literal("synthetic"), sessionId: z.string().min(1), text: z.string().min(1).max(12000), description: z.string().max(2000).optional(), delivery: z.enum(["steer", "queue"]).optional(), resume: z.boolean().optional() }),
]);

export function structuredResult(structuredContent: Record<string, unknown>, content: ContentBlock[] = []) {
  const result = { structuredContent, content };
  if (Buffer.byteLength(JSON.stringify({ structuredContent })) > 262_144) throw new ConnectorError("MCP structured response exceeds 256 KiB; request a smaller page or specific detail");
  return result;
}

function queryInputSchema(type: string, schema: z.ZodObject) {
  if (type === "usage" || !CODEX_QUERY_TYPES.has(type)) return schema.safeExtend({ runtime: opencodeRuntimeSchema });
  const forbidden = type === "sessions" ? ["limit", "searchTerm"] : type === "messages" ? ["cursor"] : type === "message" ? ["field"] : [];
  const pendingOnly = type === "permissions";
  if (!forbidden.length && !pendingOnly) return schema;
  return schema.superRefine((input, context) => {
    if (input.runtime !== "codex") return;
    for (const field of forbidden) if (input[field] !== undefined) context.addIssue({ code: "custom", message: `${field} is unsupported by Codex ${type}`, path: [field] });
    if (pendingOnly && input.section !== "pending") context.addIssue({ code: "custom", message: "Codex permissions require section: pending", path: ["section"] });
  }).meta({ ...schema.meta(), allOf: [{
    if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] },
    then: {
      ...(forbidden.length ? { not: { anyOf: forbidden.map(field => ({ required: [field] })) } } : {}),
      ...(pendingOnly ? { properties: { section: { const: "pending" } }, required: ["section"] } : {}),
    },
  }] });
}

async function queryResult(backend: OpenCodeBackend, input: QueryInput, signal?: AbortSignal) {
  const result = await backend.query([input], signal);
  return { ...structuredResult(result), ...(result.results.some(entry => "error" in entry) ? { isError: true } : {}) };
}

export function createServer(backend = new OpenCodeBackend(), host = new HostBackend(), events?: Events, browser?: BrowserBackend): McpServer {
  const capabilities = { tools: { listChanged: false }, ...(events ? { events: {} } : {}) };
  const server = new McpServer({ name: "opencode-connect", version: VERSION }, {
    capabilities, supportedProtocolVersions: ["2026-07-28"], inputRequired: { legacyShim: false },
    // Bounds recursive validation work independently of serialized string size.
    // Full permission/attachment sets and 12-step browser workflows fit this budget.
    maxToolInputElements: 4096,
      instructions: "Use purpose-specific tools; no generic runners. Readiness/recovery, create/continue/fork and activity/result inspection are distinct. Preserve native IDs and canonical cwd; follow nextCall. Reconcile uncertain mutations; worker termination is not task success. Start commands with command.startShell, command.startPty or command.startPersistentPty. Read ordinary handles with command.read; persistent observers use command.observePersistentPty.",
  });
  if (events) {
    const authenticated = async (extra: ServerContext) => {
      const value = extra.http?.req?.headers.get("x-host-ingress-auth-context");
      if (typeof value !== "string" || !value) throw new ProtocolError(EventErrorCode.AuthorizationDenied, "Events authorization denied or unavailable");
      try { return await events.authenticate(value); }
      catch { throw new ProtocolError(EventErrorCode.AuthorizationDenied, "Events authorization denied or unavailable"); }
    };
    const metadata = { _meta: z.record(z.string(), z.unknown()).optional() };
    const identity = { name: z.literal(EVENT_NAME), arguments: eventArgumentsSchema };
    server.server.setRequestHandler("events/list", { params: z.unknown() }, async (requestParams, extra) => {
      await authenticated(extra);
      if (!z.object(metadata).strict().safeParse(requestParams === undefined ? {} : requestParams).success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "event catalog accepts an object without a cursor");
      return events.catalog();
    });
    server.server.setRequestHandler("events/subscribe", { params: z.unknown() }, async (requestParams, extra) => {
      const auth = await authenticated(extra);
      const parsed = z.object({ ...metadata, ...identity, delivery: z.object({ mode: z.literal("webhook"), url: z.string().min(1).max(2048), secret: z.string().min(1).max(128) }).strict(), ttlMs: z.number().int().nonnegative().nullable().optional(), cursor: z.null().optional() }).strict().safeParse(requestParams);
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "invalid subscription");
      return events.subscribe(parsed.data, auth, async (sessionId, messageId) => { const message = await backend.query([{ type: "message", sessionId, messageId }]); const selected = message.results[0] as any; if (!selected || "error" in selected || selected.result?.type !== "user") throw new ProtocolError(ProtocolErrorCode.InvalidParams, "sessionId/messageId must identify a canonical user prompt"); });
    });
    server.server.setRequestHandler("events/unsubscribe", { params: z.unknown() }, async (requestParams, extra) => {
      const auth = await authenticated(extra);
      const parsed = z.object({ ...metadata, ...identity, delivery: z.object({ mode: z.literal("webhook"), url: z.string().min(1).max(2048) }).strict() }).strict().safeParse(requestParams);
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "invalid cancellation");
      return events.unsubscribe(parsed.data, auth);
    });
  }
  // Keep upstream exception bodies out of MCP errors as well as successful data.
  const register = server.registerTool.bind(server);
  const registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => Promise<unknown>) => {
    const definition = config as Record<string, unknown> & { outputSchema: z.ZodType };
    return register(name, { ...definition, outputSchema: z.union([definition.outputSchema, errorOutputSchema]) } as never, (async (...args: unknown[]) => {
      try { return await callback(...args); }
      catch (error) { return { ...structuredResult({ error: safeError(error), ...(error instanceof AdmissionError ? { recovery: error.recovery } : {}), ...(error instanceof SessionDeleteError ? { errorCode: error.code, reason: error.reason, mutationMayHaveOccurred: error.mutationMayHaveOccurred } : {}) }), isError: true }; }
    }) as never);
  }) as typeof server.registerTool;

  registerTool("status.readiness", {
    title: "Check Connector Readiness",
    description: "Check connector identity and OpenCode availability without reading worker history or probing browser readiness. Does not verify the Codex plugin or browser leases.",
    inputSchema: z.object({}).strict(), outputSchema: outputSchemas.readiness,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => {
    const { version, buildId, release } = await loadBuildInfo();
    let opencode: { ready: boolean; release: string | null; serverPid: number | null; error: string | null };
    try {
      const health = await backend.health();
      opencode = { ready: true, release: health.opencodeRelease, serverPid: health.serverPid, error: null };
    } catch (error) {
      opencode = { ready: false, release: null, serverPid: null, error: safeError(error) };
    }
    return { ...structuredResult({
      detail: "readiness", ready: opencode.ready, connector: { version, buildId, release },
      components: {
        opencode,
        events: events?.readiness() ?? { enabled: false, storageFailed: null },
        browser: browser ? { scope: "supervisor", ...browser.snapshot() } : null,
      },
    }), ...(opencode.ready ? {} : { isError: true }) };
  });
  registerTool("status.recovery", {
    title: "Recover Worker Status",
    description: "Read active/recent native worker inventory and result evidence for the selected runtime. Execution termination does not prove assistant success.",
    inputSchema: z.object({ runtime: runtimeSchema }).strict(), outputSchema: outputSchemas.recovery,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ runtime }) => structuredResult({ ...await backend.status(runtime), ...(events ? { events: events.snapshot() } : {}) }));

  const hostTools = [
    ["host.list", "list", "List directory entries beneath canonical cwd. Continue with the returned fingerprint-bound nextCall.", true],
    ["host.read", "read", "Read bounded file bytes beneath canonical cwd. Offset continuation requires its fingerprint; image mode returns one signature-checked image.", true],
    ["host.find", "find", "Search native filenames only (not file contents); results cap at 50.", true],
    ["host.vcs", "vcs", "Read native VCS repository information and base branch.", true],
    ["host.vcsStatus", "vcsStatus", "Read paginated native VCS status; continue with nextCall.", true],
    ["host.vcsBranch", "vcsBranch", "List native branch names, optionally filtered; continue with nextCall.", true],
    ["host.vcsDiff", "vcsDiff", "Read native VCS diff metadata or one file patch; continue with nextCall.", true],
    ["host.commands", "commands", "List native shell and PTY handles, optionally scoped to a session; continue with nextCall.", true],
    ["host.terminalScreen", "terminalScreen", "Read a rendered screen owned by the session; this is not byte replay or proof of process success.", true],
    ["host.terminalSnapshot", "terminalSnapshot", "Read a rendered persistent-PTY snapshot by canonical handle; checkpoint bytes are excluded.", true],
  ] as const;
  for (const [name, type, description] of hostTools) {
    const variant = variantsOf(hostInspectSchema).find((schema) => (schema.shape as any).type.value === type)!;
    registerTool(name, {
      title: `Host ${type} inspection`, description,
      inputSchema: variant.omit({ type: true } as never), outputSchema: outputVariant(outputSchemas.hostInspect, "type", type),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    }, async (input) => {
      const result = await host.inspect({ ...input, type } as any);
      if ("image" in result && result.image) { const { image, ...metadata } = result; return structuredResult(metadata, [{ type: "image", mimeType: image.mimeType, data: image.data }]); }
      return structuredResult(result);
    });
  }
  registerTool("host.write", {
    title: "Write Native OpenCode Host File",
    description: "Write a native file with explicit overwrite, fingerprint and persisted readback. Preflight is not atomic CAS; never retry uncertain writes automatically.",
    inputSchema: hostWriteSchema,
    outputSchema: outputSchemas.hostWrite,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => structuredResult(await host.write(input)));
  for (const [name, action, description, readOnly, destructive] of [
    ["host.worktreeList", "list", "List project worktrees; continue with the returned fingerprint-bound nextCall.", true, false],
    ["host.worktreeCreate", "create", "Create a native worktree at an explicit absolute destination. Read back the created inventory; do not retry uncertain mutations.", false, true],
    ["host.worktreeRemove", "remove", "Remove an inventoried project worktree with an explicit force decision. This is destructive; never retry uncertain removal.", false, true],
    ["host.worktreeRefresh", "refresh", "Refresh native project worktree inventory. This updates cached inventory but does not create or remove worktrees.", false, false],
  ] as const) {
    const variant = variantsOf(worktreeSchema).find((schema) => (schema.shape as any).action.value === action)!;
    registerTool(name, { title: `Native worktree ${action}`, description, inputSchema: variant.omit({ action: true } as never), outputSchema: action === "list" ? outputSchemas.worktreeList : outputVariant(outputSchemas.hostWorktree, "action", action),
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false, idempotentHint: readOnly || action === "refresh" },
    }, async (input) => structuredResult(await host.worktree({ ...input, action } as any)));
  }
  for (const [name, kind, description] of [
    ["command.startShell", "shell", "Run a shell command string with a timeout. Then use command.read with the returned handle and cursor."],
    ["command.startPty", "pty", "Run an executable with separate args in an ordinary PTY. Replay attachment ends at exit; then use command.read."],
    ["command.startPersistentPty", "persistentPty", "Start an experimental session-bound PTY. cwd must match the session; use command.observePersistentPty with native retention and observer cleanup."],
  ] as const) {
    const variant = variantsOf(commandStartSchema).find((schema) => (schema.shape as any).kind.value === kind)!;
    registerTool(name, { title: `Start ${kind} command`, description, inputSchema: variant.omit({ kind: true } as never), outputSchema: outputSchemas.commandStart.extend({ kind: z.literal(kind) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    }, async (input) => structuredResult(await host.start({ ...input, kind } as any)));
  }
  const commandReadShape = { cwd: handleShape.cwd, id: handleShape.id, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(65536).optional(), waitMs: z.number().int().min(0).max(2000).optional() };
  registerTool("command.read", {
    title: "Read Native OpenCode Command",
    description: "Read bounded shell or ordinary PTY replay by saved handle/cursor. Detach or unverified metadata never proves exit or drain. Persistent PTYs require command.observePersistentPty.",
    inputSchema: z.object({ kind: z.enum(["shell", "pty"]), ...commandReadShape }).strict(),
    outputSchema: outputSchemas.commandRead.extend({ kind: z.enum(["shell", "pty"]) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => structuredResult(await host.read(input)));
  registerTool("command.observePersistentPty", {
    title: "Observe Persistent OpenCode Terminal",
    description: "Read bounded persistent-PTY replay by saved handle/cursor. Native observer cleanup can remove an exited handle; this is destructive and non-idempotent. Detach does not prove exit or drain.",
    inputSchema: z.object(commandReadShape).strict(),
    outputSchema: outputSchemas.commandRead.extend({ kind: z.literal("persistentPty") }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => structuredResult(await host.read({ ...input, kind: "persistentPty" })));
  for (const [name, action, description] of [
    ["command.remove", "remove", "Terminate and forget a native command handle; removal is destructive and cannot be retried when uncertain."],
    ["command.resize", "resize", "Set the dimensions of an ordinary or persistent PTY; repeating the same dimensions is safe."],
    ["command.input", "input", "Send input to a PTY without durable acknowledgement; do not retry uncertain input."],
    ["command.interrupt", "interrupt", "Send Ctrl-C to a PTY without durable acknowledgement."],
    ["command.ctrlD", "ctrlD", "Send Ctrl-D as a terminal character; it is not pipe EOF and has no durable acknowledgement."],
  ] as const) {
    const variant = variantsOf(commandControlSchema).find((schema) => (schema.shape as any).action.value === action)!;
    registerTool(name, { title: `Command ${action}`, description, inputSchema: variant.omit({ action: true } as never), outputSchema: action === "remove" ? outputVariant(outputSchemas.commandControl, "removed", true) : action === "resize" ? outputVariant(outputSchemas.commandControl, "resized", true) : outputVariant(outputSchemas.commandControl, "action", action),
      annotations: { readOnlyHint: false, destructiveHint: action === "remove" || action === "input" || action === "interrupt" || action === "ctrlD", openWorldHint: action !== "resize", idempotentHint: action === "resize" },
    }, async (input) => structuredResult(await host.control({ ...input, action } as any)));
  }

  const startAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false } as const;
  const taskShape = { task: z.string().min(1).max(65536).describe("Self-contained objective or next delta for the workstream.") };
  const modelShape = { model: z.string().min(1).optional().describe("Canonical model ID; for continuation/fork this must match persisted selection.") };
  const agentShape = { agent: z.string().min(1).optional().describe("Canonical executing agent ID; for continuation/fork this must match persisted selection.") };
  const modeShape = { mode: z.enum(CODEX_MODES).optional().describe("Codex native preset. Continuation inherits the locally known mode; recovered conversations require an explicit mode.") };
  const createSchema = z.object({
    runtime: runtimeSchema, ...modeShape, ...taskShape, cwd: z.string().min(1), ...modelShape, ...agentShape,
    title: z.string().min(1).optional().describe("Optional OpenCode-only title for the fresh session."), permissions: permissionsSchema.optional(), variant: z.string().min(1).optional(), ...attachmentShape,
  }).strict().superRefine((input, context) => {
    if (input.runtime === "codex") for (const field of codexUnsupportedStartFields) if ((input as Record<string, unknown>)[field] !== undefined) context.addIssue({ code: "custom", message: `${field} is OpenCode-only and is not supported by Codex create`, path: [field] });
    if (input.mode !== undefined && input.runtime !== "codex") context.addIssue({ code: "custom", message: "mode is only valid for Codex", path: ["mode"] });
    if (input.variant !== undefined && input.model === undefined) context.addIssue({ code: "custom", message: "variant requires an explicit model", path: ["model"] });
  }).meta({ dependentRequired: { variant: ["model"] }, if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { not: { anyOf: codexUnsupportedStartFields.map(field => ({ required: [field] })) } }, else: { not: { required: ["mode"] } } });
  const continueSchema = z.object({ runtime: runtimeSchema, ...modeShape, ...taskShape, sessionId: z.string().min(1), ...modelShape, ...agentShape }).strict()
    .superRefine((input, context) => {
      if (input.mode !== undefined && input.runtime !== "codex") context.addIssue({ code: "custom", message: "mode is only valid for Codex", path: ["mode"] });
      if (input.runtime === "codex") for (const field of ["model", "agent"] as const) if (input[field] !== undefined) context.addIssue({ code: "custom", message: `${field} is OpenCode-only and is not supported by Codex continuation`, path: [field] });
    })
    .meta({ allOf: [
      { if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { not: { anyOf: [{ required: ["model"] }, { required: ["agent"] }] } }, else: { not: { required: ["mode"] } } },
    ] });
  const forkSchema = z.object({ runtime: z.literal("opencode").optional(), ...taskShape, forkFromSessionId: z.string().min(1), beforeMessageId: z.string().min(1).optional(), ...modelShape, ...agentShape, ...attachmentShape }).strict();
  for (const [name, title, description, inputSchema] of [
    ["opencode.create", "Create OpenCode Work", "Create a fresh native session and submit its first task. Omit model/agent for native defaults; reconcile uncertain admission using returned canonical IDs.", createSchema],
    ["opencode.continue", "Continue OpenCode Work", "Submit a task to one idle native session. Cwd, permissions and variant are inherited; model/agent overrides must match persisted selection. Codex may require mode after restart.", continueSchema],
    ["opencode.fork", "Fork OpenCode Work", "Fork an OpenCode session at an optional canonical message boundary, then submit the task. Runtime is OpenCode only; cwd and configuration inherit from the source.", forkSchema],
  ] as const) registerTool(name, { title, description, inputSchema, outputSchema: outputSchemas.start, annotations: startAnnotations }, async (input: any) => structuredResult(await backend.start(input)));

  registerTool("opencode.wait", {
    title: "Wait for OpenCode Work",
    description: "Synchronize one OpenCode canonical user prompt or the current Codex session turn until execution ends, input is required or timeout. Codex cannot recover execution termination after adapter restart. Terminal execution does not imply assistant success; inspect outcome evidence. Do not poll repeatedly.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      runtime: runtimeSchema,
      messageId: z.string().min(1).optional().describe("Required canonical user message ID for OpenCode. Omit for Codex, whose wait observes the current session turn."),
    }).strict().refine(input => input.runtime === "codex" ? input.messageId === undefined : !!input.messageId, { message: "OpenCode wait requires messageId; Codex wait must omit it", path: ["messageId"] })
      .meta({ if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { not: { required: ["messageId"] } }, else: { required: ["messageId"] } }),
    outputSchema: outputSchemas.wait,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ sessionId, messageId, runtime }, context) => structuredResult(await backend.wait(sessionId, messageId, context.mcpReq.signal, runtime)));

  const inspectResultSchema = z.object({
    runtime: runtimeSchema, sessionId: z.string().min(1), messageId: z.string().min(1).optional(),
    selectionCursor: z.string().min(1).optional().describe("Native continuation from an incomplete result scan; retain candidateAssistantMessageId too."),
    candidateAssistantMessageId: z.string().min(1).optional(), selectionFingerprint: z.string().min(1).optional(), ...textShape,
  }).strict()
    .refine(input => !input.selectionCursor || !!input.messageId, { message: "selectionCursor requires the original user messageId", path: ["messageId"] })
    .refine(input => !input.candidateAssistantMessageId || !!input.selectionCursor, { message: "candidate requires selectionCursor", path: ["candidateAssistantMessageId"] })
    .refine(input => input.runtime !== "codex" || (!input.messageId && !input.selectionCursor && !input.candidateAssistantMessageId && !input.selectionFingerprint), { message: "Codex exact-prompt result selection is unsupported", path: ["messageId"] })
    .meta({ dependentRequired: { selectionCursor: ["messageId"], candidateAssistantMessageId: ["selectionCursor"] }, if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { not: { anyOf: ["messageId", "selectionCursor", "candidateAssistantMessageId", "selectionFingerprint"].map(field => ({ required: [field] })) } } });
  const inspectActivitySchema = z.object({ runtime: runtimeSchema, sessionId: z.string().min(1), messageId: z.string().min(1).optional() }).strict()
    .refine(input => input.runtime !== "codex" || input.messageId === undefined, { message: "Codex exact-prompt inspection is unsupported", path: ["messageId"] })
    .meta({ if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { not: { required: ["messageId"] } } });
  registerTool("opencode.inspectActivity", {
    title: "Inspect OpenCode Activity", description: "Read current native activity and pending actions, optionally scoped to a canonical OpenCode prompt. Codex observes the current session turn and does not support exact-prompt selection.",
    inputSchema: inspectActivitySchema, outputSchema: outputSchemas.inspectActivity,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async input => structuredResult(await backend.inspect({ ...input, detail: "semantic" })));
  registerTool("opencode.inspectResult", {
    title: "Inspect OpenCode Result", description: "Select the result for a canonical OpenCode prompt, or observe the current Codex turn. Complete selection before interpreting outcome; continue with returned read-only nextCall.",
    inputSchema: inspectResultSchema, outputSchema: outputSchemas.inspectResult,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async input => structuredResult(await backend.inspect({ ...input, detail: "result" })));

  const queryTools = [
    ["opencode.sessionDiff", "sessionDiff", "Read a session's native file diff, optionally paged or narrowed to one file patch."],
    ["opencode.inbox", "inbox", "Read pending session inbox entries, or the bounded text of one exact inbox entry."],
    ["opencode.skill", "skill", "Read one canonical skill and its bounded content; cwd selects project context."],
    ["opencode.tools", "tools", "List native tool-call evidence from one canonical assistant message."],
    ["opencode.tool", "tool", "Read one exact native tool call's input, error summary, or selected content part."],
    ["opencode.models", "models", "List the native model catalog; compact view omits full specifications."],
    ["opencode.agents", "agents", "List the effective native agent catalog. Defaults to compact view and excludes hidden entries."],
    ["opencode.agent", "agent", "Read one canonical agent's description, system instructions, or raw permissions."],
    ["opencode.messages", "messages", "List native session messages with previews and native cursor or fingerprint pagination."],
    ["opencode.message", "message", "Read one exact native message or recover its full text/compaction field by fingerprinted pages."],
    ["opencode.permissions", "permissions", "Read ordered session permission rules or native pending requests. Codex supports pending only."],
    ["opencode.savedApprovals", "savedApprovals", "List project saved permission approvals for the target session."],
    ["opencode.runtime", "runtime", "Read native runtime capabilities and plugin/MCP/command inventory for cwd."],
    ["opencode.skills", "skills", "List canonical native skills, optionally in project context."],
    ["opencode.providers", "providers", "List native provider identities and activation state for optional cwd context."],
    ["opencode.usage", "usage", "Read OpenCode cumulative session token activity. Codex quota windows and reset times are read separately with codex.quota."],
    ["opencode.sessions", "sessions", "List native sessions with native cursor pagination and optional cwd/search filters. Codex supports its narrower cursor inventory."],
    ["opencode.session", "session", "Read one exact native session's canonical projected state."],
  ] as const;
  const queryTitles = {
    sessionDiff: "Read Session Diff", inbox: "List Session Inbox", skill: "Read Skill", tools: "List Tool Calls", tool: "Read Tool Call",
    models: "List Models", agents: "List Agents", agent: "Read Agent", messages: "List Messages", message: "Read Message",
    permissions: "Read Permissions", savedApprovals: "List Saved Approvals", runtime: "Inspect Runtime", skills: "List Skills",
    providers: "List Providers", usage: "Read Usage", sessions: "List Sessions", session: "Read Session",
  } as const;
  for (const [name, type, description] of queryTools) {
    const variant = variantsOf(querySchema).find((schema) => (schema.shape as any).type.value === type)!;
    const inputSchema = queryInputSchema(type, withoutFields(variant, "type"));
    registerTool(name, {
      title: queryTitles[type], description,
      inputSchema, outputSchema: queryOutputSchema(type),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    }, async (input, context) => queryResult(backend, { ...input, type } as QueryInput, context.mcpReq.signal));
  }
  registerTool("codex.quota", {
    title: "Read Codex Quota",
    description: "Read sanitized Codex quota windows and reset times through the native plugin's read-only App Server client. Does not admit a model turn or return OpenCode token totals or ChatGPT Plus message limits.",
    inputSchema: z.object({}).strict(), outputSchema: queryOutputSchema("usage"),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (_input, context) => queryResult(backend, { runtime: "codex", type: "usage" }, context.mcpReq.signal));

  const actTools = [
    ["opencode.steer", "steer", "Steer an active native session with a prompt and optional attachments. The returned message ID is canonical; never retry uncertain submission.", false, true, true, false],
    ["opencode.cancelInbox", "cancelInbox", "Cancel one exact pending inbox item in its owning session. Verify the returned pending status; do not retry uncertain cancellation.", false, true, false, false],
    ["opencode.updateInbox", "updateInbox", "Change delivery for one exact pending inbox item. Reconcile pending state before retrying an uncertain update.", false, false, false, true],
    ["opencode.compact", "compact", "Admit native session compaction using steer or queue delivery. This is not completion; verify the exact returned inbox message.", false, true, true, false],
    ["opencode.command", "command", "Admit one catalogued native session command with optional prompt attachments. Upstream supplies no message identity; do not retry uncertain submission.", false, true, true, false],
    ["opencode.invokeSkill", "invokeSkill", "Invoke one canonical native session skill. Upstream supplies no message identity; do not retry uncertain submission.", false, true, true, false],
    ["opencode.interrupt", "interrupt", "Interrupt execution in one exact native session. This preserves the conversation; verify native state rather than retrying uncertainty.", false, true, true, false],
    ["opencode.respondPermission", "respondPermission", "Answer one exact pending permission request. Codex requires an offered optionId; OpenCode requires a decision. Approving may authorize external effects.", false, true, true, false],
    ["opencode.respondForm", "respondForm", "Submit an answer to one exact native pending form. The answer may authorize follow-on work; do not retry uncertain submission.", false, true, true, false],
    ["opencode.cancelForm", "cancelForm", "Cancel one exact pending native form; this does not cancel the session worker.", false, true, false, false],
    ["opencode.delete", "delete", "Delete one exact idle native session. Runtime is mandatory; pending actions, active work, or unverifiable safety state block deletion.", false, true, false, false],
    ["opencode.revertStage", "revertStage", "Stage a native session revert for one canonical message. Files are not restored until the separate revert commit action.", false, false, false, false],
    ["opencode.revertClear", "revertClear", "Clear staged native session revert state without restoring files.", false, false, false, true],
    ["opencode.revertCommit", "revertCommit", "Commit the currently staged native session revert; this changes workspace files and must not be retried when uncertain.", false, true, true, false],
    ["opencode.switchModel", "switchModel", "Select a canonical model and optional variant for one native session; persisted selection is read back.", false, false, false, true],
    ["opencode.switchAgent", "switchAgent", "Select one canonical executing agent for a native session; persisted selection is read back. This does not create or edit an agent.", false, false, false, true],
    ["opencode.setPermissions", "setPermissions", "Replace ordered native session permission rules and verify persisted readback. Rules can broaden agent policy.", false, false, false, true],
    ["opencode.removeSavedApproval", "removeSavedApproval", "Remove one exact project saved approval with absent-target readback; never retry uncertain removal.", false, true, false, false],
    ["opencode.synthetic", "synthetic", "Create one native synthetic inbox item, optionally delivering or resuming work. Preserve its returned inbox identity; do not retry uncertain creation.", false, true, true, false],
  ] as const;
  for (const [name, action, description, readOnlyHint, destructiveHint, openWorldHint, idempotentHint] of actTools) {
    const variant = variantsOf(actSchema).find((schema) => (schema.shape as any).action.value === action)!;
    let inputSchema = withoutFields(variant, "action");
    if (!CODEX_ACTIONS.has(action)) inputSchema = inputSchema.safeExtend({ runtime: opencodeRuntimeSchema });
    if (action === "respondPermission") inputSchema = inputSchema.refine((input: any) => input.runtime === "codex" ? !!input.optionId && input.decision === undefined && input.message === undefined : !!input.decision && input.optionId === undefined, { message: "Codex requires optionId; OpenCode requires decision" }).meta({ if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { required: ["optionId"], not: { anyOf: [{ required: ["decision"] }, { required: ["message"] }] } }, else: { required: ["decision"], not: { required: ["optionId"] } } });
    registerTool(name, {
      title: `OpenCode ${action}`,
      description,
      inputSchema,
      outputSchema: outputVariant(outputSchemas.act, "action", action),
      annotations: { readOnlyHint, destructiveHint, openWorldHint, idempotentHint },
    }, async (input) => structuredResult(await backend.act({ ...input, action } as any)));
  }

  if (browser) registerBrowserTools(server, browser, events);
  return server;
}
