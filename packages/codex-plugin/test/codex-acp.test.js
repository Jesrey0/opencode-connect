/**
 * Proves the ACP path end to end through the real @agentclientprotocol/sdk:
 * a real connect + initialize handshake, a real session/new, a real
 * session/set_mode, and a real session/prompt turn against an in-process fake
 * Codex agent. No Codex process is spawned and no model quota is consumed.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { createFakeCodexAgent } from "./fake-acp.js"
import {
  CODEX_CLIENT_CAPABILITIES,
  CODEX_READ_ONLY_MODE,
  createCodexClientApp,
  openCodexConnection,
  runCodexTurn,
} from "../src/codex.js"

/** A transport that connects the client app to an in-process fake agent. */
function fakeTransport(behavior) {
  const { agent, calls, kill } = createFakeCodexAgent(behavior)
  return {
    calls,
    kill,
    open: async () => ({
      target: agent,
      close: async () => {},
      stderr: undefined,
    }),
  }
}

test("completes a real ACP handshake and prompt turn", async () => {
  const transport = fakeTransport({ chunks: ["hello ", "from codex"] })
  const denied = []

  const result = await runCodexTurn({
    open: transport.open,
    cwd: "/tmp/project",
    prompt: "summarize the repo",
    clientApp: createCodexClientApp({ onDenied: (event) => denied.push(event) }),
  })

  assert.equal(result.sessionID, "codex-session-1")
  assert.equal(result.text, "hello from codex")
  assert.equal(result.stopReason, "end_turn")
  assert.equal(result.mode, CODEX_READ_ONLY_MODE)
  assert.deepEqual(denied, [])

  // A real initialize handshake happened, with no fs and no terminal capability.
  assert.equal(transport.calls.initialize.length, 1)
  assert.deepEqual(transport.calls.initialize[0].clientCapabilities, CODEX_CLIENT_CAPABILITIES)
  assert.equal(transport.calls.initialize[0].clientCapabilities.fs.readTextFile, false)
  assert.equal(transport.calls.initialize[0].clientCapabilities.fs.writeTextFile, false)
  assert.equal(transport.calls.initialize[0].clientCapabilities.terminal, false)

  // The session was created in the requested workspace.
  assert.equal(transport.calls.newSessions[0].cwd, "/tmp/project")

  // The prompt text reached the agent.
  assert.equal(transport.calls.prompts.length, 1)
  assert.equal(JSON.stringify(transport.calls.prompts[0].prompt).includes("summarize the repo"), true)
})

test("forces read-only mode when the session starts elsewhere", async () => {
  const transport = fakeTransport({ currentModeId: "agent-full-access" })
  const result = await runCodexTurn({
    open: transport.open,
    cwd: "/tmp/project",
    prompt: "hi",
  })

  assert.equal(transport.calls.setMode.length, 1)
  assert.equal(transport.calls.setMode[0].modeId, CODEX_READ_ONLY_MODE)
  assert.equal(result.mode, CODEX_READ_ONLY_MODE)
})

test("does not re-set the mode when the session already starts read-only", async () => {
  const transport = fakeTransport({ currentModeId: CODEX_READ_ONLY_MODE })
  await runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "hi" })
  assert.equal(transport.calls.setMode.length, 0)
})

test("fails closed when no read-only mode is offered", async () => {
  const transport = fakeTransport({ modes: ["workspace-write", "agent-full-access"] })
  await assert.rejects(
    () => runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "hi" }),
    /did not offer the "read-only" session mode/,
  )
  // The prompt is never sent under a writable sandbox.
  assert.equal(transport.calls.prompts.length, 0)
})

test("fails closed when switching to read-only is rejected", async () => {
  const transport = fakeTransport({
    currentModeId: "agent-full-access",
    setModeError: "mode switch denied",
  })
  await assert.rejects(
    () => runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "hi" }),
    /Codex ACP operation failed; details omitted/,
  )
  assert.equal(transport.calls.prompts.length, 0)
})

test("every ACP permission request is cancelled, never granted", async () => {
  const transport = fakeTransport({ clientCalls: ["session/request_permission"] })
  const denied = []

  const result = await runCodexTurn({
    open: transport.open,
    cwd: "/tmp/project",
    prompt: "please edit the file",
    clientApp: createCodexClientApp({ onDenied: (event) => denied.push(event) }),
  })

  assert.equal(denied.length, 1)
  assert.equal(denied[0].method, "session/request_permission")

  // The request resolved with a cancelled outcome. Selecting an option (the
  // only other outcome) would be a protocol error here.
  assert.equal(transport.calls.clientCalls.length, 1)
  assert.equal(transport.calls.clientCalls[0].ok, true)
  assert.deepEqual(transport.calls.clientCalls[0].result, { outcome: { outcome: "cancelled" } })
  assert.equal(result.stopReason, "end_turn")
})

