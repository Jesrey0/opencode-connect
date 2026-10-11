/**
 * Bounded read-only Codex App Server JSON-RPC transport.
 *
 * `codex app-server` speaks newline-delimited JSON-RPC over stdio. This module
 * owns that wire format; each reader above it owns *which* read-only methods may
 * leave the process. It is the shared transport behind the quota reader
 * (`usage.js`) and the native turn-history reader (`outcomes.js`).
 *
 * Safety envelope
 * ---------------
 * - **Method allowlist, not a denylist.** `initialize` is always permitted
 *   because every read needs the handshake. Any other method must appear in the
 *   caller's `requests` list, and its parameters come from the caller's own
 *   `buildParams`. No caller-supplied params reach the wire unmodified.
 * - **No turn is ever requested.** Nothing here can reach `thread/start`,
 *   `turn/start`, or `thread/resume` unless a reader explicitly names it, and
 *   the readers in this package name only read methods.
 * - **Server-initiated requests are refused.** The app-server may ask this
 *   client for approval, a tool call, a token refresh, or an attestation. Every
 *   such request is answered with JSON-RPC method-not-found and recorded by
 *   method name only. In particular `account/chatgptAuthTokens/refresh` is
 *   refused rather than answered, so no credential can leave this process.
 * - **No provider text survives.** Rejections are re-described from their
 *   JSON-RPC code alone, and an unexpected failure is reported from its own
 *   error code. A message, a body, or a child stderr never reaches a caller.
 * - **Bounded everything.** One owned child per reader, a hard per-request
 *   timeout, a bounded in-flight count, a capped wire read, and an escalating
 *   bounded shutdown (stdin EOF, then SIGTERM, then SIGKILL on the owned
 *   process group).
 */

import { spawnOwnedStdio } from "./stdio.js"

/** Default per-request deadline; readers may lower it but never raise it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Hard ceiling on one request regardless of reader configuration. */
export const MAX_REQUEST_TIMEOUT_MS = 60_000

/** Bounds the whole wire read before decoding, including notifications. */
export const MAX_STDOUT_BYTES = 1_048_576

/** Bounds pending requests so a misbehaving server cannot grow this map. */
const MAX_IN_FLIGHT = 32
const READ_METHODS = new Set(["account/rateLimits/read", "account/read", "thread/read", "thread/turns/list"])

/** Identifies this transport to the app-server without claiming a capability. */
const CLIENT_INFO = Object.freeze({ name: "opencode-codex-subagent", title: null, version: "0.0.0" })

/**
 * Client capabilities for `initialize`.
 *
 * `experimentalApi: false` keeps the surface to documented methods, and
 * `requestAttestation: false` means the app-server must never ask this client
 * for an attestation token. Nothing else is opted into.
 */
export const INITIALIZE_PARAMS = Object.freeze({
  clientInfo: CLIENT_INFO,
  capabilities: Object.freeze({ experimentalApi: false, requestAttestation: false }),
})

/** Every server-initiated response this client ever produces is a refusal. */
const REFUSAL = Object.freeze({
  jsonrpc: "2.0",
  error: Object.freeze({
    code: -32601,
    message: "This read-only Codex client services no server-initiated requests.",
  }),
})

/**
 * Bounded error for this transport.
 *
 * The message is generated here and never carries a child stderr body or an
 * upstream response payload. `code` is a fixed token: `unsupported` when the
 * installed app-server does not implement the read, `unavailable` for anything
 * else, and `invalid_input` when a reader refused to build a request.
 */
