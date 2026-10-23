/**
 * The ACP client safety envelope, exercised through the real
 * @agentclientprotocol/sdk against the in-process fake agent.
 *
 * Codex performs its own tools natively, so the connector's client app advertises
 * no ACP filesystem or terminal delegation and refuses those methods outright.
 * No Codex process is spawned and no model quota is consumed.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { createFakeCodexAgent } from "./fake-acp.js"
import { CODEX_CLIENT_CAPABILITIES, CodexShutdownError, openCodexConnection } from "../src/codex.js"

/** Every client method the envelope must refuse, not merely not advertise. */
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

/** Opens a direct ACP connection to an in-process fake Codex agent. */
function fakeConnection(behavior) {
  const { agent, calls } = createFakeCodexAgent(behavior)
  return { calls, connection: openCodexConnection({ open: async () => ({ target: agent, close: async () => {} }) }) }
}

test("initialize advertises no ACP filesystem or terminal capability", async () => {
  const { calls, connection } = fakeConnection({ chunks: [] })
  const open = await connection
  try {
    // The agent observed exactly what the client advertised on the wire.
    assert.equal(calls.initialize.length, 1)
    assert.deepEqual(calls.initialize[0].clientCapabilities, CODEX_CLIENT_CAPABILITIES)
    assert.deepEqual(CODEX_CLIENT_CAPABILITIES.fs, { readTextFile: false, writeTextFile: false })
    assert.equal(CODEX_CLIENT_CAPABILITIES.terminal, false)
  } finally { await open.close() }
})

test("every ACP filesystem, terminal and elicitation call is refused", async () => {
  const { calls, connection } = fakeConnection({ chunks: [], clientCalls: DENIED_CLIENT_METHODS })
  const open = await connection
  try {
    const created = await open.request("session/new", { cwd: process.cwd(), mcpServers: [] })
    const prompt = await open.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "read /etc/passwd" }],
    })
    assert.equal(prompt.stopReason, "end_turn", "the turn completes normally; only client delegation is refused")
    assert.deepEqual(calls.clientCalls.map((call) => call.method), DENIED_CLIENT_METHODS)
    for (const call of calls.clientCalls) {
      assert.equal(call.ok, false, `${call.method} must be refused`)
      assert.match(call.error, /not available/i, `${call.method} must be refused`)
    }
  } finally { await open.close() }
})
test("failed initialization retains its child closer and can retry failed shutdown", async () => {
  const { agent } = createFakeCodexAgent({ hangMethod: "initialize" })
  const controller = new AbortController()
  let closeAttempts = 0
  const opening = openCodexConnection({
    open: async () => ({ target: agent, close: async () => {
      closeAttempts++
      if (closeAttempts === 1) throw new Error("private shutdown failure")
    } }),
    signal: controller.signal,
  })
  // Allow the fake ACP initialize request to enter before interrupting startup.
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  let shutdown
  await assert.rejects(opening, error => {
    shutdown = error
    return error instanceof CodexShutdownError && !error.message.includes("private")
  })
  assert.equal(closeAttempts, 1)
  await shutdown.close()
  assert.equal(closeAttempts, 2, "a rejected closer must not be permanently cached")
  await shutdown.close()
  assert.equal(closeAttempts, 2, "verified shutdown stays idempotent")
})
