/**
 * Read-only Codex quota snapshot tests.
 *
 * Hermetic: every transport is either an in-memory fake or the stdio fixture
 * in `fixtures/fake-app-server.mjs`. No test spawns the real `codex` binary and
 * none contacts a model, so the suite consumes no quota.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { createCodexSessions, installCodexSessionsRpc } from "../src/direct.js"
import {
  DEFAULT_USAGE_TIMEOUT_MS,
  MAX_USAGE_TIMEOUT_MS,
  UsageUnavailableError,
  boundUsageTimeout,
  projectUsage,
  readCodexUsage,
  resolveCodexBinary,
  spawnCodexAppServer,
} from "../src/usage.js"

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs")
const POSIX = process.platform !== "win32"

/** Bounded poll for a condition. Never a fixed sleep, never unbounded. */
async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const scratch = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-")), name)

/**
 * An in-memory transport recording every method the client requests, so the
 * allowlist can be asserted directly.
 */
function fakeTransport(handlers = {}) {
  const sent = []
  const serverRequests = []
  let closed = false
  return {
    sent,
    serverRequests,
    get closed() { return closed },
    onServerRequest(fn) { this._listener = fn },
    request(method) {
      sent.push(method)
      const handler = handlers[method]
      // An unhandled method never settles, so timeout and abort paths can be
      // exercised without a real server that stays silent.
      if (!handler) return new Promise(() => {})
      return Promise.resolve().then(() => handler(method))
    },
    async close() { closed = true },
  }
}

const RATE_LIMIT_RESPONSE = {
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: "codex", primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1791709440 }, secondary: null },
  rateLimitsByLimitId: {},
  rateLimitResetCredits: { availableCount: 3, credits: [{ id: "credit_secret", title: "secret" }] },
  accountId: "acct_secret_123",
  rateLimitUpsell: { headline: "buy more" },
}
const ACCOUNT_RESPONSE = {
  account: { type: "chatgpt", email: "person@example.com", planType: "plus" },
  requiresOpenaiAuth: false,
  workspaceRouting: { chatgptAccountId: "acct_secret_123", backendOrigin: "chatgpt.com" },
}

const okTransport = (extra = {}) =>
  fakeTransport({
    initialize: () => ({ userAgent: "codex/0.160.1", codexHome: "/home/user/.codex", platformFamily: "unix", platformOs: "linux" }),
    "account/rateLimits/read": () => RATE_LIMIT_RESPONSE,
    "account/read": () => ACCOUNT_RESPONSE,
    ...extra,
  })

// --- Resolution and bounds -------------------------------------------------

test("the Codex binary resolves from the explicit option, then CODEX_PATH, then PATH", () => {
  const previous = process.env.CODEX_PATH
  try {
    delete process.env.CODEX_PATH
    assert.equal(resolveCodexBinary(undefined), "codex")
    assert.equal(resolveCodexBinary(""), "codex")
    assert.equal(resolveCodexBinary("/usr/local/bin/codex"), "/usr/local/bin/codex")
    process.env.CODEX_PATH = "/opt/codex"
    assert.equal(resolveCodexBinary(undefined), "/opt/codex")
    // An explicit option still wins over the environment.
    assert.equal(resolveCodexBinary("/usr/local/bin/codex"), "/usr/local/bin/codex")
  } finally {
    if (previous === undefined) delete process.env.CODEX_PATH
    else process.env.CODEX_PATH = previous
  }
})

test("a usage timeout is always bounded, never caller-controlled", () => {
  assert.equal(boundUsageTimeout(undefined), DEFAULT_USAGE_TIMEOUT_MS)
  assert.equal(boundUsageTimeout(0), DEFAULT_USAGE_TIMEOUT_MS)
  assert.equal(boundUsageTimeout(-1), DEFAULT_USAGE_TIMEOUT_MS)
  assert.equal(boundUsageTimeout(Number.NaN), DEFAULT_USAGE_TIMEOUT_MS)
  assert.equal(boundUsageTimeout(5_000), 5_000)
  assert.equal(boundUsageTimeout(10 ** 9), MAX_USAGE_TIMEOUT_MS)
})

