import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import {
  CODEX_DEFAULT_MODE,
  CODEX_SESSION_MODES,
  DEFAULT_TIMEOUT_MS,
  applySessionMode,
  isCodexSessionMode,
  openCodexConnection,
} from "./codex.js"
import { UsageUnavailableError, readCodexUsage } from "./usage.js"

export const SESSION_RPC_ID = "codex-sessions"
const MAX_OUTPUT = 65_536
const MAX_HISTORY = 128
const MAX_HISTORY_TEXT = 262_144
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
    record.outputTruncated ||= record.output.length + update.content.text.length > MAX_OUTPUT
    record.output += update.content.text.slice(0, Math.max(0, MAX_OUTPUT - record.output.length))
    if (id) record.assistantMessageId = id
  }
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
  const argv = Array.isArray(raw.command) ? raw.command.filter((part) => typeof part === "string") : null
  const truncatedFields = []
  const cut = (field, text, limit) => {
    if (typeof text !== "string") return null
    if (text.length > limit) truncatedFields.push(field)
    return text.slice(0, limit)
  }
  const command = cut("command", argv ? argv.join(" ") : (typeof raw.command === "string" ? raw.command : null), MAX_DETAIL_TEXT)
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
    stopReason: record.stopReason ?? null, assistantMessageId: record.assistantMessageId ?? null,
    output: record.output, outputTruncated: record.outputTruncated,
    completedAtMs: record.completedAtMs ?? null, error: record.error ?? null,
    capabilities: CAPABILITIES, historyComplete: record.historyComplete,
    mode: record.mode ?? null, pendingActions: pendingActions(record),
  }
}

export function createCodexSessions({ open, connect = openCodexConnection, timeoutMs = DEFAULT_TIMEOUT_MS, maxConcurrent = 2, ttlMs = 600_000, maxPendingPermissions = MAX_PENDING_PERMISSIONS, readUsage = readCodexUsage, now = Date.now } = {}) {
  const records = new Map(), locks = new Set()
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
    return { sessionId, cwd, status: "idle", outcome: "unknown", executionKnown: false, output: "", outputTruncated: false, messages: [], historyComplete: true, touched: now(), mode: null, pending: new Map(), waiters: new Set(), maxPending: maxPendingPermissions, now }
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
    let conn
    try { signal.throwIfAborted(); conn = await connection(undefined, onUpdate, signal); return await operation(conn, signal) }
    finally { try { await conn?.close() } finally { controlBusy = false; finish() } }
  }
  async function catalog(conn, input = {}, signal) {
    if (!conn.initialized.agentCapabilities?.sessionCapabilities?.list) throw fail("unsupported", "Codex does not advertise session listing")
    const result = await conn.request("session/list", { ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }, signal)
    return { sessions: result.sessions.map(s => ({ sessionId: identity(s.sessionId), cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt ?? null, runtime: "codex", capabilities: CAPABILITIES })), nextCursor: result.nextCursor ?? null }
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
   * itself select, and `executionKnown` stays false because loading history
   * proves nothing about how a past turn ended.
   */
  async function load(conn, record, signal) {
    if (!conn.initialized.agentCapabilities?.loadSession) throw fail("unsupported", "Codex does not advertise session loading")
    return conn.request("session/load", { sessionId: record.sessionId, cwd: record.cwd, mcpServers: [] }, signal)
  }
  async function recover(sessionId) {
    identity(sessionId); sweep()
    const cached = records.get(sessionId)
    if (cached) { cached.touched = now(); return cached }
    if (locks.has(sessionId)) throw fail("busy", "Session admission is in progress")
    locks.add(sessionId)
    let record
    try {
      await control(async (conn, signal) => {
        const info = await locate(conn, sessionId)
        record = fresh(sessionId, resolveSessionCwd(info.cwd))
        record.title = info.title
        await load(conn, record, signal)
      }, p => { if (record) collect(record, p) })
      const assistants = record.messages.filter(m => m.role === "assistant")
      record.output = assistants.at(-1)?.text ?? ""
      record.outputTruncated = assistants.at(-1)?.truncated ?? false
      record.assistantMessageId = assistants.at(-1)?.id ?? null
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
      record.status = "inProgress"; record.executionKnown = true
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
      return { sessionId: record.sessionId, messageId: null, cwd, runtime: "codex", mode: selected.mode, status: "inProgress", capabilities: CAPABILITIES }
    } catch (error) {
      try { await conn?.close() } finally { active--; if (id) locks.delete(id); if (record?.sessionId) locks.delete(record.sessionId) }
      if (record?.sessionId) throw fail("admission_failed", "Codex session exists; prompt admission must be reconciled before retrying", { sessionId: record.sessionId, promptSubmitted: submitted ? null : false })
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
    const recovered = await recover(sessionId)
    recovered.mode = current?.mode ?? null
    if (current?.executionKnown && current.assistantMessageId === recovered.assistantMessageId) {
      recovered.status = current.status; recovered.outcome = current.outcome; recovered.executionKnown = true
      recovered.output = current.output; recovered.outputTruncated = current.outputTruncated
      recovered.stopReason = current.stopReason; recovered.error = current.error; recovered.completedAtMs = current.completedAtMs
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
      const results = await Promise.allSettled([usageDone, ...operations, ...[...records.values()].filter(r => r.close).map(async r => {
        r.interruptRequested = true
        r.controller?.abort()
        await r.close()
        await r.done
      })])
      if (results.some(result => result.status === "rejected")) throw fail("unavailable", "Codex adapter shutdown failed; details omitted")
    } finally {
      // Settle anything still parked so no caller waits on a dead adapter.
      for (const r of records.values()) { cancelAll(r); notifyWaiters(r) }
    }
  }
  return { start, inspect, wait, interrupt, messages, delete: remove, permissions, respondPermission, usage,
    list: (input, context = {}) => control((conn, signal) => catalog(conn, input, signal), undefined, context.signal),
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
