import * as z from "zod/v4";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const location = z.object({ directory: id }).loose();
// Native projections vary by operation. Their fields remain data, not another
// connector-owned schema for OpenCode's evolving runtime objects.
const nativeObject = z.record(z.string(), z.unknown());
const nextCall = z.object({ tool: z.enum(["opencode.inspect", "opencode.query", "host.inspect", "host.worktree"]), arguments: nativeObject }).strict().nullable();
const outcome = z.enum(["completed", "failed", "incomplete", "unknown"]);
const retry = z.object({ assistantMessageId: id, attempt: z.number().int().positive(), nextAttemptAtMs: count, error: z.object({ type: id, status: z.number().nullable(), messageOmitted: z.literal(true) }).strict() }).strict().nullable();
const session = z.object({ sessionId: id, cwd: id, status: z.enum(["inProgress", "completed", "failed", "interrupted", "idle"]), executionOutcome: z.string().nullable(), outcome, outcomeBasis: z.literal("selectedAssistantMessage"), model: z.string().nullable(), modelVariant: z.string().nullable(), agent: z.string().nullable() }).loose();
const textPaging = z.object({ offset: count, nextOffset: count.nullable(), size: count, cursorUnit: z.literal("utf16CodeUnits"), fingerprint: id }).strict();
const textShape = { text: z.string(), textPaging, truncated: z.boolean() };
const pageShape = { data: z.array(z.unknown()), offset: count, nextOffset: count.nullable(), total: count, fingerprint: id };
const result = z.object({ outcomeBasis: z.literal("selectedAssistantMessage"), outcome, messageId: id.nullable(), assistantMessageId: id.nullable(), selectionComplete: z.boolean(), selectionCursor: id.nullable(), selectionFingerprint: id, candidateAssistantMessageId: id.nullable(), scannedMessages: count, targetFound: z.boolean(), exhausted: z.boolean(), terminal: z.boolean(), retry, ...textShape, nextCall, textNextCall: nextCall, completedAtMs: z.number().nullable(), finish: z.string().nullable(), error: nativeObject.nullable() }).strict();
const semanticShape = { session, retry, outcomeEvidence: nativeObject, nextCall, textNextCall: nextCall, currentActivity: nativeObject.nullable(), recentMessages: z.array(nativeObject), pendingActions: z.array(nativeObject) };
const commandShape = { kind: z.enum(["shell", "pty", "persistentPty"]), location, id, cwd: id, status: z.enum(["running", "exited", "timeout", "killed"]), pid: z.number().nullable(), exitCode: z.number().nullable(), retention: z.string() };
const cursorShape = { cursor: count, cursorUnit: z.enum(["bytes", "utf16CodeUnits"]) };