// --- Projection ------------------------------------------------------------

test("a snapshot carries quota shape and drops every identity field", () => {
  const usage = projectUsage(RATE_LIMIT_RESPONSE, ACCOUNT_RESPONSE, { readAtMs: 1_700_000_000_000 })

  assert.equal(usage.source, "codex-app-server")
  assert.equal(usage.scope, "chatgpt-codex-usage-quota")
  assert.equal(usage.readAtMs, 1_700_000_000_000)
  assert.equal(usage.ordinaryUsageAllowed, true)
  assert.equal(usage.buckets.length, 1)

  const serialized = JSON.stringify(usage)
  for (const secret of ["acct_secret_123", "person@example.com", "chatgpt.com", "buy more", "credit_secret", "secret"]) {
    assert.equal(serialized.includes(secret), false, `"${secret}" must not survive projection`)
  }
  // The whole upstream accountId / workspaceRouting must be gone, not renamed.
  assert.equal("workspaceRouting" in usage, false)
  assert.equal("accountId" in usage, false)
  assert.equal("rateLimitUpsell" in usage, false)
})

test("the account is reduced to billing shape, not to a person", () => {
  const usage = projectUsage(RATE_LIMIT_RESPONSE, ACCOUNT_RESPONSE)
  assert.deepEqual(usage.account, { type: "chatgpt", planType: "plus", requiresOpenaiAuth: false })
})

test("an unauthenticated account reads as unavailable rather than throwing", () => {
  const usage = projectUsage(RATE_LIMIT_RESPONSE, { account: null, requiresOpenaiAuth: true })
  assert.deepEqual(usage.account, { type: null, planType: null, requiresOpenaiAuth: true })
})

test("only the reset-credit count is kept, never ids, titles, or descriptions", () => {
  const usage = projectUsage(RATE_LIMIT_RESPONSE, ACCOUNT_RESPONSE)
  assert.deepEqual(usage.resetCredits, { available: 3 })
})

test("primary and secondary windows are copied verbatim with no derived percentage", () => {
  const usage = projectUsage(
    {
      ordinaryUsageAllowed: true,
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "plus",
          primary: { usedPercent: 57, windowDurationMins: 300, resetsAt: 1791709440 },
          secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1792296240 },
        },
      },
    },
    ACCOUNT_RESPONSE,
  )
  assert.deepEqual(usage.buckets[0].primary, { usedPercent: 57, resetsAt: 1791709440, windowDurationMins: 300 })
  assert.deepEqual(usage.buckets[0].secondary, { usedPercent: 9, resetsAt: 1792296240, windowDurationMins: 10080 })
  // No "percent left" is synthesized: the source forbids inferring availability
  // from percentages, so a derived number here would read as authoritative.
  assert.equal(Object.keys(usage.buckets[0].primary).includes("remainingPercent"), false)
})

test("extra buckets are surfaced verbatim with no model-to-bucket mapping invented", () => {
  const usage = projectUsage(
    {
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 }, normalModelSlug: "gpt-x" },
        "extra-bucket": { limitId: "extra-bucket", limitName: "Extra", primary: { usedPercent: 3.5, windowDurationMins: 60, resetsAt: null } },
      },
    },
    ACCOUNT_RESPONSE,
  )
  assert.deepEqual(usage.buckets.map((bucket) => bucket.bucketKey), ["codex", "extra-bucket"])
  // Backend labels pass through; normalModelSlug is never mapped to a window.
  assert.equal("normalModelSlug" in usage.buckets[0], false)
  assert.equal("models" in usage.buckets[1], false)
  assert.equal(usage.buckets[1].limitName, "Extra")
})

test("the single-bucket view is used when the multi-bucket map is absent", () => {
  const usage = projectUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 9 } } }, ACCOUNT_RESPONSE)
  assert.equal(usage.buckets.length, 1)
  assert.equal(usage.buckets[0].bucketKey, "codex")
})

