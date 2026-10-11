/**
 * A fake Codex app-server that speaks the newline-delimited JSON-RPC surface
 * `codex app-server` exposes on stdio.
 *
 * It answers only the read methods this plugin is allowed to send, records
 * every method it received so a test can assert the allowlist was respected,
 * and can be configured to attempt a server-initiated request (an approval or
 * a token refresh) so the client's refusal path is exercised.
 *
 * Nothing here contacts a model or consumes quota.
 *
 *   node fixtures/fake-app-server.mjs
 *
 * Environment:
 *   FAKE_RATE_LIMITS   "empty" | "missing-windows" | "untyped" | "throw" | "slow"
 *   FAKE_ACCOUNT       "ok" | "throw" | "null"
 *   FAKE_INITIATE      "refresh" | "approval" | ""  (send one server->client request)
 *   FAKE_EXIT_MODE     "eof" | "ignore" | "term"
 *   FAKE_TARGET        marker file path used by FAKE_EXIT_MODE=ignore
 *   FAKE_TRACE         newline-delimited log of every method received
 */

import fs from "node:fs"

const lines = []
let buffered = ""
process.stdin.on("data", (chunk) => {
  buffered += chunk.toString("utf8")
  for (;;) {
    const end = buffered.indexOf("\n")
    if (end < 0) break
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    if (line.trim()) lines.push(JSON.parse(line))
  }
})

const rateLimitShape = process.env.FAKE_RATE_LIMITS ?? "ok"
const accountShape = process.env.FAKE_ACCOUNT ?? "ok"

function rateLimits() {
  if (rateLimitShape === "throw") return { error: { code: -32000, message: "provider secret detail that must not leak" } }
  if (rateLimitShape === "empty") return { result: { ordinaryUsageAllowed: null, rateLimitsByLimitId: {}, rateLimitResetCredits: null } }
  if (rateLimitShape === "missing-windows")
    return {
      result: {
        ordinaryUsageAllowed: false,
        // Identity fields the projection must drop.
        accountId: "acct_secret_123",
        rateLimitUpsell: { headline: "buy more" },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [{ id: "credit_secret", resetType: "window", status: "available", grantedAt: 1, expiresAt: null, title: "secret title", description: "secret description" }],
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            normalModelSlug: "some-model-slug",
            primary: { usedPercent: 57, windowDurationMins: 300, resetsAt: 1791709440 },
            secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1792296240 },
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            individualLimit: { limit: "500", used: "120", remainingPercent: 76, resetsAt: 1792000000 },
            spendControlReached: false,
            planType: "plus",
            rateLimitReachedType: null,
          },
          // A second, extra bucket the plugin must surface without guessing
          // which models it governs.
          "extra-bucket": { limitId: "extra-bucket", limitName: "Extra", primary: { usedPercent: 3.5, windowDurationMins: 60, resetsAt: null } },
        },
      },
    }
  if (rateLimitShape === "untyped")
    return {
      result: {
        ordinaryUsageAllowed: "yes",
        rateLimitsByLimitId: { codex: { limitId: 7, primary: { usedPercent: "half", windowDurationMins: null, resetsAt: {} } } },
        rateLimitResetCredits: { availableCount: "two" },
      },
    }
  return {
    result: {
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex", primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1791709440 }, secondary: null },
      rateLimitsByLimitId: {},
      rateLimitResetCredits: { availableCount: 0, credits: [] },
      accountId: "acct_secret_123",
      rateLimitUpsell: null,
    },
  }
}

function account() {
  if (accountShape === "throw") return { error: { code: -32000, message: "account read failed" } }
  if (accountShape === "null") return { result: { account: null, requiresOpenaiAuth: true } }
  return {
    result: {
      account: { type: "chatgpt", email: "person@example.com", planType: "plus" },
      requiresOpenaiAuth: false,
      workspaceRouting: { chatgptAccountId: "acct_secret_123", backendOrigin: "chatgpt.com", accountRoutingOverride: null },
    },
  }
}

function write(message) {
  try { process.stdout.write(`${JSON.stringify(message)}\n`) } catch {}
}

let initiated = false
let initialized = false

function maybeInitiate() {
  if (initiated || !process.env.FAKE_INITIATE) return
  initiated = true
  const method = process.env.FAKE_INITIATE
  write({ jsonrpc: "2.0", id: 9001, method, params: method === "account/chatgptAuthTokens/refresh" ? { tokens: { access_token: "must-not-be-echoed" } } : {} })
}

async function drain() {
  for (const message of lines.splice(0)) {
    const { id, method, params } = message
    if (process.env.FAKE_TRACE) fs.appendFileSync(process.env.FAKE_TRACE, `${method}\n`)
    if (process.env.FAKE_WIRE) fs.appendFileSync(process.env.FAKE_WIRE, `${JSON.stringify(message)}\n`)

    if (method === undefined) continue // client refusal, not another request
    if (method === "initialized") { initialized = true; continue }
    if (method !== "initialize" && process.env.FAKE_REQUIRE_INITIALIZED && !initialized) {
      write({ id, error: { code: -32000, message: "Not initialized" } })
      continue
    }

    if (method === "initialize") {
      write({ jsonrpc: "2.0", id, result: { userAgent: "codex/0.160.1", codexHome: "/home/user/.codex", platformFamily: "unix", platformOs: "linux" } })
      continue
    }
    if (method === "account/rateLimits/read" && rateLimitShape === "slow") {
      // Never answers; the client's own timeout must end the read.
      continue
    }
    if (method === "account/rateLimits/read" && rateLimitShape === "exit") process.exit(0)
    if (method === "account/rateLimits/read" && rateLimitShape === "oversized") {
      process.stdout.write("SECRET".repeat(200_000))
      continue
    }
    if (method === "account/rateLimits/read") {
      const shape = rateLimits()
      if (shape.error) write({ jsonrpc: "2.0", id, error: shape.error })
      else write({ jsonrpc: "2.0", id, result: shape.result })
      continue
    }
    if (method === "account/read") {
      const shape = account()
      if (shape.error) write({ jsonrpc: "2.0", id, error: shape.error })
      else write({ jsonrpc: "2.0", id, result: shape.result })
      continue
    }
    // Anything outside the read allowlist is refused, mirroring how a real
    // app-server would reject a method that does not exist.
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
  }
  maybeInitiate()
}

const tick = setInterval(() => void drain(), 5)
tick.unref?.()

if (process.env.FAKE_TARGET) {
  // Announce a grandchild so a test can prove the whole owned group is reaped.
  const { spawn } = await import("node:child_process")
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: false })
  fs.writeFileSync(process.env.FAKE_TARGET, String(child.pid))
}

if (process.env.FAKE_EXIT_MODE !== "ignore") {
  process.stdin.on("end", () => process.exit(process.env.FAKE_EXIT_MODE === "term" ? 0 : 0))
}
process.on("SIGTERM", () => process.exit(0))