export const outputSchemas = {
  status: z.object({ ready: z.literal(true), opencodeRelease: id, serverPid: z.number().int(), workers: z.array(z.object({ sessionId: id, cwd: id, status: session.shape.status, executionOutcome: z.string().nullable(), outcome, outcomeBasis: z.literal("selectedAssistantMessage"), outcomeEvidence: nativeObject, retry, retryReadError: z.string().nullable(), nextCall }).loose()), pendingActions: z.array(nativeObject), events: nativeObject.optional() }).strict(),
  hostInspect: z.discriminatedUnion("type", [
    z.object({ type: z.enum(["list", "vcsStatus", "vcsBranch", "commands"]), location, ...pageShape, nextCall, shellListScope: z.string().optional(), search: z.string().nullable().optional() }).strict(),
    z.object({ type: z.literal("read"), location, path: id, size: count, fingerprint: id, nextCall, encoding: z.enum(["utf8", "base64"]).optional(), text: z.string().optional(), data: z.string().optional(), cursorUnit: z.literal("bytes").optional(), offset: count.optional(), nextOffset: count.nullable().optional() }).strict(),
    z.object({ type: z.literal("find"), location, data: z.array(z.unknown()), limit: count, possiblyTruncated: z.boolean(), search: z.string(), nextCall }).strict(),
    z.object({ type: z.literal("vcs"), location, info: z.unknown(), base: z.unknown(), nextCall }).strict(),
    z.object({ type: z.literal("vcsDiff"), location, nextCall, ...Object.fromEntries(Object.entries(pageShape).map(([key, schema]) => [key, schema.optional()])), file: id.optional(), additions: count.optional(), deletions: count.optional(), status: z.string().optional(), text: z.string().optional(), textPaging: textPaging.optional(), truncated: z.boolean().optional() }).strict(),
    z.object({ type: z.enum(["terminalScreen", "terminalSnapshot"]), location, nextCall, sessionId: id, available: z.boolean().optional(), id: id.optional(), view: z.enum(["renderedScreen", "renderedSnapshot"]).optional(), size: nativeObject.optional(), screenCursor: nativeObject.optional(), checkpointIncluded: z.literal(false).optional(), text: z.string().optional(), textPaging: textPaging.optional(), truncated: z.boolean().optional(), cwd: id.optional(), status: z.string().optional(), pid: z.number().optional(), exitCode: z.number().nullable().optional(), output: nativeObject.optional() }).strict(),
  ]),
  hostWrite: z.object({ location, path: id, created: z.boolean(), persisted: z.literal(true), size: count, fingerprint: id, atomicCAS: z.literal(false), containment: z.string() }).strict(),
  hostWorktree: z.union([
    z.object({ projectId: id, location, ...pageShape, nextCall }).strict(),
    z.object({ action: z.enum(["create", "remove"]), projectId: id, directory: id, persisted: z.literal(true), removed: z.literal(true).optional() }).strict(),
    z.object({ action: z.literal("refresh"), projectId: id, persisted: z.literal(true), ...pageShape }).strict(),
  ]),
  commandStart: z.object({ ...commandShape, ...cursorShape, signal: z.string().nullable().optional(), time: nativeObject.optional(), sessionId: id.optional(), size: nativeObject.optional(), output: nativeObject.optional() }).strict(),
  commandRead: z.object({ ...commandShape, ...cursorShape, output: z.string().nullable(), drained: z.boolean(), signal: z.string().nullable().optional(), time: nativeObject.optional(), size: z.union([count, nativeObject]).optional(), truncated: z.boolean().optional(), encoding: z.enum(["nativeUtf8", "utf8", "base64"]).optional(), data: z.string().optional(), decodingLimit: z.string().optional(), replayAvailable: z.boolean().optional(), replay: nativeObject.optional(), replayComplete: z.boolean().optional(), inputSent: z.boolean().optional(), detached: z.literal(true).optional(), sessionId: id.optional(), lastConfirmedInfo: nativeObject.optional(), metadataVerified: z.boolean().optional(), metadataReadError: nativeObject.nullable().optional(), handleAvailable: z.boolean().nullable().optional() }).strict(),
  commandControl: z.union([
    z.object({ kind: commandShape.kind, location, id, removed: z.literal(true) }).strict(),
    z.object({ kind: commandShape.kind, location, id, action: z.enum(["input", "interrupt", "ctrlD"]), inputSent: z.boolean(), acknowledged: z.literal(false), delivery: z.string() }).strict(),
    z.object({ kind: commandShape.kind, location, id, cwd: id, status: commandShape.status, pid: z.number(), exitCode: z.number().nullable(), resized: z.literal(true), sessionId: id.optional(), size: nativeObject.optional(), output: nativeObject.optional() }).strict(),
  ]),
  start: z.object({ sessionId: id, messageId: id, cwd: id, model: id, modelVariant: id.nullable(), agent: id, status: z.literal("inProgress") }).strict(),
  wait: z.union([
    z.object({ sessionId: id, messageId: id, state: z.literal("terminal"), wakeReason: z.literal("terminal"), session, result }).strict(),
    z.object({ sessionId: id, messageId: id, state: z.literal("active"), wakeReason: z.enum(["actionRequired", "timeout"]), ...semanticShape }).strict(),
  ]),
  inspect: z.union([z.object({ session, result }).strict(), z.object(semanticShape).strict()]),
  query: z.object({ results: z.array(z.union([
    z.object({ index: count, type: id, result: nativeObject }).strict(),
    z.object({ index: count, type: id, error: z.string(), errorCode: z.string().nullable(), agentId: z.string().nullable() }).strict(),
  ])) }).strict(),
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
    z.object({ action: z.literal("interrupt"), sessionId: id, interrupted: z.boolean() }).strict(),
    z.object({ action: z.literal("respondPermission"), sessionId: id, requestId: id, accepted: z.literal(true) }).strict(),
    z.object({ action: z.literal("respondForm"), sessionId: id, formId: id, accepted: z.literal(true) }).strict(),
    z.object({ action: z.literal("cancelForm"), sessionId: id, formId: id, cancelled: z.literal(true) }).strict(),
    z.object({ action: z.literal("delete"), sessionId: id, deleted: z.literal(true) }).strict(),
  ]),
};
