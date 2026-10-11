import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { createHarness } from "./harness.js"
import { CODEX_AGENT_NAME } from "../src/codex.js"

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-stdio.mjs")

test("native agents delegate to the captured built-in executor unchanged", async () => {
  const harness = await createHarness()
  const result = await harness.call({ agent: "general", description: "explore", prompt: "read the repo" })

  assert.equal(harness.nativeCalls.length, 1)
  // Input object is forwarded by reference, with nothing added or removed.
  const input = { agent: "general", description: "explore", prompt: "read the repo", background: true, extra: 42 }
  await harness.call(input)
  assert.deepEqual(harness.nativeCalls[1].input, input)
  assert.equal(harness.nativeCalls[1].input, input)
  assert.equal(result.output.sessionID, "ses_native")
})

test("native continuation ids are never routed to codex", async () => {
  const harness = await createHarness()
  await harness.call({ agent: "build", description: "continue", prompt: "more", sessionID: "ses_abc" })
  assert.equal(harness.nativeCalls.length, 1)
})

test("a configured native agent named codex wins over the backend", async () => {
  const harness = await createHarness({ agents: ["build", "general", "codex"] })
  const result = await harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p", background: true })

  // Routed natively, so background was accepted and the native output returned.
  assert.equal(harness.nativeCalls.length, 1)
  assert.equal(result.output.sessionID, "ses_native")
})

test("codex is fully inert unless enableCodex is set", async () => {
  let spawned = 0
  const harness = await createHarness({
    pluginOptions: { enableCodex: false },
    internals: {
      spawnCodexAcp: () => {
        spawned++
        throw new Error("must not spawn")
      },
    },
  })

  // No override is registered, so the built-in tool is left exactly as-is.
  assert.equal(harness.subagent, harness.builtInSubagent)
  assert.equal(harness.subagent.description, "Launch a subagent.")
  assert.doesNotMatch(harness.subagent.description, /codex/)

  const result = await harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p" })
  assert.equal(spawned, 0)
  assert.equal(harness.nativeCalls.length, 1)
  assert.equal(result.output.sessionID, "ses_native")
})

test("the codex agent name is advertised only when enabled", async () => {
  const disabled = await createHarness({ pluginOptions: { enableCodex: false } })
  assert.doesNotMatch(disabled.subagent.description, /`codex`/)

  const enabled = await createHarness()
  assert.match(enabled.subagent.description, /read-only/)
})

test("the parent agent must be allowed to launch codex", async () => {
  const cases = [
    { name: "no rules at all", permissions: [], pattern: /resolves to "ask"/ },
    { name: "ask", permissions: [{ action: "subagent", resource: "codex", effect: "ask" }], pattern: /resolves to "ask"/ },
    { name: "deny", permissions: [{ action: "subagent", resource: "codex", effect: "deny" }], pattern: /resolves to "deny"/ },
    {
      name: "allow for another agent only",
      permissions: [{ action: "subagent", resource: "claude-code", effect: "allow" }],
      pattern: /resolves to "ask"/,
    },
  ]

  for (const { name, permissions, pattern } of cases) {
    let spawned = 0
    const harness = await createHarness({
      permissions,
      internals: {
        spawnCodexAcp: () => {
          spawned++
          throw new Error("must not spawn")
        },
      },
    })

    await assert.rejects(() => harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p" }), pattern, name)
    assert.equal(spawned, 0, `${name} must not spawn codex-acp`)
    assert.equal(harness.nativeCalls.length, 0, `${name} must not reach the native executor`)
  }
})

test("a later deny overrides an earlier allow", async () => {
  const harness = await createHarness({
    permissions: [
      { action: "subagent", resource: "codex", effect: "allow" },
      { action: "subagent", resource: "codex", effect: "deny" },
    ],
  })
  await assert.rejects(
    () => harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p" }),
    /resolves to "deny"/,
  )
})

test("a wildcard allow rule authorizes codex", async () => {
  const harness = await createHarness({
    permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
    pluginOptions: { enableCodex: true, codexAcpEntry: FIXTURE, nodePath: "node", cwd: path.dirname(FIXTURE) },
  })
  const result = await harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p" })
  assert.equal(result.output.sessionID, "stdio-session")
  assert.equal(result.output.status, "completed")
  assert.equal(result.output.output, "stdio ok")
  assert.equal(result.metadata.codexSubagentMode, "read-only")
  assert.equal(harness.nativeCalls.length, 0)
})

test("an allowed codex call returns the native tool result shape", async () => {
  const harness = await createHarness({
    pluginOptions: { enableCodex: true, codexAcpEntry: FIXTURE, nodePath: "node", cwd: path.dirname(FIXTURE) },
  })

  const result = await harness.call({
    agent: CODEX_AGENT_NAME,
    description: "check",
    prompt: "say hello",
  })

  assert.equal(result.output.sessionID, "stdio-session")
  assert.equal(result.output.status, "completed")
  assert.equal(result.output.output, "stdio ok")
  assert.equal(result.content, "stdio ok")
  assert.equal(result.metadata.codexSubagentMode, "read-only")
  assert.equal(result.metadata.codexSubagentStopReason, "end_turn")

  // The native executor was never involved.
  assert.equal(harness.nativeCalls.length, 0)
})

test("codex background and continuation calls are rejected", async () => {
  const harness = await createHarness()
  await assert.rejects(
    () => harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p", background: true }),
    /foreground/i,
  )
  await assert.rejects(
    () => harness.call({ agent: CODEX_AGENT_NAME, description: "d", prompt: "p", sessionID: "ses_x" }),
    /continuation/i,
  )
})

test("foreground Codex inherits the calling session's moved directory, not the plugin location", async () => {
  let received
  const harness = await createHarness({ cwd: "/plugin/location", sessionCwd: "/session/moved", internals: {
    runCodexTurn: async options => { received = options; return { sessionID: "native", text: "ok", mode: "read-only", stopReason: "end_turn" } },
  } })
  await harness.call({ agent: CODEX_AGENT_NAME, description: "cwd", prompt: "inspect" })
  assert.equal(received.cwd, "/session/moved")
  await harness.dispose()
})

test("the plugin returns native Tool.Error without raw upstream error detail", async () => {
  const harness = await createHarness()
  harness.ctx.agent.get = async () => { throw new Error("SECRET") }
  await assert.rejects(harness.call({ agent: CODEX_AGENT_NAME, description: "error", prompt: "inspect" }), error => {
    assert.equal(error._tag, "Tool.Error")
    assert.equal(error.error, undefined)
    assert.equal(JSON.stringify(error).includes("SECRET"), false)
    return true
  })
  await harness.dispose()
})

test("tool registration failure disposes the already-registered RPC adapter", async () => {
  const harness = await createHarness()
  await harness.dispose()
  let disposed = 0
  harness.ctx.tool.transform = async () => { throw new Error("registration failed") }
  const { installCodexSubagent } = await import("../src/index.js")
  await assert.rejects(installCodexSubagent(harness.ctx, { direct: { sessions: { dispose: async () => { disposed++ } } } }), /registration failed/)
  assert.equal(disposed, 1)
  assert.equal(harness.rpc("codex-sessions"), undefined)
})
