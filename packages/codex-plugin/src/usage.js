/**
 * Read-only Codex quota snapshot.
 *
 * This module answers exactly one question: what do the ChatGPT Codex quota
 * windows look like right now? It is deliberately narrow and sits beside the
 * ACP backend in `codex.js` because it shares the same authority envelope:
 * the only Codex entry point it touches is the read side of the quota.
 *
 * What it is
 * ----------
 * `codex app-server` exposes `account/rateLimits/read` over newline-delimited
 * JSON-RPC. That is the same protocol `codex-acp` speaks to Codex internally,
 * so this module reads it directly instead of asking a model turn to report its
 * own budget. Verified against the installed Codex CLI 0.160.1:
 *
 *   initialize              -> { userAgent, codexHome, platformFamily, platformOs }
 *   account/rateLimits/read -> { ordinaryUsageAllowed, rateLimits,
 *                                 rateLimitsByLimitId, rateLimitResetCredits,
 *                                 accountId, rateLimitUpsell }
 *   account/read            -> { account, requiresOpenaiAuth, workspaceRouting }
 *
 * What it is not
 * --------------
 * This is ChatGPT Codex usage quota. It is not OpenCode token accounting, and
 * it is not the ChatGPT General Chat Plus message quota; those live in
 * different subsystems and are never read here.
 *
 * Safety envelope
 * ---------------
 * - **No turn is ever requested.** No `thread/start`, no `turn/start`, no
 *   `thread/resume`. Reading a quota window must not spend one, and asking a
 *   model to report its own budget would be the one way to guarantee spending
 *   it.
 * - **Method allowlist, not a denylist.** Only `initialize`,
 *   `account/rateLimits/read`, and `account/read` can leave this process, plus
 *   the fixed `initialized` handshake notification, and
 *   each carries a fixed parameter set supplied here. No caller-supplied
 *   params, so nothing can be steered into a write, a login, or a config
 *   change.
 * - **`account/read` never refreshes a token.** It is always called with
 *   `refreshToken: false`, so the read cannot mutate local auth state.
 * - **No credentials are read.** `auth.json` is never opened. The app-server
 *   owns auth; this module only reads quota numbers back out of it.
 * - **No identity leaves.** The account email, `accountId`,
 *   `chatgptAccountId`, and `backendOrigin` are dropped during projection, as
 *   are reset-credit ids, titles, and descriptions. What survives is quota
 *   shape: buckets, windows, percentages, reset times, and the plan tier.
 * - **No bucket-to-model mapping is invented.** `limitId` and `limitName` are
 *   passed through verbatim as opaque backend labels. Nothing here claims a
 *   window applies to a particular model.
 * - **Server-initiated requests are refused.** The app-server may ask the
 *   client for approval, a tool call, a token refresh, or an attestation. This
 *   client answers every one with JSON-RPC method-not-found and records the
 *   attempt. `account/chatgptAuthTokens/refresh` in particular is answered with
 *   a refusal, never with a token.
 * - **Bounded lifetime.** One child per snapshot, a hard read timeout, and an
 *   escalating bounded shutdown (stdin EOF, then SIGTERM, then SIGKILL on the
 *   owned process group).
 */

import { spawnOwnedStdio } from "./stdio.js"

/** Bounded read budget; owned-process shutdown has its own bounded grace. */
export const DEFAULT_USAGE_TIMEOUT_MS = 15_000

/** Hard ceiling on one snapshot regardless of caller input. */
export const MAX_USAGE_TIMEOUT_MS = 60_000

const MAX_STDOUT_BYTES = 1_048_576
const MAX_BUCKETS = 64

/** Identifies this reader to the app-server without claiming any capability. */
const CLIENT_INFO = Object.freeze({ name: "opencode-codex-subagent", title: null, version: "0.0.0" })

/**
 * Client capabilities for `initialize`.
 *
 * `experimentalApi: false` keeps the surface to documented methods, and
 * `requestAttestation: false` means the app-server must never ask this client
 * for an attestation token. Nothing else is opted into.
 */
