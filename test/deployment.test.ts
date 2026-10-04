import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  activateBuild,
  buildDirFor,
  copySourceTree,
  deploymentPaths,
  deploymentStatus,
  getSourceMeta,
  hashSourceTree,
  healthUrl,
  isValidBuildId,
  loadBuildRecord,
  parseHealthPayload,
  pointLinkAtomically,
  prepareBuild,
  readLinkState,
  resolveBaseDir,
  rollbackBuild,
  waitForBuild,
} from "../src/deployment.js";
import { loadBuildInfo, sourceBuildInfo } from "../src/buildInfo.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeSource(tree: Record<string, string>): Promise<string> {
  return (async () => {
    const dir = await tempDir("opencode-deploy-src-");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.5.0" }));
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({}));
    await mkdir(path.join(dir, "src"), { recursive: true });
    for (const [rel, content] of Object.entries(tree)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return dir;
  })();
}

async function seedBuild(baseDir: string, buildId: string): Promise<string> {
  const paths = deploymentPaths(baseDir);
  const dir = buildDirFor(paths, buildId);
  await mkdir(path.join(dir, "dist", "src"), { recursive: true });
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await writeFile(path.join(dir, "dist", "src", "server.js"), "seed");
  await writeFile(path.join(dir, "build.json"), JSON.stringify({
    buildId, version: "0.5.0", commit: null, commitShort: null, branch: null,
    dirty: null, builtAt: new Date().toISOString(), nodeVersion: process.version,
  }));
  return dir;
}

test("build ids are 16-hex and validated", () => {
  assert.equal(isValidBuildId("0123456789abcdef"), true);
  assert.equal(isValidBuildId("SOURCE"), false);
  assert.equal(isValidBuildId("short"), false);
  assert.equal(isValidBuildId("0123456789abcdef0"), false);
  assert.equal(isValidBuildId("0123456789abcdeg"), false);
});

test("base dir prefers env override, health url prefers direct override", () => {
  assert.equal(resolveBaseDir({ OPENCODE_CONNECT_LIB_DIR: "/tmp/custom" }, "/home/u"), "/tmp/custom");
  assert.equal(resolveBaseDir({}, "/home/u"), path.join("/home/u", ".local", "lib", "opencode-connect"));
  assert.equal(healthUrl({ OPENCODE_CONNECT_HEALTH_URL: "http://example/health" }), "http://example/health");
  assert.equal(healthUrl({}), "http://127.0.0.1:8788/health");
});

test("deployment paths stay under the base dir", () => {
  const paths = deploymentPaths("/tmp/base");
  assert.equal(paths.buildsDir, "/tmp/base/builds");
  assert.equal(paths.currentLink, "/tmp/base/current");
  assert.equal(paths.previousLink, "/tmp/base/previous");
  assert.equal(buildDirFor(paths, "0123456789abcdef"), "/tmp/base/builds/0123456789abcdef");
});

test("source hash is deterministic and content-derived", async () => {
  const a = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const b = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const c = await fakeSource({ "src/a.ts": "export const a = 2;\n" });
  try {
    const ha = await hashSourceTree(a);
    const hb = await hashSourceTree(b);
    const hc = await hashSourceTree(c);
    assert.equal(ha.buildId, hb.buildId);
    assert.notEqual(ha.buildId, hc.buildId);
    assert.match(ha.buildId, /^[0-9a-f]{16}$/);
    assert.ok(ha.files.includes("package.json") && ha.files.includes("src/a.ts"));
  } finally {
    await Promise.all([rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true }), rm(c, { recursive: true, force: true })]);
  }
});

