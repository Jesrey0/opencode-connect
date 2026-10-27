import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import {
  CODEX_DEFAULT_MODE,
  CODEX_SESSION_MODES,
  CodexShutdownError,
  DEFAULT_TIMEOUT_MS,
  applySessionMode,
  isCodexSessionMode,
  openCodexConnection,
} from "./codex.js"
import { UsageUnavailableError, readCodexUsage } from "./usage.js"
import { MAX_OUTCOME_ROWS, createTurnOutcomeReader } from "./outcomes.js"

export const SESSION_RPC_ID = "codex-sessions"
const MAX_OUTPUT = 65_536
const MAX_HISTORY = 128
const MAX_HISTORY_TEXT = 262_144
/** Native turn outcomes are recovered for at most this many catalog rows. */
const MAX_RECOVERED_ROWS = MAX_OUTCOME_ROWS
/** Bounded per-session permission queue. Codex is serial per session, so a
 * small bound is enough to absorb review latency without becoming a sink. */
export const MAX_PENDING_PERMISSIONS = 8
const MAX_PERMISSION_OPTIONS = 16
/** Bounds on the native tool detail an operator reviews before answering. */
const MAX_DETAIL_TEXT = 16_384
const MAX_DETAIL_PATH = 1024
const MAX_DETAIL_LOCATIONS = 32
const ALLOW_OPTION_KINDS = new Set(["allow_once", "allow_always"])
const CAPABILITIES = Object.freeze({
  continuation: true,
  exactPromptWait: false,
  modelSelection: false,
  permissions: "operator-selected",
  events: false,
  modes: CODEX_SESSION_MODES,
  defaultMode: CODEX_DEFAULT_MODE,
  filesystemClient: false,
  terminalClient: false,
  usageQuota: "codex-app-server",
  turnOutcomeHistory: "codex-app-server",
})

export class SessionError extends Error {
  constructor(code, message, data = {}) { super(message); this.code = code; this.data = data }
}
const fail = (code, message, data) => new SessionError(`codex-sessions.${code}`, message, data)

export function resolveSessionCwd(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw fail("invalid_input", "cwd must be an existing absolute directory")
  try {
    const cwd = fs.realpathSync(value)
    if (fs.statSync(cwd).isDirectory()) return cwd
  } catch {}
  throw fail("invalid_input", "cwd must be an existing absolute directory")
}
function identity(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw fail("invalid_input", "sessionId is invalid")
  return value
}
function shortId(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return null
  return value
}
function collect(record, notification) {
  if (notification.sessionId !== record.sessionId) return
  const update = notification.update
  if (update.sessionUpdate === "session_info_update" && typeof update.title === "string") record.title = update.title.slice(0, 512)
  if (!["user_message_chunk", "agent_message_chunk"].includes(update.sessionUpdate) || update.content?.type !== "text") return
  const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
  const id = typeof update.messageId === "string" ? update.messageId : null
  let message = id ? record.messages.find(m => m.id === id) : record.messages.at(-1)
  if (!message || message.role !== role || message.id !== id) {
    message = { id, role, text: "", truncated: false }
    record.messages.push(message)
  }
  const remaining = MAX_OUTPUT - message.text.length
  message.text += update.content.text.slice(0, Math.max(0, remaining))
  message.truncated ||= update.content.text.length > remaining
  while (record.messages.length > MAX_HISTORY || record.messages.reduce((n, m) => n + m.text.length, 0) > MAX_HISTORY_TEXT) {
    record.messages.shift(); record.historyComplete = false
  }
  if (record.status === "inProgress" && role === "assistant") {
    // Result text and its native ID must describe the same assistant message.
    // Earlier messages remain in history; chunks without IDs stay grouped.
    record.output = message.text
    record.outputTruncated = message.truncated
    record.assistantMessageId = id
  }
}

function sameMessage(a, b) {
  return !!a?.id && a.id === b?.id && !a.truncated && !b.truncated && a.role === b.role && a.text === b.text
}

function matchObservedReplay(current, recovered) {
  const context = current?.turnContext
  if (!context?.complete || !recovered.historyComplete || !current.executionKnown || !current.assistantMessageId) return null
  const baseline = context.messages
  if (!baseline.every((message, index) => sameMessage(message, current.messages[index]) && sameMessage(message, recovered.messages[index]))) return null
  const prompt = recovered.messages[baseline.length]
  if (!prompt?.id || prompt.role !== "user" || prompt.text !== context.prompt || prompt.truncated) return null
  const observed = current.messages.slice(baseline.length)
  if (observed[0]?.role === "user") {
    if (!sameMessage(observed[0], prompt)) return null
    observed.shift()
  }
  if (observed.some(message => message.role !== "assistant" || !message.id) || observed.at(-1)?.id !== current.assistantMessageId) return null
  const replayed = recovered.messages.slice(baseline.length + 1)
  if (replayed.length > observed.length || !replayed.every((message, index) => sameMessage(message, observed[index]))) return null
  if (replayed.length === observed.length) return "complete"
  return observed.slice(replayed.length).every(message => !recovered.messages.some(item => item.id === message.id)) ? "partial" : null
}

// Codex asks the ACP client to resolve each approval. This adapter never
// decides on its own: it parks the request, publishes the exact optionIds the
// agent advertised, and resolves it only when the operator names one of them.

