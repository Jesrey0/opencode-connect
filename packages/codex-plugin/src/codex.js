/**
 * Codex ACP backend.
 *
 * Direct operator sessions (`codex-sessions` RPC) select one of the native ACP
 * session modes explicitly and queue permission requests for the operator
 * instead of answering them automatically. Mode selection is the only authority
 * widening available to that route: it never gains ACP filesystem or terminal
 * delegation, because Codex performs its own tools natively.
 */

import { createRequire } from "node:module"
import path from "node:path"
import { Readable, Writable } from "node:stream"

import { ClientApp, PROTOCOL_VERSION, RequestError, ndJsonStream } from "@agentclientprotocol/sdk"
import { spawnOwnedStdio } from "./stdio.js"

/**
 * The native ACP session modes a direct operator session may select, in the
 * order Codex itself advertises them. Each entry names the sandbox policy and
 * the approval reviewer Codex binds to that mode; this plugin never overrides
 * either, so a selected mode is exactly the native envelope.
 */
export const CODEX_SESSION_MODES = Object.freeze([
  Object.freeze({ id: "read-only", name: "Read-only", sandboxPolicy: "readOnly", approvalPolicy: "on-request", approvalsReviewer: "user" }),
  Object.freeze({ id: "workspace-write", name: "Workspace access", sandboxPolicy: "workspaceWrite", approvalPolicy: "on-request", approvalsReviewer: "user" }),
  Object.freeze({ id: "agent", name: "Auto review", sandboxPolicy: "workspaceWrite", approvalPolicy: "on-request", approvalsReviewer: "auto_review" }),
  Object.freeze({ id: "agent-full-access", name: "Full access", sandboxPolicy: "dangerFullAccess", approvalPolicy: "never", approvalsReviewer: "user" }),
])

/** The mode a fresh direct session uses when the operator selects none. */
export const CODEX_DEFAULT_MODE = "agent"

const MODE_IDS = new Set(CODEX_SESSION_MODES.map((mode) => mode.id))
class CodexModeError extends Error {}

// Initialization can fail after opening an owned child. If shutdown also fails,
// pass its lifetime back to the session owner instead of losing the only closer.
export class CodexShutdownError extends Error {
  constructor(close) {
    super("Codex transport shutdown failed; details omitted")
    this.close = close
  }
}

/** True only for an exactly advertised Codex session mode. */
export function isCodexSessionMode(value) {
  return typeof value === "string" && MODE_IDS.has(value)
}

/** Default bounded runtime for one direct Codex turn. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const require_ = createRequire(import.meta.url)

/**
 * Resolves the codex-acp entrypoint script from the installed package.
 * Never uses process.execPath or any OpenCode runtime path.
 */
export function resolveCodexAcpEntry(packageName = "@agentclientprotocol/codex-acp") {
  const manifest = require_.resolve(`${packageName}/package.json`)
  return path.join(path.dirname(manifest), "dist", "index.js")
}

/**
 * The node binary used to launch codex-acp.
 * Resolved from PATH (or an explicit option) rather than process.execPath.
 */
export function resolveNodeBinary(nodePath) {
  return nodePath && nodePath.length > 0 ? nodePath : "node"
}

/**
 * Default transport: launches codex-acp with an explicit `node` invocation and
 * speaks newline-delimited ACP over its stdio.
 *
 * The child is detached on POSIX so that it leads its own process group.
 * codex-acp runs Codex as its own child, and signalling only the ACP process
 * would leave that Codex process alive holding the native thread, so
 * termination targets the whole owned group.
 *
 * @returns {Promise<{ target: import("@agentclientprotocol/sdk").Stream, close: () => Promise<void> }>}
 */
export function spawnCodexAcp({ nodePath, entry, cwd, env }) {
  const owned = spawnOwnedStdio(resolveNodeBinary(nodePath), [entry], { cwd, env })
  const { child } = owned

  const target = ndJsonStream(
    // ndJsonStream(output, input): output carries client -> agent messages,
    // input carries agent -> client messages.
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  )

  return {
    target,
    stderr: owned.stderr,
    /** Resolves once the child process is gone. */
    exited: owned.exited,
    isRunning: owned.isRunning,
    /**
     * Shuts down in escalating bounded steps, with no retry and no sleep.
     *
     * ACP over stdio reads stdin EOF as "the client is gone", so the agent gets
     * that chance first and reaps its own children. Only a transport that
     * ignores EOF is signalled, and the signal reaches the whole owned group.
     */
    close: owned.close,
  }
}

