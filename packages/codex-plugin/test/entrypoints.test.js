import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"
import * as entrypoint from "opencode-codex-subagent"
import * as direct from "../src/direct.js"

test("the pinned native directory loader and npm export load the same src entry", async () => {
  const source = fileURLToPath(new URL("../src", import.meta.url))
  const entry = Host.resolve({ directory: source }).server
  assert.equal(entry, import.meta.resolve("opencode-codex-subagent"))
  const loaded = await Host.load(entry)
  assert.equal(loaded, entrypoint)
})

test("local configuration must name src, not the package root", () => {
  assert.equal(Host.resolve({ directory: fileURLToPath(new URL("..", import.meta.url)) }).server, undefined)
})

test("plugin modules expose no helper aliases owned by other modules", () => {
  for (const name of ["CODEX_DEFAULT_MODE", "CODEX_SESSION_MODES", "DEFAULT_TIMEOUT_MS", "CodexSessionsRpc", "SESSION_RPC_ID", "DEFAULT_USAGE_TIMEOUT_MS", "MAX_USAGE_TIMEOUT_MS", "UsageUnavailableError", "projectUsage", "readCodexUsage"])
    assert.equal(Object.hasOwn(entrypoint, name), false, name)
  for (const name of ["CODEX_DEFAULT_MODE", "CODEX_SESSION_MODES", "UsageUnavailableError"])
    assert.equal(Object.hasOwn(direct, name), false, name)
})
