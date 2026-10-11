/**
 * opencode-codex-subagent
 *
 * Extends OpenCode's built-in `subagent` tool with one external agent name,
 * `codex`, backed by Codex over the Agent Client Protocol.
 *
 * The built-in executor is captured from the tool editor and used unchanged for
 * every native agent name, so native child sessions, permissions, jobs,
 * continuation, cancellation, and TUI inspection keep working exactly as before.
 */

import { Plugin } from "@opencode/plugin"
import { Tool } from "@opencode/schema/tool"
import { Schema } from "effect"

import {
  CODEX_AGENT_NAME,
  DEFAULT_TIMEOUT_MS,
  resolveCodexAcpEntry,
  resolveNodeBinary,
  runCodexTurn,
  spawnCodexAcp,
} from "./codex.js"
import { SessionError, installCodexSessionsRpc } from "./direct.js"
import { authorizeCodexSubagent } from "./permissions.js"
import { readCodexUsage } from "./usage.js"

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The agent to delegate to. Any native OpenCode agent, or `codex`." }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  sessionID: Schema.optionalKey(Schema.String).annotate({
    description: "Continue a previous native OpenCode subagent conversation. Native IDs start with ses_.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Run a native subagent in the background. Not supported for the codex agent.",
  }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})

export const CODEX_DESCRIPTION = [
  "",
  "The `codex` agent runs Codex through the Agent Client Protocol.",
  "This foreground route is read-only by construction: the session mode is forced to `read-only` and the run fails if that mode is unavailable.",
  "A `subagent` allow rule authorizes launching Codex; it never grants write access, because this route cannot select a writable mode.",
  "Every permission request is denied and Codex receives no ACP filesystem or terminal access.",
  "It requires an explicit `subagent` allow rule for the `codex` resource on the calling agent; `ask` and `deny` fail closed.",
  "Writable Codex modes are available only to direct operator sessions through the `codex-sessions` RPC, which is not reachable from this tool.",
  "It stays disabled unless the plugin option `enableCodex` is true.",
].join(" ")

/** Normalizes plugin options without trusting their shape. */
export function readOptions(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {}
  return {
    enableCodex: raw.enableCodex === true,
    cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : undefined,
    timeoutMs:
      typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
        ? raw.timeoutMs
        : undefined,
    nodePath: typeof raw.nodePath === "string" && raw.nodePath.length > 0 ? raw.nodePath : undefined,
    codexAcpEntry:
      typeof raw.codexAcpEntry === "string" && raw.codexAcpEntry.length > 0 ? raw.codexAcpEntry : undefined,
    // Codex binary used only by the read-only quota snapshot.
    codexPath: typeof raw.codexPath === "string" && raw.codexPath.length > 0 ? raw.codexPath : undefined,
  }
}

const toolError = message => new Tool.Error({ message })

/**
 * Builds the tool-editor transform. Exported for testing.
 *
 * @param {import("@opencode/plugin").Context} ctx
 * @param {object} [internals] Injection seam used by the tests.
 */
