import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentApp, RequestError } from "@agentclientprotocol/sdk"
import { createCodexSessions, SESSION_RPC_ID } from "../src/direct.js"
import { createHarness } from "./harness.js"
import { createFakeCodexAgent } from "./fake-acp.js"

const cwd = process.cwd()
const ALL_MODES = ["read-only", "workspace-write", "agent", "agent-full-access"]

function backend({ outputOverride, initialModeId = "agent", modes = ALL_MODES, permissions, toolCall, permissionSessionId } = {}) {
  const persisted = new Map(), calls = [], cancels = new Map(), modeState = new Map()
  let sequence = 0
  const app = new AgentApp({ name: "persistent-codex-test" })
  const modeStateFor = (sessionId) => ({
    currentModeId: modeState.get(sessionId) ?? initialModeId,
    availableModes: modes.map(id => ({ id, name: id })),
  })
  app.onRequest("initialize", ({ params }) => ({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } } }))
  app.onRequest("session/new", ({ params }) => {
    const sessionId = `native-${++sequence}`
    persisted.set(sessionId, { sessionId, cwd: params.cwd, messages: [] })
    // Codex starts a new session in its configured initial mode.
    modeState.set(sessionId, initialModeId)
    return { sessionId, modes: modeStateFor(sessionId) }
  })
  app.onRequest("session/list", () => ({ sessions: [...persisted.values()].map(s => ({ sessionId: s.sessionId, cwd: s.cwd })), nextCursor: null }))
  app.onRequest("session/load", async ({ params, client }) => {
    const s = persisted.get(params.sessionId)
    if (!s) throw new RequestError(-32000, "missing")
    for (const m of s.messages) await client.notify("session/update", { sessionId: s.sessionId, update: { sessionUpdate: `${m.role}_message_chunk`, messageId: m.id, content: { type: "text", text: m.text } } })
    // A loaded session resets to the initial mode regardless of what it ran under.
    modeState.set(s.sessionId, initialModeId)
    return { modes: modeStateFor(s.sessionId) }
  })
  app.onRequest("session/set_mode", ({ params }) => {
    if (!modeStateFor(params.sessionId).availableModes.some(m => m.id === params.modeId)) throw new RequestError(-32000, "unknown mode")
    calls.push(params)
    modeState.set(params.sessionId, params.modeId)
    return {}
  })
  app.onNotification("session/cancel", ({ params }) => { cancels.get(params.sessionId)?.() })
  app.onRequest("session/delete", ({ params }) => { persisted.delete(params.sessionId); return {} })
  app.onRequest("session/prompt", async ({ params, client, signal }) => {
    const s = persisted.get(params.sessionId), text = params.prompt[0].text
    // Every turn runs under whatever mode is currently selected.
    s.modeAtPrompt = modeStateFor(s.sessionId).currentModeId
    s.messages.push({ role: "user", id: `user-${++sequence}`, text })
    if (text === "hang") {
      await new Promise(resolve => { cancels.set(s.sessionId, resolve); signal.addEventListener("abort", resolve, { once: true }) })
      return { stopReason: "cancelled" }
    }
    if (text === "fail") throw new RequestError(-32000, "private provider failure")
    if (permissions) {
      // `options` is the advertised option list; `concurrent` raises every
      // request without awaiting, which is the only way a queue bound is
      // actually exercised against a normally serial agent.
      const options = permissions.options ?? permissions
      const ask = () => client.request("session/request_permission", {
        sessionId: permissionSessionId ?? s.sessionId,
        toolCall: toolCall ?? {
          toolCallId: "call-1", title: "Run a command", kind: "execute", status: "pending",
          rawInput: { command: ["rm", "-rf", "/tmp/x"], cwd: "/tmp", env: { SECRET_TOKEN: "do-not-export" } },
          locations: [{ path: "/tmp/x" }],
          content: [{ type: "content", content: { type: "text", text: "Remove a temporary directory" } }],
        },
        options,
      })
      const outcomes = []
      if (permissions.concurrent) {
        outcomes.push(...await Promise.all(Array.from({ length: permissions.count ?? 2 }, ask)))
      } else {
        for (let round = 0; round < (permissions.count ?? 1); round += 1) {
          const outcome = await ask()
          if (outcome.outcome.outcome !== "cancelled") s.lastChoice = outcome.outcome.optionId
          outcomes.push(outcome)
        }
      }
      if (outcomes.some(o => o.outcome.outcome === "cancelled")) return { stopReason: "cancelled" }
    }
    const output = outputOverride ?? (text === "recall" ? s.messages[0].text : text)
    const id = `assistant-${++sequence}`
    for (const text of [output.slice(0, 2), output.slice(2)]) await client.notify("session/update", { sessionId: s.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } } })
    s.messages.push({ role: "agent", id, text: output })
    return { stopReason: "end_turn" }
  })
  return { open: async () => ({ target: app, close: async () => {} }), persisted, calls, modeStateFor }
}

