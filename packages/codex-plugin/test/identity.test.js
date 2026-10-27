import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { readPluginIdentity } from "../src/identity.js"

const id = "1234567890abcdef"
function fixture(release = false) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-identity-"))
  const root = path.join(parent, release ? id : "source")
  const packageRoot = path.join(root, "packages", "codex-plugin")
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true })
  const manifest = { name: "opencode-codex-subagent", type: "module", version: "0.4.0", dependencies: { "@opencode/plugin": "2.0.24" } }
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-connect", version: "0.16.0", workspaces: ["packages/codex-plugin"] }))
  const modulePath = path.join(packageRoot, "src", "identity.js")
  fs.copyFileSync(new URL("../src/identity.js", import.meta.url), modulePath)
  const record = { buildId: id, version: "0.16.0", commit: null, commitShort: null, branch: null, dirty: false, builtAt: "2026-10-28T00:00:00.000Z", nodeVersion: process.version, integrity: { sourceHash: id + "0".repeat(48), runtimeHash: "a".repeat(64) } }
  return { root, packageRoot, modulePath, url: pathToFileURL(modulePath).href, manifest, record, writeRecord: value => fs.writeFileSync(path.join(root, "build.json"), JSON.stringify(value)), close: () => fs.rmSync(parent, { recursive: true, force: true }) }
}

test("source identity is package-relative and reports the declared native pin without paths or options", () => {
  const f = fixture()
  try {
    const value = readPluginIdentity(f.url)
    assert.deepEqual(value, { status: "available", packageVersion: "0.4.0", nativeVersion: "2.0.24", build: { kind: "source", buildId: null, evidence: "package-relative-source" } })
    assert.equal(JSON.stringify(value).includes(f.root), false)
    fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ ...f.manifest, version: "PRIVATE invalid" }))
    assert.deepEqual(readPluginIdentity(f.url), { status: "unavailable", reason: "package-metadata-unavailable" })
  } finally { f.close() }
})

test("release identity uses its loaded package record and never guesses from a missing or invalid record", () => {
  const f = fixture(true)
  try {
    assert.equal(readPluginIdentity(f.url).build.reason, "release-record-missing")
    f.writeRecord(f.record)
    assert.deepEqual(readPluginIdentity(f.url).build, { kind: "immutable", buildId: id, evidence: "package-relative-build-record" })
    for (const change of [{ builtAt: "not-a-date" }, { builtAt: "2026-02-30T00:00:00Z" }, { dirty: "SECRET" }, { commit: undefined }, { buildId: "fedcba0987654321" }, { version: "0.0.0" }, { integrity: { sourceHash: "a".repeat(64), runtimeHash: "b".repeat(64) } }]) {
      f.writeRecord({ ...f.record, ...change })
      assert.equal(readPluginIdentity(f.url).build.reason, "release-record-invalid")
    }
    fs.writeFileSync(path.join(f.root, "build.json"), "PRIVATE malformed JSON")
    assert.equal(readPluginIdentity(f.url).build.reason, "release-record-invalid")
  } finally { f.close() }
})

test("loaded identity is captured at module load and pointer/source edits do not relabel it", async () => {
  const f = fixture()
  try {
    const loaded = await import(f.url)
    const captured = JSON.stringify(loaded.loadedPluginIdentity)
    fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ ...f.manifest, version: "9.9.9" }))
    assert.equal(JSON.stringify(loaded.loadedPluginIdentity), captured)
    assert.equal(loaded.readPluginIdentity().packageVersion, "9.9.9")
  } finally { f.close() }
})