test("an untyped or malformed upstream payload degrades instead of corrupting", () => {
  assert.throws(() => projectUsage({
    ordinaryUsageAllowed: "yes",
    rateLimitsByLimitId: { codex: { limitId: 7, primary: { usedPercent: "half", windowDurationMins: null, resetsAt: {} } } },
    rateLimitResetCredits: { availableCount: "two" },
  }, undefined), (error) => error instanceof UsageUnavailableError && error.code === "unavailable")
})

test("a window with no usable percentage is dropped rather than shown as zero", () => {
  assert.throws(
    () => projectUsage({ rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: null } } } }, ACCOUNT_RESPONSE),
    (error) => error instanceof UsageUnavailableError && error.code === "unavailable",
  )
})

test("an oversized backend label is truncated instead of trusted", () => {
  const usage = projectUsage({ rateLimitsByLimitId: { codex: { limitId: "x".repeat(1000), primary: { usedPercent: 1 } } } }, ACCOUNT_RESPONSE)
  assert.equal(usage.buckets[0].limitId.length, 128)
})

test("a read with no usable buckets fails as unavailable rather than reporting zero quota", () => {
  assert.throws(() => projectUsage({}, ACCOUNT_RESPONSE), (error) => error instanceof UsageUnavailableError && error.code === "unavailable")
  assert.throws(() => projectUsage(null, ACCOUNT_RESPONSE), (error) => error.code === "unsupported")
})

// --- Read behavior ---------------------------------------------------------

test("the read sends only initialize and the two account reads, in that order", async () => {
  const transport = okTransport()
  const usage = await readCodexUsage({ open: () => transport })

  assert.deepEqual(transport.sent, ["initialize", "account/rateLimits/read", "account/read"])
  assert.equal(transport.closed, true)
  assert.equal(usage.buckets.length, 1)
  // No turn method is ever reachable, so no quota can be spent by reading it.
  for (const method of transport.sent) assert.equal(/^(thread|turn)\//.test(method), false)
})

test("the read is refused outright for any method outside the allowlist", async () => {
  const transport = spawnCodexAppServer({ codexPath: fixtureBinary() })
  try {
    for (const method of ["turn/start", "thread/start", "account/login/start", "account/logout", "config/value/write", "command/exec", "constructor", "toString", "__proto__"]) {
      assert.throws(() => transport.request(method),
        (error) => error instanceof UsageUnavailableError && error.code === "unsupported",
        method + " must be refused")
    }
  } finally {
    await transport.close()
  }
})

test("a failing account read degrades the account without losing the quota snapshot", async () => {
  const transport = okTransport({ "account/read": () => { throw new Error("provider detail") } })
  const usage = await readCodexUsage({ open: () => transport })
  assert.equal(usage.buckets.length, 1)
  assert.deepEqual(usage.account, { type: null, planType: null, requiresOpenaiAuth: null })
})

test("a rejected rate-limit read reports unavailable and omits the provider body", async () => {
  const transport = fakeTransport({
    initialize: () => ({}),
    "account/rateLimits/read": () => { throw new Error("secret provider detail") },
  })
  await assert.rejects(
    () => readCodexUsage({ open: () => transport }),
    (error) => error instanceof UsageUnavailableError && !error.message.includes("secret provider detail"),
  )
})

test("a read that never answers is ended by the bounded timeout and torn down", async () => {
  const transport = fakeTransport({ initialize: () => ({}) })
  await assert.rejects(
    () => readCodexUsage({ open: () => transport, timeoutMs: 60 }),
    (error) => error instanceof UsageUnavailableError && error.message.includes("60ms"),
  )
  assert.equal(transport.closed, true)
})

test("a caller abort ends the read and still tears the client down", async () => {
  const controller = new AbortController()
  const transport = fakeTransport({ initialize: () => ({}) })
  const pending = readCodexUsage({ open: () => transport, signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(() => pending, (error) => error instanceof UsageUnavailableError && error.message.includes("aborted"))
  assert.equal(transport.closed, true)
})

test("an already-cancelled quota read opens no transport", async () => {
  let opened = false
  await assert.rejects(readCodexUsage({ signal: AbortSignal.abort(), open: () => { opened = true; return okTransport() } }), UsageUnavailableError)
  assert.equal(opened, false)
})

for (const reason of ["abort", "timeout"]) test(`a supplementary account ${reason} cannot turn cancellation into success`, async () => {
  const controller = new AbortController()
  const transport = okTransport({ "account/read": () => {
    if (reason === "abort") controller.abort()
    return new Promise(() => {})
  } })
  await assert.rejects(readCodexUsage({ open: () => transport, signal: controller.signal, timeoutMs: 60 }), UsageUnavailableError)
  assert.equal(transport.closed, true)
})

test("a timed-out transport factory is closed when it eventually resolves", async () => {
  let release
  const transport = okTransport()
  const opening = new Promise(resolve => { release = resolve })
  await assert.rejects(readCodexUsage({ open: () => opening, timeoutMs: 60 }), UsageUnavailableError)
  release(transport)
  assert.equal(await until(() => transport.closed, 1000), true)
  assert.deepEqual(transport.sent, [])
})

test("bucket inventory and refused method labels cannot grow without bound", async () => {
  const buckets = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { primary: { usedPercent: 1 } }]))
  assert.throws(() => projectUsage({ rateLimitsByLimitId: buckets }, {}), UsageUnavailableError)
  let release
  const transport = okTransport({ initialize: () => new Promise(resolve => { release = () => resolve({}) }) })
  const pending = readCodexUsage({ open: () => transport })
  assert.equal(await until(() => typeof release === "function", 1000), true)
  transport._listener("x".repeat(1_000_000))
  release()
  const usage = await pending
  assert.ok(usage.refusedServerRequests[0].length <= 128)
})