test("a fresh session selects the default agent mode and reapplies it before every prompt", async () => {
  const native = backend(), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "first" })
  assert.equal(admitted.messageId, null)
  assert.equal(admitted.mode, "agent")
  await sessions.wait({ sessionId: admitted.sessionId })
  // The fresh session already started in "agent", so no switch is issued.
  assert.deepEqual(native.calls.map(c => c.modeId), [])
  assert.equal(native.persisted.get(admitted.sessionId).modeAtPrompt, "agent")
  await sessions.dispose()
})

for (const operation of ["start", "list"]) test(`disposal cancels and awaits ${operation} initialization before unloading`, { timeout: 2000 }, async () => {
  const { agent, calls } = createFakeCodexAgent({ hangMethod: "initialize" })
  let opened, closing, release, disposed = false
  const ready = new Promise(resolve => { opened = resolve })
  const closingReady = new Promise(resolve => { closing = resolve })
  const cleanup = new Promise(resolve => { release = resolve })
  const sessions = createCodexSessions({ open: async () => {
    opened()
    return { target: agent, close: async () => { closing(); await cleanup } }
  } })
  const stopped = assert.rejects(sessions[operation]({ cwd, task: "must not run" }))
  await ready
  const disposal = sessions.dispose().then(() => { disposed = true })
  await closingReady
  assert.equal(disposed, false)
  release()
  await Promise.all([disposal, stopped])
  assert.equal(disposed, true)
  assert.equal(calls.prompts.length, 0)
  await assert.rejects(sessions.start({ cwd, task: "still closed" }), /adapter is closed/)
})

test("failed owned cleanup is not reported as completed or readmitted as a safe writer", async () => {
  const native = backend()
  const sessions = createCodexSessions({ ...native, open: async () => ({ ...await native.open(), close: async () => { throw new Error("SECRET cleanup") } }) })
  const admitted = await sessions.start({ cwd, task: "work" })
  const result = await sessions.wait(admitted)
  assert.equal(result.status, "failed")
  assert.equal(result.outcome, "failed")
  assert.deepEqual(result.error, { type: "codex-sessions.shutdown_failed", messageOmitted: true })
  assert.equal(JSON.stringify(result).includes("SECRET"), false)
  await assert.rejects(sessions.start({ sessionId: admitted.sessionId, task: "unsafe retry" }), /already running/)
  await assert.rejects(sessions.delete(admitted), /Interrupt execution/)
  await assert.rejects(sessions.dispose(), /shutdown failed; details omitted/)
})

test("an explicitly selected writable mode is applied before the prompt runs", async () => {
  const native = backend(), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "edit things", mode: "workspace-write" })
  assert.equal(admitted.mode, "workspace-write")
  await sessions.wait({ sessionId: admitted.sessionId })
  assert.deepEqual(native.calls.map(c => c.modeId), ["workspace-write"])
  assert.equal(native.persisted.get(admitted.sessionId).modeAtPrompt, "workspace-write")
  const inspected = await sessions.inspect({ sessionId: admitted.sessionId })
  assert.equal(inspected.mode, "workspace-write")
  await sessions.dispose()
})