const INITIALIZE_PARAMS = Object.freeze({
  clientInfo: CLIENT_INFO,
  capabilities: Object.freeze({ experimentalApi: false, requestAttestation: false }),
})

/**
 * The complete set of requests this client may ever send.
 *
 * The value is the exact parameter object, so no caller can vary it. Adding a
 * method here is a deliberate widening of authority and must be justified: a
 * write, a login, a config change, or a turn-start do not belong.
 */
const REQUESTS = Object.freeze({
  initialize: INITIALIZE_PARAMS,
  // No params at all: this read has no client-declared usage capabilities, so
  // the backend is never asked to record experiment exposure.
  "account/rateLimits/read": undefined,
  // `refreshToken: false` keeps this read from mutating local auth state.
  "account/read": Object.freeze({ refreshToken: false }),
})

/** Quota uses the installed CLI; ACP may instead use its bundled Codex CLI. */
export function resolveCodexBinary(codexPath) {
  if (typeof codexPath === "string" && codexPath.length > 0) return codexPath
  const fromEnv = process.env.CODEX_PATH
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  return "codex"
}

/** Bounds a caller-supplied timeout into the enforced window. */
export function boundUsageTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_USAGE_TIMEOUT_MS
  return Math.min(MAX_USAGE_TIMEOUT_MS, timeoutMs)
}

/**
 * Describes an unexpected failure without reproducing its text.
 *
 * Only the error's own code is used, because a code is a fixed token while a
 * message is free-form and can carry upstream detail. Nothing here reads a
 * file, and the cause is retained for a local operator rather than returned.
 */
function describeUnexpected(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null
  return code
    ? `The Codex quota read failed (${code}).`
    : "The Codex quota read failed."
}

/**
 * Bounded error class for this transport. The message is generated here and
 * never carries a child stderr body or an upstream response payload.
 */
export class UsageUnavailableError extends Error {
  constructor(message, { code = "unavailable", detail } = {}) {
    super(message)
    this.name = "UsageUnavailableError"
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * The only server-initiated responses this client ever produces.
 *
 * Every entry is a refusal. In particular `account/chatgptAuthTokens/refresh`
 * is refused rather than answered, so no credential can leave this process in
 * response to a server request.
 */
const REFUSAL = Object.freeze({ jsonrpc: "2.0", error: Object.freeze({ code: -32601, message: "This read-only usage client services no server-initiated requests." }) })

/**
 * Spawns `codex app-server` and speaks newline-delimited JSON-RPC over stdio.
 *
 * `spawnCodexAcp` cannot be reused: it launches codex-acp with node and speaks
 * ACP. This is the Codex binary's own JSON-RPC surface, so it gets its own
 * small transport rather than a protocol-shaped wrapper it does not fit.
 *
 * @returns {{ request: (method: string) => Promise<any>, onServerRequest: (fn: (method: string) => void) => void, close: () => Promise<void>, stderr: CodexStderr, isRunning: () => boolean }}
 */
export function spawnCodexAppServer({ codexPath, cwd, env } = {}) {
  const binary = resolveCodexBinary(codexPath)
  const owned = spawnOwnedStdio(binary, ["app-server"], { cwd, env })
  const { child, stderr } = owned

  let nextId = 1
  const pending = new Map()
  const serverRequestListeners = new Set()
  let closing, failure
  const failPending = (error) => {
    failure ??= error
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(failure)
    }
    pending.clear()
  }
  child.once("error", () => failPending(new UsageUnavailableError("Could not start the Codex app-server.")))
  child.once("exit", () => failPending(new UsageUnavailableError("The Codex app-server exited before the usage read completed.")))
  // Requests are bounded so a misbehaving or hostile app-server cannot make
  // this map grow without limit.
  const MAX_IN_FLIGHT = 32

  const send = (message) => {
    if (closing || failure) throw failure ?? new UsageUnavailableError("The Codex usage read is closed.")
    if (!owned.isRunning()) throw new UsageUnavailableError("The Codex app-server exited before the usage read completed.")
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      throw new UsageUnavailableError("Could not write to the Codex app-server.")
    }
  }

