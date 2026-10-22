import { EventErrorCode } from "./eventsErrors.js";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { OpenCodeBackend } from "./opencode.js";
import { HostBackend } from "./host.js";
import { exposedUnion, variantsOf } from "./schema.js";
import { VERSION } from "./version.js";
import { loadBuildInfo } from "./buildInfo.js";
import { safeError, AdmissionError, ConnectorError, SessionDeleteError } from "./bounds.js";
import { ProtocolErrorCode, ProtocolError } from "@modelcontextprotocol/server";
import { Events, EVENT_NAME, eventArgumentsSchema } from "./events.js";
import type { ServerContext, ContentBlock } from "@modelcontextprotocol/server";
import { errorOutputSchema, outputSchemas } from "./results.js";
import { CODEX_MODES } from "./codex.js";
import { BrowserBackend } from "./browser/backend.js";
import { registerBrowserTools } from "./browser/tools.js";

const runtimeSchema = z.enum(["opencode", "codex"]).optional().describe("Session runtime; omission selects OpenCode. Codex uses native ACP session IDs and advertises its narrower capabilities.");
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
    limit: z.number().int().min(1).max(50).optional().meta({ default: 25 }),
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
    answer: z.record(z.string(), formValueSchema),
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

export function createServer(backend = new OpenCodeBackend(), host = new HostBackend(), events?: Events, browser?: BrowserBackend): McpServer {
  const capabilities = { tools: { listChanged: false }, ...(events ? { events: {} } : {}) };
  const server = new McpServer({ name: "opencode-connect", version: VERSION }, {
    capabilities, supportedProtocolVersions: ["2026-07-28"], inputRequired: { legacyShim: false },
    // Bounds recursive validation work independently of serialized string size.
    // Full permission/attachment sets and 12-step browser workflows fit this budget.
    maxToolInputElements: 4096,
     instructions: "Host and command operations are separately named purpose-specific tools. Preserve native IDs and canonical cwd. Start commands with command.startShell, command.startPty or command.startPersistentPty, then read the saved handle/cursor with command.read. Follow returned nextCall for paging. Reconcile persisted state before retrying uncertain mutations. Worker termination is not proof of assistant success; inspect result evidence.",
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

  registerTool("status", {
    title: "Read OpenCode Connect Status",
    description: "Use detail readiness for connector identity and OpenCode availability without worker history or a browser probe. Omitted detail or recovery includes active/recent native workers, selected by runtime. Readiness does not verify the Codex plugin or browser leases. Execution termination does not prove assistant success; inspect exact result evidence.",
    inputSchema: z.object({ runtime: runtimeSchema, detail: z.enum(["readiness", "recovery"]).optional().describe("Defaults to recovery; readiness skips worker/session/result reads. Runtime selects recovery inventory only.").meta({ default: "recovery" }) }).strict(),
    outputSchema: outputSchemas.status,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ runtime, detail }) => {
    if (detail !== "readiness") return structuredResult({ ...await backend.status(runtime), ...(events ? { events: events.snapshot() } : {}) });
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
      inputSchema: variant.omit({ type: true } as never), outputSchema: outputSchemas.hostInspect,
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
    registerTool(name, { title: `Native worktree ${action}`, description, inputSchema: variant.omit({ action: true } as never), outputSchema: outputSchemas.hostWorktree,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false, idempotentHint: readOnly || action === "refresh" },
    }, async (input) => structuredResult(await host.worktree({ ...input, action } as any)));
  }
  for (const [name, kind, description] of [
    ["command.startShell", "shell", "Run a shell command string with a timeout. Then use command.read with the returned handle and cursor."],
    ["command.startPty", "pty", "Run an executable with separate args in an ordinary PTY. Replay attachment ends at exit; then use command.read."],
    ["command.startPersistentPty", "persistentPty", "Start an experimental session-bound PTY. cwd must match the session; native retention and observer cleanup apply."],
  ] as const) {
    const variant = variantsOf(commandStartSchema).find((schema) => (schema.shape as any).kind.value === kind)!;
    registerTool(name, { title: `Start ${kind} command`, description, inputSchema: variant.omit({ kind: true } as never), outputSchema: outputSchemas.commandStart,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    }, async (input) => structuredResult(await host.start({ ...input, kind } as any)));
  }
  registerTool("command.read", {
    title: "Read Native OpenCode Command",
    description: "Read bounded native command replay by saved handle/cursor. Persistent observers may remove exited handles; detach or unverified metadata never proves exit or drain.",
    inputSchema: z.object({ ...handleShape, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(65536).optional(), waitMs: z.number().int().min(0).max(2000).optional() }).strict(),
    outputSchema: outputSchemas.commandRead,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => structuredResult(await host.read(input)));
  for (const [name, action, description] of [
    ["command.remove", "remove", "Terminate and forget a native command handle; removal is destructive and cannot be retried when uncertain."],
    ["command.resize", "resize", "Set the dimensions of an ordinary or persistent PTY; repeating the same dimensions is safe."],
    ["command.input", "input", "Send input to a PTY without durable acknowledgement; do not retry uncertain input."],
    ["command.interrupt", "interrupt", "Send Ctrl-C to a PTY without durable acknowledgement."],
    ["command.ctrlD", "ctrlD", "Send Ctrl-D as a terminal character; it is not pipe EOF and has no durable acknowledgement."],
  ] as const) {
    const variant = variantsOf(commandControlSchema).find((schema) => (schema.shape as any).action.value === action)!;
    registerTool(name, { title: `Command ${action}`, description, inputSchema: variant.omit({ action: true } as never), outputSchema: outputSchemas.commandControl,
      annotations: { readOnlyHint: false, destructiveHint: action === "remove" || action === "input" || action === "interrupt" || action === "ctrlD", openWorldHint: action !== "resize", idempotentHint: action === "resize" },
    }, async (input) => structuredResult(await host.control({ ...input, action } as any)));
  }

  registerTool("opencode.start", {
    title: "Start OpenCode Work",
    description: "Admit fresh, idle-resume or forked native work. OpenCode chooses configured model/agent defaults when omitted; agents[] supplies prompt context. Select runtime, retain native sessionId and any returned user messageId; reconcile uncertain admission. Codex selects a native mode (fresh default agent), returns messageId null, and supports idle continuation.",
    inputSchema: z.object({
      runtime: runtimeSchema,
      mode: z.enum(CODEX_MODES).optional().describe("Codex native preset. Fresh default agent permits workspace writes with automatic approval review. Continuation inherits locally known mode; recovered conversations require an explicit mode."),
      task: z.string().min(1).max(65536).describe("Self-contained objective or next delta for the workstream."),
      model: z.string().min(1).optional().describe("Optional canonical provider/model ID for fresh OpenCode work; omission lets OpenCode choose its configured default. Resume/fork inherit and reject conflicts. Codex rejects this field."),
      cwd: z.string().min(1).optional().describe("Required for fresh work; resume/fork inherit canonical cwd."),
      sessionId: z.string().min(1).optional().describe("Persisted idle session to continue."),
      forkFromSessionId: z.string().min(1).optional().describe("Persisted session to fork into a new workstream."),
      beforeMessageId: z.string().min(1).optional().describe("Optional fork boundary; requires forkFromSessionId."),
      agent: z.string().min(1).optional().describe("Optional executing canonical agent ID for fresh OpenCode work; omission lets OpenCode choose its configured default. Resume/fork inherit and reject conflicts."),
      title: z.string().min(1).optional().describe("OpenCode-only optional title for a fresh session; Codex rejects this field."),
      permissions: permissionsSchema.optional().describe("Canonical ordered session rules for fresh work. Omission preserves native policy. Session rules follow agent rules; broad allow can override agent restrictions."),
      variant: z.string().min(1).optional().describe("Fresh only: native model variant persisted before the first prompt; requires model. Resume/fork inherit and reject overrides."),
      ...attachmentShape,
    }).strict()
      // Publish the fresh/resume/fork admission rules the backend already enforces, so
      // discovery describes the contract and rejected combinations fail before any native
      // access. These mirror the guards in OpenCodeBackend.start; both layers must agree.
      .superRefine((input, context) => {
        if (input.runtime !== "codex") return;
        for (const field of codexUnsupportedStartFields) {
          if (input[field] !== undefined) context.addIssue({ code: "custom", message: `${field} is OpenCode-only and is not supported by Codex start`, path: [field] });
        }
      })
      .refine((input) => input.mode === undefined || input.runtime === "codex", { message: "mode is only valid for Codex", path: ["mode"] })
      .refine((input) => !input.sessionId || !input.forkFromSessionId, { message: "sessionId and forkFromSessionId are mutually exclusive", path: ["forkFromSessionId"] })
      .refine((input) => !input.beforeMessageId || !!input.forkFromSessionId, { message: "beforeMessageId requires forkFromSessionId", path: ["beforeMessageId"] })
      .refine((input) => !!input.sessionId || !!input.forkFromSessionId || !!input.cwd, { message: "fresh opencode.start requires an explicit cwd", path: ["cwd"] })
      .refine((input) => !input.cwd || (!input.sessionId && !input.forkFromSessionId), { message: "resume and fork inherit cwd and reject cwd overrides", path: ["cwd"] })
      .refine((input) => !input.permissions || (!input.sessionId && !input.forkFromSessionId), { message: "permissions are only valid for fresh sessions", path: ["permissions"] })
      .refine((input) => input.variant === undefined || (!input.sessionId && !input.forkFromSessionId), { message: "resume and fork inherit canonical variant and reject overrides", path: ["variant"] })
      .refine((input) => input.variant === undefined || input.model !== undefined, { message: "variant requires an explicit model", path: ["variant"] })
      .meta({
        not: { required: ["sessionId", "forkFromSessionId"] },
        dependentRequired: { beforeMessageId: ["forkFromSessionId"], variant: ["model"] },
        anyOf: [{ required: ["cwd"] }, { required: ["sessionId"] }, { required: ["forkFromSessionId"] }],
        allOf: [
          { if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: { not: { anyOf: codexUnsupportedStartFields.map(field => ({ required: [field] })) } }, else: { not: { required: ["mode"] } } },
          { not: { anyOf: [{ required: ["sessionId", "cwd"] }, { required: ["forkFromSessionId", "cwd"] }] } },
          { not: { anyOf: [{ required: ["sessionId", "permissions"] }, { required: ["forkFromSessionId", "permissions"] }] } },
          { not: { anyOf: [{ required: ["sessionId", "variant"] }, { required: ["forkFromSessionId", "variant"] }] } },
        ],
      }),
    outputSchema: outputSchemas.start,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await backend.start(input)));

  registerTool("opencode.wait", {
    title: "Wait for OpenCode Work",
    description: "Synchronize one OpenCode canonical user prompt or the current Codex session turn until execution ends, input is required or timeout. Codex cannot recover execution termination after adapter restart. Terminal execution does not imply assistant success; inspect outcome evidence. Do not poll repeatedly.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      runtime: runtimeSchema,
      messageId: z.string().min(1).optional().describe("Required canonical user message ID for OpenCode. Omit for Codex, whose wait observes the current session turn."),
    }).strict().refine(input => input.runtime === "codex" || !!input.messageId, { message: "OpenCode wait requires messageId" })
      .meta({ if: { properties: { runtime: { const: "codex" } }, required: ["runtime"] }, then: {}, else: { required: ["messageId"] } }),
    outputSchema: outputSchemas.wait,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ sessionId, messageId, runtime }, context) => structuredResult(await backend.wait(sessionId, messageId, context.mcpReq.signal, runtime)));

  registerTool("opencode.inspect", {
    title: "Inspect OpenCode Work",
    description: "Read native activity or result. Codex returns the current session turn, with explicit execution knowledge; exact-prompt selection is unsupported. Complete selection before interpreting outcome; text continuation is separate. Use returned read-only nextCall arguments.",
    inputSchema: z.object({
      runtime: runtimeSchema,
      sessionId: z.string().min(1),
      messageId: z.string().min(1).optional(),
      detail: z.enum(["semantic", "result"]).default("semantic"),
      selectionCursor: z.string().min(1).optional().describe("Native continuation from an incomplete result scan; retain candidateAssistantMessageId too."),
      candidateAssistantMessageId: z.string().min(1).optional(),
      selectionFingerprint: z.string().min(1).optional().describe("Required with selectionCursor; session changes invalidate continuation."),
      ...textShape,
    }).strict()
      // These continuation arguments only mean something together. Publish the
      // dependencies the backend enforces in latestResult so an incomplete
      // recovery call is rejected by the contract instead of being ignored.
      .refine((input) => !input.selectionCursor || !!input.messageId, { message: "selectionCursor requires the original user messageId", path: ["messageId"] })
      .refine((input) => !input.candidateAssistantMessageId || !!input.selectionCursor, { message: "candidate requires selectionCursor", path: ["candidateAssistantMessageId"] })
      .meta({ dependentRequired: { selectionCursor: ["messageId"], candidateAssistantMessageId: ["selectionCursor"] } }),
    outputSchema: outputSchemas.inspect,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => structuredResult(await backend.inspect(input)));

  registerTool("opencode.query", {
    title: "Query OpenCode State",
    description: "Batch read native catalogs, ordered permissions, sessions, messages, inbox and tool evidence. Agents default to compact effective catalog with hidden entries excluded. Message pages return 512-unit previews with canonical IDs and bounded tool counts; recover full text via type:message. Session tokens are cumulative totals, not context occupancy. runtime selects the native session backend; Codex supports session inventories, history, native mode selection, pending permission requests, capabilities, and read-only ChatGPT Codex rate-limit windows via runtime: codex, type: usage. OpenCode usage remains cumulative token activity, not quota. General Chat Plus limits are not exposed. Unsupported operations fail explicitly. Continue using fingerprints/native cursors; selected text may contain secrets.",
    inputSchema: z.object({
      queries: z.array(querySchema).min(1).max(10),
    }).strict(),
    outputSchema: outputSchemas.query,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ queries }, context) => structuredResult(await backend.query(queries, context.mcpReq.signal)));

  registerTool("opencode.act", {
    title: "Act on OpenCode State",
    description: "Mutate a native session or admit prompt/inbox/command/skill work. Select the session runtime. Codex supports interrupt, delete and exact-option permission replies; continuation uses start sessionId. Read back configuration. Never automatically retry uncertain mutations.",
    inputSchema: actSchema,
    outputSchema: outputSchemas.act,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await backend.act(input)));

  if (browser) registerBrowserTools(server, browser, events);
  return server;
}
