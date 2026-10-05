import { EventErrorCode } from "./eventsErrors.js";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { OpenCodeBackend } from "./opencode.js";
import { HostBackend } from "./host.js";
import { ComputerBackend } from "./computer.js";
import { computerObserveSchema, computerInteractSchema, computerScreenshotSchema, computerSequenceSchema, computerOutputSchemas } from "./computerSchema.js";
import { exposedUnion } from "./schema.js";
import { VERSION } from "./version.js";
import { safeError, AdmissionError, ConnectorError } from "./bounds.js";
import { ProtocolErrorCode, ProtocolError } from "@modelcontextprotocol/server";
import { Events, EVENT_NAME, eventArgumentsSchema } from "./events.js";
import type { ServerContext, ContentBlock } from "@modelcontextprotocol/server";
import { outputSchemas } from "./results.js";

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
  z.object({ type: z.literal("sessionDiff"), sessionId: z.string().min(1), from: z.string().min(1).optional(), to: z.string().min(1).optional(), context: z.number().int().min(0).max(1000).optional(), file: z.string().min(1).optional(), ...pageShape, ...textShape }).strict(),
  z.object({ type: z.literal("inbox"), sessionId: z.string().min(1), inboxId: z.string().min(1).optional(), ...pageShape, ...textShape }).strict(),
  z.object({ type: z.literal("skill"), cwd: z.string().min(1).optional(), skillId: z.string().min(1), ...textShape }).strict(),
  z.object({ type: z.literal("tools"), sessionId: z.string().min(1), messageId: z.string().min(1), ...pageShape }).strict(),
  z.object({ type: z.literal("tool"), sessionId: z.string().min(1), messageId: z.string().min(1), toolId: z.string().min(1), field: z.enum(["input", "content", "error"]), contentIndex: z.number().int().min(0).optional(), ...textShape }).strict(),
  z.object({ type: z.literal("models"), cwd: z.string().min(1).optional(), ...pageShape }),
  z.object({ type: z.literal("agents"), cwd: z.string().min(1).optional().describe("Select project context; response returns the native resolved location."), view: z.enum(["compact", "full"]).optional().describe("Defaults to compact catalog; full includes instructions and raw permission pages."), includeHidden: z.boolean().optional().describe("Defaults to false; true includes native internal agents."), includePermissionsSummary: z.boolean().optional().describe("Compact ordered-rule summary, excluding session rules, saved approvals and policies."), ...pageShape }).strict(),
  z.object({ type: z.literal("agent"), cwd: z.string().min(1).optional(), agentId: z.string().min(1), field: z.enum(["system", "description", "permissions", "permissionSummary"]).optional(), ...textShape, ...pageShape }).strict(),
  z.object({ type: z.literal("messages"), sessionId: z.string().min(1), cursor: z.string().min(1).optional(), order: z.enum(["asc", "desc"]).optional(), limit: z.number().int().min(1).max(50).optional() }).refine((input) => !input.cursor || !input.order, { message: "native message cursor cannot be combined with order", path: ["order"] }).meta({ not: { required: ["cursor", "order"] } }),
  z.object({ type: z.literal("message"), sessionId: z.string().min(1), messageId: z.string().min(1), field: z.enum(["summary", "recent"]).optional().describe("Compaction only: page the full native summary or recent text instead of the bounded preview."), ...textShape }),
  z.object({ type: z.literal("permissions"), sessionId: z.string().min(1), section: z.enum(["rules", "pending", "summary"]).optional().describe("summary compacts current agent plus session rules; saved approvals and policies are excluded."), ...pageShape }).strict(),
  z.object({ type: z.literal("savedApprovals"), sessionId: z.string().min(1), ...pageShape }),
  z.object({ type: z.literal("runtime"), cwd: z.string().min(1), ...pageShape }),
  z.object({ type: z.literal("skills"), cwd: z.string().min(1).optional(), ...pageShape }),
  z.object({ type: z.literal("providers"), cwd: z.string().min(1).optional(), ...pageShape }),
  z.object({ type: z.literal("usage") }),
  z.object({
    type: z.literal("sessions"),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).default(25),
    cwd: z.string().min(1).optional(),
    searchTerm: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("session"), sessionId: z.string().min(1) }),
]);

const formValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export const actSchema = exposedUnion("action", [
  z.object({ action: z.literal("steer"), sessionId: z.string().min(1), instruction: z.string().min(1).max(65536), ...attachmentShape }).strict(),
  z.object({ action: z.literal("cancelInbox"), sessionId: z.string().min(1), inboxId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("updateInbox"), sessionId: z.string().min(1), inboxId: z.string().min(1), delivery: z.enum(["steer", "queue"]) }).strict(),
  z.object({ action: z.literal("compact"), sessionId: z.string().min(1), delivery: z.enum(["steer", "queue"]).optional() }).strict(),
  z.object({ action: z.literal("command").describe("Admit a catalogued native session command; upstream returns no message identity."), sessionId: z.string().min(1), name: z.string().min(1).max(256), text: z.string().max(65536), delivery: z.enum(["steer", "queue"]).optional().describe("Native steer or queue delivery."), ...attachmentShape }).strict(),
  z.object({ action: z.literal("invokeSkill"), sessionId: z.string().min(1), skillId: z.string().min(1), resume: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("interrupt"), sessionId: z.string().min(1) }),
  z.object({
    action: z.literal("respondPermission"),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(["once", "always", "reject"]),
    message: z.string().optional(),
  }),
  z.object({
    action: z.literal("respondForm"),
    sessionId: z.string().min(1),
    formId: z.string().min(1),
    answer: z.record(z.string(), formValueSchema),
  }),
  z.object({ action: z.literal("cancelForm"), sessionId: z.string().min(1), formId: z.string().min(1) }),
  z.object({ action: z.literal("delete"), sessionId: z.string().min(1) }),
  z.object({ action: z.literal("revertStage").describe("Stage native session revert for a canonical message; this does not restore files until commit."), sessionId: z.string().min(1), messageId: z.string().min(1), files: z.boolean().optional().describe("Pass the native file-revert option; omitted preserves OpenCode default.") }).strict(),
  z.object({ action: z.literal("revertClear").describe("Clear a staged native session revert without committing it."), sessionId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("revertCommit").describe("Commit the currently staged native session revert."), sessionId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("switchModel"), sessionId: z.string().min(1), model: z.string().min(1), variant: z.string().min(1).optional() }),
  z.object({ action: z.literal("switchAgent"), sessionId: z.string().min(1), agent: z.string().min(1).describe("Executing canonical agent ID from the effective catalog; persisted session selection is read back. This does not create or edit an agent.") }),
  z.object({ action: z.literal("setPermissions"), sessionId: z.string().min(1), permissions: permissionsSchema }),
  z.object({ action: z.literal("removeSavedApproval").describe("Remove one project saved approval by exact ID with absent-target readback; never retry uncertain removal."), sessionId: z.string().min(1), approvalId: z.string().min(1) }),
  z.object({ action: z.literal("synthetic"), sessionId: z.string().min(1), text: z.string().min(1).max(12000), description: z.string().max(2000).optional(), delivery: z.enum(["steer", "queue"]).optional(), resume: z.boolean().optional() }),
]);

export function structuredResult(structuredContent: Record<string, unknown>, content: ContentBlock[] = []) {
  const result = { structuredContent, content };
  if (Buffer.byteLength(JSON.stringify({ structuredContent })) > 262_144) throw new ConnectorError("MCP structured response exceeds 256 KiB; request a smaller page or specific detail");
  return result;
}

