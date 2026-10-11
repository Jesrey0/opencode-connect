/**
 * Historical Codex turn outcomes from durable native history.
 *
 * This module answers exactly one question: how did the most recent turn of a
 * native Codex thread end, when this adapter did not supervise that turn?
 *
 * What it is
 * ----------
 * ACP remains the execution protocol. `codex-acp` creates each ACP session
 * with `thread/start` and returns `response.thread.id` as the ACP `sessionId`;
 * it resumes the same identity with `threadId: request.sessionId` and lists
 * `thread.id` as `sessionId`. An ACP session ID is therefore a Codex thread ID,
 * byte for byte, and the durable record of how a turn ended lives in Codex's
 * own App Server history:
 *
 *   thread/read       -> { thread: { id, ... } }
 *   thread/turns/list -> { data: [{ id, status, items, error, completedAt }],
 *                         nextCursor }
 *
 *   status is one of `completed`, `interrupted`, `failed`, `inProgress`.
 *
 * What it is not
 * --------------
 * This is not a second execution path and not a live event feed. No turn is
 * started, resumed, or steered; nothing is written. It reads the status Codex
 * itself persisted when a turn ended, which is authoritative precisely because
 * it is not this module's inference.
 *
 * Safety envelope
 * ---------------
 * - **Read methods only.** `thread/read` and `thread/turns/list` are named in
 *   this reader's allowlist and nothing else can leave the process. The shared
 *   transport (`app-server.js`) refuses every other method, including
 *   `thread/start`, `thread/resume`, and `turn/start`.
 * - **Fixed parameters.** `thread/read` asks for no turns, and
 *   `thread/turns/list` asks for one newest turn with items unloaded, so a
 *   thread with thousands of items cannot inflate a single read.
 * - **Strict identity.** `thread/read` echoes the resolved thread; its `id`
 *   must equal the requested ID exactly. Anything else - a mismatch, a
 *   missing echo, an unreadable payload - yields no evidence rather than a
 *   guess. If an ACP session ID were ever not a thread ID, every read here
 *   fails closed.
 * - **No timestamps.** `completedAt` is not projected. Its unit is not stated
 *   by the protocol this reader speaks, and normalizing it by magnitude would
 *   be a guess about time rather than evidence about time.
 * - **No error bodies.** A failed turn carries a fixed local error type; the
 *   native `error` payload is never read, because it can contain provider text.
 * - **Terminal evidence only.** An `inProgress` turn is not an outcome. This
 *   adapter holds no writer for a turn it did not start, so it cannot wait on
 *   or interrupt one, and it reports no outcome rather than a provisional one.
 * - **Bounded and batched.** One short-lived child serves a whole batch, ids
 *   are deduplicated and cached, concurrent readers collapse onto one batch,
 *   and a failed read backs off instead of respawning on every call.
 */

import { AppServerUnavailableError, spawnCodexAppServer } from "./app-server.js"

/** Bounded budget for one batch of outcome reads. */
export const DEFAULT_OUTCOME_TIMEOUT_MS = 5_000

/** Hard ceiling on one batch regardless of configuration. */
export const MAX_OUTCOME_TIMEOUT_MS = 30_000

/** One displayed row is one request pair; a page is bounded, never unbounded. */
export const MAX_OUTCOME_ROWS = 25

/** Requests in flight to one app-server child. */
export const MAX_OUTCOME_CONCURRENCY = 4

/** How long a terminal outcome stays usable without re-reading history. */
export const OUTCOME_CACHE_TTL_MS = 5 * 60_000

/** Short pause after a failed batch, so repeated reads cannot respawn a child. */
export const OUTCOME_RETRY_BACKOFF_MS = 30_000

/** Bounds the evidence cache; the dashboard shows a page, not a history. */
const MAX_CACHE_ENTRIES = 256

/** The complete set of requests this reader may ever send. */
export const OUTCOME_REQUESTS = Object.freeze(["thread/read", "thread/turns/list"])

/** Bounds a caller-supplied batch budget into the enforced window. */
export function boundOutcomeTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_OUTCOME_TIMEOUT_MS
  return Math.min(MAX_OUTCOME_TIMEOUT_MS, timeoutMs)
}

/** Native identity bound; the same rule the ACP boundary applies. */
function boundedId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : null
}

/**
 * Ends a request that outlives its batch.
 *
 * A read is bounded by the caller's cancellation and by this reader's own
 * budget, so a transport that simply never answers cannot hold the batch - or
 * the metadata reads queued behind it - open indefinitely. The transport is torn
 * down by the batch regardless; this only refuses to keep waiting for it.
 */