/** ACP methods this client refuses to service. */
const DENIED_CLIENT_METHODS = [
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
  "terminal/kill",
  "elicitation/create",
]

/**
 * Builds the ACP client app with the safety envelope applied.
 *
 * Every fs/terminal method is absent. Direct sessions supply `onPermission` and
 * resolve each request from a bounded queue instead of deciding here.
 */
export function createCodexClientApp({ name = "opencode-codex-subagent", onPermission } = {}) {
  const app = new ClientApp({ name })

  // Without a resolver every request is cancelled, so an unrouted approval is
  // refused rather than granted.
  app.onRequest("session/request_permission", ({ params, requestId, signal }) =>
    onPermission ? onPermission({ params, requestId, signal }) : { outcome: { outcome: "cancelled" } })

  for (const method of DENIED_CLIENT_METHODS) {
    app.onRequest(method, () => {
      throw new RequestError(-32601, `${method} is not available: this client advertises no ACP filesystem or terminal access.`)
    })
  }

  return app
}

/** Client capabilities advertised at initialize: no fs, no terminal. */
export const CODEX_CLIENT_CAPABILITIES = Object.freeze({
  fs: Object.freeze({ readTextFile: false, writeTextFile: false }),
  terminal: false,
  auth: Object.freeze({ terminal: false }),
})

// ACP cancellation is cooperative. A peer that ignores a cancellation must not
// keep startup or a prompt pending forever; callers then close their transport.
async function cancellable(operation, signal) {
  signal?.throwIfAborted()
  if (!signal) return operation()
  let onAbort
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }),
      new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally { signal.removeEventListener("abort", onAbort) }
}

export async function openCodexConnection({ open, cwd, onUpdate, signal, onPermission }) {
  const app = createCodexClientApp({ onPermission })
  app.onNotification("session/update", ({ params }) => onUpdate?.(params))
  let opened, connection, closing
  const close = () => {
    if (!closing) closing = (async () => {
      try { connection?.close() } finally { await opened?.close() }
    })().catch(error => {
      // Keep the retry handle live if reaping could not be confirmed.
      closing = undefined
      throw error
    })
    return closing
  }
  try {
    await cancellable(async () => {
      const resource = await open({ cwd })
      opened = resource
      signal?.throwIfAborted()
    }, signal)
    connection = app.connect(opened.target)
    const client = connection.agent
    const request = (method, params, requestSignal = signal) =>
      cancellable(() => client.request(method, params, { cancellationSignal: requestSignal }), requestSignal)
    const initialized = await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CODEX_CLIENT_CAPABILITIES,
      clientInfo: { name: "opencode-codex-sessions" },
    })
    return { request, notify: (method, params) => client.notify(method, params), close, initialized }
  } catch (error) {
    try { await close() } catch { throw new CodexShutdownError(close) }
    throw error
  }
}

function availableModeIds(modes) {
  return Array.isArray(modes?.availableModes) ? modes.availableModes.map((mode) => mode?.id).filter((id) => typeof id === "string") : []
}

/**
 * Applies one selected session mode, or fails closed.
 *
 * `session/set_mode` returns no mode state, so the guarantee is narrow: the mode
 * must be advertised, the switch must succeed, and the caller must reapply it
 * because Codex resets a loaded session to its initial mode.
 */
export async function applySessionMode(client, sessionId, modeId, modes, request, unavailableMessage) {
  const available = availableModeIds(modes)
  if (!isCodexSessionMode(modeId))
    throw new CodexModeError(`Codex session mode must be one of ${[...MODE_IDS].join(", ")}.`)
  if (!available.includes(modeId))
    throw new CodexModeError(
      `Codex ACP agent did not offer the "${modeId}" session mode ` +
        `(required by this route).` + (unavailableMessage ? ` ${unavailableMessage}` : ""),
    )
  if (modes?.currentModeId === modeId) return { mode: modeId, changed: false, available }
  await request.call(client, "session/set_mode", { sessionId, modeId })
  return { mode: modeId, changed: true, available }
}