test("copy carries runtime sources without checkout node_modules/dist", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const stage = await tempDir("opencode-deploy-stage-");
  try {
    await mkdir(path.join(src, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(src, "node_modules", "dep", "index.js"), "x");
    await mkdir(path.join(src, "dist", "src"), { recursive: true });
    await writeFile(path.join(src, "dist", "src", "server.js"), "stale");
    const target = path.join(stage, "copy");
    await copySourceTree(src, target);
    assert.equal(await readFile(path.join(target, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(await readFile(path.join(target, "package.json"), "utf8"), await readFile(path.join(src, "package.json"), "utf8"));
    await assert.rejects(stat(path.join(target, "node_modules")));
    await assert.rejects(stat(path.join(target, "dist")));
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(stage, { recursive: true, force: true })]);
  }
});

test("symlink switch is atomic and link state round-trips", async () => {
  const base = await tempDir("opencode-deploy-links-");
  try {
    const paths = deploymentPaths(base);
    assert.equal(await readLinkState(paths.currentLink), null);
    const first = await seedBuild(base, "1111111111111111");
    const second = await seedBuild(base, "2222222222222222");
    await pointLinkAtomically(paths.currentLink, first);
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: "1111111111111111", path: first });
    await pointLinkAtomically(paths.currentLink, second);
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: "2222222222222222", path: second });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("health parsing accepts release shape and reports source runs as missing", () => {
  assert.deepEqual(parseHealthPayload({ ok: true, version: "0.5.0", buildId: "abcdef0123456789", build: { buildId: "abcdef0123456789" } }),
    { buildId: "abcdef0123456789", version: "0.5.0", ok: true });
  assert.deepEqual(parseHealthPayload({ ok: true, version: "0.5.0", build: { buildId: "abcdef0123456789" } }),
    { buildId: null, version: "0.5.0", ok: true });
  assert.deepEqual(parseHealthPayload({ ok: true, version: "0.5.0" }), { buildId: null, version: "0.5.0", ok: true });
  assert.deepEqual(parseHealthPayload(null), { buildId: null, version: null, ok: false });
});

test("waitForBuild rejects on wrong or missing build identity", async () => {
  await assert.rejects(
    waitForBuild({ expectedBuildId: "aaaaaaaaaaaaaaaa", fetchHealth: async () => ({ buildId: "bbbbbbbbbbbbbbbb" }), timeoutMs: 10, intervalMs: 5 }),
    /expected healthy build aaaa.*got bbbb/s,
  );
  await assert.rejects(
    waitForBuild({ expectedBuildId: "aaaaaaaaaaaaaaaa", fetchHealth: async () => ({ ok: true }), timeoutMs: 10, intervalMs: 5 }),
    /got null/,
  );
  await assert.rejects(
    waitForBuild({ expectedBuildId: "aaaaaaaaaaaaaaaa", fetchHealth: async () => ({ ok: false, buildId: "aaaaaaaaaaaaaaaa", version: "0.5.0" }), timeoutMs: 10, intervalMs: 5 }),
    /expected healthy build/,
  );
  const ok = await waitForBuild({ expectedBuildId: "aaaaaaaaaaaaaaaa", fetchHealth: async () => ({ ok: true, buildId: "aaaaaaaaaaaaaaaa", version: "0.5.0" }), timeoutMs: 100 });
  assert.equal(ok.buildId, "aaaaaaaaaaaaaaaa");
});

