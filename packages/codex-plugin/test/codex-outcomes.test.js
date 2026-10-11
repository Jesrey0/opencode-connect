/**
 * Historical Codex turn outcome recovery.
 *
 * Hermetic: every transport is an in-memory fake. No test spawns `codex`, no
 * test reads the developer's real Codex history, and none contacts a model.
 *
 * The contract under test is deliberately narrow. ACP stays the execution
 * protocol, so this reader may only report what Codex itself persisted about a
 * turn that already ended; anything it cannot correlate, cannot finish reading,
 * or cannot prove must leave the outcome unknown.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { spawnCodexAppServer } from "../src/app-server.js"
import {
  DEFAULT_OUTCOME_TIMEOUT_MS,
  OUTCOME_CACHE_TTL_MS,
  OUTCOME_REQUESTS,
  buildTurnParams,
  createTurnOutcomeReader,
  projectTurnOutcome,
} from "../src/outcomes.js"

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs")
const scratch = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-outcomes-")), name)

const THREAD = "01998f2c-1a2b-7c3d-8e4f-5a6b7c8d9e0f"

/** One terminal turn exactly as Codex persists it. */
function turn(status, overrides = {}) {
  return { id: "turn-1", status, items: [], error: null, completedAt: 1_700_000_000, ...overrides }
}
const page = (status, overrides) => ({ data: [turn(status, overrides)], nextCursor: null })

/**
 * In-memory app-server transport.
 *
 * `threads` maps a thread ID to its newest turn status. Anything absent is
 * unknown to the server, which is how an ACP identity that is not a thread ID,
 * an archived thread, or an unmaterialized one behaves. `failTurns` marks a
 * thread whose turn page the server refuses.
 */
function fakeAppServer({ threads = {}, delayMs = 0, failTurns = [] } = {}) {
  const sent = []
  const opened = []
  let closed = 0
  const open = () => {
    opened.push(true)
    return {
      sent,
      onServerRequest() {},
      async request(method, params) {
        sent.push({ method, params })
        if (method === "initialize") return { userAgent: "codex/0.160.1" }
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
        if (method === "thread/read") {
          // A thread Codex does not know echoes nothing at all.
          if (threads[params.threadId] === undefined) throw new Error("thread not found")
          return { thread: { id: params.threadId } }
        }
        if (method === "thread/turns/list") {
          if (threads[params.threadId] === undefined) throw new Error("thread not found")
          if (failTurns.includes(params.threadId)) throw new Error("provider detail that must not leak")
          return page(threads[params.threadId])
        }
        throw new Error(`unexpected method ${method}`)
      },
      async initialized() { sent.push({ method: "initialized" }) },
      async close() { closed++ },
    }
  }
  return { sent, opened, open, get closed() { return closed } }
}

/** A transport that never answers, so bounded timeouts are exercised. */
const silentAppServer = () => {
  let closed = 0
  return {
    get closed() { return closed },
    open: () => ({
      onServerRequest() {},
      request: (method) => (method === "initialize" ? Promise.resolve({}) : new Promise(() => {})),
      async initialized() {},
      async close() { closed++ },
    }),
  }
}

// --- Projection -----------------------------------------------------------

test("a terminal native turn becomes that outcome, and nothing else does", () => {
  assert.deepEqual(projectTurnOutcome(page("completed"), THREAD), {
    threadId: THREAD, turnId: "turn-1", status: "completed", outcome: "completed", executionOutcome: "completed", error: null,
  })
  assert.deepEqual(projectTurnOutcome(page("failed"), THREAD), {
    threadId: THREAD, turnId: "turn-1", status: "failed", outcome: "failed", executionOutcome: "failed",
    error: { type: "codex-sessions.turn_failed", messageOmitted: true },
  })
  assert.deepEqual(projectTurnOutcome(page("interrupted"), THREAD), {
    threadId: THREAD, turnId: "turn-1", status: "interrupted", outcome: "incomplete", executionOutcome: "interrupted", error: null,
  })
})