test("ACP filesystem and terminal access is denied", async () => {
  const methods = [
    "fs/read_text_file",
    "fs/write_text_file",
    "terminal/create",
    "terminal/kill",
    "elicitation/create",
  ]
  const transport = fakeTransport({ clientCalls: methods })

  await runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "read /etc/passwd" })

  assert.equal(transport.calls.clientCalls.length, methods.length)
  for (const call of transport.calls.clientCalls) {
    assert.equal(call.ok, false, `${call.method} should be refused`)
    assert.match(call.error, /not available/i, `${call.method} should be refused`)
  }
})

test("a hung turn is cancelled by the bounded timeout", async () => {
  const transport = fakeTransport({ hang: true })
  await assert.rejects(
    () => runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "hang", timeoutMs: 150 }),
    /exceeded the 150ms time limit/,
  )
})

for (const hangMethod of ["initialize", "session/new", "session/set_mode"]) test(`startup timeout covers ${hangMethod} before any prompt`, { timeout: 2000 }, async () => {
  const transport = fakeTransport({ hangMethod, currentModeId: "agent-full-access" })
  await assert.rejects(runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "must not run", timeoutMs: 100 }), /exceeded the 100ms time limit/)
  assert.equal(transport.calls.prompts.length, 0)
})

test("direct ACP initialization is bounded even if the peer ignores cancellation", { timeout: 2000 }, async () => {
  const transport = fakeTransport({ hangMethod: "initialize" })
  let closed = 0
  await assert.rejects(openCodexConnection({ open: async () => ({ ...await transport.open(), close: async () => { closed++ } }), signal: AbortSignal.timeout(50) }))
  assert.equal(closed, 1)
  assert.equal(transport.calls.prompts.length, 0)
})

for (const route of ["foreground", "direct"]) test(`${route} ACP open closes a late resource after cancellation`, { timeout: 2000 }, async () => {
  let release, closed = 0
  const open = () => new Promise(resolve => { release = () => resolve({ close: async () => { closed++ } }) })
  const signal = AbortSignal.timeout(50)
  const request = route === "foreground"
    ? runCodexTurn({ open, cwd: "/tmp/project", prompt: "never run", signal })
    : openCodexConnection({ open, signal })
  await assert.rejects(request)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 1)
})

test("a cancelled foreground call stops the turn and reports cancellation", async () => {
  const transport = fakeTransport({ hang: true })
  const controller = new AbortController()
  const promise = runCodexTurn({
    open: transport.open,
    cwd: "/tmp/project",
    prompt: "hang",
    signal: controller.signal,
  })

  setTimeout(() => controller.abort(), 50)

  await assert.rejects(promise, /cancelled because the parent tool call was interrupted/)
})

test("an already-aborted signal never starts the prompt", async () => {
  const transport = fakeTransport({ chunks: ["should not run"] })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () =>
      runCodexTurn({
        open: transport.open,
        cwd: "/tmp/project",
        prompt: "hi",
        signal: controller.signal,
      }),
    /cancelled because the parent tool call was interrupted/,
  )
  assert.equal(transport.calls.prompts.length, 0)
})

test("a dead agent connection surfaces a bounded error, not a hang", async () => {
  const transport = fakeTransport({ hang: true })

  const promise = runCodexTurn({
    open: transport.open,
    cwd: "/tmp/project",
    prompt: "hi",
    timeoutMs: 2000,
  })

  // Sever the ACP connection mid-turn, as a crashed codex-acp would.
  setTimeout(() => transport.kill(), 50)

  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error)
    return true
  })
})

test("an agent prompt failure omits upstream text and stderr", async () => {
  const transport = fakeTransport({ promptError: "SECRET provider detail" })
  await assert.rejects(
    () => runCodexTurn({ open: async () => ({ ...await transport.open(), stderr: { summary: () => "SECRET stderr" } }), cwd: "/tmp/project", prompt: "hi" }),
    error => error.message.includes("details omitted") && !error.message.includes("SECRET"),
  )
})

test("empty assistant output still yields a usable result", async () => {
  const transport = fakeTransport({ chunks: [] })
  const result = await runCodexTurn({ open: transport.open, cwd: "/tmp/project", prompt: "hi" })
  assert.equal(result.text, "")
})