  const refuse = (id) => {
    try {
      child.stdin.write(`${JSON.stringify({ ...REFUSAL, id })}\n`)
    } catch {}
  }

  const onLine = (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      // A non-JSON line is dropped, never forwarded into an error message.
      return
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return
    // A server-initiated request carries both an id and a method. It is
    // refused unconditionally; only the method name is observed.
    if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      for (const listener of serverRequestListeners) listener(message.method.slice(0, 128))
      refuse(message.id)
      return
    }
    if (message.id === undefined) return // a notification; this read needs none
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined) {
      const code = message.error?.code
      waiter.reject(
        new UsageUnavailableError(
          code === -32601
            ? "The installed Codex app-server does not support this account read."
            : "The Codex app-server rejected a read-only account request.",
          { code: code === -32601 ? "unsupported" : "unavailable" },
        ),
      )
      return
    }
    waiter.resolve(message.result)
  }
  // readline buffers an unterminated line without a bound. Cap the whole wire
  // read before decoding, including notifications and malformed JSON.
  let buffered = Buffer.alloc(0), receivedBytes = 0
  child.stdout.on("data", chunk => {
    if (failure || closing) return
    receivedBytes += chunk.length
    if (receivedBytes > MAX_STDOUT_BYTES) {
      buffered = Buffer.alloc(0)
      failPending(new UsageUnavailableError("The Codex usage response exceeded its bounded wire size."))
      return
    }
    buffered = Buffer.concat([buffered, chunk])
    let end
    while ((end = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, end).toString("utf8")
      buffered = buffered.subarray(end + 1)
      onLine(line)
    }
  })
  child.stdout.once("end", () => failPending(new UsageUnavailableError("The Codex app-server closed its usage response stream.")))

  const request = (method) => {
    if (typeof method !== "string" || !Object.hasOwn(REQUESTS, method))
      throw new UsageUnavailableError("Refusing a method outside the read-only usage allowlist.", { code: "unsupported" })
    const params = REQUESTS[method]
    if (pending.size >= MAX_IN_FLIGHT)
      throw new UsageUnavailableError("The Codex usage read exceeded its bounded number of in-flight requests.")
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new UsageUnavailableError(`The Codex app-server did not answer "${method}" in time.`))
      }, boundUsageTimeout(DEFAULT_USAGE_TIMEOUT_MS))
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  return {
    request,
    initialized: () => send({ jsonrpc: "2.0", method: "initialized", params: {} }),
    onServerRequest(fn) {
      serverRequestListeners.add(fn)
    },
    stderr,
    isRunning: owned.isRunning,
    /**
     * Escalating bounded shutdown, matching the ACP transport.
     *
     * stdin EOF is tried first, because a well-behaved stdio server treats it
     * as "the client is gone". Only a server that ignores EOF is signalled,
     * and the signal reaches the whole owned group.
     */
    close() {
      if (closing) return closing
      failPending(new UsageUnavailableError("The Codex usage read was closed before it completed."))
      serverRequestListeners.clear()
      buffered = Buffer.alloc(0)
      closing = owned.close()
      return closing
    },
  }
}

// --- Projection -----------------------------------------------------------
//
// Everything below reads an untrusted upstream payload and produces the
// sanitized shape. Each reader is total: a wrong-typed or missing field becomes
// `null` rather than propagating, so a protocol change degrades the snapshot
// instead of corrupting it.

const finiteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null)
const boolean = (value) => (typeof value === "boolean" ? value : null)
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Bounds an opaque backend label.
 *
 * Labels are passed through verbatim rather than interpreted, so they are
 * truncated at a fixed length instead of trusted to be short.
 */
const label = (value, limit = 256) => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/**
 * Projects one quota window.
 *
 * `usedPercent`, `resetsAt`, and `windowDurationMins` are copied as sent. No
 * percentage is recomputed and no reset time is formatted here: the raw values
 * are what the backend reports, and a derived "percent left" would read as
 * authoritative when the source explicitly says percentages must not be used
 * to infer availability.
 */
