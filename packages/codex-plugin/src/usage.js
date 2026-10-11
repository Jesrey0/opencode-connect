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
 *   change. The wire format lives in the shared read-only transport
 *   (`app-server.js`); this module owns the allowlist.
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

import {
  AppServerUnavailableError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  codexBinary,
  describeUnexpected,
  spawnCodexAppServer as spawnAppServer,
} from "./app-server.js"

/** Bounded read budget; owned-process shutdown has its own bounded grace. */
export const DEFAULT_USAGE_TIMEOUT_MS = 15_000

/** Hard ceiling on one snapshot regardless of caller input. */
export const MAX_USAGE_TIMEOUT_MS = MAX_REQUEST_TIMEOUT_MS

/** Bounds a caller-supplied timeout into the enforced window. */
export function boundUsageTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_USAGE_TIMEOUT_MS
  return Math.min(MAX_USAGE_TIMEOUT_MS, timeoutMs)
}

/** The quota read's own error, so no other read's failure is ever mistaken for it. */
export const UsageUnavailableError = AppServerUnavailableError

/** Quota uses the installed CLI; ACP may instead use its bundled Codex CLI. */
export function resolveCodexBinary(codexPath) {
  return codexBinary(codexPath)
}

/**
 * The complete set of requests this client may ever send.
 *
 * The value is the exact parameter object, so no caller can vary it. Adding a
 * method here is a deliberate widening of authority and must be justified: a
 * write, a login, a config change, or a turn-start do not belong.
 */
const REQUESTS = Object.freeze({
  // No params at all: this read has no client-declared usage capabilities, so
  // the backend is never asked to record experiment exposure.
  "account/rateLimits/read": undefined,
  // `refreshToken: false` keeps this read from mutating local auth state.
  "account/read": Object.freeze({ refreshToken: false }),
})

/** The methods the quota read adds to the shared transport's `initialize`. */
export const USAGE_REQUESTS = Object.freeze(Object.keys(REQUESTS))

/**
 * Spawns `codex app-server` for one quota snapshot.
 *
 * The shared transport supplies the wire format, the server-request refusal,
 * and the bounded shutdown; this reader supplies only the allowlist above and
 * the fixed parameters behind it.
 */
export function spawnCodexAppServer({ codexPath, cwd, env } = {}) {
  return spawnAppServer({
    codexPath,
    cwd,
    env,
    requests: USAGE_REQUESTS,
    buildParams: (method) => REQUESTS[method],
    requestTimeoutMs: DEFAULT_USAGE_TIMEOUT_MS,
  })
}

// --- Projection -----------------------------------------------------------
//
// Everything below reads an untrusted upstream payload and produces the
// sanitized shape. Each reader is total: a wrong-typed or missing field becomes
// `null` rather than propagating, so a protocol change degrades the snapshot
// instead of corrupting it.

const MAX_BUCKETS = 64

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