test("server-initiated request methods are refused and reported", async () => {
  let release
  const transport = okTransport({ initialize: () => new Promise(resolve => { release = () => resolve({}) }) })
  const pending = readCodexUsage({ open: () => transport })
  assert.equal(await until(() => typeof release === "function", 1000), true)
  transport._listener("account/chatgptAuthTokens/refresh")
  transport._listener("item/fileChange/requestApproval")
  release()
  const usage = await pending
  assert.deepEqual(usage.refusedServerRequests, ["account/chatgptAuthTokens/refresh", "item/fileChange/requestApproval"])
})

test("the transport is always closed, even when the read fails", async () => {
  const transport = fakeTransport({ initialize: () => { throw new Error("handshake failed") } })
  await assert.rejects(() => readCodexUsage({ open: () => transport }))
  assert.equal(transport.closed, true)
})

// --- Over real stdio --------------------------------------------------------

/**
 * A tiny shim binary so the node fixture can be launched through the real
 * transport. The transport appends `app-server` to argv, which the fixture
 * ignores, which is exactly how the real binary behaves.
 */
function fixtureBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-bin-"))
  const shim = path.join(dir, "codex")
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  return shim
}

function readThroughStdio(env = {}) {
  return readCodexUsage({ open: () => spawnCodexAppServer({ codexPath: fixtureBinary(), env: { ...process.env, ...env } }) })
}

test("a full snapshot runs over the real spawn + newline-delimited JSON-RPC path", async () => {
  const trace = scratch("trace.txt")
  const usage = await readThroughStdio({ FAKE_RATE_LIMITS: "missing-windows", FAKE_TRACE: trace })

  assert.equal(usage.source, "codex-app-server")
  assert.deepEqual(usage.buckets.map((bucket) => bucket.bucketKey), ["codex", "extra-bucket"])
  assert.deepEqual(usage.buckets[0].primary, { usedPercent: 57, resetsAt: 1791709440, windowDurationMins: 300 })
  assert.deepEqual(usage.buckets[0].individualLimit, { limit: "500", used: "120", remainingPercent: 76, resetsAt: 1792000000 })
  assert.deepEqual(usage.resetCredits, { available: 2 })
  assert.deepEqual(usage.account, { type: "chatgpt", planType: "plus", requiresOpenaiAuth: false })

  const sent = fs.readFileSync(trace, "utf8").split("\n").filter(Boolean)
  assert.deepEqual(sent, ["initialize", "initialized", "account/rateLimits/read", "account/read"])
})

