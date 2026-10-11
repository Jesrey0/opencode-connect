import "./verify-native-client.mjs"
import { readFileSync, realpathSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"
// Node 24 strips types natively; this declaration has no relative runtime
// imports. No compiler/dev dependency or source-text approximation is needed.
import { CodexSessionsDefinition } from "../src/codexRpc.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative) => JSON.parse(readFileSync(resolve(root, relative), "utf8"))
const connector = read("package.json")
const plugin = read("packages/codex-plugin/package.json")
const lock = read("package-lock.json")
const clientVersion = connector.dependencies["@opencode/client"]
const pluginVersion = plugin.dependencies["@opencode/plugin"]
if (clientVersion !== pluginVersion || plugin.dependencies["@opencode/schema"] !== pluginVersion || !/^\d+\.\d+\.\d+$/.test(clientVersion)) {
  throw new Error("OpenCode client/plugin version drift: " + clientVersion + " != " + pluginVersion)
}
if (!connector.workspaces?.includes("packages/codex-plugin") ||
    !lock.packages?.["packages/codex-plugin"] ||
    lock.packages?.["node_modules/opencode-codex-subagent"]?.resolved !== "packages/codex-plugin" ||
    lock.packages?.["node_modules/opencode-codex-subagent"]?.link !== true) {
  throw new Error("Plugin is not present in the root npm workspace lock")
}
for (const [name, version] of Object.entries(plugin.dependencies)) {
  if (lock.packages["packages/codex-plugin"].dependencies?.[name] !== version)
    throw new Error("Plugin manifest/lock dependency drift: " + name)
}
for (const name of ["@opencode/plugin", "@opencode/schema"])
  if (lock.packages["node_modules/" + name]?.version !== pluginVersion)
    throw new Error("Locked OpenCode dependency version drift: " + name)
const entrypoint = import.meta.resolve("opencode-codex-subagent")
if (realpathSync(fileURLToPath(entrypoint)) !== realpathSync(resolve(root, "packages/codex-plugin/src/index.js")))
  throw new Error("Installed plugin does not resolve to this workspace's source")
if (Host.resolve({ directory: resolve(root, "packages/codex-plugin/src") }).server !== entrypoint)
  throw new Error("Native directory loader does not resolve to the workspace's plugin entry")
for (const name of ["@opencode/plugin", "@opencode/schema"]) {
  const installed = JSON.parse(readFileSync(findPackageJSON(name, entrypoint), "utf8"))
  if (installed.version !== pluginVersion) throw new Error("Installed OpenCode dependency version drift: " + name)
}
// Resolve the declaration from the verified installed workspace, not a facade
// alias. Importing it does not run plugin setup or start a native session.
const { CodexSessionsRpc } = await import(new URL("./direct.js", entrypoint).href)
const methods = Object.keys(CodexSessionsDefinition.methods).sort()
if (CodexSessionsRpc.id !== CodexSessionsDefinition.id || JSON.stringify(Object.keys(CodexSessionsRpc.methods).sort()) !== JSON.stringify(methods))
  throw new Error("Connector/plugin RPC method sets differ")
console.log("Integration contract verified: " + methods.length + " Codex RPC methods; OpenCode " + clientVersion)
