import * as z from "zod/v4";
import { quotaSnapshot, pluginIdentitySchema } from "./codex.js";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const location = z.object({ directory: id }).loose();
// Native projections vary by operation. Their fields remain data, not another
// connector-owned schema for OpenCode's evolving runtime objects.
const nativeObject = z.record(z.string(), z.unknown());
export function continuationSchema(tool: string | [string, ...string[]]) {
  return z.object({ tool: typeof tool === "string" ? z.literal(tool) : z.enum(tool), arguments: nativeObject }).strict().nullable();
}
const nextCall = continuationSchema(["opencode.result", "opencode.messages", "opencode.message"]);
const hostNextCall = z.object({ tool: id, arguments: nativeObject }).strict().nullable();

const outcome = z.enum(["completed", "failed", "incomplete", "unknown"]);
const retry = z.object({ assistantMessageId: id, attempt: z.number().int().positive(), nextAttemptAtMs: count, error: z.object({ type: id, status: z.number().nullable(), messageOmitted: z.literal(true) }).strict() }).strict().nullable();
const session = z.object({ sessionId: id, cwd: id, status: z.enum(["inProgress", "completed", "failed", "interrupted", "idle"]), executionOutcome: z.string().nullable(), outcome, outcomeBasis: z.enum(["selectedAssistantMessage", "nativePromptResponse", "nativeTurnHistory", "historyReplay"]), model: z.string().nullable(), modelVariant: z.string().nullable(), agent: z.string().nullable() }).loose();
const textPaging = z.object({ offset: count, nextOffset: count.nullable(), size: count, cursorUnit: z.literal("utf16CodeUnits"), fingerprint: id }).strict();
const textShape = { text: z.string(), textPaging, truncated: z.boolean() };
const pageShape = { data: z.array(z.unknown()), offset: count, nextOffset: count.nullable(), total: count, fingerprint: id };
const result = z.object({ outcomeBasis: z.literal("selectedAssistantMessage"), outcome, messageId: id.nullable(), assistantMessageId: id.nullable(), selectionComplete: z.boolean(), selectionCursor: id.nullable(), selectionFingerprint: id, candidateAssistantMessageId: id.nullable(), scannedMessages: count, targetFound: z.boolean(), exhausted: z.boolean(), terminal: z.boolean(), retry, ...textShape, nextCall, textNextCall: nextCall, completedAtMs: z.number().nullable(), finish: z.string().nullable(), error: nativeObject.nullable() }).strict();
const semanticShape = { session, retry, outcomeEvidence: nativeObject, nextCall, textNextCall: nextCall, currentActivity: nativeObject.nullable(), recentMessages: z.array(nativeObject), pendingActions: z.array(nativeObject) };
const commandShape = { kind: z.enum(["shell", "pty", "persistentPty"]), location, id, cwd: id, status: z.enum(["running", "exited", "timeout", "killed"]), pid: z.number().nullable(), exitCode: z.number().nullable(), retention: z.string() };
const cursorShape = { cursor: count, cursorUnit: z.enum(["bytes", "utf16CodeUnits"]) };

const codexResult = z.object({ outcomeBasis: z.enum(["nativePromptResponse", "nativeTurnHistory", "historyReplay"]), outcome, messageId: z.null(), assistantMessageId: id.nullable(), correlationSupported: z.literal(false), terminal: z.boolean(), finish: z.string().nullable(), completedAtMs: z.number().nullable(), error: nativeObject.nullable(), outputTruncated: z.boolean(), ...textShape, textNextCall: nextCall }).strict();
const codexInspection = z.object({ session, result: codexResult, pendingActions: z.array(nativeObject) }).strict();

// Connector-authored errors are structured results too. Publish their existing
// envelope alongside success contracts; SDK input errors remain text-only.
export const errorOutputSchema = z.object({
  error: z.string(),
  recovery: z.object({ sessionId: id, stage: z.string(), promptSubmitted: z.union([z.literal(false), z.null()]) }).strict().optional(),
  commandRecovery: z.object({ kind: z.literal("shell"), cwd: id, admission: z.literal("mayHaveOccurred") }).strict().optional(),
  errorCode: z.string().optional(),
  reason: z.string().optional(),
  mutationMayHaveOccurred: z.boolean().optional(),
}).strict();