test("stdio handshake includes initialized and fixed non-refreshing parameters", async () => {
  const wire = scratch("wire.jsonl")
  await readThroughStdio({ FAKE_WIRE: wire, FAKE_REQUIRE_INITIALIZED: "1" })
  const sent = fs.readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.parse(line))
  assert.equal(sent[1].method, "initialized")
  assert.equal("id" in sent[1], false)
  assert.equal(sent[0].params.capabilities.experimentalApi, false)
  assert.equal(sent[0].params.capabilities.requestAttestation, false)
  assert.equal("params" in sent[2], false)
  assert.deepEqual(sent[3].params, { refreshToken: false })
})

test("early app-server exit rejects pending reads promptly", async () => {
  const started = Date.now()
  await assert.rejects(readThroughStdio({ FAKE_RATE_LIMITS: "exit" }), UsageUnavailableError)
  assert.ok(Date.now() - started < 5000)
})

test("an oversized unterminated stdio frame fails without retaining its body", async () => {
  await assert.rejects(readThroughStdio({ FAKE_RATE_LIMITS: "oversized" }), error =>
    error instanceof UsageUnavailableError && !error.message.includes("SECRET"))
})

test("the stdio path never sends a turn method, and identity never crosses it", async () => {
  const trace = scratch("trace.txt")
  const usage = await readThroughStdio({ FAKE_RATE_LIMITS: "missing-windows", FAKE_TRACE: trace })
  const sent = fs.readFileSync(trace, "utf8")
  assert.equal(/(^|\n)(thread|turn)\//.test(sent), false)
  for (const secret of ["acct_secret_123", "person@example.com", "chatgpt.com", "credit_secret", "buy more"])
    assert.equal(JSON.stringify(usage).includes(secret), false, `"${secret}" must not cross the transport`)
})

test("a server-initiated token refresh is refused over the real transport", async () => {
  const usage = await readThroughStdio({ FAKE_INITIATE: "account/chatgptAuthTokens/refresh" })
  assert.deepEqual(usage.refusedServerRequests, ["account/chatgptAuthTokens/refresh"])
  assert.equal(JSON.stringify(usage).includes("must-not-be-echoed"), false)
})

test("an unavailable rate-limit read is a bounded error with no provider body", async () => {
  await assert.rejects(
    () => readThroughStdio({ FAKE_RATE_LIMITS: "throw" }),
    (error) =>
      error instanceof UsageUnavailableError &&
      !error.message.includes("provider secret detail"),
  )
})

test("an empty quota read is unavailable, not reported as 0% used", async () => {
  await assert.rejects(
    () => readThroughStdio({ FAKE_RATE_LIMITS: "empty" }),
    (error) => error instanceof UsageUnavailableError && error.message.includes("no quota buckets"),
  )
})

test("a server that never answers is bounded and reaped", async () => {
  const trace = scratch("trace.txt")
  let transport
  try {
    await assert.rejects(
      () => readCodexUsage({
        timeoutMs: 1000,
        open: () => {
          transport = spawnCodexAppServer({ codexPath: fixtureBinary(), env: { ...process.env, FAKE_RATE_LIMITS: "slow", FAKE_TRACE: trace } })
          assert.equal(transport.isRunning(), true)
          return transport
        },
      }),
      (error) => error instanceof UsageUnavailableError && /exceeded its 1000ms limit/.test(error.message),
    )
    assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), ["initialize", "initialized", "account/rateLimits/read"])
    assert.equal(transport.isRunning(), false, "the real app-server exited before the timeout rejection settled")
  } finally {
    await transport?.close()
  }
})