function projectOptions(options) {
  if (!Array.isArray(options)) return []
  return options.slice(0, MAX_PERMISSION_OPTIONS).flatMap((option) => {
    const optionId = shortId(option?.optionId)
    if (!optionId) return []
    const name = typeof option?.name === "string" ? option.name.slice(0, 256) : optionId
    const kind = typeof option?.kind === "string" ? option.kind.slice(0, 64) : "unknown"
    return [{ optionId, name, kind }]
  })
}
/**
 * Bounds the native tool detail an operator has to review.
 *
 * Only the fields an operator authorizes on are read: the command, the working
 * directory, the touched paths, the agent's readable summary, and diff headers.
 * The rest of `rawInput` is never copied, so credentials and provider
 * configuration cannot ride along. Every cut is reported, because a silently
 * shortened command would let an operator approve a suffix they never saw.
 */
function projectDetails(toolCall) {
  const call = toolCall && typeof toolCall === "object" && !Array.isArray(toolCall) ? toolCall : {}
  const raw = call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput) ? call.rawInput : {}
  const argv = Array.isArray(raw.command) ? raw.command : null
  const truncatedFields = []
  if (argv?.some((part) => typeof part !== "string")) truncatedFields.push("command")
  const cut = (field, text, limit) => {
    if (typeof text !== "string") return null
    if (text.length > limit) truncatedFields.push(field)
    return text.slice(0, limit)
  }
  // Preserve argument boundaries exactly; never silently omit malformed entries.
  const command = cut("command", argv ? JSON.stringify(argv.map((part) => typeof part === "string" ? part : null)) : (typeof raw.command === "string" ? raw.command : null), MAX_DETAIL_TEXT)
  if (call.kind === "execute" && (!command || (argv && argv.length === 0))) truncatedFields.push("command")
  const cwd = cut("cwd", typeof raw.cwd === "string" ? raw.cwd : null, MAX_DETAIL_PATH)
  // A path cut short is still a path the operator cannot read, so an oversized
  // one marks the whole request unreviewable rather than looking complete.
  const allLocations = Array.isArray(call.locations) ? call.locations : []
  if (allLocations.length > MAX_DETAIL_LOCATIONS) truncatedFields.push("locations")
  const locations = allLocations.flatMap((entry) => (typeof entry?.path === "string" ? [cut("locations", entry.path, MAX_DETAIL_PATH)] : []))
  // ACP tool-call content is a `content`, `diff`, or `terminal` block. An edit
  // approval is only reviewable if the operator can read the actual change, so
  // each diff contributes its own bounded oldText/newText pair. Nothing else in
  // `rawInput` is copied, so credentials and provider configuration stay out.
  const blocks = Array.isArray(call.content) ? call.content : []
  const diffs = blocks.filter((block) => block?.type === "diff" && typeof block?.path === "string" && typeof block?.newText === "string")
  if (diffs.length > MAX_DETAIL_LOCATIONS) truncatedFields.push("diffs")
  const diffPaths = diffs.slice(0, MAX_DETAIL_LOCATIONS).map((block) => cut("diffs", block.path, MAX_DETAIL_PATH))
  const readable = [
    ...blocks.flatMap((block) => (typeof block?.content?.text === "string" ? [block.content.text] : [])),
    ...diffs.slice(0, MAX_DETAIL_LOCATIONS).map((block) => [
      `--- ${block.path}`, `--- old`, block.oldText ?? "", `--- new`, block.newText,
    ].join("\n")),
  ].join("\n")
  const content = cut("content", readable.length > 0 ? readable : null, MAX_DETAIL_TEXT)
  // Every bounded value is computed before the flags are snapshotted, so a cut
  // can never be dropped from the truncation report.
  const fields = [...new Set(truncatedFields)]
  return {
    command,
    cwd,
    locations: locations.slice(0, MAX_DETAIL_LOCATIONS),
    diffs: diffPaths,
    content,
    truncated: fields.length > 0,
    truncatedFields: fields,
  }
}
function projectPending(entry) {
  return {
    requestId: entry.requestId, sessionId: entry.sessionId, action: entry.action,
    resources: entry.details.locations, message: entry.details.content, details: entry.details,
    options: entry.options, reviewable: entry.reviewable, createdAtMs: entry.createdAtMs,
  }
}
function notifyWaiters(record) {
  for (const waiter of [...record.waiters]) waiter()
}
function settle(record, entry, outcome) {
  if (entry.settled) return false
  entry.settled = true
  // Detach the abort listener as soon as the request is answered, so a long turn
  // that raises many requests cannot accumulate listeners on one signal.
  if (entry.onAbort) { entry.signal?.removeEventListener("abort", entry.onAbort); entry.onAbort = null }
  record.pending.delete(entry.requestId)
  entry.resolve(outcome)
  return true
}
function cancelAll(record) {
  for (const entry of [...record.pending.values()]) settle(record, entry, { outcome: { outcome: "cancelled" } })
}
function queuePermission(record, { params, signal }) {
  const advertised = projectOptions(params?.options)
  // Nothing an operator could legitimately select, or a full queue, means the
  // request is cancelled rather than published unanswerable or buffered.
  if (!advertised.length) return Promise.resolve({ outcome: { outcome: "cancelled" } })
  // A request naming another session is never this record's decision to park.
  if (params?.sessionId !== record.sessionId) return Promise.resolve({ outcome: { outcome: "cancelled" } })
  if (record.pending.size >= record.maxPending) return Promise.resolve({ outcome: { outcome: "cancelled" } })
  if (signal?.aborted) return Promise.resolve({ outcome: { outcome: "cancelled" } })
  // Request IDs are globally unique and never reused. A sequential or
  // record-derived ID could be replayed onto a later request after a history
  // refresh or an adapter restart, answering a decision nobody made.
  const requestId = randomUUID()
  const details = projectDetails(params?.toolCall)
  const entry = {
    requestId,
    sessionId: record.sessionId,
    action: typeof params?.toolCall?.title === "string" ? params.toolCall.title.slice(0, 512) : (typeof params?.toolCall?.name === "string" ? params.toolCall.name.slice(0, 256) : "permission"),
    details,
    // Truncated detail cannot be authorized on: the operator would approve a
    // command or diff they cannot read. Rejecting stays available instead.
    reviewable: !details.truncated,
    options: advertised,
    createdAtMs: record.now(),
    settled: false,
    signal: null,
    onAbort: null,
  }
  const settled = new Promise((resolve) => { entry.resolve = resolve })
  // ACP cancels an outstanding request when the turn is cancelled or the
  // connection ends. Mirroring that keeps a decision from outliving its turn.
  if (signal) {
    entry.signal = signal
    entry.onAbort = () => { if (settle(record, entry, { outcome: { outcome: "cancelled" } })) notifyWaiters(record) }
    signal.addEventListener("abort", entry.onAbort, { once: true })
  }
  record.pending.set(requestId, entry)
  notifyWaiters(record)
  return settled
}
function pendingActions(record) {
  return [...record.pending.values()].map(projectPending)
}
function waitable(record, budgetMs, predicate) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled || !predicate()) return
      settled = true
      clearTimeout(timer)
      record.waiters.delete(finish)
      resolve()
    }
    const timer = setTimeout(() => { settled = true; record.waiters.delete(finish); resolve() }, budgetMs)
    timer.unref?.()
    record.waiters.add(finish)
    finish()
  })
}