test("an unfinished, empty, or unreadable turn is never an outcome", () => {
  // A turn this adapter does not supervise cannot be waited on or interrupted,
  // so its status is not projected as a result and is not cached as one either.
  for (const response of [
    page("inProgress"),
    page("something-new"),
    { data: [], nextCursor: null },
    { data: [{ status: "completed" }] },
    { data: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "failed" }] },
    { data: "not-a-page" },
    null,
    [],
    "not-a-response",
  ]) assert.equal(projectTurnOutcome(response, THREAD), null, JSON.stringify(response))
  // An identity that is not a bounded native ID correlates nothing.
  assert.equal(projectTurnOutcome(page("completed"), ""), null)
  assert.equal(projectTurnOutcome(page("completed"), `x\n${THREAD}`), null)
})

test("a native completion time is never projected", () => {
  const evidence = projectTurnOutcome(page("completed", { completedAt: 1_700_000_000_000 }), THREAD)
  assert.equal("completedAtMs" in evidence, false)
  assert.equal(JSON.stringify(evidence).includes("1700000"), false)
})

test("turn reads carry fixed parameters and refuse an unbounded identity", () => {
  assert.deepEqual(buildTurnParams("thread/read", { threadId: THREAD }), { threadId: THREAD, includeTurns: false })
  assert.deepEqual(buildTurnParams("thread/turns/list", { threadId: THREAD }),
    { threadId: THREAD, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
  for (const args of [{}, { threadId: "" }, { threadId: "x".repeat(513) }, { threadId: "bad\nid" }, { threadId: 7 }, { threadId: THREAD, extra: "steered" }]) {
    // `extra` is dropped rather than forwarded: a caller cannot widen the read.
    if (args.extra) continue
    assert.throws(() => buildTurnParams("thread/turns/list", args), error => error.code === "invalid_input")
  }
  assert.equal("extra" in buildTurnParams("thread/turns/list", { threadId: THREAD, extra: "steered" }), false)
})

// --- Reading --------------------------------------------------------------

test("a recovered outcome is read through identity confirmation, never around it", async () => {
  const server = fakeAppServer({ threads: { [THREAD]: "completed" } })
  const reader = createTurnOutcomeReader({ open: server.open })
  try {
    const found = await reader.read([THREAD])
    assert.equal(found.get(THREAD).outcome, "completed")
    assert.deepEqual(server.sent.map(entry => entry.method), ["initialize", "initialized", "thread/read", "thread/turns/list"])
    // The reader passes one identity; the reader's own parameter builder fixes
    // everything else on the wire (asserted above and over real stdio below).
    assert.deepEqual(server.sent.slice(2).map(entry => entry.params), [{ threadId: THREAD }, { threadId: THREAD }])
    assert.equal(server.closed, 1, "the owned child is reaped with its batch")
    // A history read is not an execution protocol: no turn is ever requested.
    for (const entry of server.sent) assert.equal(/^(turn|thread\/(start|resume|fork))/.test(entry.method), false)
  } finally { await reader.dispose() }
})

test("a thread the app-server does not resolve to itself yields no evidence at all", async () => {
  // The server answers, but its thread claims a different identity than the
  // ACP session ID this read asked about.
  const sent = []
  let opened = 0
  const reader = createTurnOutcomeReader({ open: () => {
    opened++
    return {
      onServerRequest() {},
      request: async (method, params) => {
        sent.push({ method, params })
        if (method === "initialize") return {}
        return { thread: { id: `${params.threadId}-other` } }
      },
      async initialized() { sent.push({ method: "initialized" }) },
      async close() {},
    }
  } })
  try {
    assert.deepEqual([...(await reader.read([THREAD])).keys()], [])
    assert.equal(opened, 1)
    // Fail closed before the turn read: an unproven identity is never queried.
    assert.deepEqual(sent.map(entry => entry.method), ["initialize", "initialized", "thread/read"])
  } finally { await reader.dispose() }
})

test("an unreachable or unmaterialized thread is unknown, and never fails its neighbours", async () => {
  const server = fakeAppServer({ threads: { good: "completed", running: "inProgress", private: "failed" }, failTurns: ["private"] })
  const reader = createTurnOutcomeReader({ open: server.open })
  try {
    const found = await reader.read(["good", "running", "missing", "private"])
    assert.equal(found.get("good").outcome, "completed")
    assert.equal(found.has("running"), false, "an unfinished turn has no outcome")
    assert.equal(found.has("missing"), false, "a thread Codex does not know has no outcome")
    assert.equal(found.has("private"), false, "an unreadable turn page has no outcome")
    assert.equal(server.opened.length, 1)
    // A refused page never becomes evidence, and its provider text is dropped.
    assert.deepEqual([...found.values()].map(evidence => evidence.threadId), ["good"])
  } finally { await reader.dispose() }
})

test("one batch serves a whole page, and the cache keeps later reads off the transport", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `thread-${index}`)
  const server = fakeAppServer({ threads: Object.fromEntries([...ids, "thread-new"].map(id => [id, "completed"])) })
  const reader = createTurnOutcomeReader({ open: server.open, now: () => 0 })
  try {
    const first = await reader.read(ids)
    assert.equal(first.size, 12)
    assert.equal(server.opened.length, 1, "one short-lived child serves the whole page")
    const second = await reader.read(ids)
    assert.equal(second.size, 12)
    assert.equal(server.opened.length, 1, "a cached outcome costs no read")
    assert.equal(server.closed, 1)
    // Uncached rows are read; already-cached ones are not.
    const partial = await reader.read([...ids, "thread-new"])
    assert.equal(partial.size, 13)
    assert.equal(server.opened.length, 2)
    assert.equal(server.sent.filter(entry => entry.method === "thread/read").length, 13)
  } finally { await reader.dispose() }
})