test("a cooperative app-server exits on stdin EOF without ever being signalled", async (t) => {
  if (!POSIX) return t.skip("process-group termination is POSIX-only")
  const transport = spawnCodexAppServer({ codexPath: fixtureBinary(), env: { ...process.env, FAKE_EXIT_MODE: "eof" } })
  assert.equal(transport.isRunning(), true)
  await transport.close()
  assert.equal(transport.isRunning(), false)
  // A second close is a no-op rather than an error.
  await transport.close()
})

test("an uncooperative app-server is reaped through the owned process group", async (t) => {
  if (!POSIX) return t.skip("process-group termination is POSIX-only")
  const pidFile = scratch("grandchild.pid")
  const transport = spawnCodexAppServer({ codexPath: fixtureBinary(), env: { ...process.env, FAKE_EXIT_MODE: "ignore", FAKE_TARGET: pidFile } })
  assert.equal(await until(() => fs.existsSync(pidFile), 10_000), true, "the app-server announced its child")
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"))
  assert.equal(alive(grandchild), true)

  await transport.close()
  assert.equal(transport.isRunning(), false)
  assert.equal(await until(() => !alive(grandchild), 5_000), true, "the owned child was reaped")
})

// --- RPC surface -----------------------------------------------------------

test("the usage RPC returns a sanitized snapshot and opens no session", async () => {
  const usage = await createCodexSessions({ readUsage: () => readCodexUsage({ open: () => okTransport() }) }).usage()
  assert.equal(usage.scope, "chatgpt-codex-usage-quota")
  assert.equal(usage.capabilities.usageQuota, "codex-app-server")
})

test("the usage RPC reports a refusal without leaking the provider body", async () => {
  const sessions = createCodexSessions({
    readUsage: () => Promise.reject(new UsageUnavailableError("provider secret detail", { code: "unavailable" })),
  })
  await assert.rejects(() => sessions.usage(), (error) => error.code === "codex-sessions.unavailable" && !error.message.includes("secret"))
})

test("RPC cancellation reaches the quota reader and disposal awaits cleanup", async () => {
  let received, cleaned = false
  const sessions = createCodexSessions({ readUsage: ({ signal }) => new Promise((_resolve, reject) => {
    received = signal
    signal.addEventListener("abort", () => { cleaned = true; reject(new UsageUnavailableError("cancelled")) }, { once: true })
  }) })
  let handlers
  await installCodexSessionsRpc({ rpc: { register: async (_definition, registered) => { handlers = registered; return { dispose: async () => {} } } } }, { sessions })
  const controller = new AbortController()
  const pending = handlers.usage({}, { signal: controller.signal, error: (type) => ({ type }) })
  await Promise.resolve()
  controller.abort()
  assert.equal((await pending).type, "codex-sessions.unavailable")
  assert.equal(received.aborted, true)
  const next = sessions.usage()
  await Promise.resolve()
  await sessions.dispose()
  await assert.rejects(next)
  assert.equal(cleaned, true)
  await assert.rejects(sessions.usage(), error => error.code === "codex-sessions.unavailable")
})

test("an unsupported quota read surfaces as an unsupported error, not a generic failure", async () => {
  const sessions = createCodexSessions({
    readUsage: () => Promise.reject(new UsageUnavailableError("no such method", { code: "unsupported" })),
  })
  await assert.rejects(() => sessions.usage(), (error) => error.code === "codex-sessions.unsupported")
})

test("a concurrent quota read is rejected rather than spawning a second client", async () => {
  let release
  const sessions = createCodexSessions({
    readUsage: () => new Promise((resolve) => { release = () => resolve({ scope: "chatgpt-codex-usage-quota", buckets: [] }) }),
  })
  const first = sessions.usage()
  await assert.rejects(() => sessions.usage(), (error) => error.code === "codex-sessions.busy")
  release()
  await first
  // A subsequent read owns another gate; release that promise before awaiting.
  const subsequent = sessions.usage()
  release()
  assert.equal((await subsequent).scope, "chatgpt-codex-usage-quota")
})
