import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native client guard rejects drift and accepts an aligned install", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-client-guard-"));
  const client = join(root, "node_modules", "@opencode", "client");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(client, { recursive: true });
    mkdirSync(join(client, "dist", "promise"), { recursive: true });
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/verify-native-client.mjs");
    const script = join(root, "scripts", "verify-native-client.mjs");
    copyFileSync(source, script);
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@opencode/client": "2.0.24" } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@opencode/client": { version: "2.0.24" } } }));
    const installed = (version: string) => writeFileSync(join(client, "package.json"), JSON.stringify({
      name: "@opencode/client", version, type: "module", exports: { import: "./dist/promise/index.js" },
    }));
    writeFileSync(join(client, "dist", "promise", "index.js"), "export const ready = true;\n");

    installed("2.0.22");
    const stale = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /native client mismatch/);
    assert.match(stale.stderr, /installed=2\.0\.22/);

    installed("2.0.24");
    const aligned = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(aligned.status, 0, aligned.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
