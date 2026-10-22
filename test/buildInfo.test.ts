import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuildInfo, loadBuildRecord, sourceBuildInfo } from "../src/buildInfo.js";
import { VERSION } from "../src/version.js";

const record = { buildId: "aaaaaaaaaaaaaaaa", version: VERSION, commit: null, commitShort: null, branch: null,
  dirty: false, builtAt: "2026-10-22T00:00:00.000Z", nodeVersion: process.version,
  integrity: { sourceHash: "a".repeat(64), runtimeHash: "b".repeat(64) } };

test("release identity is complete and fail-closed; missing release metadata is not source mode", async () => {
  const base = await mkdtemp(join(tmpdir(), "opencode-build-info-"));
  const root = join(base, record.buildId);
  await mkdir(root);
  try {
    assert.deepEqual(await loadBuildInfo(base), sourceBuildInfo());
    await assert.rejects(loadBuildInfo(root), { code: "ENOENT" });
    await writeFile(join(root, "build.json"), JSON.stringify(record));
    const info = await loadBuildInfo(root);
    assert.equal(info.release, true);
    assert.equal(info.buildId, record.buildId);
    assert.equal(info.version, VERSION);
    for (const invalid of [
      "not-json", "null", "[]", JSON.stringify({ ...record, buildId: "bbbbbbbbbbbbbbbb" }),
      JSON.stringify({ ...record, version: "0.0.0" }), JSON.stringify({ ...record, version: undefined }),
      JSON.stringify({ ...record, builtAt: undefined }), JSON.stringify({ ...record, nodeVersion: undefined }),
      JSON.stringify({ ...record, dirty: "false" }), JSON.stringify({ ...record, integrity: undefined }),
      JSON.stringify({ ...record, builtAt: "not-a-date" }), JSON.stringify({ ...record, extra: true }),
      JSON.stringify({ ...record, integrity: { ...record.integrity, sourceHash: "b".repeat(64) } }),
    ]) {
      await writeFile(join(root, "build.json"), invalid);
      await assert.rejects(loadBuildInfo(root), /build.json|version/);
    }
    await rm(join(root, "build.json"));
    await mkdir(join(root, "build.json"));
    await assert.rejects(loadBuildInfo(root), /expected a regular file/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("runtime and deployment consume the same strict build record", async () => {
  const base = await mkdtemp(join(tmpdir(), "opencode-build-record-"));
  const root = join(base, record.buildId);
  await mkdir(root);
  try {
    for (const field of Object.keys(record)) {
      await writeFile(join(root, "build.json"), JSON.stringify({ ...record, [field]: undefined }));
      await assert.rejects(loadBuildRecord(root), /invalid build.json/);
      await assert.rejects(loadBuildInfo(root), /invalid build.json/);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("process cwd cannot supply another connector's release identity", async () => {
  const base = await mkdtemp(join(tmpdir(), "opencode-build-cwd-"));
  try {
    await writeFile(join(base, "build.json"), JSON.stringify(record));
    const loader = import.meta.resolve("tsx");
    const module = new URL("../src/buildInfo.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e",
      `import { loadBuildInfo } from ${JSON.stringify(module)}; console.log(JSON.stringify(await loadBuildInfo()));`], { cwd: base });
    assert.deepEqual(JSON.parse(stdout), sourceBuildInfo());
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("loaded source and compiled layouts resolve their own package through a moving symlink", async () => {
  const base = await mkdtemp(join(tmpdir(), "opencode-build-layout-"));
  const root = join(base, record.buildId);
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "dist/src"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    // Native type stripping accepts these .ts files under either layout, so this
    // also exercises root discovery without depending on pre-existing dist output.
    for (const name of ["buildInfo", "version"]) {
      await cp(new URL(`../src/${name}.ts`, import.meta.url), join(root, `src/${name}.ts`));
      await cp(new URL(`../src/${name}.ts`, import.meta.url), join(root, `dist/src/${name}.ts`));
    }
    await symlink(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
    await symlink(root, join(base, "current"), "dir");
    await writeFile(join(root, "build.json"), JSON.stringify(record));
    for (const layout of ["src", "dist/src"]) {
      const loader = import.meta.resolve("tsx");
      const module = join(base, "current", layout, "buildInfo.ts");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e",
        `import { loadBuildInfo } from ${JSON.stringify(module)}; console.log(JSON.stringify(await loadBuildInfo()));`], { cwd: base });
      assert.equal(JSON.parse(stdout).buildId, record.buildId);
      assert.equal(JSON.parse(stdout).release, true);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});