export function createServer(backend = new OpenCodeBackend(), host = new HostBackend(), events?: Events, computer?: ComputerBackend): McpServer {
  const computerBackend = computer ?? new ComputerBackend();
  const capabilities = { tools: { listChanged: false }, ...(events ? { events: {} } : {}) };
  const server = new McpServer({ name: "opencode-connect", version: VERSION }, {
    capabilities, supportedProtocolVersions: ["2026-07-28"], inputRequired: { legacyShim: false },
  });
  // A standalone server owns its default backend; HTTP exchanges borrow the shared one.
  if (!computer) server.server.onclose = () => computerBackend.close();
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
  const registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => Promise<unknown>) => register(name, config as never, (async (...args: unknown[]) => {
    try { return await callback(...args); }
    catch (error) { return { ...structuredResult({ error: safeError(error), ...(error instanceof AdmissionError ? { recovery: error.recovery } : {}) }), isError: true }; }
  }) as never)) as typeof server.registerTool;

  registerTool("status", {
    title: "Read OpenCode Connect Status",
    description: "Recover readiness and active/recent native workers. Execution termination does not prove assistant success; inspect exact result evidence.",
    inputSchema: z.object({}).strict(),
    outputSchema: outputSchemas.status,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => structuredResult({ ...await backend.status(), ...(events ? { events: events.snapshot() } : {}) }));

  registerTool("computer.observe", {
    title: "Observe Windows Computer",
    description: "Read WCU v1 capabilities, windows, window state, exact semantic matches or element state. Locators are case-sensitive with at most one ancestor; no waits or fuzzy matching.",
    inputSchema: computerObserveSchema,
    outputSchema: computerOutputSchemas.observe,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => structuredResult(await computerBackend.observe(input)));

  registerTool("computer.interact", {
    title: "Interact with Windows Computer",
    description: "Perform one explicit Windows action. Foreground activation requires activate=true (keySequence also requires handle). focus/setValue/invoke default to immediate inspect readback; observed element state does not verify application effects. No automatic retries after uncertain mutations.",
    inputSchema: computerInteractSchema,
    outputSchema: computerOutputSchemas.interact,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await computerBackend.interact(input)));

  registerTool("computer.sequence", {
    title: "Run Windows Computer Sequence",
    description: "Run 1..32 explicit actions or exact waitFor conditions sequentially; stop on first failure, never retry mutations. Waits default to 3000 ms (maximum 10000), polling every 100 ms (50..1000). Same activation/readback contracts as computer.interact. Returns indexed results and HostPlane timings; no screenshots, scripts, loops or branches.",
    inputSchema: computerSequenceSchema,
    outputSchema: computerOutputSchemas.sequence,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => {
    const result = await computerBackend.sequence(input);
    return { ...structuredResult(result), ...(result.success ? {} : { isError: true }) };
  });

  registerTool("computer.screenshot", {
    title: "Capture Windows Computer",
    description: "Capture desktop, or an explicit window handle, as exactly one PNG image (maximum 1 MiB) with safe metadata. Does not activate a window.",
    inputSchema: computerScreenshotSchema,
    outputSchema: computerOutputSchemas.screenshot,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => {
    const { metadata, image } = await computerBackend.screenshot(input);
    return structuredResult(metadata, [image]);
  });

  registerTool("host.inspect", {
    title: "Inspect OpenCode Host",
    description: "Read native files/images, filename search, VCS, command inventory or rendered terminal screens. Continue with fingerprints; direct host authority is independent of worker permissions.",
    inputSchema: hostInspectSchema,
    outputSchema: outputSchemas.hostInspect,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => {
    const result = await host.inspect(input);
    if ("image" in result && result.image) {
      const { image, ...metadata } = result;
      return structuredResult(metadata, [{ type: "image", mimeType: image.mimeType, data: image.data }]);
    }
    return structuredResult(result);
  });
  registerTool("host.write", {
    title: "Write Native OpenCode Host File",
    description: "Write a native file with explicit overwrite, fingerprint and persisted readback. Preflight is not atomic CAS; never retry uncertain writes automatically.",
    inputSchema: hostWriteSchema,
    outputSchema: outputSchemas.hostWrite,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => structuredResult(await host.write(input)));
  registerTool("host.worktree", {
    title: "Manage Native OpenCode Worktrees",
    description: "List/create/remove/refresh native project worktrees. Remove requires an explicit force decision (false allowed); mutations require readback and must not be retried automatically.",
    inputSchema: worktreeSchema,
    outputSchema: outputSchemas.hostWorktree,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => structuredResult(await host.worktree(input)));
  registerTool("command.start", {
    title: "Start Native OpenCode Command",
    description: "Start a native shell or PTY. Save kind, id, canonical cwd and cursor; handles can expire and ordinary PTYs cannot replay after exit. Direct host authority.",
    inputSchema: commandStartSchema,
    outputSchema: outputSchemas.commandStart,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await host.start(input)));
  registerTool("command.read", {
    title: "Read Native OpenCode Command",
    description: "Read bounded native command replay by saved handle/cursor. Persistent observers may remove exited handles; detach or unverified metadata never proves exit or drain.",
    inputSchema: z.object({ ...handleShape, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(65536).optional(), waitMs: z.number().int().min(0).max(2000).optional() }).strict(),
    outputSchema: outputSchemas.commandRead,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => structuredResult(await host.read(input)));
  registerTool("command.control", {
    title: "Control Native OpenCode Command",
    description: "Remove a command or resize/send input to a PTY. Shell supports remove only; persistent input may require takeover. Input has no durable acknowledgement; never retry uncertain input.",
    inputSchema: commandControlSchema,
    outputSchema: outputSchemas.commandControl,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await host.control(input)));

  registerTool("opencode.start", {
    title: "Start OpenCode Work",
    description: "Admit fresh, idle-resume or forked native work. Catalog agents and ordered permissions first; agent selects execution, agents[] supplies prompt context. Save sessionId and user messageId; reconcile uncertain admission.",
    inputSchema: z.object({
      task: z.string().min(1).max(65536).describe("Self-contained objective or next delta for the workstream."),
      model: z.string().min(1).describe("Required canonical provider/model ID on every start."),
      cwd: z.string().min(1).optional().describe("Required for fresh work; resume/fork inherit canonical cwd."),
      sessionId: z.string().min(1).optional().describe("Persisted idle session to continue."),
      forkFromSessionId: z.string().min(1).optional().describe("Persisted session to fork into a new workstream."),
      beforeMessageId: z.string().min(1).optional().describe("Optional fork boundary; requires forkFromSessionId."),
      agent: z.string().min(1).optional().describe("Executing canonical agent ID; fresh defaults to build. Catalog effective agents and ordered rules first. Resume/fork inherit and reject conflicts."),
      title: z.string().min(1).optional().describe("Optional title for a fresh session."),
      permissions: permissionsSchema.optional().describe("Canonical ordered session rules for fresh work. Omission preserves native policy. Session rules follow agent rules; broad allow can override agent restrictions."),
      variant: z.string().min(1).optional().describe("Fresh only: catalog-validated model variant persisted before the first prompt; resume/fork inherit and reject overrides."),
      ...attachmentShape,
    }).strict(),
    outputSchema: outputSchemas.start,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await backend.start(input)));

  registerTool("opencode.wait", {
    title: "Wait for OpenCode Work",
    description: "Synchronize one canonical user prompt until execution ends, input is required or timeout. Terminal execution does not imply assistant success; inspect outcome evidence. Do not poll repeatedly.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      messageId: z.string().min(1).describe("Canonical user message ID returned by opencode.start or opencode.act steer."),
    }).strict(),
    outputSchema: outputSchemas.wait,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ sessionId, messageId }, context) => structuredResult(await backend.wait(sessionId, messageId, context.mcpReq.signal)));

  registerTool("opencode.inspect", {
    title: "Inspect OpenCode Work",
    description: "Read native activity or exact prompt result. Complete selection before interpreting outcome; text continuation is separate. Use returned read-only nextCall arguments.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      messageId: z.string().min(1).optional(),
      detail: z.enum(["semantic", "result"]).default("semantic"),
      selectionCursor: z.string().min(1).optional().describe("Native continuation from an incomplete result scan; retain candidateAssistantMessageId too."),
      candidateAssistantMessageId: z.string().min(1).optional(),
      selectionFingerprint: z.string().min(1).optional().describe("Required with selectionCursor; session changes invalidate continuation."),
      ...textShape,
    }).strict(),
    outputSchema: outputSchemas.inspect,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => structuredResult(await backend.inspect(input)));

  registerTool("opencode.query", {
    title: "Query OpenCode State",
    description: "Batch read native catalogs, ordered permissions, sessions, messages, inbox and tool evidence. Agents default to compact effective catalog with hidden entries excluded. Message pages return 512-unit previews with canonical IDs and bounded tool counts; recover full text via type:message. Session tokens are cumulative totals, not context occupancy. Continue using fingerprints/native cursors; selected text may contain secrets.",
    inputSchema: z.object({
      queries: z.array(querySchema).min(1).max(10),
    }).strict(),
    outputSchema: outputSchemas.query,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ queries }) => structuredResult(await backend.query(queries)));

  registerTool("opencode.act", {
    title: "Act on OpenCode State",
    description: "Mutate a native session or admit prompt/inbox/command/skill work. Read back configuration; void admissions have no invented message ID. Compaction admission is not completion: inbox absence never proves it; verify the exact native compaction message using the returned inbox ID. Never automatically retry uncertain mutations.",
    inputSchema: actSchema,
    outputSchema: outputSchemas.act,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => structuredResult(await backend.act(input)));

  return server;
}