test("activate switches current, preserves previous, restarts once and verifies", async () => {
  const base = await tempDir("opencode-deploy-activate-");
  try {
    const paths = deploymentPaths(base);
    const oldDir = await seedBuild(base, "1111111111111111");
    const newDir = await seedBuild(base, "2222222222222222");
    await pointLinkAtomically(paths.currentLink, oldDir);
    const calls: string[] = [];
    const live = { buildId: "2222222222222222" };
    await activateBuild("2222222222222222", {
      baseDir: base,
      systemctl: async (action) => { calls.push(action); return action === "is-active" ? "active" : ""; },
      fetchHealth: async () => ({ ok: true, buildId: live.buildId, version: "0.5.0" }),
      timeoutMs: 100,
    });
    assert.deepEqual(calls, ["is-active", "restart"]);
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: "2222222222222222", path: newDir });
    assert.deepEqual(await readLinkState(paths.previousLink), { buildId: "1111111111111111", path: oldDir });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("activate failure restores old target and reports rollback ok", async () => {
  const base = await tempDir("opencode-deploy-actfail-");
  try {
    const paths = deploymentPaths(base);
    const oldDir = await seedBuild(base, "1111111111111111");
    await seedBuild(base, "2222222222222222");
    await pointLinkAtomically(paths.currentLink, oldDir);
    const restarts: string[] = [];
    // Live keeps reporting the old build, so new-build verification fails, then
    // old-build verification after restore succeeds.
    await assert.rejects(
      activateBuild("2222222222222222", {
        baseDir: base,
        systemctl: async (action) => { if (action === "restart") restarts.push(action); return action === "is-active" ? "active" : ""; },
        fetchHealth: async () => ({ ok: true, buildId: "1111111111111111", version: "0.5.0" }),
        timeoutMs: 50,
      }),
      /rolled back to 1111111111111111/,
    );
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: "1111111111111111", path: oldDir });
    assert.equal(restarts.length, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rollback swaps previous/current so it stays reversible", async () => {
  const base = await tempDir("opencode-deploy-rollback-");
  try {
    const paths = deploymentPaths(base);
    const cur = await seedBuild(base, "2222222222222222");
    const prev = await seedBuild(base, "1111111111111111");
    await pointLinkAtomically(paths.currentLink, cur);
    await pointLinkAtomically(paths.previousLink, prev);
    const first = await rollbackBuild({
      baseDir: base,
      systemctl: async () => "",
      fetchHealth: async () => ({ ok: true, buildId: "1111111111111111" }),
      timeoutMs: 100,
    });
    assert.equal(first.buildId, "1111111111111111");
    assert.equal(first.previousBuildId, "2222222222222222");
    const second = await rollbackBuild({
      baseDir: base,
      systemctl: async () => "",
      fetchHealth: async () => ({ ok: true, buildId: "2222222222222222" }),
      timeoutMs: 100,
    });
    assert.equal(second.buildId, "2222222222222222");
    await assert.rejects(rollbackBuild({ baseDir: await tempDir("opencode-deploy-empty-"), systemctl: async () => "" }), /no previous/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rollback verification failure restores the original current and previous links", async () => {
  const base = await tempDir("opencode-deploy-rollback-fail-");
  try {
    const paths = deploymentPaths(base);
    const cur = await seedBuild(base, "2222222222222222");
    const prev = await seedBuild(base, "1111111111111111");
    await pointLinkAtomically(paths.currentLink, cur);
    await pointLinkAtomically(paths.previousLink, prev);
    let restarts = 0;
    await assert.rejects(
      rollbackBuild({
        baseDir: base,
        systemctl: async () => { restarts += 1; return ""; },
        fetchHealth: async () => ({ ok: true, buildId: "2222222222222222", version: "0.5.0" }),
        timeoutMs: 20,
      }),
      /rollback failed: .*restored 2222222222222222/,
    );
    assert.equal(restarts, 2);
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: "2222222222222222", path: cur });
    assert.deepEqual(await readLinkState(paths.previousLink), { buildId: "1111111111111111", path: prev });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("prepare reuses an identical build without running npm", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-prepare-");
  try {
    const { buildId } = await hashSourceTree(src);
    await seedBuild(base, buildId);
    let execCalls = 0;
    const result = await prepareBuild({ sourceDir: src, baseDir: base, exec: async () => { execCalls += 1; } });
    assert.equal(result.buildId, buildId);
    assert.equal(result.reused, true);
    assert.equal(execCalls, 0);
    const record = await loadBuildRecord(result.path);
    assert.equal(record.buildId, buildId);
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("fresh prepare builds with the locked toolchain before pruning dev dependencies", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-prepare-fresh-");
  try {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = await prepareBuild({
      sourceDir: src,
      baseDir: base,
      exec: async (cmd, args, cwd) => {
        calls.push({ cmd, args: [...args] });
        if (args[0] === "ci") {
          await mkdir(path.join(cwd, "node_modules"), { recursive: true });
        }
        if (args[0] === "run" && args[1] === "build") {
          await mkdir(path.join(cwd, "dist", "src"), { recursive: true });
          await writeFile(path.join(cwd, "dist", "src", "server.js"), "built\n");
        }
      },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(calls, [
      { cmd: "npm", args: ["ci", "--include=dev"] },
      { cmd: "npm", args: ["run", "build"] },
      { cmd: "npm", args: ["prune", "--omit=dev"] },
    ]);
    assert.equal(await readFile(path.join(result.path, "dist", "src", "server.js"), "utf8"), "built\n");
    assert.equal((await loadBuildRecord(result.path)).buildId, result.buildId);
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("prepare refuses to delete a corrupt build referenced by current", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-protected-");
  try {
    const { buildId } = await hashSourceTree(src);
    const dir = await seedBuild(base, buildId);
    const paths = deploymentPaths(base);
    await pointLinkAtomically(paths.currentLink, dir);
    await rm(path.join(dir, "dist", "src", "server.js"), { force: true });
    await assert.rejects(
      prepareBuild({ sourceDir: src, baseDir: base, exec: async () => {} }),
      /refusing to replace corrupt build .*referenced by current/,
    );
    assert.equal((await stat(dir)).isDirectory(), true);
    assert.equal((await readLinkState(paths.currentLink))?.path, dir);
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("deployment operations refuse a live deployment lock", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-lock-");
  try {
    await writeFile(path.join(base, "deploy.lock"), JSON.stringify({ pid: process.pid, action: "other" }));
    await assert.rejects(
      prepareBuild({ sourceDir: src, baseDir: base, exec: async () => {} }),
      /deployment busy/,
    );
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("status reports links, service state and live/source without throwing", async () => {
  const base = await tempDir("opencode-deploy-status-");
  try {
    const paths = deploymentPaths(base);
    const cur = await seedBuild(base, "aaaaaaaaaaaaaaaa");
    await pointLinkAtomically(paths.currentLink, cur);
    const status = await deploymentStatus({
      baseDir: base,
      sourceDir: base,
      systemctl: async () => "active",
      fetchHealth: async () => ({ ok: true, version: "0.5.0", buildId: "aaaaaaaaaaaaaaaa" }),
    });
    assert.equal(status.current?.buildId, "aaaaaaaaaaaaaaaa");
    assert.equal(status.current?.runnable, true);
    assert.equal(status.previous, null);
    assert.equal(status.service.state, "active");
    assert.equal(status.live.reachable, true);
    assert.equal(status.live.buildId, "aaaaaaaaaaaaaaaa");
    assert.equal(status.drift, false);
    const drifted = await deploymentStatus({
      baseDir: base,
      sourceDir: base,
      systemctl: async () => "active",
      fetchHealth: async () => ({ ok: true, version: "0.5.0", buildId: "bbbbbbbbbbbbbbbb" }),
    });
    assert.equal(drifted.drift, true);
    const down = await deploymentStatus({
      baseDir: base,
      sourceDir: base,
      systemctl: async () => { throw new Error("no bus"); },
      fetchHealth: async () => { throw new Error("refused"); },
    });
    assert.equal(down.live.reachable, false);
    assert.match(down.service.state, /no bus/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("source metadata never throws outside git", async () => {
  const dir = await tempDir("opencode-deploy-nogit-");
  try {
    const meta = await getSourceMeta(dir);
    assert.equal(meta.available, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build info prefers release build.json and falls back to source identity", async () => {
  const release = await tempDir("opencode-deploy-buildinfo-");
  const empty = await tempDir("opencode-deploy-buildinfo-empty-");
  try {
    await writeFile(path.join(release, "build.json"), JSON.stringify({
      buildId: "aaaaaaaaaaaaaaaa", version: "0.5.0", commit: "abc", commitShort: "abc",
      branch: "main", dirty: false, builtAt: new Date().toISOString(),
    }));
    const info = await loadBuildInfo(release);
    assert.equal(info.buildId, "aaaaaaaaaaaaaaaa");
    assert.equal(info.release, true);
    const fallback = await loadBuildInfo(empty);
    assert.equal(fallback.buildId, "source");
    assert.equal(fallback.release, false);
    assert.equal(sourceBuildInfo().buildId, "source");
  } finally {
    await Promise.all([rm(release, { recursive: true, force: true }), rm(empty, { recursive: true, force: true })]);
  }
});