test("an expired cache re-reads native history instead of serving a stale outcome", async () => {
  let at = 0
  const server = fakeAppServer({ threads: { [THREAD]: "failed" } })
  const reader = createTurnOutcomeReader({ open: server.open, now: () => at })
  try {
    assert.equal((await reader.read([THREAD])).get(THREAD).outcome, "failed")
    at = OUTCOME_CACHE_TTL_MS + 1
    assert.equal((await reader.read([THREAD])).get(THREAD).outcome, "failed")
    assert.equal(server.opened.length, 2, "the expired entry was read again from Codex")
    // An in-window read is still free.
    at += 1
    await reader.read([THREAD])
    assert.equal(server.opened.length, 2)
  } finally { await reader.dispose() }
})

test("a new native session revision invalidates an older terminal outcome", async () => {
  const threads = { [THREAD]: "completed" }
  const server = fakeAppServer({ threads })
  const reader = createTurnOutcomeReader({ open: server.open, now: () => 0 })
  try {
    assert.equal((await reader.read([THREAD], { revisions: { [THREAD]: "2026-10-12T01:00:00Z" } })).get(THREAD).status, "completed")
    threads[THREAD] = "inProgress"
    const latest = await reader.read([THREAD], { revisions: { [THREAD]: "2026-10-12T01:01:00Z" } })
    assert.equal(latest.has(THREAD), false, "a previous completion must not mask a newer running turn")
    assert.equal(server.opened.length, 2)
  } finally { await reader.dispose() }
})

test("a page is bounded: one read cannot spawn a process per displayed row", async () => {
  const ids = Array.from({ length: 40 }, (_, index) => `thread-${index}`)
  const server = fakeAppServer({ threads: Object.fromEntries(ids.map(id => [id, "completed"])) })
  const reader = createTurnOutcomeReader({ open: server.open })
  try {
    assert.equal((await reader.read(ids)).size, 25)
    assert.equal(server.opened.length, 1)
  } finally { await reader.dispose() }
})

test("concurrent readers collapse onto one batch and all receive the same evidence", async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `thread-${index}`)
  const server = fakeAppServer({ threads: Object.fromEntries(ids.map(id => [id, "completed"])), delayMs: 5 })
  const reader = createTurnOutcomeReader({ open: server.open })
  try {
    const batches = await Promise.all([reader.read(ids), reader.read(ids), reader.read(ids)])
    for (const batch of batches) assert.equal(batch.size, 6)
    assert.equal(server.opened.length, 1, "one child answers every concurrent reader")
    assert.equal(server.sent.filter(entry => entry.method === "thread/read").length, 6)
  } finally { await reader.dispose() }
})

test("a transport that fails backs off instead of respawning on the next read", async () => {
  let at = 0
  let opened = 0
  const reader = createTurnOutcomeReader({
    now: () => at,
    open: () => { opened++; throw new Error("no app-server here") },
  })
  try {
    assert.equal((await reader.read([THREAD])).size, 0)
    assert.equal((await reader.read([THREAD])).size, 0)
    assert.equal(opened, 1, "a failed read is not retried on every call")
    at = 31_000
    assert.equal((await reader.read([THREAD])).size, 0)
    assert.equal(opened, 2, "the backoff is bounded, not permanent")
  } finally { await reader.dispose() }
})