export function toolErrorSchema(name: string) {
  const base = errorOutputSchema.omit({ recovery: true, commandRecovery: true });
  if (["opencode.create", "opencode.continue", "opencode.fork"].includes(name)) return base.extend({ recovery: errorOutputSchema.shape.recovery });
  if (name === "command.run") return base.extend({ commandRecovery: errorOutputSchema.shape.commandRecovery });
  if (name === "opencode.agent") return base.extend({ agentId: id.optional() });
  return base;
}

const recoveryOutputSchema = z.object({ ready: z.literal(true), opencodeRelease: id, serverPid: z.number().int(), workers: z.array(z.object({ sessionId: id, cwd: id, status: session.shape.status, executionOutcome: z.string().nullable(), outcome, outcomeBasis: z.enum(["selectedAssistantMessage", "nativePromptResponse", "nativeTurnHistory", "historyReplay"]), outcomeEvidence: nativeObject, retry, retryReadError: z.string().nullable(), nextCall }).loose()), pendingActions: z.array(nativeObject), events: nativeObject.optional() }).strict();
const readinessOutputSchema = z.object({
  detail: z.literal("readiness"), ready: z.boolean(),
  connector: z.object({ version: id, buildId: id, release: z.boolean() }).strict(),
  components: z.object({
    opencode: z.object({ ready: z.boolean(), release: id.nullable(), serverPid: z.number().int().nullable(), error: z.string().nullable() }).strict(),
    events: z.object({ enabled: z.boolean(), storageFailed: z.boolean().nullable() }).strict(),
    browser: z.object({ scope: z.literal("supervisor"), enabled: z.boolean(), worker: z.enum(["running", "stopped"]), currentIssue: z.string().nullable() }).strict().nullable(),
  }).strict(),
}).strict();
const worktreeListOutputSchema = z.object({ projectId: id, location, ...pageShape, nextCall: hostNextCall }).strict();