test("continuation inherits the known mode and reapplies it after the load reset", async () => {
  const native = backend({ initialModeId: "agent" }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "remember me", mode: "workspace-write" })
  await sessions.wait({ sessionId: admitted.sessionId })
  native.calls.length = 0
  const resumed = await sessions.start({ sessionId: admitted.sessionId, task: "recall" })
  assert.equal(resumed.sessionId, admitted.sessionId)
  assert.equal(resumed.mode, "workspace-write")
  const finished = await sessions.wait(resumed)
  assert.equal(finished.output, "remember me")
  assert.equal(native.persisted.size, 1)
  // The load reset the session back to its initial mode, so the inherited mode
  // had to be switched again before the second prompt.
  assert.deepEqual(native.calls.map(c => c.modeId), ["workspace-write"])
  assert.equal(native.persisted.get(admitted.sessionId).modeAtPrompt, "workspace-write")
  await sessions.dispose()
})

test("an unrecoverable mode after restart requires an explicit selection", async () => {
  const native = backend(), before = createCodexSessions(native)
  const admitted = await before.start({ cwd, task: "persisted", mode: "workspace-write" })
  await before.wait(admitted); await before.dispose()
  const after = createCodexSessions(native)
  const recovered = await after.inspect(admitted)
  // Loading history asserts neither a mode nor an execution outcome.
  assert.equal(recovered.mode, null)
  assert.equal(recovered.executionKnown, false)
  assert.equal(recovered.outcome, "unknown")
  const permissions = await after.permissions({ sessionId: admitted.sessionId })
  assert.equal(permissions.modeKnown, false)
  assert.deepEqual(permissions.pendingActions, [])
  await assert.rejects(after.start({ sessionId: admitted.sessionId, task: "recall" }), (error) => {
    assert.equal(error.code, "codex-sessions.mode_required")
    assert.equal(error.data.recoverable, false)
    return true
  })
  const resumed = await after.start({ sessionId: admitted.sessionId, task: "recall", mode: "workspace-write" })
  assert.equal((await after.wait(resumed)).output, "persisted")
  await after.dispose()
})

test("an unknown mode is rejected before any session is opened", async () => {
  const native = backend(), sessions = createCodexSessions(native)
  await assert.rejects(sessions.start({ cwd, task: "work", mode: "dangerous" }), /mode must be one of/)
  assert.deepEqual([...native.persisted.keys()], [])
  await sessions.dispose()
  // A real mode the agent does not advertise fails at the switch, which happens
  // after the native session exists. The prompt was never submitted.
  const unsupported = backend({ modes: ["read-only"] }), narrow = createCodexSessions(unsupported)
  await assert.rejects(narrow.start({ cwd, task: "work", mode: "agent-full-access" }), error => {
    assert.equal(error.code, "codex-sessions.admission_failed")
    assert.equal(error.data.promptSubmitted, false)
    return true
  })
  await narrow.dispose()
})

test("parked permission requests expose the tool detail and exact options", async () => {
  const options = [
    { optionId: "allow_once", name: "Yes, just this once", kind: "allow_once" },
    { optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" },
  ]
  const native = backend({ permissions: options }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "write", mode: "workspace-write" })
  const waiting = await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  assert.equal(waiting.wakeReason, "actionRequired")
  assert.equal(waiting.pendingActions.length, 1)
  const [pending] = waiting.pendingActions
  assert.equal(pending.sessionId, admitted.sessionId)
  assert.equal(pending.action, "Run a command")
  assert.equal(pending.details.command, "rm -rf /tmp/x")
  assert.equal(pending.details.cwd, "/tmp")
  assert.deepEqual(pending.resources, ["/tmp/x"])
  assert.equal(pending.message, "Remove a temporary directory")
  assert.equal(pending.details.truncated, false)
  assert.equal(pending.reviewable, true)
  assert.deepEqual(pending.options.map(o => o.optionId), ["allow_once", "cancel"])
  // rawInput carries an environment value; only the reviewable fields are read.
  assert.equal(JSON.stringify(pending).includes("do-not-export"), false)
  const state = await sessions.permissions({ sessionId: admitted.sessionId })
  assert.equal(state.pendingActions.length, 1)
  const rejected = await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "allow-always" })
    .then(() => null, error => error)
  assert.equal(rejected.code, "codex-sessions.unknown_option")
  assert.deepEqual(rejected.data.options, ["allow_once", "cancel"])
  const answered = await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "allow_once" })
  assert.equal(answered.accepted, true)
  assert.equal(answered.pendingActions.length, 0)
  const finished = await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  assert.equal(finished.wakeReason, "terminal")
  assert.equal(native.persisted.get(admitted.sessionId).lastChoice, "allow_once")
  await sessions.dispose()
})