function view(record) {
  return {
    sessionId: record.sessionId, cwd: record.cwd, runtime: "codex", title: record.title ?? null,
    status: record.status, outcome: record.outcome, executionKnown: record.executionKnown,
    outcomeBasis: record.basis, executionOutcome: executionOutcome(record),
    stopReason: record.stopReason ?? null, assistantMessageId: record.assistantMessageId ?? null,
    output: record.output, outputTruncated: record.outputTruncated,
    completedAtMs: record.completedAtMs ?? null, error: record.error ?? null,
    capabilities: CAPABILITIES, historyComplete: record.historyComplete,
    mode: record.mode ?? null, model: record.model ?? null,
    modelProvider: record.modelProvider ?? null, reasoningEffort: record.reasoningEffort ?? null,
    pendingActions: pendingActions(record),
  }
}

/**
 * Names the authority behind a record's execution state.
 *
 * Three provenances, never blended: the ACP prompt response this adapter
 * supervised, the durable native turn status Codex persisted for a turn it did
 * not supervise, or no evidence at all. Each basis derives its own execution
 * outcome, so recovered history is never reported as an observed prompt and an
 * absent prompt response is never reported as native status.
 */
function executionOutcome(record) {
  if (record.basis === "nativeTurnHistory") return record.turn?.executionOutcome ?? null
  if (record.basis !== "nativePromptResponse") return null
  return record.stopReason ?? (record.status === "failed" ? "failed" : null)
}

/**
 * Applies one recovered native turn to a record.
 *
 * Only a terminal native status is applied, and only to a record that has no
 * prompt-response evidence of its own: a supervised turn's ACP response is
 * stronger evidence than a later read of the same thread, so it is never
 * overwritten here. Anything else leaves the record untouched and unknown.
 */
const THREAD_METADATA = ["model", "modelProvider", "reasoningEffort"]
function applyThreadMetadata(target, evidence) {
  if (!evidence) return
  for (const field of THREAD_METADATA) if (evidence[field] != null) target[field] = evidence[field]
}
function applyTurnEvidence(record, evidence) {
  applyThreadMetadata(record, evidence)
  if (!evidence?.status || record.executionKnown) return
  record.basis = "nativeTurnHistory"
  record.turn = evidence
  record.executionKnown = true
  record.status = evidence.status
  record.outcome = evidence.outcome
  record.error = evidence.error
}