export const outputSchemas = {
  status: z.union([recoveryOutputSchema, readinessOutputSchema]),
  readiness: readinessOutputSchema,
  recovery: recoveryOutputSchema,
  hostInspect: z.discriminatedUnion("type", [
    z.object({ type: z.enum(["list", "vcsStatus", "vcsBranch", "commands"]), location, ...pageShape, nextCall: hostNextCall, shellListScope: z.string().optional(), terminalListScope: z.string().optional(), search: z.string().nullable().optional() }).strict(),
    z.object({ type: z.literal("read"), location, path: id, size: count, fingerprint: id, nextCall: hostNextCall, encoding: z.enum(["utf8", "base64"]).optional(), text: z.string().optional(), data: z.string().optional(), cursorUnit: z.literal("bytes").optional(), offset: count.optional(), nextOffset: count.nullable().optional() }).strict(),
    z.object({ type: z.literal("find"), location, data: z.array(z.unknown()), limit: count, possiblyTruncated: z.boolean(), search: z.string(), nextCall: hostNextCall }).strict(),
    z.object({ type: z.literal("vcs"), location, info: z.unknown(), base: z.unknown(), nextCall: hostNextCall }).strict(),
    z.object({ type: z.literal("vcsDiff"), location, nextCall: hostNextCall, ...Object.fromEntries(Object.entries(pageShape).map(([key, schema]) => [key, schema.optional()])), file: id.optional(), additions: count.optional(), deletions: count.optional(), status: z.string().optional(), text: z.string().optional(), textPaging: textPaging.optional(), truncated: z.boolean().optional() }).strict(),
    z.object({ type: z.enum(["terminalScreen", "terminalSnapshot"]), location, nextCall: hostNextCall, sessionId: id, available: z.boolean().optional(), id: id.optional(), view: z.enum(["renderedScreen", "renderedSnapshot"]).optional(), size: nativeObject.optional(), screenCursor: nativeObject.optional(), checkpointIncluded: z.literal(false).optional(), text: z.string().optional(), textPaging: textPaging.optional(), truncated: z.boolean().optional(), cwd: id.optional(), status: z.string().optional(), pid: z.number().optional(), exitCode: z.number().nullable().optional(), output: nativeObject.optional() }).strict(),
  ]),
  hostWrite: z.object({ location, path: id, created: z.boolean(), persisted: z.literal(true), size: count, fingerprint: id, atomicCAS: z.literal(false), containment: z.string() }).strict(),
  worktreeList: worktreeListOutputSchema,
  hostWorktree: z.union([
    worktreeListOutputSchema,
    z.object({ action: z.enum(["create", "remove"]), projectId: id, directory: id, persisted: z.literal(true), removed: z.literal(true).optional() }).strict(),
    z.object({ action: z.literal("refresh"), projectId: id, persisted: z.literal(true), ...pageShape }).strict(),
  ]),
  commandRun: z.object({ ...commandShape, kind: z.literal("shell"), cursor: count, cursorUnit: z.literal("bytes"), output: z.string(), size: count.nullable(), truncated: z.boolean().nullable(), drained: z.boolean(), encoding: z.literal("nativeUtf8"), decodingLimit: z.string(), signal: z.string().nullable().optional(), time: nativeObject.optional(), metadataSource: z.enum(["admission", "get"]), metadataVerified: z.boolean(), observation: z.object({ reason: z.enum(["terminal", "outputLimit", "waitTimeout", "cancelled", "observationError"]), stage: z.enum(["get", "output", "wait"]), error: z.object({ type: z.string().nullable(), message: z.string() }).strict().nullable() }).strict(), nextCall: continuationSchema("command.read") }).strict(),
  commandStart: z.object({ ...commandShape, ...cursorShape, signal: z.string().nullable().optional(), time: nativeObject.optional(), sessionId: id.optional(), size: nativeObject.optional(), output: nativeObject.optional() }).strict(),
  commandRead: z.object({ ...commandShape, ...cursorShape, output: z.string().nullable(), drained: z.boolean(), signal: z.string().nullable().optional(), time: nativeObject.optional(), size: z.union([count, nativeObject]).optional(), truncated: z.boolean().optional(), encoding: z.enum(["nativeUtf8", "utf8", "base64"]).optional(), data: z.string().optional(), decodingLimit: z.string().optional(), replayAvailable: z.boolean().optional(), replay: nativeObject.optional(), replayComplete: z.boolean().optional(), inputSent: z.boolean().optional(), detached: z.literal(true).optional(), sessionId: id.optional(), lastConfirmedInfo: nativeObject.optional(), metadataVerified: z.boolean().optional(), metadataReadError: nativeObject.nullable().optional(), handleAvailable: z.boolean().nullable().optional(), nextCall: nextCall.optional() }).strict(),
  commandControl: z.union([
    z.object({ kind: commandShape.kind, location, id, removed: z.literal(true) }).strict(),
    z.object({ kind: commandShape.kind, location, id, action: z.enum(["input", "interrupt", "ctrlD"]), inputSent: z.boolean(), acknowledged: z.literal(false), delivery: z.string() }).strict(),
    z.object({ kind: commandShape.kind, location, id, cwd: id, status: commandShape.status, pid: z.number(), exitCode: z.number().nullable(), resized: z.literal(true), sessionId: id.optional(), size: nativeObject.optional(), output: nativeObject.optional() }).strict(),
  ]),
  start: z.union([
    z.object({ runtime: z.literal("opencode"), sessionId: id, messageId: id, cwd: id, model: id.nullable(), modelVariant: id.nullable(), agent: id.nullable(), status: z.literal("inProgress") }).strict(),
    z.object({ runtime: z.literal("codex"), sessionId: id, messageId: z.null(), cwd: id, model: id.nullable(), modelProvider: id.nullable(), reasoningEffort: id.nullable(), modelVariant: z.null(), agent: z.literal("codex"), status: z.literal("inProgress"), mode: z.string().nullable(), capabilities: nativeObject }).strict(),
  ]),
  wait: z.union([
    z.object({ runtime: z.literal("codex"), sessionId: id, messageId: z.null(), state: z.enum(["active", "terminal", "unknown"]), wakeReason: z.enum(["timeout", "terminal", "executionUnavailable", "actionRequired"]), session, result: codexResult, pendingActions: z.array(nativeObject) }).strict(),
    z.object({ runtime: z.literal("opencode"), sessionId: id, messageId: id, state: z.literal("terminal"), wakeReason: z.literal("terminal"), session, result }).strict(),
    z.object({ runtime: z.literal("opencode"), sessionId: id, messageId: id, state: z.literal("active"), wakeReason: z.enum(["actionRequired", "timeout"]), ...semanticShape }).strict(),
  ]),
  inspectActivity: z.union([codexInspection, z.object(semanticShape).strict()]),
  inspectResult: z.union([codexInspection, z.object({ session, result }).strict()]),
  act: z.discriminatedUnion("action", [
    z.object({ action: z.enum(["switchModel", "switchAgent", "setPermissions"]), session, persisted: z.literal(true) }).strict(),
    z.object({ action: z.literal("compact"), inboxId: id, sessionId: id, type: id, createdAtMs: z.number(), delivery: z.enum(["steer", "queue"]), status: z.literal("admitted"), completed: z.literal(false), correlationSupported: z.literal(true), completionNote: z.string().min(1), verifyNextCall: nextCall }).strict(),
    z.object({ action: z.enum(["cancelInbox", "updateInbox"]), sessionId: id, inboxId: id, pending: z.boolean(), delivery: z.enum(["steer", "queue"]).nullable(), status: z.enum(["pending", "absentFromPendingInbox"]), mutationSubmitted: z.literal(true), persisted: z.boolean(), deliveryVerified: z.boolean().nullable() }).strict(),
    z.object({ action: z.literal("removeSavedApproval"), sessionId: id, projectId: id, approvalId: id, removed: z.literal(true), persisted: z.literal(true) }).strict(),
    z.object({ action: z.literal("revertStage"), sessionId: id, revert: z.object({ messageId: id, partId: id.nullable(), files: z.array(nativeObject) }).strict() }).strict(),
    z.object({ action: z.literal("revertClear"), sessionId: id, cleared: z.literal(true) }).strict(),
    z.object({ action: z.literal("revertCommit"), sessionId: id, committed: z.literal(true) }).strict(),
    z.object({ action: z.literal("command"), sessionId: id, name: id, submitted: z.literal(true), identitySupplied: z.literal(false) }).strict(),
    z.object({ action: z.literal("invokeSkill"), sessionId: id, skillId: id, submitted: z.literal(true), identitySupplied: z.literal(false) }).strict(),
    z.object({ action: z.literal("synthetic"), sessionId: id, inboxId: id, type: id, createdAtMs: z.number(), delivery: z.enum(["steer", "queue"]) }).strict(),
    z.object({ action: z.literal("steer"), sessionId: id, messageId: id }).strict(),
    z.object({ action: z.literal("interrupt"), runtime: z.literal("codex").optional(), sessionId: id, interrupted: z.boolean() }).strict(),
    z.object({ action: z.literal("respondPermission"), runtime: z.literal("codex").optional(), sessionId: id, requestId: id, optionId: id.optional(), accepted: z.literal(true) }).strict(),
    z.object({ action: z.literal("respondForm"), sessionId: id, formId: id, accepted: z.literal(true) }).strict(),
    z.object({ action: z.literal("cancelForm"), sessionId: id, formId: id, cancelled: z.literal(true) }).strict(),
    z.object({ action: z.literal("delete"), runtime: z.enum(["opencode", "codex"]), sessionId: id, deleted: z.literal(true) }).strict(),
  ]),
};