test("an edit approval surfaces the native diff so the change is readable", async () => {
  const options = [
    { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
    { optionId: "decline", name: "No, continue without running it", kind: "reject_once" },
  ]
  const toolCall = {
    toolCallId: "call-1", title: "Apply an edit", kind: "edit", status: "pending",
    locations: [{ path: "/tmp/project/src/index.ts" }],
    content: [{ type: "diff", path: "/tmp/project/src/index.ts", oldText: "export const a = 1\n", newText: "export const a = 2\n" }],
  }
  const native = backend({ permissions: options, toolCall }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "edit", mode: "workspace-write" })
  const [pending] = (await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })).pendingActions
  assert.deepEqual(pending.details.diffs, ["/tmp/project/src/index.ts"])
  assert.match(pending.details.content, /export const a = 1/)
  assert.match(pending.details.content, /export const a = 2/)
  assert.equal(pending.details.truncated, false)
  assert.equal(pending.reviewable, true)
  await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "allow_once" })
  assert.equal((await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })).wakeReason, "terminal")
  assert.equal(native.persisted.get(admitted.sessionId).lastChoice, "allow_once")
  await sessions.dispose()
})

test("an oversized diff is not approvable but can still be rejected", async () => {
  const options = [
    { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
    { optionId: "decline", name: "No, continue without running it", kind: "reject_once" },
  ]
  const toolCall = {
    toolCallId: "call-1", title: "Apply a large edit", kind: "edit", status: "pending",
    content: [{ type: "diff", path: "/tmp/project/big.ts", oldText: "x".repeat(20_000), newText: "y".repeat(20_000) }],
  }
  const native = backend({ permissions: options, toolCall }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "edit", mode: "workspace-write" })
  const [pending] = (await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })).pendingActions
  assert.equal(pending.details.truncated, true)
  assert.deepEqual(pending.details.truncatedFields, ["content"])
  assert.equal(pending.reviewable, false)
  assert.equal(pending.details.content.length, 16_384)
  await assert.rejects(
    sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "allow_once" }),
    error => { assert.equal(error.code, "codex-sessions.unreviewable_request"); return true },
  )
  await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "decline" })
  await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  await sessions.dispose()
})

test("an oversized diff path alone also makes the request unreviewable", async () => {
  const options = [{ optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" }]
  const toolCall = {
    toolCallId: "call-1", title: "Apply an edit", kind: "edit", status: "pending",
    content: [{ type: "diff", path: "/deep/".repeat(400) + "file.ts", oldText: "a", newText: "b" }],
  }
  const native = backend({ permissions: options, toolCall }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "edit", mode: "workspace-write" })
  const [pending] = (await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })).pendingActions
  assert.equal(pending.details.truncated, true)
  assert.ok(pending.details.truncatedFields.includes("diffs"))
  assert.equal(pending.reviewable, false)
  await sessions.dispose()
})