async function bounded(signal, operation) {
  if (signal.aborted) throw new AppServerUnavailableError("The Codex outcome read was cancelled before it completed.", { code: "cancelled" })
  let onAbort
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        onAbort = () => reject(new AppServerUnavailableError("The Codex outcome read was cancelled before it completed.", { code: "cancelled" }))
        signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Builds the exact parameter object for each permitted method.
 *
 * `thread/read` runs with `includeTurns: false` so identity is confirmed
 * without materializing history, and `thread/turns/list` asks for exactly one
 * newest turn with its items unloaded. A thread ID that is not a bounded native
 * identity is refused here, before anything is written.
 */
export function buildTurnParams(method, args) {
  const threadId = boundedId(args?.threadId)
  if (!threadId)
    throw new AppServerUnavailableError("Refusing a Codex turn read without one bounded native thread identity.", { code: "invalid_input" })
  if (method === "thread/read") return { threadId, includeTurns: false }
  return { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }
}

/**
 * The fixed local error for a turn Codex reports as failed.
 *
 * The native `error` payload is deliberately not read, so this is the only
 * error evidence a recovered failure carries.
 */
export const TURN_FAILED_ERROR = Object.freeze({ type: "codex-sessions.turn_failed", messageOmitted: true })

/**
 * How each terminal native turn status becomes an execution outcome.
 *
 * `inProgress` is absent on purpose: an unfinished turn has no outcome, and
 * this adapter cannot supervise a turn it did not start.
 */
const TERMINAL_TURNS = Object.freeze({
  completed: Object.freeze({ status: "completed", outcome: "completed", executionOutcome: "completed", error: null }),
  failed: Object.freeze({ status: "failed", outcome: "failed", executionOutcome: "failed", error: TURN_FAILED_ERROR }),
  interrupted: Object.freeze({ status: "interrupted", outcome: "incomplete", executionOutcome: "interrupted", error: null }),
})

/**
 * Projects one `thread/turns/list` page into recovered evidence.
 *
 * Total by construction: an unreadable payload, a page without a turn, or a
 * turn this adapter cannot correlate to a native ID all produce `null`, which
 * the caller reads as "no outcome evidence". `completedAt` is intentionally
 * dropped; see the module envelope.
 *
 * @param {unknown} result `thread/turns/list` result.
 * @param {string} threadId The identity the read was requested for.
 * @returns {{threadId: string, turnId: string, status: string, outcome: string, executionOutcome: string, error: object|null}|null}
 */
export function projectTurnOutcome(result, threadId) {
  const id = boundedId(threadId)
  if (!id || !result || typeof result !== "object" || Array.isArray(result)) return null
  if (!Array.isArray(result.data) || result.data.length !== 1) return null
  const turn = result.data[0]
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null
  const turnId = boundedId(turn.id)
  if (!turnId) return null
  const shape = TERMINAL_TURNS[turn.status]
  return shape ? { threadId: id, turnId, ...shape } : null
}

/**
 * Reads authoritative turn outcomes for a bounded set of native threads.
 *
 * The reader owns one cache and one batch lane. Batches never overlap: a
 * concurrent reader waits for the running batch and then resolves whatever is
 * still missing, so the adapter spawns at most one app-server child at a time
 * regardless of how many callers ask.
 *
 * `read` never throws and never rejects. A missing, malformed, mismatched, or
 * unreachable history is indistinguishable at the call site from "no evidence",
 * which is what keeps a native read failure from ever becoming a claim.
 *
 * @param {object} [options]
 * @param {() => any} [options.open] Transport factory, injected by the tests.
 * @param {string} [options.codexPath] Codex binary. Defaults to `CODEX_PATH`, then PATH.
 * @param {number} [options.timeoutMs] Bounded lifetime for one whole batch.
 * @param {AbortSignal} [options.signal] Caller cancellation for a batch.
 */
export function createTurnOutcomeReader({
  open,
  codexPath,
  cwd,
  timeoutMs,
  maxConcurrent = MAX_OUTCOME_CONCURRENCY,
  maxRows = MAX_OUTCOME_ROWS,
  ttlMs = OUTCOME_CACHE_TTL_MS,
  backoffMs = OUTCOME_RETRY_BACKOFF_MS,
  now = Date.now,
} = {}) {
  const budget = boundOutcomeTimeout(timeoutMs)
  const cache = new Map()
  const lifecycle = new AbortController()
  let batch = null, backoffUntil = 0, disposed = false

  /** Ids this reader accepts: bounded, deduplicated, order-preserving. */
  function accepted(ids) {
    const seen = new Set()
    const selected = []
    for (const value of Array.isArray(ids) ? ids : []) {
      const id = boundedId(value)
      if (!id || seen.has(id) || selected.length >= maxRows) continue
      seen.add(id)
      selected.push(id)
    }
    return selected
  }
  function fresh(id, revision = null) {
    const entry = cache.get(id)
    if (!entry) return null
    // ACP's native updatedAt changes when an external turn updates a thread.
    // A prior completed turn must not mask a newly active turn.
    if (entry.revision !== revision) { cache.delete(id); return null }
    // A recovered outcome is a fact about a turn that already ended. Expiry
    // only bounds how long a page stays cheap to render; it never contradicts
    // a terminal status, it just re-reads it.
    if (now() - entry.at > (revision === null ? Math.min(ttlMs, 10_000) : ttlMs)) {
      cache.delete(id)
      return null
    }
    return entry.evidence
  }
  function store(evidence, revision) {
    cache.delete(evidence.threadId)
    cache.set(evidence.threadId, { evidence, at: now(), revision })
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
  }
  function result(ids, revisions = {}) {
    const found = new Map()
    for (const id of ids) {
      const evidence = fresh(id, revisions[id] ?? null)
      if (evidence) found.set(id, evidence)
    }
    return found
  }

  /** One identity: confirm the thread echoes, then read its newest turn. */
  async function resolveOne(transport, id, signal) {
    const thread = await bounded(signal, () => transport.request("thread/read", { threadId: id }))
    // Strict correlation. The app-server must resolve this exact ID back to a
    // thread that claims it; anything else is not this session's history.
    if (thread?.thread?.id !== id) return null
    const turns = await bounded(signal, () => transport.request("thread/turns/list", { threadId: id }))
    return projectTurnOutcome(turns, id)
  }
  async function runBatch(ids, signal, revisions) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    timer.unref?.()
    const combined = AbortSignal.any([controller.signal, lifecycle.signal, ...(signal ? [signal] : [])])
    let transport
    try {
      transport = open
        ? await open({ signal: combined })
        : spawnCodexAppServer({ codexPath, cwd, requests: OUTCOME_REQUESTS, buildParams: buildTurnParams, requestTimeoutMs: budget })
      await bounded(combined, () => transport.request("initialize"))
      await bounded(combined, () => transport.initialized?.())
      const queue = [...ids]
      const workers = Array.from({ length: Math.max(1, Math.min(maxConcurrent, queue.length)) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          if (combined.aborted) return
          // A rejected identity, an unreachable thread, an unreadable page, or
          // a cancelled read leaves that row without evidence; it never fails
          // its neighbours, and it never outlives its own deadline.
          const evidence = await resolveOne(transport, id, combined).catch(() => null)
          if (evidence) store(evidence, revisions[id] ?? null)
        }
      })
      await Promise.all(workers)
    } finally {
      clearTimeout(timer)
      try {
        await transport?.close()
      } catch {}
    }
  }
  /**
   * The single batch lane.
   *
   * Batches never overlap. A caller that arrives while one is running waits for
   * it and re-reads the cache, so the adapter holds at most one app-server
   * child no matter how many callers ask at once. A transport that fails backs
   * off instead of respawning a child on the next call.
   */
  async function lane(ids, signal, revisions) {
    const previous = batch
    let release
    const mine = new Promise(resolve => { release = resolve })
    batch = mine
    try {
      if (previous) await previous
      if (disposed || ids.length === 0 || now() < backoffUntil) return
      try {
        await runBatch(ids, signal, revisions)
      } catch {
        backoffUntil = now() + backoffMs
      }
    } finally {
      release()
      if (batch === mine) batch = null
    }
  }

  return {
    /**
     * Resolves the outcomes it can establish for `ids`, never throwing.
     *
     * @param {string[]} ids Native session/thread identities to resolve.
     * @param {{signal?: AbortSignal}} [context]
     * @returns {Promise<Map<string, object>>} Evidence keyed by native identity.
     */
    async read(ids, context = {}) {
      if (disposed) return new Map()
      const wanted = accepted(ids)
      const revisions = context.revisions ?? {}
      // At most one join, one lane, and one re-read: a caller converges on the
      // cache instead of retrying a transport that has already failed.
      for (let attempt = 0; attempt < 3 && wanted.length > 0; attempt++) {
        const missing = wanted.filter(id => !fresh(id, revisions[id] ?? null))
        if (missing.length === 0) break
        const running = batch
        if (running) {
          await running.catch(() => {})
          continue
        }
        await lane(missing, context.signal, revisions)
        break
      }
      return result(wanted, revisions)
    },
    /** Evidence currently cached, without touching the transport. */
    peek: (ids, revisions = {}) => result(accepted(ids), revisions),
    /** Ends the adapter's read authority; no cached outcome outlives it. */
    async dispose() {
      disposed = true
      lifecycle.abort()
      await batch?.catch(() => {})
      cache.clear()
    },
  }
}