// These schemas describe connector projections. Native extension fields remain
// visible through loose objects; model/provider inventories are never frozen here.
const textPageSchema = z.object(textShape).strict();
const modelCost = z.object({ tier: z.object({ type: z.literal("context"), size: count }).loose().optional(), input: z.number(), output: z.number(), cache: z.object({ read: z.number(), write: z.number() }).loose() }).loose();
const modelEntry = z.object({ id, enabled: z.boolean(), cost: z.array(modelCost), modalities: z.array(z.string()), variants: z.array(id), name: z.string().optional(), providerId: id.optional(), contextWindow: count.optional() }).loose();
const agentEntry = z.object({ id, name: z.string(), mode: z.string(), hidden: z.boolean(), description: textPageSchema, model: id.nullable() }).loose();
const skillEntry = z.object({ id, name: z.string(), description: textPageSchema, path: z.string().nullable() }).loose();
const sessionEntry = z.object({ sessionId: id, runtime: z.enum(["opencode", "codex"]), cwd: id, status: z.string().nullable(), model: id.nullable(), outcome: outcome.optional() }).loose();
const messageEntry = z.object({ id: id.nullable(), type: z.string(), text: z.string().optional(), textPaging: textPaging.optional(), nextCall: continuationSchema("opencode.message").optional() }).loose();
const permissionEntry = z.object({ requestId: id, sessionId: id, action: z.string().nullable(), resources: z.array(z.string()), message: z.string().nullable() }).loose();
const ruleEntry = z.object({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "deny", "ask"]) }).loose();
const inboxEntry = z.object({ inboxId: id, sessionId: id, type: z.string(), createdAtMs: z.number(), delivery: z.string(), status: z.literal("pending") }).loose();
const tokenTotals = z.object({ input: count, output: count, reasoning: count, cache: z.object({ read: count, write: count }).loose() }).loose();

