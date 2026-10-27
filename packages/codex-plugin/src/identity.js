import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const version = value => typeof value === "string" && value.length <= 128 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const buildId = value => typeof value === "string" && /^[0-9a-f]{16}$/.test(value)
const checksum = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
const nullableText = value => value === null || typeof value === "string" && value.length > 0
function completeRecord(record) {
  const keys = ["buildId", "version", "commit", "commitShort", "branch", "dirty", "builtAt", "nodeVersion", "integrity"]
  return record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key)) &&
    [record.commit, record.commitShort, record.branch].every(nullableText) && (record.dirty === null || typeof record.dirty === "boolean") &&
    typeof record.builtAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(record.builtAt) && Number.isFinite(Date.parse(record.builtAt)) && new Date(record.builtAt).toISOString().slice(0, 19) === record.builtAt.slice(0, 19) &&
    typeof record.nodeVersion === "string" && record.nodeVersion.length > 0 && record.integrity && typeof record.integrity === "object" &&
    Object.keys(record.integrity).length === 2 && checksum(record.integrity.sourceHash) && checksum(record.integrity.runtimeHash)
}
function json(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid identity file")
  return JSON.parse(fs.readFileSync(file, "utf8"))
}
const unavailableBuild = reason => ({ kind: "unavailable", buildId: null, reason })

// Only identity-bearing release fields are projected. This is package-relative
// record evidence, not a fresh hash/integrity attestation of the running process.
function readBuild(packageRoot) {
  if (path.basename(packageRoot) !== "codex-plugin" || path.basename(path.dirname(packageRoot)) !== "packages") return unavailableBuild("package-layout-unrecognized")
  const root = path.resolve(packageRoot, "../..")
  let manifest
  try {
    manifest = json(path.join(root, "package.json"))
    if (manifest.name !== "opencode-connect" || !version(manifest.version) || !Array.isArray(manifest.workspaces) || !manifest.workspaces.includes("packages/codex-plugin")) return unavailableBuild("package-layout-unrecognized")
  } catch { return unavailableBuild("package-layout-unrecognized") }
  let record
  try { record = json(path.join(root, "build.json")) }
  catch (error) {
    if (error?.code === "ENOENT") return buildId(path.basename(root))
      ? unavailableBuild("release-record-missing")
      : { kind: "source", buildId: null, evidence: "package-relative-source" }
    return unavailableBuild("release-record-invalid")
  }
  if (!completeRecord(record) || !buildId(record.buildId) || record.buildId !== path.basename(root) || record.version !== manifest.version ||
      !checksum(record.integrity?.sourceHash) || !record.integrity.sourceHash.startsWith(record.buildId) || !checksum(record.integrity?.runtimeHash)) return unavailableBuild("release-record-invalid")
  return { kind: "immutable", buildId: record.buildId, evidence: "package-relative-build-record" }
}

export function readPluginIdentity(moduleUrl = import.meta.url) {
  try {
    // Resolve the loaded module, never cwd, an environment override, or a release
    // current pointer. A standalone installation can still report its package pin.
    const packageRoot = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(moduleUrl))), "..")
    const manifest = json(path.join(packageRoot, "package.json"))
    if (manifest.name !== "opencode-codex-subagent" || !version(manifest.version) || !version(manifest.dependencies?.["@opencode/plugin"])) throw new Error("invalid package identity")
    return { status: "available", packageVersion: manifest.version, nativeVersion: manifest.dependencies["@opencode/plugin"], build: readBuild(packageRoot) }
  } catch { return { status: "unavailable", reason: "package-metadata-unavailable" } }
}

// Capture when this module is loaded: later source edits or pointer changes must
// not silently relabel an already loaded plugin. No plugin options are consulted.
export const loadedPluginIdentity = readPluginIdentity()