function projectWindow(window) {
  if (!isObject(window)) return null
  const usedPercent = finiteNumber(window.usedPercent)
  // A window with no usable percentage is not a window, so it is dropped
  // rather than reported as an empty one that looks like 0% used.
  if (usedPercent === null) return null
  return {
    usedPercent,
    resetsAt: finiteNumber(window.resetsAt),
    windowDurationMins: finiteNumber(window.windowDurationMins),
  }
}

/** Projects the optional credit balance. */
function projectCredits(credits) {
  if (!isObject(credits)) return null
  const unlimited = boolean(credits.unlimited)
  return {
    hasCredits: boolean(credits.hasCredits),
    unlimited,
    balance: label(credits.balance, 64),
  }
}

/** Projects an individual spend-control limit. */
function projectIndividualLimit(limit) {
  if (!isObject(limit)) return null
  return {
    limit: label(limit.limit, 64),
    used: label(limit.used, 64),
    remainingPercent: finiteNumber(limit.remainingPercent),
    resetsAt: finiteNumber(limit.resetsAt),
  }
}

/**
 * Projects one metered bucket.
 *
 * `limitId` and `limitName` are opaque backend labels. They are not matched
 * against any model list: which models a window governs is backend policy, and
 * guessing here would invent a mapping the protocol does not state.
 */
function projectBucket(snapshot) {
  if (!isObject(snapshot)) return null
  const primary = projectWindow(snapshot.primary)
  const secondary = projectWindow(snapshot.secondary)
  // A bucket with no readable window is dropped. Keeping it would present an
  // empty object as a metered quota, which reads as "unlimited" rather than
  // as the unreadable payload it actually is.
  if (!primary && !secondary) return null
  return {
    limitId: label(snapshot.limitId, 128),
    limitName: label(snapshot.limitName, 128),
    planType: label(snapshot.planType, 64),
    primary,
    secondary,
    credits: projectCredits(snapshot.credits),
    individualLimit: projectIndividualLimit(snapshot.individualLimit),
    spendControlReached: boolean(snapshot.spendControlReached),
    rateLimitReachedType: label(snapshot.rateLimitReachedType, 128),
  }
}

/**
 * Collects the multi-bucket view plus the single-bucket view.
 *
 * `rateLimitsByLimitId` is the current shape and `rateLimits` is the
 * backward-compatible single bucket. When the map is absent or empty the
 * single bucket is the only one, and it is reported under its own label rather
 * than being filed under an invented id.
 */