function queryPage(tool: string, entry: z.ZodType = nativeObject) {
  return z.object({ ...pageShape, data: z.array(entry), nextCall: continuationSchema(tool) }).loose();
}
function queryText(tool: string) {
  return z.object({ ...textShape, nextCall: continuationSchema(tool) }).loose();
}

export function queryOutputSchema(type: string): z.ZodType {
  switch (type) {
    case "models": return queryPage("opencode.models", modelEntry).extend({ location, view: z.enum(["compact", "full"]) });
    case "agents": return queryPage("opencode.agents", agentEntry).extend({ location, catalog: z.literal("effective"), provenanceAvailable: z.literal(false), view: z.enum(["compact", "full"]), includesBuiltins: z.literal(true), includesHidden: z.boolean(), hiddenCount: count });
    case "agent": return agentEntry.extend({ location, field: z.enum(["system", "description", "permissions"]), text: z.string().optional(), textPaging: textPaging.optional(), truncated: z.boolean().optional(), permissions: queryPage("opencode.agent", ruleEntry).omit({ nextCall: true }).optional(), nextCall: continuationSchema("opencode.agent") });
    case "skills": return queryPage("opencode.skills", skillEntry).extend({ location });
    case "skill": return skillEntry.extend({ ...textShape, nextCall: continuationSchema("opencode.skill") });
    case "providers": return queryPage("opencode.providers", z.object({ id, name: z.string(), activation: z.unknown() }).loose()).extend({ location });
    case "sessions": return z.object({ runtime: z.enum(["opencode", "codex"]), sessions: z.array(sessionEntry), cursor: z.object({ next: id.nullable(), previous: id.nullable().optional() }).strict(), nextCall: continuationSchema("opencode.sessions") }).strict();
    case "session": return sessionEntry.extend({ nextCall: z.null() });
    case "messages": return z.union([
      z.object({ messages: z.array(messageEntry), cursor: z.object({ next: id.nullable(), previous: id.nullable().optional() }).strict(), nextCall: continuationSchema("opencode.messages") }).strict(),
      queryPage("opencode.messages", messageEntry).extend({ historyComplete: z.boolean() }),
    ]);
    case "message": return messageEntry.extend({ nextCall: continuationSchema("opencode.message") });
    case "permissions": return z.union([
      z.object({ sessionId: id, section: z.literal("rules"), rules: queryPage("opencode.permissions", ruleEntry).omit({ nextCall: true }), nextCall: continuationSchema("opencode.permissions") }).strict(),
      z.object({ sessionId: id, section: z.literal("pending"), pending: queryPage("opencode.permissions", permissionEntry).omit({ nextCall: true }), nextCall: continuationSchema("opencode.permissions") }).strict(),
      queryPage("opencode.permissions", permissionEntry).extend({ sessionId: id, runtime: z.literal("codex") }),
    ]);
    case "savedApprovals": return queryPage("opencode.savedApprovals").extend({ projectId: id });
    case "inbox": return z.union([queryPage("opencode.inbox", inboxEntry), inboxEntry.extend({ ...textShape, nextCall: continuationSchema("opencode.inbox") })]);
    case "tools": return queryPage("opencode.toolCalls", z.object({ id, name: z.string(), status: z.string() }).loose()).extend({ sessionId: id, messageId: id });
    case "tool": return queryText("opencode.toolCall").extend({ sessionId: id, messageId: id, toolId: id, name: z.string(), status: z.string(), field: z.enum(["input", "content", "error"]), contentType: z.string().nullable(), contentTotal: count, contentIndex: count, file: nativeObject.nullable() });
    case "sessionDiff": {
      const identity = { sessionId: id, from: id.nullable(), to: id.nullable() };
      return z.union([
        queryPage("opencode.sessionDiff", z.object({ file: id, additions: count, deletions: count, status: z.string(), patchSize: count, patchFingerprint: id }).loose()).extend(identity),
        queryText("opencode.sessionDiff").extend({ ...identity, file: id, additions: count, deletions: count, status: z.string() }),
      ]);
    }
    case "runtime": return z.union([
      queryPage("opencode.runtime", z.object({ type: z.enum(["plugin", "mcp", "command"]) }).loose()).extend({ runtime: z.literal("opencode"), diagnostics: diagnosticsSchema, location, projectId: id, opencodeRelease: id }),
      z.object({ runtime: z.literal("codex"), diagnostics: diagnosticsSchema, capabilities: nativeObject, pluginIdentity: pluginIdentitySchema, nextCall: z.null() }).strict(),
    ]);
    case "codexQuota": return quotaSnapshot.extend({ runtime: z.literal("codex"), capabilities: nativeObject, nextCall: z.null() });
    case "usage": return z.object({ range: z.object({ from: z.number(), to: z.number() }).loose(), sessions: count, subagents: count, prompts: count, steps: count, tokens: tokenTotals, cost: z.number(), tools: nativeObject, activeDays: count, streak: count, activity: z.array(nativeObject), models: z.array(nativeObject), nextCall: z.null() }).loose();
    default: throw new Error("Unknown public query result schema: " + type);
  }
}

