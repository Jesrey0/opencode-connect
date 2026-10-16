/**
 * Live non-prompt verification against the real codex-acp binary.
 *
 * Exercises the plugin's own transport (spawnCodexAcp) and the real ACP client
 * app: spawn with an explicit `node`, ndJsonStream handshake, initialize,
 * session/new, and the forced session/set_mode read-only switch.
 *
 * A session/prompt is never sent, so no model quota is consumed.
 *
 *   node scripts/live-acp-handshake.mjs
 */
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"

import { CODEX_CLIENT_CAPABILITIES, createCodexClientApp, resolveCodexAcpEntry, resolveNodeBinary, spawnCodexAcp } from "../src/codex.js"

const READ_ONLY_MODE = "read-only"

const entry = resolveCodexAcpEntry()
const nodePath = resolveNodeBinary(undefined)
console.log(`node binary : ${nodePath}`)
console.log(`codex-acp   : ${entry}`)

const app = createCodexClientApp()

const transport = spawnCodexAcp({ nodePath, entry, cwd: process.cwd() })
transport.stderr && process.stderr.write("")

const connection = app.connect(transport.target)
const timeout = setTimeout(() => {
  console.error("TIMEOUT: no handshake within 45s")
  process.exit(2)
}, 45000)

try {
  const init = await connection.agent.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: CODEX_CLIENT_CAPABILITIES,
    clientInfo: { name: "opencode-codex-subagent-live-check" },
  })
  console.log(`agent       : ${init.agentInfo?.name} ${init.agentInfo?.version}`)

  const active = await connection.agent.buildSession(process.cwd()).start()
  const offered = active.modes?.availableModes?.map((mode) => mode.id) ?? []
  console.log(`session     : ${active.sessionId}`)
  console.log(`modes       : ${offered.join(", ")}`)
  console.log(`default mode: ${active.modes?.currentModeId}`)

  if (!offered.includes(READ_ONLY_MODE)) {
    throw new Error(`read-only mode is not offered; offered: ${offered.join(", ")}`)
  }
  if (active.modes?.currentModeId !== READ_ONLY_MODE) {
    await connection.agent.request("session/set_mode", { sessionId: active.sessionId, modeId: READ_ONLY_MODE })
    console.log(`mode switch : forced ${READ_ONLY_MODE}`)
  } else {
    console.log(`mode switch : already ${READ_ONLY_MODE}`)
  }

  console.log("HANDSHAKE COMPLETE (no prompt sent, no quota used)")
  clearTimeout(timeout)
} catch (error) {
  const detail = transport.stderr?.summary?.()
  console.error("HANDSHAKE FAILED:", error?.message ?? error)
  if (detail) console.error(detail)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  try {
    connection.close()
  } catch {}
  await transport.close()
}
