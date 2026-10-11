/**
 * Codex ACP backend.
 *
 * Two callers share this transport and they deliberately have different
 * authority envelopes.
 *
 * The foreground `subagent(agent="codex")` route is the constrained one. It
 * runs a single turn with:
 *
 *   - ACP session mode forced to `read-only`, aborting when the agent does not
 *     offer that mode. Writable and full-access modes are never selected.
 *   - Advertised client capabilities that disable ACP filesystem and terminal
 *     access, and the corresponding client methods reject with "method not
 *     found" even if an agent calls them anyway.
 *   - Every `session/request_permission` answered as `cancelled`. No approval
 *     is ever granted on this route.
 *   - An explicit timeout and the caller's AbortSignal.
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

/** The agent name reserved for the external Codex backend. */
export const CODEX_AGENT_NAME = "codex"

/** The only Codex session mode the foreground subagent route will run under. */
export const CODEX_READ_ONLY_MODE = "read-only"

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

/** True only for an exactly advertised Codex session mode. */
export function isCodexSessionMode(value) {
  return typeof value === "string" && MODE_IDS.has(value)
}

/** Default bounded runtime for one foreground Codex turn. */
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
 * Every fs/terminal method is absent on both routes. Permission requests are
 * cancelled unless a route supplies `onPermission`; the direct operator route
 * does, and resolves each request from a bounded queue instead of deciding here.
 */
export function createCodexClientApp({ name = "opencode-codex-subagent", onDenied, onPermission } = {}) {
  const app = new ClientApp({ name })

  app.onRequest("session/request_permission", async ({ params, requestId, signal }) => {
    if (onPermission) return onPermission({ params, requestId, signal })
    onDenied?.({
      method: "session/request_permission",
      toolName: params?.toolCall?.title ?? params?.toolCall?.name,
    })
    return { outcome: { outcome: "cancelled" } }
  })

  for (const method of DENIED_CLIENT_METHODS) {
    app.onRequest(method, (params) => {
      onDenied?.({ method, params })
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
  const close = async () => {
    if (!closing) closing = (async () => {
      try { connection?.close() } finally { await opened?.close() }
    })()
    return closing
  }
  try {
    await cancellable(async () => {
      const resource = await open({ cwd })
      if (signal?.aborted) {
        await resource.close()
        signal.throwIfAborted()
      }
      opened = resource
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
    await close()
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

/** The foreground subagent route never reaches a writable mode. */
export async function forceReadOnlyMode(client, sessionId, modes, request) {
  return applySessionMode(client, sessionId, CODEX_READ_ONLY_MODE, modes, request, "Refusing to run Codex under a writable sandbox.")
}

function chunkText(update) {
  if (update?.sessionUpdate !== "agent_message_chunk") return ""
  const content = update.content
  if (!content) return ""
  if (typeof content === "string") return content
  if (content.type === "text" && typeof content.text === "string") return content.text
  return ""
}

/**
 * Drives one prompt turn, collecting assistant text, and always finishes on a
 * stop message, a prompt rejection, or an abort.
 */
async function runTurn(session, prompt, { signal, onText }) {
  const promptPromise = session.prompt(prompt, { cancellationSignal: signal })

  const pump = (async () => {
    let text = ""
    for (;;) {
      const message = await session.nextUpdate()
      if (message.kind === "stop") return { text, stopReason: message.stopReason }
      const chunk = chunkText(message.update)
      if (chunk) {
        text += chunk
        onText?.(chunk, text)
      }
    }
  })()

  // A prompt rejection must surface immediately rather than waiting on updates.
  const winner = await Promise.race([
    pump.then(() => "pump"),
    promptPromise.then(
      () => "prompt",
      (error) => {
        throw error
      },
    ),
  ])

  // If the prompt settled first, drain the queued stop message.
  if (winner === "prompt") {
    const settled = await pump
    return { text: settled.text, stopReason: settled.stopReason }
  }

  const settled = await pump
  return { text: settled.text, stopReason: settled.stopReason }
}

/**
 * Runs one bounded, foreground Codex turn.
 *
 * @param {object} options
 * @param {() => Promise<{target: any, close: () => Promise<void>, stderr?: {summary: () => string}}>} options.open
 *   Transport factory. Defaults to spawning codex-acp with `node`.
 * @param {string} options.cwd Absolute workspace path for the Codex session.
 * @param {string} options.prompt The task text sent to Codex.
 * @param {AbortSignal} [options.signal] Caller cancellation.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ sessionID: string, text: string, stopReason: string, mode: string }>}
 */
export async function runCodexTurn({
  open,
  cwd,
  prompt,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onText,
  onDenied,
  clientApp,
}) {
  const app = clientApp ?? createCodexClientApp({ onDenied })
  let opened, connection

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onExternalAbort, { once: true })
  }

  try {
    controller.signal.throwIfAborted()
    await cancellable(async () => {
      const resource = await open()
      if (controller.signal.aborted) {
        await resource.close()
        controller.signal.throwIfAborted()
      }
      opened = resource
    }, controller.signal)
    controller.signal.throwIfAborted()
    connection = app.connect(opened.target)
    const client = connection.agent
    await cancellable(() => client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CODEX_CLIENT_CAPABILITIES,
      clientInfo: { name: "opencode-codex-subagent" },
    }, { cancellationSignal: controller.signal }), controller.signal)

    const active = await cancellable(() => client.buildSession(cwd).start({ cancellationSignal: controller.signal }), controller.signal)
    const mode = await forceReadOnlyMode(client, active.sessionId, active.modes, {
      call: (target, method, params) => cancellable(() => target.request(method, params, { cancellationSignal: controller.signal }), controller.signal),
    })

    // Never open a model turn on an already-cancelled call.
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("cancelled")

    const turn = await cancellable(() => runTurn(active, prompt, { signal: controller.signal, onText }), controller.signal)

    if (timedOut) throw new Error(`Codex subagent exceeded the ${timeoutMs}ms time limit and was cancelled.`)
    if (signal?.aborted) throw new Error("Codex subagent was cancelled because the parent tool call was interrupted.")

    return {
      sessionID: active.sessionId,
      text: turn.text,
      stopReason: turn.stopReason,
      mode: mode.mode,
    }
  } catch (error) {
    // Cancellation is reported as a deliberate, bounded outcome rather than a
    // protocol failure, whether it came from the caller or the time limit.
    if (timedOut) throw new Error(`Codex subagent exceeded the ${timeoutMs}ms time limit and was cancelled.`)
    if (signal?.aborted)
      throw new Error("Codex subagent was cancelled because the parent tool call was interrupted.")

    if (error instanceof CodexModeError) throw error
    // Provider/SDK errors and stderr can contain credential-derived text.
    throw new Error("Codex ACP operation failed; details omitted.")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onExternalAbort)
    try {
      connection?.close()
    } catch {}
    try { await opened?.close() }
    catch { throw new Error("Codex ACP transport shutdown failed; details omitted.") }
  }
}