const diagnosticsSchema = z.object({
  capabilityScope: z.literal("connector-api"),
  context: z.object({ plane: z.literal("WorkerPlane"), runtime: z.enum(["opencode", "codex"]), platformContext: z.literal("separate"), hostContext: z.literal("hosted"), session: z.literal("not-selected") }).strict(),
  hostInterface: z.object({ plane: z.literal("HostPlane"), transport: z.literal("MCP"), owner: z.literal("opencode-connect") }).strict(),
  control: z.object({ service: z.literal("opencode"), interface: z.enum(["native-api", "plugin-rpc"]), rpc: z.string().nullable(), evidence: z.enum(["plugin-status", "native-location-and-inventory"]) }).strict(),
  api: z.object({ sessionIdentity: z.array(z.string()), promptCorrelation: z.enum(["canonical-user-message", "current-turn-only"]), continuation: z.boolean(), fork: z.boolean(), modelSelection: z.boolean(), agentSelection: z.boolean(), promptAttachments: z.boolean(), permissionRules: z.boolean(), nativeModes: z.boolean(), nativeSessionEvents: z.boolean() }).strict(),
  effectiveTools: z.object({ status: z.literal("unavailable"), reason: z.literal("runtime-read-is-not-model-agent-scoped") }).strict(),
  execution: z.object({ activity: z.literal("not-observed"), osSandbox: z.literal("not-observed") }).strict(),
}).strict();

// Derive each public operation's output from the backend's authoritative union.
// Shared enum variants are narrowed too, so another operation cannot validate.
export function outputVariant(schema: z.ZodUnion, key: string, value: string | boolean): z.ZodObject {
  const matches: z.ZodObject[] = [];
  for (const option of schema.options) {
    if (option instanceof z.ZodObject && option.shape[key]?.safeParse(value).success) matches.push(option);
  }
  if (matches.length !== 1) throw new Error(`Expected one output variant for ${key}=${value}`);
  return matches[0]!.extend({ [key]: z.literal(value) });
}