function projectBuckets(response) {
  const byId = isObject(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : {}
  const buckets = []
  if (Object.keys(byId).length > MAX_BUCKETS)
    throw new UsageUnavailableError("The Codex quota bucket inventory exceeded its bound.")
  for (const [key, snapshot] of Object.entries(byId)) {
    const projected = projectBucket(snapshot)
    if (projected) buckets.push({ bucketKey: label(key, 128), ...projected })
  }
  if (buckets.length === 0) {
    const single = projectBucket(response.rateLimits)
    if (single) buckets.push({ bucketKey: single.limitId, ...single })
  }
  return buckets
}

/**
 * Reports only the *count* of reset credits.
 *
 * Each credit carries an opaque backend id, a display title, and a description.
 * None of that is quota state, so only the numeric availability is kept.
 */
function projectResetCredits(resetCredits) {
  if (!isObject(resetCredits)) return null
  const available = finiteNumber(resetCredits.availableCount)
  if (available === null) return null
  return { available }
}

/**
 * Projects the account into plan tier only.
 *
 * `type` and `planType` describe the billing arrangement, which is what makes
 * a quota window interpretable. `email`, `accountId`, `chatgptAccountId`, and
 * `backendOrigin` identify a person or an account and are never projected.
 */
function projectAccount(response) {
  const account = isObject(response.account) ? response.account : null
  return {
    type: label(account?.type, 64),
    planType: label(account?.planType, 64),
    requiresOpenaiAuth: boolean(response.requiresOpenaiAuth),
  }
}

/**
 * Builds the sanitized snapshot from the two upstream reads.
 *
 * @param {object} rateLimits `account/rateLimits/read` result.
 * @param {object} account `account/read` result.
 * @param {object} [meta] Extra provenance the caller owns.
 */
export function projectUsage(rateLimits, account, { readAtMs = Date.now() } = {}) {
  if (!isObject(rateLimits))
    throw new UsageUnavailableError("The Codex app-server returned no usable account rate-limit read.", { code: "unsupported" })
  const buckets = projectBuckets(rateLimits)
  if (buckets.length === 0)
    throw new UsageUnavailableError("The Codex account rate-limit read contained no quota buckets.", { code: "unavailable" })
  return {
    source: "codex-app-server",
    scope: "chatgpt-codex-usage-quota",
    readAtMs,
    ordinaryUsageAllowed: boolean(rateLimits.ordinaryUsageAllowed),
    account: projectAccount(account ?? {}),
    buckets,
    resetCredits: projectResetCredits(rateLimits.rateLimitResetCredits),
  }
}

/**
 * Reads one quota snapshot through a short-lived app-server client.
 *
 * @param {object} [options]
 * @param {() => any} [options.open] Transport factory, injected by the tests.
 * @param {string} [options.codexPath] Codex binary. Defaults to `CODEX_PATH`, then PATH.
 * @param {string} [options.cwd] Working directory for the app-server.
 * @param {number} [options.timeoutMs] Bounded lifetime for the whole snapshot.
 * @param {AbortSignal} [options.signal] Caller cancellation.
 */
export async function readCodexUsage({ open, codexPath, cwd, timeoutMs, signal } = {}) {
  const budget = boundUsageTimeout(timeoutMs)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, budget)
  timer.unref?.()

  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onExternalAbort, { once: true })
  }

  const expired = () =>
    new UsageUnavailableError(
      timedOut
        ? `The Codex quota read exceeded its ${budget}ms limit and was cancelled.`
        : "The Codex quota read was cancelled by the caller.",
    )

  let transport
  const raced = async (operation) => {
    if (controller.signal.aborted) throw expired()
    let onAbort
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw expired()
          return operation()
        }),
        new Promise((_resolve, reject) => {
          onAbort = () => reject(expired())
          controller.signal.addEventListener("abort", onAbort, { once: true })
        }),
      ])
    } finally {
      controller.signal.removeEventListener("abort", onAbort)
    }
  }
  try {
    await raced(async () => {
      const opened = open ? await open() : spawnCodexAppServer({ codexPath, cwd })
      if (controller.signal.aborted) {
        await opened.close()
        throw expired()
      }
      transport = opened
    })
    const refused = []
    transport.onServerRequest?.((method) => {
      // Recorded so a caller can see that the server asked for something this
      // client will not do. Method names only; no request body is retained.
      if (refused.length < 16) refused.push(label(method, 128))
    })
    await raced(() => transport.request("initialize"))
    await raced(() => transport.initialized?.())
    const rateLimits = await raced(() => transport.request("account/rateLimits/read"))
    // The account read is supplementary. A failure here must not lose an
    // otherwise good quota snapshot, so it degrades to a null account.
    const account = await raced(() => transport.request("account/read")).catch(error => {
      if (controller.signal.aborted) throw expired()
      return null
    })
    if (controller.signal.aborted) throw expired()

    const usage = projectUsage(rateLimits, account)
    if (refused.length > 0) usage.refusedServerRequests = refused
    return usage
  } catch (error) {
    if (timedOut) throw expired()
    if (signal?.aborted) throw new UsageUnavailableError("The Codex quota read was cancelled because the caller aborted it.", { cause: error })
    if (error instanceof UsageUnavailableError) throw error
    // An unexpected failure is reported from its own error code only, never
    // from its message. A transport, JSON, or protocol error can carry
    // provider text in its message, so echoing it would leak a detail this
    // module exists to keep out. The child's stderr is dropped for the same
    // reason: it is not sanitized.
    throw new UsageUnavailableError(describeUnexpected(error), { cause: error })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onExternalAbort)
    try { await transport?.close() }
    catch { throw new UsageUnavailableError("The Codex quota client could not complete shutdown.") }
  }
}