test("truncated tool detail cannot be approved but can still be rejected", async () => {
  const options = [
    { optionId: "allow_once", name: "Yes, just this once", kind: "allow_once" },
    { optionId: "decline", name: "No, continue without running it", kind: "reject_once" },
  ]
  const toolCall = {
    toolCallId: "call-1", title: "Run a long command", kind: "execute", status: "pending",
    rawInput: { command: ["bash", "-lc", "x".repeat(20_000)], cwd: "/tmp" },
  }
  const native = backend({ permissions: options, toolCall }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "run", mode: "workspace-write" })
  const [pending] = (await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })).pendingActions
  assert.equal(pending.details.truncated, true)
  assert.deepEqual(pending.details.truncatedFields, ["command"])
  assert.equal(pending.reviewable, false)
  assert.equal(pending.details.command.length, 16_384)
  await assert.rejects(
    sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "allow_once" }),
    error => { assert.equal(error.code, "codex-sessions.unreviewable_request"); assert.deepEqual(error.data.truncatedFields, ["command"]); return true },
  )
  const declined = await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: pending.requestId, optionId: "decline" })
  assert.equal(declined.accepted, true)
  const finished = await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  assert.equal(finished.wakeReason, "terminal")
  assert.equal(native.persisted.get(admitted.sessionId).lastChoice, "decline")
  await sessions.dispose()
})

test("request IDs are never reused after a history refresh or a new manager", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  const native = backend({ permissions: options }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "write", mode: "workspace-write" })
  const [first] = (await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })).pendingActions
  await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: first.requestId, optionId: "allow_once" })
  await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  // A refreshed history and a rebuilt manager both mint fresh identities, so
  // the answered ID cannot be replayed onto the next request.
  const again = await sessions.start({ sessionId: admitted.sessionId, task: "write again", mode: "workspace-write" })
  const [second] = (await sessions.wait({ sessionId: again.sessionId, waitMs: 2000 })).pendingActions
  assert.notEqual(second.requestId, first.requestId)
  await assert.rejects(sessions.respondPermission({ sessionId: again.sessionId, requestId: first.requestId, optionId: "allow_once" }), /unknown, already answered/)
  const recreated = createCodexSessions(native)
  await recreated.start({ sessionId: admitted.sessionId, task: "third", mode: "workspace-write" }).catch(() => {})
  await assert.rejects(recreated.respondPermission({ sessionId: admitted.sessionId, requestId: second.requestId, optionId: "allow_once" }))
  await recreated.dispose()
  await sessions.dispose()
})

test("stale, unknown and cross-session permission responses are all rejected", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  const native = backend({ permissions: options }), sessions = createCodexSessions(native)
  const first = await sessions.start({ cwd, task: "write", mode: "workspace-write" })
  const second = await sessions.start({ cwd, task: "write too", mode: "workspace-write" })
  const parked = (await sessions.wait({ sessionId: first.sessionId, waitMs: 2000 })).pendingActions[0]
  await assert.rejects(sessions.respondPermission({ sessionId: first.sessionId, requestId: "made-up", optionId: "allow_once" }), /unknown, already answered/)
  await assert.rejects(sessions.respondPermission({ sessionId: second.sessionId, requestId: parked.requestId, optionId: "allow_once" }), /different session/)
  await sessions.respondPermission({ sessionId: first.sessionId, requestId: parked.requestId, optionId: "allow_once" })
  await assert.rejects(sessions.respondPermission({ sessionId: first.sessionId, requestId: parked.requestId, optionId: "allow_once" }), /unknown, already answered/)
  await sessions.dispose()
})

test("interruption settles parked decisions so no request is left dangling", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  const native = backend({ permissions: options }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "hang", mode: "workspace-write" })
  await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  const interrupted = await sessions.interrupt({ sessionId: admitted.sessionId })
  assert.equal(interrupted.interrupted, true)
  const inspected = await sessions.inspect({ sessionId: admitted.sessionId })
  assert.deepEqual(inspected.pendingActions, [])
  await assert.rejects(sessions.respondPermission({ sessionId: admitted.sessionId, requestId: "stale-id", optionId: "allow_once" }))
  await sessions.dispose()
})