test("a silent app-server is bounded, and the caller still gets history", async () => {
  const server = silentAppServer()
  const reader = createTurnOutcomeReader({ open: server.open, timeoutMs: 120 })
  try {
    const started = Date.now()
    assert.equal((await reader.read([THREAD])).size, 0)
    assert.ok(Date.now() - started < DEFAULT_OUTCOME_TIMEOUT_MS, "the batch ends on its own bounded budget")
    assert.equal(server.closed, 1, "the owned child is reaped even when it never answers")
  } finally { await reader.dispose() }
})

test("a cancelled read leaves no evidence and never outlives its caller", async () => {
  const controller = new AbortController()
  const server = fakeAppServer({ threads: { [THREAD]: "completed" }, delayMs: 50 })
  const reader = createTurnOutcomeReader({ open: server.open })
  try {
    const pending = reader.read([THREAD], { signal: controller.signal })
    controller.abort()
    assert.deepEqual([...(await pending).keys()].length, 0)
    assert.equal(server.closed, 1)
  } finally { await reader.dispose() }
})

test("a disposed reader answers nothing and keeps nothing", async () => {
  const server = fakeAppServer({ threads: { [THREAD]: "completed" } })
  const reader = createTurnOutcomeReader({ open: server.open })
  assert.equal((await reader.read([THREAD])).size, 1)
  await reader.dispose()
  assert.deepEqual(reader.peek([THREAD]).size, 0)
  assert.equal((await reader.read([THREAD])).size, 0)
  assert.equal(server.opened.length, 1)
})

test("the allowlist names history reads and nothing that can spend or mutate", () => {
  assert.deepEqual([...OUTCOME_REQUESTS], ["thread/read", "thread/turns/list"])
  for (const method of ["thread/start", "thread/resume", "turn/start", "thread/archive", "account/login/start", "config/value/write"])
    assert.equal(OUTCOME_REQUESTS.includes(method), false, `${method} must not be reachable`)
})

// --- Real stdio wire ------------------------------------------------------

/** A `codex` shim that runs the fixture, so the real spawn path is exercised. */
function fixtureBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-outcomes-bin-"))
  const shim = path.join(dir, "codex")
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  return shim
}

/** One outcome read over real stdio against the fake app-server. */
function readThroughStdio(threads, threadId = THREAD) {
  const wire = scratch("wire.jsonl")
  const trace = scratch("trace.txt")
  const reader = createTurnOutcomeReader({
    open: () => spawnCodexAppServer({
      codexPath: fixtureBinary(),
      env: { ...process.env, FAKE_THREADS: threads, FAKE_WIRE: wire, FAKE_TRACE: trace },
      requests: OUTCOME_REQUESTS,
      buildParams: buildTurnParams,
    }),
  })
  return reader.read([threadId]).then(found => ({
    found,
    sent: fs.readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.parse(line)),
    methods: fs.readFileSync(trace, "utf8").trim().split("\n"),
  }))
}

test("the real wire carries one bounded history read and no turn method", async () => {
  const { found, sent, methods } = await readThroughStdio("completed")
  assert.equal(found.get(THREAD).outcome, "completed")
  assert.deepEqual(methods, ["initialize", "initialized", "thread/read", "thread/turns/list"])
  assert.deepEqual(sent[0].params.capabilities, { experimentalApi: false, requestAttestation: false })
  assert.deepEqual(sent[2].params, { threadId: THREAD, includeTurns: false })
  assert.deepEqual(sent[3].params, { threadId: THREAD, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
  assert.equal(/(^|\n)(turn|thread\/(start|resume|fork|items))/.test(methods.join("\n")), false)
})

for (const [native, expected] of [["failed", { status: "failed", outcome: "failed" }], ["interrupted", { status: "interrupted", outcome: "incomplete" }]]) {
  test(`a real ${native} turn is recovered as recorded`, async () => {
    const { found } = await readThroughStdio(native)
    assert.equal(found.get(THREAD).status, expected.status)
    assert.equal(found.get(THREAD).outcome, expected.outcome)
  })
}

for (const native of ["inProgress", "empty", "mismatch", "error"]) {
  test(`a real ${native} history yields no outcome and no provider text`, async () => {
    const { found } = await readThroughStdio(native)
    assert.deepEqual([...found.keys()], [], `${native} must not become an outcome`)
    assert.equal(JSON.stringify([...found.values()]).includes("secret"), false)
  })
}