export function createCodexSessions({ open, connect = openCodexConnection, timeoutMs = DEFAULT_TIMEOUT_MS, maxConcurrent = 2, ttlMs = 600_000, maxPendingPermissions = MAX_PENDING_PERMISSIONS, readUsage = readCodexUsage, readTurnOutcomes = createTurnOutcomeReader(), now = Date.now } = {}) {
  const records = new Map(), locks = new Set()
  const failedClosers = new Set()
  const lifecycle = new AbortController(), operations = new Set()
  function trackOperation() {
    let finish
    const done = new Promise(resolve => { finish = resolve })
    operations.add(done)
    return () => { operations.delete(done); finish() }
  }
  let active = 0, controlBusy = false, usageBusy = false, disposed = false
  let usageController, usageDone
  function sweep() {
    for (const [id, r] of records) if (!locks.has(id) && now() - r.touched > ttlMs) records.delete(id)
    for (const [id] of records) { if (records.size <= 64) break; if (!locks.has(id)) records.delete(id) }
  }
  function remember(record) { record.touched = now(); records.set(record.sessionId, record); sweep(); return record }
  function fresh(sessionId, cwd) {
    return { sessionId, cwd, status: "idle", outcome: "unknown", executionKnown: false, basis: "historyReplay", turn: null, output: "", outputTruncated: false, messages: [], historyComplete: true, touched: now(), mode: null, model: null, modelProvider: null, reasoningEffort: null, pending: new Map(), waiters: new Set(), maxPending: maxPendingPermissions, now }
  }
  async function connection(cwd, onUpdate, signal, onPermission) {
    if (disposed) throw fail("unavailable", "Codex session adapter is closed")
    return connect({ open, cwd, onUpdate, signal, onPermission })
  }
  async function control(operation, onUpdate, callerSignal) {
    if (controlBusy) throw fail("busy", "A Codex metadata read is already in progress")
    controlBusy = true
    const finish = trackOperation()
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), lifecycle.signal, ...(callerSignal ? [callerSignal] : [])])
    let conn, cleanupFailed = false
    try { signal.throwIfAborted(); conn = await connection(undefined, onUpdate, signal); return await operation(conn, signal) }
    catch (error) {
      if (error instanceof CodexShutdownError) { failedClosers.add(error.close); cleanupFailed = true }
      throw error
    } finally {
      try { await conn?.close() }
      catch {
        failedClosers.add(() => conn.close())
        cleanupFailed = true
        throw fail("unavailable", "Codex transport shutdown failed; details omitted")
      } finally {
        if (!cleanupFailed) controlBusy = false
        finish()
      }
    }
  }
  async function catalog(conn, input = {}, signal) {
    if (!conn.initialized.agentCapabilities?.sessionCapabilities?.list) throw fail("unsupported", "Codex does not advertise session listing")
    const result = await conn.request("session/list", { ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }, signal)
    return { sessions: result.sessions.map(s => {
      const local = records.get(s.sessionId)
      return {
        sessionId: identity(s.sessionId), cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt ?? null,
        runtime: "codex", capabilities: CAPABILITIES, mode: local?.mode ?? null,
        model: local?.model ?? null, modelProvider: local?.modelProvider ?? null,
        reasoningEffort: local?.reasoningEffort ?? null,
      }
    }), nextCursor: result.nextCursor ?? null }
  }
  async function locate(conn, sessionId) {
    let cursor
    for (let page = 0; page < 32; page++) {
      const listing = await catalog(conn, { cursor })
      const found = listing.sessions.find(s => s.sessionId === sessionId)
      if (found) return found
      if (!listing.nextCursor) throw fail("unknown_session", "Native Codex session was not found", { sessionId, catalogComplete: true })
      if (listing.nextCursor === cursor) break
      cursor = listing.nextCursor
    }
    throw fail("unavailable", "Codex session lookup exceeded its bounded catalog scan")
  }
  /**
   * Loads native history into a record.
   *
   * This deliberately asserts nothing about the execution envelope. Codex
   * resets a loaded session to its initial mode, so `modes.currentModeId` here
   * describes a transient post-load state, not the mode the session ran under.
   * The record therefore keeps its own mode and never claims one it did not
   * itself select.
   */
  async function load(conn, record, signal) {
    if (!conn.initialized.agentCapabilities?.loadSession) throw fail("unsupported", "Codex does not advertise session loading")
    return conn.request("session/load", { sessionId: record.sessionId, cwd: record.cwd, mcpServers: [] }, signal)
  }
  /**
   * Recovers persisted settings and how the newest native turn ended.
   *
   * ACP history alone proves nothing about a turn's termination, so the outcome
   * comes from Codex's own durable turn status instead. The read is bounded,
   * batched and read-only, and it holds no session lock, so it never blocks
   * execution. A read that fails, is cancelled, or finds nothing leaves the
   * record unknown rather than guessing an outcome. Settings alone never make
   * execution known.
   */
  async function recoverOutcomes(ids, signal, revisions = {}) {
    if (disposed || ids.length === 0) return new Map()
    try {
      return await readTurnOutcomes.read(ids, { signal, revisions }) ?? new Map()
    } catch {
      // A read failure is evidence of nothing. It must not become an outcome.
      return new Map()
    }
  }
  /**
   * Attaches native thread metadata and terminal evidence to catalog rows.
   *
   * A row the adapter supervises keeps its own ACP evidence, and only a bounded
   * prefix of a page is read at all, so one native batch serves a page instead of
   * one process per displayed row. Rows without evidence are returned exactly as
   * the native catalog described them.
   */
  async function enrich(rows, signal) {
    const targets = rows.slice(0, MAX_RECOVERED_ROWS)
    if (targets.length === 0) return
    const evidence = await recoverOutcomes(targets.map(row => row.sessionId), signal,
      Object.fromEntries(targets.map(row => [row.sessionId, row.updatedAt ?? null])))
    for (const row of targets) {
      const turn = evidence.get(row.sessionId)
      if (!turn) continue
      applyThreadMetadata(row, turn)
      const local = records.get(row.sessionId)
      if (local) applyThreadMetadata(local, turn)
      if (!turn.status || local?.executionKnown) continue
      Object.assign(row, {
        status: turn.status, outcome: turn.outcome, executionKnown: true,
        outcomeBasis: "nativeTurnHistory", executionOutcome: turn.executionOutcome, error: turn.error,
      })
    }
  }
  async function recover(sessionId) {
    identity(sessionId); sweep()
    const cached = records.get(sessionId)
    if (cached) { cached.touched = now(); return cached }
    if (locks.has(sessionId)) throw fail("busy", "Session admission is in progress")
    locks.add(sessionId)
    let record, updatedAt = null
    try {
      await control(async (conn, signal) => {
        const info = await locate(conn, sessionId)
        updatedAt = info.updatedAt ?? null
        record = fresh(sessionId, resolveSessionCwd(info.cwd))
        record.title = info.title
        await load(conn, record, signal)
      }, p => { if (record) collect(record, p) })
      const assistants = record.messages.filter(m => m.role === "assistant")
      record.output = assistants.at(-1)?.text ?? ""
      record.outputTruncated = assistants.at(-1)?.truncated ?? false
      record.assistantMessageId = assistants.at(-1)?.id ?? null
      // Read the outcome after the ACP metadata connection is released: the
      // native read is a separate bounded transport and must not extend it.
      applyTurnEvidence(record, (await recoverOutcomes([record.sessionId], undefined,
        { [record.sessionId]: updatedAt })).get(record.sessionId))
      return remember(record)
    } finally { locks.delete(sessionId) }
  }
  /**
   * Resolves the session mode for one admitted turn.
   *
   * A fresh session uses the documented default. A continuation must either
   * name a mode explicitly or inherit the mode this adapter itself applied and
   * still remembers. Recovery never yields a mode: after a restart or cache
   * eviction there is no evidence of the mode the conversation ran under, and
   * guessing would silently widen the sandbox.
   */
  function resolveMode(input, previous) {
    if (input.mode !== undefined && !isCodexSessionMode(input.mode))
      throw fail("invalid_input", `mode must be one of ${CODEX_SESSION_MODES.map(m => m.id).join(", ")}`)
    if (input.mode !== undefined) return { mode: input.mode, inherited: false }
    if (!input.sessionId) return { mode: CODEX_DEFAULT_MODE, inherited: false }
    if (previous?.mode) return { mode: previous.mode, inherited: true }
    throw fail(
      "mode_required",
      "This session's Codex mode is not recoverable after an adapter restart; pass mode explicitly. " +
        "Omitting it would silently select a sandbox the session did not previously run under.",
      { sessionId: input.sessionId, recoverable: false, modes: CODEX_SESSION_MODES.map(m => m.id) },
    )
  }
  async function start(input = {}) {
    if (disposed) throw fail("unavailable", "Codex session adapter is closed")
    if (typeof input.task !== "string" || !input.task.trim() || Buffer.byteLength(input.task) > MAX_OUTPUT) throw fail("invalid_input", "task must be nonempty and at most 64 KiB")
    if (input.sessionId && input.cwd) throw fail("invalid_input", "Continuation inherits cwd")
    if (!input.sessionId && !input.cwd) throw fail("invalid_input", "Fresh work requires cwd")
    const id = input.sessionId ? identity(input.sessionId) : undefined
    if (id && locks.has(id)) throw fail("busy", "Session is already running; interrupt it before continuing")
    if (active >= maxConcurrent) throw fail("busy", "Codex execution capacity is in use")
    active++
    const finish = trackOperation()
    if (id) locks.add(id)
    const admissionSignal = AbortSignal.any([AbortSignal.timeout(30_000), lifecycle.signal])
    let conn, record, submitted = false
    try {
      const old = id ? records.get(id) : undefined
      // Mode is resolved before any admission so an unrecoverable continuation
      // never opens a connection or creates a native session.
      const selected = resolveMode(input, old)
      let cwd = old?.cwd
      if (id && !cwd) cwd = await control(async c => (await locate(c, id)).cwd)
      cwd = resolveSessionCwd(cwd ?? input.cwd)
      record = fresh(id ?? "", cwd)
      record.mode = selected.mode
      applyThreadMetadata(record, old)
      conn = await connection(cwd, p => collect(record, p), admissionSignal, request => queuePermission(record, request))
      // Codex resets a loaded session to its initial mode, so the selected mode
      // is reapplied on every turn, including the very first one after a load.
      let modes
      if (id) modes = (await load(conn, record, admissionSignal)).modes
      else {
        const created = await conn.request("session/new", { cwd, mcpServers: [] }, admissionSignal)
        record.sessionId = identity(created.sessionId)
        locks.add(record.sessionId)
        modes = created.modes
      }
      await applySessionMode(null, record.sessionId, selected.mode, modes, { call: (_client, method, params) => conn.request(method, params, admissionSignal) })
      admissionSignal.throwIfAborted()
      // Retain the exact observed baseline and prompt so a later partial
      // history replay cannot be confused with an edited conversation.
      record.turnContext = { complete: record.historyComplete, messages: record.messages.map(message => ({ ...message })), prompt: input.task }
      record.status = "inProgress"; record.executionKnown = true; record.basis = "nativePromptResponse"
      record.close = () => conn.close()
      record.conn = conn
      remember(record)
      const controller = new AbortController()
      record.controller = controller
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void interrupt({ sessionId: record.sessionId }).catch(() => {})
      }, timeoutMs)
      timer.unref?.()
      submitted = true
      record.done = conn.request("session/prompt", { sessionId: record.sessionId, prompt: [{ type: "text", text: input.task }] }, controller.signal).then(
        result => {
          record.stopReason = result.stopReason
          record.status = result.stopReason === "cancelled" ? "interrupted" : "completed"
          record.outcome = result.stopReason === "end_turn" ? "completed" : "incomplete"
        },
        () => { record.status = record.interruptRequested ? "interrupted" : "failed"; record.outcome = record.interruptRequested ? "incomplete" : "failed"; record.error = { type: "codex-sessions.turn_failed", messageOmitted: true } },
      ).finally(async () => {
        clearTimeout(timer)
        // A turn that ended, failed or timed out owns no live decision. Cancel
        // anything still parked so no permission promise outlives its turn.
        cancelAll(record)
        if (timedOut) { record.status = "failed"; record.outcome = "failed"; record.error = { type: "codex-sessions.timeout", messageOmitted: true } }
        record.completedAtMs = now(); record.touched = now()
        notifyWaiters(record)
        // Cleanup is inside record.done, so a terminal wait that awaits it also
        // waits for the ACP process to be gone. The admission lock is released
        // only here, so nothing downstream can observe a still-live writer.
        try {
          await conn.close()
          active--; locks.delete(record.sessionId); delete record.conn; delete record.controller; delete record.close
        } catch {
          // An unreaped writer cannot be declared completed or readmitted.
          // Retain its lock/capacity and surface only fixed failure evidence.
          record.status = "failed"; record.outcome = "failed"
          record.error = { type: "codex-sessions.shutdown_failed", messageOmitted: true }
          notifyWaiters(record)
          throw fail("unavailable", "Codex transport shutdown failed; details omitted")
        }
      })
      // Keep supervision attached even when an RPC caller disconnects.
      void record.done.catch(() => {})
      return {
        sessionId: record.sessionId, messageId: null, cwd, runtime: "codex", mode: selected.mode,
        model: record.model, modelProvider: record.modelProvider, reasoningEffort: record.reasoningEffort,
        status: "inProgress", capabilities: CAPABILITIES,
      }
    } catch (error) {
      let cleanupFailed = error instanceof CodexShutdownError
      if (cleanupFailed) failedClosers.add(error.close)
      try { await conn?.close() }
      catch { failedClosers.add(() => conn.close()); cleanupFailed = true }
      // Admission owns a child before it owns a prompt. A failed close retains
      // that capacity and any known session lock, just like turn cleanup does.
      if (!cleanupFailed) { active--; if (id) locks.delete(id); if (record?.sessionId) locks.delete(record.sessionId) }
      if (record?.sessionId) throw fail("admission_failed", "Codex session exists; prompt admission must be reconciled before retrying", { sessionId: record.sessionId, promptSubmitted: submitted ? null : false, ...(cleanupFailed ? { cleanupFailed: true } : {}) })
      if (cleanupFailed) throw fail("unavailable", "Codex transport shutdown failed; details omitted")
      throw error
    } finally { finish() }
  }
  async function inspect({ sessionId }) { return view(await recover(sessionId)) }
  async function wait({ sessionId, waitMs = 40_000 }) {
    const record = await recover(sessionId)
    const budget = Math.min(40_000, Math.max(1, waitMs))
    if (record.status === "inProgress" && record.done) {
      // Wake on terminal execution or on an actionable decision, so a parked
      // approval surfaces promptly instead of hiding behind the whole timeout.
      let timer
      try {
        await Promise.race([
          record.done.catch(() => {}),
          waitable(record, budget, () => record.pending.size > 0 || record.status !== "inProgress"),
          new Promise(resolve => { timer = setTimeout(resolve, budget) }),
        ])
      } finally { clearTimeout(timer) }
    }
    // A terminal claim must also mean the turn's owned ACP process is gone and
    // the admission lock is released. Without this a caller could delete a
    // session while its writer was still shutting down.
    if (record.pending.size === 0 && record.status !== "inProgress" && record.done) await record.done.catch(() => {})
    return { ...view(record), wakeReason: record.pending.size > 0 ? "actionRequired" : record.status !== "inProgress" ? "terminal" : "timeout" }
  }
  async function interrupt({ sessionId }) {
    identity(sessionId)
    const record = records.get(sessionId)
    if (!record) throw fail("unavailable", "No locally supervised execution is available to interrupt; inspect native history")
    if (record.status !== "inProgress") return { sessionId, interrupted: false, status: record.status }
    record.interruptRequested = true
    await record.conn.notify("session/cancel", { sessionId })
    let timer
    try { await Promise.race([record.done, new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) }
    finally { clearTimeout(timer) }
    if (record.status === "inProgress") {
      record.controller.abort()
      await record.close()
      await record.done
    }
    // Cancellation must not leave a parked decision resolvable forever.
    cancelAll(record)
    notifyWaiters(record)
    return { sessionId, interrupted: record.status === "interrupted", status: record.status }
  }
  async function messages({ sessionId }) {
    const current = records.get(identity(sessionId))
    if (current?.status === "inProgress") return { sessionId, messages: current.messages, historyComplete: false }
    // Finish owned transport cleanup before replacing cached execution evidence.
    if (current?.done) await current.done.catch(() => {})
    // Read native history again so canonical user IDs and changes by other clients are visible.
    records.delete(sessionId)
    let recovered
    try { recovered = await recover(sessionId) }
    catch (error) {
      // A read failure must not erase locally verified mode or execution evidence.
      if (current && !records.has(sessionId)) records.set(sessionId, current)
      throw error
    }
    recovered.mode = current?.mode ?? null
    applyThreadMetadata(recovered, current)
    // Match the full retained baseline, prompt and streamed assistant messages
    // before carrying supervised evidence into any native history replay.
    const match = matchObservedReplay(current, recovered)
    if (match === "partial") {
      current.historyComplete = false
      remember(current)
      return { sessionId, messages: recovered.messages, historyComplete: false }
    }
    if (match === "complete") {
      recovered.status = current.status; recovered.outcome = current.outcome; recovered.executionKnown = true
      recovered.basis = current.basis; recovered.turn = current.turn
      recovered.output = current.output; recovered.outputTruncated = current.outputTruncated
      recovered.stopReason = current.stopReason; recovered.error = current.error; recovered.completedAtMs = current.completedAtMs
      recovered.turnContext = current.turnContext
    }
    return { sessionId, messages: recovered.messages, historyComplete: recovered.historyComplete }
  }
  async function permissions({ sessionId }) {
    identity(sessionId)
    const record = records.get(sessionId)
    if (!record) return { sessionId, mode: null, modeKnown: false, pendingActions: [], capabilities: CAPABILITIES }
    remember(record)
    return { sessionId, mode: record.mode ?? null, modeKnown: record.mode != null, pendingActions: pendingActions(record), capabilities: CAPABILITIES }
  }
  /**
   * Answers exactly one parked permission request with exactly one option the
   * agent advertised. Unknown, already-settled, and cross-session request IDs
   * all fail; nothing is inferred from a partial match.
   */
  async function respondPermission({ sessionId, requestId, optionId }) {
    identity(sessionId)
    const record = records.get(sessionId)
    if (!record) throw fail("unavailable", "No locally supervised Codex session is available to answer")
    const rid = typeof requestId === "string" ? requestId : ""
    const oid = typeof optionId === "string" ? optionId : ""
    if (!rid) throw fail("invalid_input", "requestId is required")
    if (!oid) throw fail("invalid_input", "optionId is required")
    const entry = record.pending.get(rid)
    if (!entry) throw fail("unknown_request", "That Codex permission request is unknown, already answered, or belongs to a different session", { sessionId, requestId: rid })
    if (!entry.options.some(option => option.optionId === oid))
      throw fail("unknown_option", "optionId is not one of the options Codex advertised for this request", { sessionId, requestId: rid, optionId: oid, options: entry.options.map(o => o.optionId) })
    if (!entry.reviewable && ALLOW_OPTION_KINDS.has(entry.options.find(o => o.optionId === oid).kind))
      throw fail("unreviewable_request", "Codex truncated this request's tool detail, so it cannot be approved; answer with a rejecting option instead", { sessionId, requestId: rid, optionId: oid, truncatedFields: entry.details.truncatedFields })
    settle(record, entry, { outcome: { outcome: "selected", optionId: oid } })
    record.touched = now()
    notifyWaiters(record)
    return { sessionId, requestId: rid, optionId: oid, accepted: true, pendingActions: pendingActions(record) }
  }
  /**
   * Reads one sanitized ChatGPT Codex quota snapshot.
   *
   * This runs no session and opens no ACP connection. The quota lives in the
   * Codex app-server, so a short-lived read-only app-server client is spawned
   * for this call alone and torn down when it returns. Nothing is requested
   * from a model, so the read cannot consume the quota it reports on.
   *
   * It is serialized against itself but not against session execution: a quota
   * read opens no thread and holds no session lock, so it never blocks a turn.
   */
  async function usage(_input, context = {}) {
    if (disposed) throw fail("unavailable", "Codex session adapter is closed")
    if (usageBusy) throw fail("busy", "A Codex quota read is already in progress")
    usageBusy = true
    usageController = new AbortController()
    const signal = context.signal ? AbortSignal.any([context.signal, usageController.signal]) : usageController.signal
    let complete
    usageDone = new Promise(resolve => { complete = resolve })
    try {
      signal.throwIfAborted()
      const snapshot = await readUsage({ signal })
      signal.throwIfAborted()
      return { ...snapshot, capabilities: CAPABILITIES }
    } catch (error) {
      // A refusal carries its own code; anything else is reported as an
      // unavailable read with no upstream body, so no provider detail or
      // credential-derived text can reach the caller.
      if (error instanceof UsageUnavailableError) {
        throw fail(error.code === "unsupported" ? "unsupported" : "unavailable", "The Codex quota read is unavailable; details omitted")
      }
      throw fail("unavailable", "The Codex quota read failed")
    } finally {
      usageBusy = false
      usageController = undefined
      complete()
    }
  }
  async function remove({ sessionId }) {
    identity(sessionId)
    const record = records.get(sessionId)
    // These are authoritative only for locally supervised work. ACP's native
    // catalog has no execution/approval state; absence of local evidence does
    // not establish that another client has no live writer.
    if (record?.pending.size) throw fail("delete_pending_approval", "Resolve pending approvals before deleting the session", { sessionId })
    if (record?.status === "inProgress" || locks.has(sessionId)) throw fail("delete_active", "Interrupt execution before deleting the session", { sessionId })
    locks.add(sessionId)
    let mutationAttempted = false, deleteAcknowledged = false, absenceVerified = false
    const unverified = reason => fail("delete_unverified", "Codex session deletion could not be verified; reconcile native state before retrying", {
      sessionId, mutationAttempted, mutationUncertain: mutationAttempted, deleteAcknowledged, absenceVerified, reason,
    })
    try {
      await control(async conn => {
        if (!conn.initialized.agentCapabilities?.sessionCapabilities?.delete) throw fail("unsupported", "Codex does not advertise session deletion")
        // Refuse before mutation if the native catalog cannot verify its result.
        if (!conn.initialized.agentCapabilities?.sessionCapabilities?.list) throw fail("unsupported", "Codex does not advertise session listing required for deletion verification")
        try {
          await locate(conn, sessionId)
        } catch (error) {
          // Only a complete native catalog scan establishes pre-mutation
          // absence. Delete-request errors below never take this path.
          if (error instanceof SessionError && error.code === "codex-sessions.unknown_session" && error.data?.catalogComplete === true) throw error
          throw unverified("preflight_failed")
        }
        mutationAttempted = true
        await conn.request("session/delete", { sessionId })
        deleteAcknowledged = true
        try {
          await locate(conn, sessionId)
        } catch (error) {
          // Only exhaustion of a complete native catalog proves absence. A
          // request failure, repeated cursor or scan limit is not that proof.
          if (error instanceof SessionError && error.code === "codex-sessions.unknown_session" && error.data?.catalogComplete === true) {
            absenceVerified = true
            return
          }
          throw unverified("verification_failed")
        }
        throw unverified("session_present")
      })
      records.delete(sessionId)
      return { sessionId, deleted: true }
    } catch (error) {
      if (error instanceof SessionError && error.code === "codex-sessions.delete_unverified") throw error
      // Even a rejected request may have mutated native state. Never forward
      // transport/provider bodies, or discard cached evidence on uncertainty.
      if (mutationAttempted) throw unverified(deleteAcknowledged ? "verification_failed" : "delete_failed")
      throw error
    } finally { locks.delete(sessionId) }
  }
  async function dispose() {
    disposed = true
    lifecycle.abort()
    usageController?.abort()
    try {
      const results = await Promise.allSettled([usageDone, readTurnOutcomes.dispose?.(), ...operations, ...[...records.values()].filter(r => r.close).map(async r => {
        r.interruptRequested = true
        r.controller?.abort()
        await r.close()
        await r.done
      })])
      // An in-flight admission can retain its closer while disposal waits for
      // operations above, so collect these only after those operations settle.
      const cleanup = await Promise.allSettled([...failedClosers].map(close => close()))
      if ([...results, ...cleanup].some(result => result.status === "rejected")) throw fail("unavailable", "Codex adapter shutdown failed; details omitted")
      failedClosers.clear()
    } finally {
      // Settle anything still parked so no caller waits on a dead adapter.
      for (const r of records.values()) { cancelAll(r); notifyWaiters(r) }
    }
  }
  /**
   * Lists native sessions and recovers what is knowable about each turn.
   *
   * The ACP catalog page is read first and its connection is released before
   * any native outcome read begins, so a slow or failing history read can only
   * cost its own bounded budget. Every failure degrades to the plain catalog row.
   */
  async function list(input, context = {}) {
    const page = await control((conn, signal) => catalog(conn, input, signal), undefined, context.signal)
    await enrich(page.sessions, context.signal)
    return page
  }
  return { start, inspect, wait, interrupt, messages, delete: remove, permissions, respondPermission, usage,
    list,
    status: () => ({ sessions: [...records.values()].map(r => ({ ...view(r), output: "" })), capabilities: CAPABILITIES, pendingActions: [...records.values()].flatMap(pendingActions) }), dispose }
}