export async function installCodexSubagent(ctx, internals = {}) {
  const options = readOptions(ctx.options ?? {})

  let entry
  let entryUnavailable = false
  const resolveEntry = () => {
    if (entry || entryUnavailable) return entry
    try {
      entry = options.codexAcpEntry ?? resolveCodexAcpEntry()
    } catch {
      entryUnavailable = true
    }
    return entry
  }

  if (options.enableCodex && !resolveEntry()) {
    console.error(
      "[codex-subagent] @agentclientprotocol/codex-acp could not be resolved; details omitted.",
    )
  }

  const runTurn = internals.runCodexTurn ?? runCodexTurn
  const openTransport = internals.spawnCodexAcp ?? spawnCodexAcp

  // Disabled means fully inert: no tool override is registered at all, so the
  // built-in subagent tool keeps its original definition and behavior.
  if (!options.enableCodex) return

  // Operator sessions enter ACP directly through the native plugin RPC.
  const directRegistration = await installCodexSessionsRpc(ctx, {
    open: ({ cwd }) => {
      const entrypoint = resolveEntry()
      if (!entrypoint)
        throw new SessionError(
          "codex-sessions.internal",
          "@agentclientprotocol/codex-acp could not be resolved from this plugin.",
        )
      return openTransport({
        nodePath: resolveNodeBinary(options.nodePath),
        entry: entrypoint,
        cwd: cwd ?? options.cwd ?? ctx.location?.directory,
      })
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // The quota snapshot resolves its own Codex binary and timeout; it must not
    // inherit the ACP turn timeout, which is sized for a model turn.
    readUsage: ({ signal }) => readCodexUsage({ codexPath: options.codexPath, cwd: options.cwd ?? ctx.location?.directory, signal }),
    ...internals.direct,
  })

  const toolRegistration = await ctx.tool.transform((draft) => {
    const current = draft.get("subagent")
    if (!current) return

    const { id: _id, ...native } = current
    const nativeExecute = native.execute

    draft.add({
      ...native,
      description: `${native.description ?? ""}${CODEX_DESCRIPTION}`,
      input: Input,
      output: Output,
      execute: async (input, context) => {
        if (input?.agent !== CODEX_AGENT_NAME) {
          // Native agents keep the captured built-in executor, unchanged.
          return nativeExecute(input, context)
        }

        // A native OpenCode agent configured under the reserved name wins, so
        // configuring an agent named "codex" is never shadowed by the backend.
        const agents = await ctx.agent.list().catch(() => { throw toolError("Could not resolve the native agent inventory; details omitted.") })
        if (agents?.data?.some((agent) => agent?.id === CODEX_AGENT_NAME)) {
          return nativeExecute(input, context)
        }

        if (input.background) {
          throw toolError(
            `The "${CODEX_AGENT_NAME}" subagent only supports foreground calls; background execution is not available.`,
          )
        }

        if (input.sessionID !== undefined) {
          throw toolError(
            `The "${CODEX_AGENT_NAME}" subagent does not support continuation. ` +
              `Only native OpenCode subagents accept a sessionID (native IDs start with ses_).`,
          )
        }

        // Parent authority is preserved: the calling agent must itself be allowed
        // to launch the codex subagent. ask and deny both fail closed.
        let parent
        try {
          parent = await ctx.agent.get({ agentID: context.agent })
        } catch {
          throw toolError("Could not resolve the calling agent to authorize the codex subagent; details omitted.")
        }
        const decision = authorizeCodexSubagent({
          permissions: parent?.data?.permissions,
          parentAgent: context.agent,
          codexAgent: CODEX_AGENT_NAME,
        })
        if (!decision.allowed) throw toolError(decision.reason)

        const entrypoint = resolveEntry()
        if (!entrypoint) {
          throw toolError("@agentclientprotocol/codex-acp could not be resolved from this plugin.")
        }

        // A plugin instance's location need not match a moved session. Resolve
        // the caller's canonical location instead of the plugin/server cwd.
        const cwd = options.cwd ?? await ctx.session.get({ sessionID: context.sessionID }, { signal: context.signal })
          .then(session => session.data.location.directory)
          .catch(() => { throw toolError("Could not resolve the calling session's directory; details omitted.") })
        await context.progress?.({ codexSubagent: "starting" })

        const result = await runTurn({
          open: () =>
            Promise.resolve(
              openTransport({
                nodePath: resolveNodeBinary(options.nodePath),
                entry: entrypoint,
                cwd,
              }),
            ),
          cwd,
          prompt: input.prompt,
          signal: context.signal,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }).catch((error) => {
          throw toolError(error instanceof Error ? error.message : "Codex operation failed; details omitted.")
        })

        const text = result.text.trim() || "Codex completed without a text response."
        await context.progress?.({ codexSubagent: "completed", sessionID: result.sessionID })

        return {
          output: { sessionID: result.sessionID, status: "completed", output: text },
          content: text,
          metadata: {
            codexSubagentSessionID: result.sessionID,
            codexSubagentMode: result.mode,
            codexSubagentStopReason: result.stopReason,
          },
        }
      },
    })
  }).catch(async error => { await directRegistration.dispose(); throw error })

  // OpenCode plugin setup must return a cleanup *function*, not a Registration
  // object. This is invoked by the V2 loader during hot reload/unload.
  return async () => {
    try { await toolRegistration.dispose() }
    finally { await directRegistration.dispose() }
  }
}

export const CodexSubagentPlugin = Plugin.define({
  id: "codex-subagent",
  setup: installCodexSubagent,
})

export default CodexSubagentPlugin
