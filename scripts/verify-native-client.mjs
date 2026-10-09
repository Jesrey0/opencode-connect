import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const declared = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"))
  .dependencies["@opencode/client"];
const locked = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8"))
  .packages["node_modules/@opencode/client"].version;

let installed;
try {
  const entry = fileURLToPath(import.meta.resolve("@opencode/client"));
  installed = JSON.parse(readFileSync(resolve(dirname(entry), "../..", "package.json"), "utf8")).version;
} catch {
  console.error("OpenCode native client is missing. Run npm ci before building or testing.");
  process.exit(1);
}

if (declared !== locked || installed !== declared) {
  console.error(
    `OpenCode native client mismatch (declared=${declared}, locked=${locked}, installed=${installed}). Run npm ci.`,
  );
  process.exit(1);
}