test("a bounded permission queue never holds more than its bound", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  // The agent raises five at once against a bound of two.
  const native = backend({ permissions: { options, concurrent: true, count: 5 } })
  const sessions = createCodexSessions({ ...native, maxPendingPermissions: 2 })
  const admitted = await sessions.start({ cwd, task: "write many times", mode: "workspace-write" })
  let peak = 0, finished = false
  for (let round = 0; round < 40 && !finished; round += 1) {
    const state = await sessions.wait({ sessionId: admitted.sessionId, waitMs: 250 })
    peak = Math.max(peak, state.pendingActions.length)
    for (const entry of state.pendingActions)
      await sessions.respondPermission({ sessionId: admitted.sessionId, requestId: entry.requestId, optionId: "allow_once" })
    finished = state.wakeReason === "terminal"
  }
  assert.ok(peak <= 2, "the queue never holds more than its bound")
  assert.equal(finished, true)
  assert.deepEqual((await sessions.inspect({ sessionId: admitted.sessionId })).pendingActions, [])
  await sessions.dispose()
})

test("a queue with no capacity cancels requests instead of buffering them", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  const native = backend({ permissions: options })
  const sessions = createCodexSessions({ ...native, maxPendingPermissions: 0 })
  const admitted = await sessions.start({ cwd, task: "write", mode: "workspace-write" })
  const finished = await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  assert.deepEqual(finished.pendingActions, [])
  assert.equal(finished.wakeReason, "terminal")
  assert.equal(finished.outcome, "incomplete")
  assert.equal(native.persisted.get(admitted.sessionId).lastChoice, undefined)
  await sessions.dispose()
})

test("a request naming another session is never parked as this session's decision", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  const native = backend({ permissions: options, permissionSessionId: "somebody-else" })
  const sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "write", mode: "workspace-write" })
  const finished = await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  assert.deepEqual(finished.pendingActions, [])
  assert.equal(finished.wakeReason, "terminal")
  await sessions.dispose()
})

test("disposal settles parked decisions", async () => {
  const options = [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }]
  const native = backend({ permissions: options }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "hang", mode: "workspace-write" })
  await sessions.wait({ sessionId: admitted.sessionId, waitMs: 2000 })
  await sessions.dispose()
  assert.deepEqual((await sessions.permissions({ sessionId: admitted.sessionId })).pendingActions, [])
})

test("every selectable native Codex mode is exposed with its native policy", async () => {
  const native = backend({ modes: ALL_MODES, initialModeId: "read-only" }), sessions = createCodexSessions(native)
  for (const mode of ALL_MODES) {
    const admitted = await sessions.start({ cwd, task: `run ${mode}`, mode })
    assert.equal(admitted.mode, mode)
    await sessions.wait({ sessionId: admitted.sessionId })
    assert.equal(native.persisted.get(admitted.sessionId).modeAtPrompt, mode)
    assert.equal(admitted.capabilities.defaultMode, "agent")
    assert.deepEqual(admitted.capabilities.modes.map(m => m.id), ALL_MODES)
    assert.equal(admitted.capabilities.filesystemClient, false)
    assert.equal(admitted.capabilities.terminalClient, false)
  }
  await sessions.dispose()
})

test("restart recovers history but does not fabricate execution completion", async () => {
  const native = backend(), before = createCodexSessions(native)
  const admitted = await before.start({ cwd, task: "persisted", mode: "read-only" })
  await before.wait(admitted); await before.dispose()
  const after = createCodexSessions(native), recovered = await after.inspect(admitted)
  assert.equal(recovered.output, "persisted")
  assert.equal(recovered.executionKnown, false)
  assert.equal(recovered.outcome, "unknown")
  const history = await after.messages(admitted)
  assert.deepEqual(history.messages.map(m => m.id), ["user-2", "assistant-3"])
  const resumed = await after.start({ sessionId: admitted.sessionId, task: "recall", mode: "read-only" })
  assert.equal((await after.wait(resumed)).output, "persisted")
  await after.delete(admitted)
  assert.equal(native.persisted.size, 0)
  await after.dispose()
})

