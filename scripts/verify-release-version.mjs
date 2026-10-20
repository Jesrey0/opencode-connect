// Source-only release gate. Runtime installation verification stays separate:
// README is deliberately absent from immutable release trees.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv.length > 3) throw new Error("Usage: node scripts/verify-release-version.mjs [source-root]");
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = async path => readFile(resolve(root, path), "utf8");
const [manifest, lock, readme, runtime] = await Promise.all([
  read("package.json").then(JSON.parse), read("package-lock.json").then(JSON.parse),
  read("README.md"), import(pathToFileURL(resolve(root, "src/version.ts")).href),
]);
const release = manifest.version;
const introduction = [...readme.matchAll(/^OpenCode Connect \*\*([^*\n]+)\*\* projects/gm)];
const nativePin = [...readme.matchAll(/It pins `@opencode\/client` to \*\*([^*\n]+)\*\*/g)];
if (typeof release !== "string" || !release || introduction.length !== 1 || nativePin.length !== 1)
  throw new Error("Missing or ambiguous package/README release identity");
for (const [label, version] of [
  ["lock", lock.version], ["lock root", lock.packages?.[""]?.version],
  ["runtime VERSION", runtime.VERSION], ["README", introduction[0][1]],
]) {
  if (version !== release) throw new Error(`Release version drift: package=${release}, ${label}=${version}`);
}
if (nativePin[0][1] !== manifest.dependencies?.["@opencode/client"])
  throw new Error("README OpenCode client pin differs from package.json");
console.log(`Source release identity verified: ${release}; OpenCode ${nativePin[0][1]}`);
