import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/verify-release-version.mjs", import.meta.url));
test("release gate accepts one identity and rejects independently stale owning sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-release-version-"));
  const source: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module", version: "1.2.3", dependencies: { "@opencode/client": "2.0.24" } }),
    "package-lock.json": JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }),
    "src/version.ts": 'export const VERSION = "1.2.3";\n',
    "README.md": 'OpenCode Connect **1.2.3** projects native operations. It pins `@opencode/client` to **2.0.24**.\n',
  };
  const run = () => execFileSync(process.execPath, [script, root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    await mkdir(join(root, "src"));
    for (const [path, text] of Object.entries(source)) await writeFile(join(root, path), text);
    assert.match(run(), /Source release identity verified: 1\.2\.3/);
    for (const [path, stale, reason] of [
      ["README.md", source["README.md"].replace("1.2.3", "1.2.2"), /README=1\.2\.2/],
      ["src/version.ts", source["src/version.ts"].replace("1.2.3", "1.2.2"), /runtime VERSION=1\.2\.2/],
      ["package-lock.json", JSON.stringify({ version: "1.2.2", packages: { "": { version: "1.2.3" } } }), /lock=1\.2\.2/],
      ["package-lock.json", JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.2" } } }), /lock root=1\.2\.2/],
      ["README.md", source["README.md"].replace("2.0.24", "2.0.23"), /client pin differs/],
      ["README.md", "No release declaration\n", /Missing or ambiguous/],
    ] as const) {
      await writeFile(join(root, path), stale);
      assert.throws(run, reason, path);
      await writeFile(join(root, path), source[path]);
    }
    await rm(join(root, "README.md"));
    assert.throws(run, /ENOENT/, "missing source README cannot silently skip the release gate");
    assert.equal(await readFile(join(root, "src/version.ts"), "utf8"), source["src/version.ts"], "verification is read-only");
  } finally { await rm(root, { recursive: true, force: true }); }
});