const id = Schema.String
const mode = Schema.Literals(CODEX_SESSION_MODES.map(m => m.id))
const errors = Object.fromEntries(["invalid_input", "busy", "unsupported", "unknown_session", "unknown_request", "unknown_option", "unreviewable_request", "mode_required", "unavailable", "admission_failed", "delete_active", "delete_pending_approval", "delete_unverified", "internal"].map(code => [`codex-sessions.${code}`, { type: "object", additionalProperties: true }]))
const method = input => ({ input, output: { type: "object", additionalProperties: true }, errors })
export const CodexSessionsRpc = Rpc.define({ id: SESSION_RPC_ID, methods: {
  start: method(Schema.Struct({ task: id, cwd: Schema.optionalKey(id), sessionId: Schema.optionalKey(id), mode: Schema.optionalKey(mode) })),
  inspect: method(Schema.Struct({ sessionId: id })),
  wait: method(Schema.Struct({ sessionId: id, waitMs: Schema.optionalKey(Schema.Number) })),
  interrupt: method(Schema.Struct({ sessionId: id })),
  delete: method(Schema.Struct({ sessionId: id })),
  messages: method(Schema.Struct({ sessionId: id })),
  permissions: method(Schema.Struct({ sessionId: id })),
  respondPermission: method(Schema.Struct({ sessionId: id, requestId: id, optionId: id })),
  list: method(Schema.Struct({ cwd: Schema.optionalKey(id), cursor: Schema.optionalKey(id) })),
  // No input: a quota read takes no session, no path, and no options, so it
  // has no surface on which a caller could steer it.
  usage: method(Schema.Struct({})),
  status: method(Schema.Struct({})),
}, events: {} })
export async function installCodexSessionsRpc(ctx, deps) {
  const sessions = deps.sessions ?? createCodexSessions(deps)
  const handlers = Object.fromEntries(Object.keys(CodexSessionsRpc.methods).map(name => [name, async (input, context) => {
    try { return await sessions[name](input, context) }
    catch (error) { return context.error(error instanceof SessionError ? error.code : "codex-sessions.internal", "Codex session operation failed", error instanceof SessionError ? error.data : {}) }
  }]))
  const registration = await ctx.rpc.register(CodexSessionsRpc, handlers)
  return { dispose: async () => { try { await registration.dispose() } finally { await sessions.dispose() } } }
}
