/**
 * OpenCode Connect's native plugin entrypoint.
 *
 * This plugin registers direct Codex session RPC only. It never transforms
 * OpenCode tools, leaving native subagent behavior wholly owned by OpenCode.
 */

import { Plugin } from "@opencode/plugin"

import {
  DEFAULT_TIMEOUT_MS,
  resolveCodexAcpEntry,
  resolveNodeBinary,
  spawnCodexAcp,
} from "./codex.js"
import { SessionError, installCodexSessionsRpc } from "./direct.js"
import { readCodexUsage } from "./usage.js"
import { createTurnOutcomeReader } from "./outcomes.js"

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
    // Codex binary used by the read-only quota and native history readers.
    codexPath: typeof raw.codexPath === "string" && raw.codexPath.length > 0 ? raw.codexPath : undefined,
  }
}

/** Registers the direct codex-sessions RPC without changing native tools. */
export async function installCodexSessions(ctx, internals = {}) {
  const options = readOptions(ctx.options ?? {})
  if (!options.enableCodex) return

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

  if (!resolveEntry()) {
    console.error(
      "[codex-sessions] @agentclientprotocol/codex-acp could not be resolved; details omitted.",
    )
  }

  const openTransport = internals.spawnCodexAcp ?? spawnCodexAcp
  const registration = await installCodexSessionsRpc(ctx, {
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
    // Quota reads have their own short timeout and do not inherit turn bounds.
    readUsage: ({ signal }) => readCodexUsage({ codexPath: options.codexPath, cwd: options.cwd ?? ctx.location?.directory, signal }),
    readTurnOutcomes: createTurnOutcomeReader({ codexPath: options.codexPath, cwd: options.cwd ?? ctx.location?.directory }),
    ...internals.direct,
  })

  return async () => registration.dispose()
}

export const CodexSubagentPlugin = Plugin.define({
  id: "codex-subagent",
  setup: installCodexSessions,
})

export default CodexSubagentPlugin