test("interruption preserves a session and refuses concurrent continuation", async () => {
  const native = backend(), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "hang" })
  await assert.rejects(sessions.start({ sessionId: admitted.sessionId, task: "duplicate" }), /already running/)
  await assert.rejects(sessions.delete(admitted), /Interrupt/)
  const interrupted = await sessions.interrupt(admitted)
  assert.equal(interrupted.interrupted, true)
  assert.equal((await sessions.inspect(admitted)).status, "interrupted")
  assert.equal(native.persisted.has(admitted.sessionId), true)
  const resumed = await sessions.start({ sessionId: admitted.sessionId, task: "after interruption" })
  assert.equal((await sessions.wait(resumed)).output, "after interruption")
  await sessions.dispose()
})

test("capacity is reserved during admission and released after process cleanup", async () => {
  const native = backend()
  let releaseClose
  const closed = new Promise(resolve => { releaseClose = resolve })
  const sessions = createCodexSessions({ ...native, maxConcurrent: 1, open: async () => ({ target: (await native.open()).target, close: () => closed }) })
  const first = sessions.start({ cwd, task: "one" })
  await assert.rejects(sessions.start({ cwd, task: "two" }), /capacity/)
  const admitted = await first
  await new Promise(resolve => setTimeout(resolve, 10))
  await assert.rejects(sessions.start({ sessionId: admitted.sessionId, task: "three" }), /already running/)
  const history = sessions.messages({ sessionId: admitted.sessionId })
  releaseClose()
  assert.equal((await history).messages.at(-1).text, "one")
  assert.equal((await sessions.inspect(admitted)).mode, "agent")
  await sessions.wait(admitted)
  const next = await sessions.start({ cwd, task: "four" })
  await sessions.wait(next)
  await sessions.dispose()
})

test("provider failures stay bounded and invalid prompts do not run", async () => {
  const native = backend(), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "fail" })
  const failed = await sessions.wait(admitted)
  assert.equal(failed.status, "failed")
  assert.equal(JSON.stringify(failed).includes("private provider"), false)
  await assert.rejects(sessions.start({ cwd: "relative", task: "work" }), /absolute/)
  await assert.rejects(sessions.start({ cwd, task: "x".repeat(65_537) }), /64 KiB/)
  await sessions.dispose()
})

test("the registered RPC returns native sessions through real ACP", async () => {
  const native = backend(), harness = await createHarness({ internals: { direct: native } })
  const admitted = await harness.rpcCall(SESSION_RPC_ID, "start", { cwd, task: "rpc text" })
  const result = await harness.rpcCall(SESSION_RPC_ID, "wait", { sessionId: admitted.sessionId })
  assert.equal(result.output, "rpc text")
  await harness.rpcCall(SESSION_RPC_ID, "delete", { sessionId: admitted.sessionId })
  assert.equal(native.persisted.size, 0)
  const ordinary = await harness.call({ agent: "explore", prompt: "native", description: "test" })
  assert.equal(ordinary.output.sessionID, "ses_native")
})

test("large streamed answers stay bounded and report truncation", async () => {
  const native = backend({ outputOverride: "x".repeat(90_000) }), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "expand" })
  const result = await sessions.wait(admitted)
  assert.equal(result.output.length, 65_536)
  assert.equal(result.outputTruncated, true)
  await sessions.dispose()
})


test("history replay identity changes preserve selected mode without fabricating execution evidence", async () => {
  const native = backend(), sessions = createCodexSessions(native)
  const admitted = await sessions.start({ cwd, task: "first", mode: "workspace-write" })
  await sessions.wait(admitted)
  native.persisted.get(admitted.sessionId).messages.at(-1).id = "native-replay-assistant"
  await sessions.messages(admitted)
  const replayed = await sessions.inspect(admitted)
  assert.equal(replayed.executionKnown, false)
  assert.equal(replayed.outcome, "unknown")
  assert.equal(replayed.mode, "workspace-write")
  const continued = await sessions.start({ sessionId: admitted.sessionId, task: "second" })
  assert.equal(continued.mode, "workspace-write")
  await sessions.wait(continued)
  await sessions.dispose()
})
