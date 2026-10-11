/**
 * Transport-level tests: the real spawn + newline-delimited ACP stdio path,
 * with no codex-acp process and no model quota.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { resolveCodexAcpEntry, resolveNodeBinary, runCodexTurn, spawnCodexAcp } from "../src/codex.js"

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-stdio.mjs")
const SHUTDOWN_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "shutdown-acp-stdio.mjs")
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
const scratch = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-shutdown-")), name)

test("codex-acp is launched with an explicit node binary, never process.execPath", () => {
  assert.equal(resolveNodeBinary(undefined), "node")
  assert.equal(resolveNodeBinary(""), "node")
  assert.equal(resolveNodeBinary("/usr/bin/node24"), "/usr/bin/node24")
  assert.notEqual(resolveNodeBinary(undefined), process.execPath)
})

test("the codex-acp entrypoint resolves from the pinned package", () => {
  const entry = resolveCodexAcpEntry()
  assert.match(entry, /@agentclientprotocol\/codex-acp\/dist\/index\.js$/)
})

test("runs a full turn over real spawn + ndjson stdio", async () => {
  const result = await runCodexTurn({
    open: () =>
      Promise.resolve(
        spawnCodexAcp({ nodePath: "node", entry: FIXTURE, cwd: path.dirname(FIXTURE) }),
      ),
    cwd: path.dirname(FIXTURE),
    prompt: "say hello",
    timeoutMs: 20000,
  })

  assert.equal(result.sessionID, "stdio-session")
  assert.equal(result.text, "stdio ok")
  assert.equal(result.stopReason, "end_turn")
  // The fixture starts in agent-full-access; the plugin must force read-only.
  assert.equal(result.mode, "read-only")
})

test("the spawned child is reaped and stdin errors do not escape", async () => {
  const transport = spawnCodexAcp({ nodePath: "node", entry: FIXTURE, cwd: path.dirname(FIXTURE) })
  assert.equal(transport.isRunning(), true)

  await transport.close()
  assert.equal(transport.isRunning(), false)
  // A second close is a no-op rather than an error.
  await transport.close()
})

test("a cooperative agent is given stdin EOF before it is ever signalled", async () => {
  const marker = scratch("eof.txt")
  const transport = spawnCodexAcp({ nodePath: "node", entry: SHUTDOWN_FIXTURE, cwd: path.dirname(SHUTDOWN_FIXTURE), env: { ...process.env, SHUTDOWN_MODE: "exit-on-eof", SHUTDOWN_TARGET: marker } })
  assert.equal(fs.existsSync(marker), false)
  await transport.close()
  assert.equal(fs.existsSync(marker), true, "shutdown went through graceful EOF, not a signal")
  assert.equal(transport.isRunning(), false)
})

test("an uncooperative agent and its child are reaped through the owned process group", async (t) => {
  if (!POSIX) return t.skip("process-group termination is POSIX-only")
  const pidFile = scratch("grandchild.pid")
  const transport = spawnCodexAcp({ nodePath: "node", entry: SHUTDOWN_FIXTURE, cwd: path.dirname(SHUTDOWN_FIXTURE), env: { ...process.env, SHUTDOWN_MODE: "ignore", SHUTDOWN_TARGET: pidFile } })
  assert.equal(await until(() => fs.existsSync(pidFile), 10_000), true, "the agent announced its child")
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"))
  assert.equal(alive(grandchild), true)

  await transport.close()
  assert.equal(transport.isRunning(), false)
  // Signalling only the ACP process would leave its Codex-shaped child running.
  assert.equal(await until(() => !alive(grandchild), 5_000), true, "the owned child was reaped")
})

test("a missing codex-acp entrypoint surfaces a bounded error", async () => {
  await assert.rejects(
    () =>
      runCodexTurn({
        open: () =>
          Promise.resolve(
            spawnCodexAcp({ nodePath: "node", entry: path.join(path.dirname(FIXTURE), "missing.mjs"), cwd: "/" }),
          ),
        cwd: "/",
        prompt: "hi",
        timeoutMs: 15000,
      }),
    (error) => error instanceof Error,
  )
})