export class AppServerUnavailableError extends Error {
  constructor(message, { code = "unavailable", detail } = {}) {
    super(message)
    this.name = "AppServerUnavailableError"
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/** Bounds a reader-supplied per-request timeout into the enforced window. */
export function boundRequestTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(MAX_REQUEST_TIMEOUT_MS, timeoutMs)
}

/**
 * Describes an unexpected failure without reproducing its text.
 *
 * Only the error's own code is used, because a code is a fixed token while a
 * message is free-form and can carry upstream detail. Nothing here reads a
 * file, and the cause is retained for a local operator rather than returned.
 */
export function describeUnexpected(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null
  return code ? `The Codex read failed (${code}).` : "The Codex read failed."
}

/** The only server-initiated responses: one refusal, for every method. */
function refusal(id) {
  return { ...REFUSAL, id }
}

/**
 * Spawns `codex app-server` and speaks newline-delimited JSON-RPC over stdio.
 *
 * `spawnCodexAcp` in `codex.js` cannot be reused: it launches codex-acp with
 * node and speaks ACP. This is the Codex binary's own JSON-RPC surface, so it
 * gets its own small transport rather than a protocol-shaped wrapper it does not
 * fit.
 *
 * @param {object} [options]
 * @param {string} [options.codexPath] Codex binary. Defaults to `CODEX_PATH`, then PATH.
 * @param {string} [options.cwd] Working directory for the app-server.
 * @param {object} [options.env] Child environment.
 * @param {readonly string[]} [options.requests] Methods this reader may send besides `initialize`.
 * @param {(method: string, args: unknown) => object|undefined} [options.buildParams]
 *   Builds the exact parameter object for a permitted method. Throwing here
 *   refuses the request before anything is written.
 * @param {number} [options.requestTimeoutMs] Bounded per-request deadline.
 * @returns {{ request: (method: string, args?: unknown) => Promise<any>, onServerRequest: (fn: (method: string) => void) => void, initialized: () => void, stderr: CodexStderr, isRunning: () => boolean, close: () => Promise<void> }}
 */
export function spawnCodexAppServer({ codexPath, cwd, env, requests = [], buildParams, requestTimeoutMs } = {}) {
  if (!Array.isArray(requests) || requests.some(method => !READ_METHODS.has(method)))
    throw new AppServerUnavailableError("Refusing a non-read-only Codex method.", { code: "unsupported" })
  const permitted = new Set(["initialize", ...requests])
  const deadline = boundRequestTimeout(requestTimeoutMs)
  const owned = spawnOwnedStdio(codexBinary(codexPath), ["app-server"], { cwd, env })
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
  child.once("error", () => failPending(new AppServerUnavailableError("Could not start the Codex app-server.")))
  child.once("exit", () => failPending(new AppServerUnavailableError("The Codex app-server exited before the read completed.")))

  const send = (message) => {
    if (closing || failure) throw failure ?? new AppServerUnavailableError("The Codex read was closed.")
    if (!owned.isRunning()) throw new AppServerUnavailableError("The Codex app-server exited before the read completed.")
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      throw new AppServerUnavailableError("Could not write to the Codex app-server.")
    }
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
      try {
        child.stdin.write(`${JSON.stringify(refusal(message.id))}\n`)
      } catch {}
      return
    }
    if (message.id === undefined) return // a notification; these reads need none
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined) {
      const code = message.error?.code
      waiter.reject(
        new AppServerUnavailableError(
          code === -32601
            ? "The installed Codex app-server does not support this read-only request."
            : "The Codex app-server rejected a read-only request.",
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
  child.stdout.on("data", (chunk) => {
    if (failure || closing) return
    receivedBytes += chunk.length
    if (receivedBytes > MAX_STDOUT_BYTES) {
      buffered = Buffer.alloc(0)
      failPending(new AppServerUnavailableError("The Codex response exceeded its bounded wire size."))
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
  child.stdout.once("end", () => failPending(new AppServerUnavailableError("The Codex app-server closed its response stream.")))

  const request = (method, args) => {
    if (typeof method !== "string" || !permitted.has(method))
      throw new AppServerUnavailableError("Refusing a method outside this read's allowlist.", { code: "unsupported" })
    // The handshake is this transport's own: no reader can vary or inspect it.
    const params = method === "initialize" ? INITIALIZE_PARAMS : buildParams ? buildParams(method, args) : undefined
    if (pending.size >= MAX_IN_FLIGHT)
      throw new AppServerUnavailableError("The Codex read exceeded its bounded number of in-flight requests.")
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new AppServerUnavailableError(`The Codex app-server did not answer "${method}" in time.`))
      }, deadline)
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
      failPending(new AppServerUnavailableError("The Codex read was closed before it completed."))
      serverRequestListeners.clear()
      buffered = Buffer.alloc(0)
      closing = owned.close()
      return closing
    },
  }
}

/** Quota uses the installed CLI; ACP may instead use its bundled Codex CLI. */
export function codexBinary(codexPath) {
  if (typeof codexPath === "string" && codexPath.length > 0) return codexPath
  const fromEnv = process.env.CODEX_PATH
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  return "codex"
}