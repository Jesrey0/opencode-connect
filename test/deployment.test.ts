import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  parseHealthPayload,
  pointLinkAtomically,
  prepareBuild,
  readLinkState,
  resolveBaseDir,
  rollbackBuild,
  waitForBuild,
  type ExecFn,
} from "../src/deployment.js";
import { isValidBuildId, loadBuildRecord } from "../src/buildInfo.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeSource(tree: Record<string, string>): Promise<string> {
  return (async () => {
    const dir = await tempDir("opencode-deploy-src-");
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({}));
    await mkdir(path.join(dir, "src"), { recursive: true });
    for (const [rel, content] of Object.entries({ ...workspaceFiles, ...tree })) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return dir;
  })();
}

const workspaceFiles: Record<string, string> = {
  "package.json": JSON.stringify({ name: "x", version: "0.10.0", workspaces: ["packages/codex-plugin"] }),
  "scripts/verify-release-version.mjs": "// fixture source gate\n",
  "scripts/verify-integration.mjs": 'await import("../packages/codex-plugin/src/index.js");\n',
  "packages/codex-plugin/package.json": JSON.stringify({ name: "opencode-codex-subagent", version: "0.3.1" }),
  ...Object.fromEntries(["codex", "direct", "permissions", "usage", "stdio", "app-server", "outcomes"].map(name => [`packages/codex-plugin/src/${name}.js`, "export {};\n"])),
  "packages/codex-plugin/src/index.js": 'import "./app-server.js"; import "./outcomes.js";\n',
};

const fixtureExec: ExecFn = async (cmd, args, cwd) => {
  if (cmd === "node") {
    await promisify(execFile)(process.execPath, args, { cwd });
  } else if (args[0] === "ci") {
    await mkdir(path.join(cwd, "node_modules/fixture"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules/fixture/index.js"), "export {};\n");
    await symlink("../packages/codex-plugin", path.join(cwd, "node_modules/opencode-codex-subagent"));
  } else if (args[0] === "run") {
    await mkdir(path.join(cwd, "dist/src"), { recursive: true });
    await writeFile(path.join(cwd, "dist/src/server.js"), "built\n");
    const { version } = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    await writeFile(path.join(cwd, "dist/src/buildInfo.js"), `
      import { readFile } from 'node:fs/promises';
      export async function loadBuildInfo() {
        const record = JSON.parse(await readFile(new URL('../../build.json', import.meta.url), 'utf8'));
        if (record.version !== ${JSON.stringify(version)}) throw new Error('compiled version mismatch');
        return { ...record, release: true };
      }
    `);
  }
};

async function seedBuild(baseDir: string, label: string, sourceDir?: string) {
  const source = sourceDir ?? await fakeSource({ "src/identity.ts": label });
  try { return await prepareBuild({ sourceDir: source, baseDir, exec: fixtureExec }); }
  finally { if (!sourceDir) await rm(source, { recursive: true, force: true }); }
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

test("release source hashing and staging include native build scripts", async () => {
  const src = await fakeSource({
    "src/a.ts": "export const a = 1;\n",
    "scripts/verify-native-client.mjs": "console.log('first');\n",
  });
  const stage = await tempDir("opencode-deploy-scripts-");
  try {
    const first = await hashSourceTree(src);
    assert.ok(first.files.includes("scripts/verify-native-client.mjs"));
    await copySourceTree(src, path.join(stage, "copy"));
    assert.equal(
      await readFile(path.join(stage, "copy", "scripts", "verify-native-client.mjs"), "utf8"),
      "console.log('first');\n",
    );
    await writeFile(path.join(src, "scripts", "verify-native-client.mjs"), "console.log('changed');\n");
    assert.notEqual(first.buildId, (await hashSourceTree(src)).buildId);
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(stage, { recursive: true, force: true })]);
  }
});

test("plugin sources participate in build identity and release staging", async () => {
  const source = await fakeSource({
    "src/a.ts": "export const a = 1;\n",
    "packages/codex-plugin/package.json": JSON.stringify({ name: "opencode-codex-subagent", version: "0.3.1" }),
    "packages/codex-plugin/src/index.js": "export const plugin = 'v1';\n",
    "packages/codex-plugin/src/usage.js": "export const quota = 1;\n",
    "packages/codex-plugin/src/runtime-data.json": "{\"quota\":1}\n",
    "packages/codex-plugin/test/fixture.js": "not shipped or hashed",
  });
  const destination = await tempDir("opencode-deploy-plugin-");
  try {
    const before = await hashSourceTree(source);
    assert.ok(before.files.includes("packages/codex-plugin/src/index.js"));
    assert.ok(before.files.includes("packages/codex-plugin/src/usage.js"));
    assert.ok(before.files.includes("packages/codex-plugin/package.json"));
    assert.equal(before.files.includes("packages/codex-plugin/index.js"), false);
    assert.ok(before.files.includes("packages/codex-plugin/src/runtime-data.json"));
    assert.equal(before.files.includes("packages/codex-plugin/test/fixture.js"), false);
    await copySourceTree(source, destination);
    assert.equal((await hashSourceTree(destination)).buildId, before.buildId);
    assert.equal(
      await readFile(path.join(destination, "packages/codex-plugin/src/usage.js"), "utf8"),
      "export const quota = 1;\n",
    );
    await assert.rejects(stat(path.join(destination, "packages/codex-plugin/test")));
    await writeFile(path.join(source, "packages/codex-plugin/src/usage.js"), "export const quota = 2;\n");
    assert.notEqual((await hashSourceTree(source)).buildId, before.buildId);
  } finally {
    await Promise.all([rm(source, { recursive: true, force: true }), rm(destination, { recursive: true, force: true })]);
  }
});

test("declared workspace packages cannot be silently omitted or partially staged", async () => {
  const source = await fakeSource({
    "package.json": JSON.stringify({ name: "x", version: "1", workspaces: ["packages/codex-plugin"] }),
    "src/a.ts": "export const a = 1;",
  });
  const destination = await tempDir("opencode-deploy-missing-plugin-");
  try {
    await rm(path.join(source, "packages/codex-plugin"), { recursive: true });
    await assert.rejects(copySourceTree(source, destination), /ENOENT/);
    await mkdir(path.join(source, "packages/codex-plugin"), { recursive: true });
    await writeFile(path.join(source, "packages/codex-plugin/package.json"), "{}");
    await assert.rejects(hashSourceTree(source), /ENOENT/);
  } finally { await Promise.all([rm(source, { recursive: true, force: true }), rm(destination, { recursive: true, force: true })]); }
});

test("connector-only sources and builds fail the mandatory workspace invariant before service actions", async () => {
  const source = await fakeSource({ "package.json": JSON.stringify({ name: "x", version: "1" }) });
  const base = await tempDir("opencode-deploy-no-workspace-");
  try {
    await rm(path.join(source, "packages"), { recursive: true });
    await assert.rejects(hashSourceTree(source), /root manifest must declare packages\/codex-plugin/);
    await assert.rejects(copySourceTree(source, path.join(base, "copy")), /root manifest must declare/);
    await assert.rejects(prepareBuild({ sourceDir: source, baseDir: base, exec: async () => { assert.fail("tooling must not run"); } }), /root manifest must declare/);
    const build = await seedBuild(base, "a");
    await writeFile(path.join(build.path, "package.json"), "{}");
    const systemctl = async () => { assert.fail("service must not be touched"); return ""; };
    await assert.rejects(activateBuild(build.buildId, { baseDir: base, systemctl }), /root manifest must declare/);
    await pointLinkAtomically(deploymentPaths(base).previousLink, build.path);
    await assert.rejects(rollbackBuild({ baseDir: base, systemctl }), /root manifest must declare/);
    assert.equal(await readLinkState(deploymentPaths(base).currentLink), null);
  } finally { await Promise.all([rm(source, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
});

test("workspace build validation rejects missing plugin code before any service action", async () => {
  const base = await tempDir("opencode-deploy-incomplete-plugin-");
  try {
    const build = await seedBuild(base, "a");
    await rm(path.join(build.path, "packages/codex-plugin/src/usage.js"));
    await assert.rejects(activateBuild(build.buildId, { baseDir: base, systemctl: async () => { assert.fail("service must not be touched"); } }), /source integrity mismatch/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

for (const name of ["app-server", "outcomes"]) {
  test(`prepare rejects an omitted ${name}.js through the installed import graph, not a static plugin list`, async () => {
    const source = await fakeSource({ "src/a.ts": "export const a = 1;" });
    const base = await tempDir("opencode-deploy-omitted-");
    try {
      await rm(path.join(source, `packages/codex-plugin/src/${name}.js`));
      const { buildId } = await hashSourceTree(source);
      await assert.rejects(prepareBuild({ sourceDir: source, baseDir: base, exec: fixtureExec }), /ERR_MODULE_NOT_FOUND/);
      await assert.rejects(stat(buildDirFor(deploymentPaths(base), buildId)), { code: "ENOENT" });
      assert.equal(await readLinkState(deploymentPaths(base).currentLink), null);
    } finally { await Promise.all([rm(source, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
  });
}

const corruptions: Record<string, (root: string) => Promise<void>> = {
  "missing app-server.js": root => rm(path.join(root, "packages/codex-plugin/src/app-server.js")),
  "missing outcomes.js": root => rm(path.join(root, "packages/codex-plugin/src/outcomes.js")),
  "missing plugin manifest": root => rm(path.join(root, "packages/codex-plugin/package.json")),
  "missing server output": root => rm(path.join(root, "dist/src/server.js")),
  "missing compiled identity": root => rm(path.join(root, "dist/src/buildInfo.js")),
  "missing dependency": root => rm(path.join(root, "node_modules/fixture/index.js")),
  "tampered source": root => writeFile(path.join(root, "src/a.ts"), "tampered"),
  "tampered compiled output": root => writeFile(path.join(root, "dist/src/server.js"), "tampered"),
  "tampered dependency": root => writeFile(path.join(root, "node_modules/fixture/index.js"), "tampered"),
  "malformed build record": root => writeFile(path.join(root, "build.json"), "null"),
  "missing build record": root => rm(path.join(root, "build.json")),
  "incomplete build record": async root => {
    const record = JSON.parse(await readFile(path.join(root, "build.json"), "utf8"));
    delete record.integrity;
    await writeFile(path.join(root, "build.json"), JSON.stringify(record));
  },
  "mismatched record identity": async root => {
    const record = JSON.parse(await readFile(path.join(root, "build.json"), "utf8"));
    await writeFile(path.join(root, "build.json"), JSON.stringify({ ...record, buildId: "aaaaaaaaaaaaaaaa" }));
  },
  "mismatched record version": async root => {
    const record = JSON.parse(await readFile(path.join(root, "build.json"), "utf8"));
    await writeFile(path.join(root, "build.json"), JSON.stringify({ ...record, version: "0.0.0" }));
  },
  "external runtime link": async root => {
    await rm(path.join(root, "node_modules/opencode-codex-subagent"));
    await symlink(process.cwd(), path.join(root, "node_modules/opencode-codex-subagent"));
  },
};

for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`reuse, activation and rollback reject ${name} without service or link mutation`, async () => {
    const source = await fakeSource({ "src/a.ts": "export const a = 1;" });
    const base = await tempDir("opencode-deploy-integrity-");
    try {
      const build = await seedBuild(base, "unused", source);
      const paths = deploymentPaths(base);
      await pointLinkAtomically(paths.previousLink, build.path);
      await corrupt(build.path);
      const before = await readLinkState(paths.previousLink);
      let serviceCalls = 0;
      const systemctl = async () => { serviceCalls++; assert.fail("invalid release must not reach service actions"); return ""; };
      await assert.rejects(prepareBuild({ sourceDir: source, baseDir: base, exec: fixtureExec }), /refusing to reuse corrupt build/);
      await assert.rejects(activateBuild(build.buildId, { baseDir: base, systemctl }));
      await assert.rejects(rollbackBuild({ baseDir: base, systemctl }));
      assert.equal(serviceCalls, 0);
      assert.equal(await readLinkState(paths.currentLink), null);
      assert.deepEqual(await readLinkState(paths.previousLink), before);
      assert.equal((await stat(build.path)).isDirectory(), true, "corrupt immutable candidates are preserved");
    } finally { await Promise.all([rm(source, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
  });
}

test("prepare rejects a sealed build whose compiled runtime reports a different identity", async () => {
  const source = await fakeSource({ "src/a.ts": "export const a = 1;" });
  const base = await tempDir("opencode-deploy-runtime-identity-");
  try {
    const { buildId } = await hashSourceTree(source);
    await assert.rejects(prepareBuild({ sourceDir: source, baseDir: base, exec: async (cmd, args, cwd) => {
      await fixtureExec(cmd, args, cwd);
      if (args[0] === "run") await writeFile(path.join(cwd, "dist/src/buildInfo.js"), `export async function loadBuildInfo() { return { release: true, buildId: ${JSON.stringify(buildId)}, version: '0.0.0' }; }`);
    } }), /compiled release identity mismatch/);
    await assert.rejects(stat(buildDirFor(deploymentPaths(base), buildId)), { code: "ENOENT" });
  } finally { await Promise.all([rm(source, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
});

test("build tooling cannot mutate source inputs under an unchanged release identity", async () => {
  const source = await fakeSource({ "src/a.ts": "export const a = 1;" });
  const base = await tempDir("opencode-deploy-source-race-");
  try {
    await assert.rejects(prepareBuild({ sourceDir: source, baseDir: base, exec: async (_cmd, args, cwd) => {
      if (args[0] === "run") await writeFile(path.join(cwd, "src/a.ts"), "export const a = 2;");
    } }), /release inputs changed during build/);
    assert.equal(await readLinkState(deploymentPaths(base).currentLink), null);
  } finally { await Promise.all([rm(source, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
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

test("release inputs reject file and directory symlinks instead of copying unhashed external state", async () => {
  const source = await fakeSource({ "src/a.ts": "export const a = 1;" });
  try {
    await symlink("a.ts", path.join(source, "src/link.ts"));
    await assert.rejects(hashSourceTree(source), /regular file or directory/);
    await rm(path.join(source, "src/link.ts"));
    await rm(path.join(source, "scripts"), { recursive: true });
    await symlink("src", path.join(source, "scripts"));
    await assert.rejects(hashSourceTree(source), /regular directory/);
    await rm(path.join(source, "scripts"));
    await rm(path.join(source, "tsconfig.json"));
    await symlink("package.json", path.join(source, "tsconfig.json"));
    await assert.rejects(hashSourceTree(source), /regular file/);
  } finally { await rm(source, { recursive: true, force: true }); }
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
    const old = await seedBuild(base, "old");
    const next = await seedBuild(base, "next");
    await pointLinkAtomically(paths.currentLink, old.path);
    const calls: string[] = [];
    const live = { buildId: next.buildId };
    await activateBuild(next.buildId, {
      baseDir: base,
      systemctl: async (action) => { calls.push(action); return action === "is-active" ? "active" : ""; },
      fetchHealth: async () => ({ ok: true, buildId: live.buildId, version: "0.5.0" }),
      timeoutMs: 100,
    });
    assert.deepEqual(calls, ["is-active", "restart"]);
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: next.buildId, path: next.path });
    assert.deepEqual(await readLinkState(paths.previousLink), { buildId: old.buildId, path: old.path });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("activate failure restores old target and reports rollback ok", async () => {
  const base = await tempDir("opencode-deploy-actfail-");
  try {
    const paths = deploymentPaths(base);
    const old = await seedBuild(base, "old");
    const next = await seedBuild(base, "next");
    await pointLinkAtomically(paths.currentLink, old.path);
    const restarts: string[] = [];
    // Live keeps reporting the old build, so new-build verification fails, then
    // old-build verification after restore succeeds.
    await assert.rejects(
      activateBuild(next.buildId, {
        baseDir: base,
        systemctl: async (action) => { if (action === "restart") restarts.push(action); return action === "is-active" ? "active" : ""; },
        fetchHealth: async () => ({ ok: true, buildId: old.buildId, version: "0.10.0" }),
        timeoutMs: 50,
      }),
      new RegExp(`rolled back to ${old.buildId}`),
    );
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: old.buildId, path: old.path });
    assert.equal(restarts.length, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rollback between integrity-verified workspace releases stays reversible", async () => {
  const base = await tempDir("opencode-deploy-rollback-");
  try {
    const paths = deploymentPaths(base);
    const cur = await seedBuild(base, "current");
    const prev = await seedBuild(base, "previous");
    await pointLinkAtomically(paths.currentLink, cur.path);
    await pointLinkAtomically(paths.previousLink, prev.path);
    const first = await rollbackBuild({
      baseDir: base,
      systemctl: async () => "",
      fetchHealth: async () => ({ ok: true, buildId: prev.buildId }),
      timeoutMs: 100,
    });
    assert.equal(first.buildId, prev.buildId);
    assert.equal(first.previousBuildId, cur.buildId);
    const second = await rollbackBuild({
      baseDir: base,
      systemctl: async () => "",
      fetchHealth: async () => ({ ok: true, buildId: cur.buildId }),
      timeoutMs: 100,
    });
    assert.equal(second.buildId, cur.buildId);
    const empty = await tempDir("opencode-deploy-empty-");
    try { await assert.rejects(rollbackBuild({ baseDir: empty, systemctl: async () => "" }), /no previous/); }
    finally { await rm(empty, { recursive: true, force: true }); }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rollback verification failure restores the original current and previous links", async () => {
  const base = await tempDir("opencode-deploy-rollback-fail-");
  try {
    const paths = deploymentPaths(base);
    const cur = await seedBuild(base, "current");
    const prev = await seedBuild(base, "previous");
    await pointLinkAtomically(paths.currentLink, cur.path);
    await pointLinkAtomically(paths.previousLink, prev.path);
    let restarts = 0;
    await assert.rejects(
      rollbackBuild({
        baseDir: base,
        systemctl: async () => { restarts += 1; return ""; },
        fetchHealth: async () => ({ ok: true, buildId: cur.buildId, version: "0.10.0" }),
        timeoutMs: 20,
      }),
      new RegExp(`rollback failed: .*restored ${cur.buildId}`),
    );
    assert.equal(restarts, 2);
    assert.deepEqual(await readLinkState(paths.currentLink), { buildId: cur.buildId, path: cur.path });
    assert.deepEqual(await readLinkState(paths.previousLink), { buildId: prev.buildId, path: prev.path });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("prepare reuses an identical build only after installed integration and compiled identity verification", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-prepare-");
  try {
    const { buildId } = await hashSourceTree(src);
    await seedBuild(base, "unused", src);
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const result = await prepareBuild({ sourceDir: src, baseDir: base, exec: async (cmd, args, cwd) => { calls.push({ cmd, args: [...args], cwd }); await fixtureExec(cmd, args, cwd); } });
    assert.equal(result.buildId, buildId);
    assert.equal(result.reused, true);
    assert.deepEqual(calls.slice(0, 2), [
      { cmd: "node", args: ["scripts/verify-release-version.mjs"], cwd: src },
      { cmd: "node", args: ["scripts/verify-integration.mjs"], cwd: result.path },
    ]);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].args[0], "--input-type=module");
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
        await fixtureExec(cmd, args, cwd);
      },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(calls.slice(0, 5), [
      { cmd: "node", args: ["scripts/verify-release-version.mjs"] },
      { cmd: "npm", args: ["ci", "--include=dev"] },
      { cmd: "npm", args: ["run", "build"] },
      { cmd: "npm", args: ["prune", "--omit=dev"] },
      { cmd: "node", args: ["scripts/verify-integration.mjs"] },
    ]);
    assert.equal(calls.length, 6);
    assert.equal(calls[5].cmd, "node");
    assert.equal(calls[5].args[0], "--input-type=module");
    assert.equal(await readFile(path.join(result.path, "dist", "src", "server.js"), "utf8"), "built\n");
    assert.equal((await loadBuildRecord(result.path)).buildId, result.buildId);
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("source release gate failure blocks preparation and reuse without changing a candidate", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-release-gate-");
  try {
    const { buildId } = await hashSourceTree(src);
    for (const existing of [false, true]) {
      if (existing) await seedBuild(base, "unused", src);
      const calls: string[] = [];
      await assert.rejects(prepareBuild({ sourceDir: src, baseDir: base, exec: async (cmd, args, cwd) => {
        assert.equal(cwd, src);
        calls.push(`${cmd} ${args.join(" ")}`);
        throw new Error("Release version drift");
      } }), /Release version drift/);
      assert.deepEqual(calls, ["node scripts/verify-release-version.mjs"]);
      assert.equal(await readLinkState(deploymentPaths(base).currentLink), null);
      if (existing) assert.equal((await loadBuildRecord(path.join(base, "builds", buildId))).buildId, buildId);
    }
  } finally { await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
});

test("prepare never replaces corrupt immutable builds, including missing records and referenced builds", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-protected-");
  try {
    const { path: dir } = await seedBuild(base, "unused", src);
    const paths = deploymentPaths(base);
    await pointLinkAtomically(paths.currentLink, dir);
    await rm(path.join(dir, "dist", "src", "server.js"), { force: true });
    await assert.rejects(
      prepareBuild({ sourceDir: src, baseDir: base, exec: async () => {} }),
      /refusing to reuse corrupt build/,
    );
    assert.equal((await stat(dir)).isDirectory(), true);
    assert.equal((await readLinkState(paths.currentLink))?.path, dir);
    await rm(paths.currentLink);
    await rm(path.join(dir, "build.json"));
    await assert.rejects(prepareBuild({ sourceDir: src, baseDir: base, exec: fixtureExec }), /refusing to reuse corrupt build/);
    assert.equal((await stat(dir)).isDirectory(), true);
  } finally {
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("all deployment mutations contend on one lock and release it after failure", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-lock-");
  let entered!: () => void, release!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const owner = prepareBuild({ sourceDir: src, baseDir: base, exec: async () => { entered(); await released; throw new Error("fixture build failed"); } });
  const failure = assert.rejects(owner, /fixture build failed/);
  try {
    await holding;
    const lock = path.join(base, "deploy.lock.sqlite");
    const inode = (await stat(lock)).ino;
    const rejectEffects = async () => { assert.fail("contender must not execute tooling or service actions"); };
    const contenders = [
      prepareBuild({ sourceDir: src, baseDir: base, exec: rejectEffects }),
      activateBuild("aaaaaaaaaaaaaaaa", { baseDir: base, systemctl: rejectEffects }),
      rollbackBuild({ baseDir: base, systemctl: rejectEffects }),
    ];
    for (const result of await Promise.allSettled(contenders)) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(result.reason.message, /deployment is already owned/);
    }
    assert.equal(await readLinkState(deploymentPaths(base).currentLink), null);
    release(); await failure;
    await assert.rejects(prepareBuild({ sourceDir: src, baseDir: base, exec: async () => { throw new Error("successor admitted"); } }), /successor admitted/);
    assert.equal((await stat(lock)).ino, inode, "normal release never replaces or unlinks the lock");
  } finally {
    release(); await failure;
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("deployment ownership recovers after SIGKILL without stale-lock reclamation", { timeout: 15_000 }, async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-crash-");
  const module = new URL("../src/deployment.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { prepareBuild } from ${JSON.stringify(module)};
    await prepareBuild({ sourceDir: ${JSON.stringify(src)}, baseDir: ${JSON.stringify(base)},
      exec: async () => { process.stdout.write('ready'); await new Promise(() => setInterval(() => {}, 1000)); } });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("deployment holder exited before ready"); })]);
    const lock = path.join(base, "deploy.lock.sqlite"), inode = (await stat(lock)).ino;
    await assert.rejects(prepareBuild({ sourceDir: src, baseDir: base, exec: async () => assert.fail("live owner") }), /deployment is already owned/);
    child.kill("SIGKILL");
    assert.equal((await exited)[1], "SIGKILL");
    await assert.rejects(prepareBuild({ sourceDir: src, baseDir: base, exec: async () => { throw new Error("successor admitted"); } }), /successor admitted/);
    assert.equal((await stat(lock)).ino, inode);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  }
});

test("deployment lock corruption fails closed without deleting the lock or changing links", async () => {
  const src = await fakeSource({ "src/a.ts": "export const a = 1;\n" });
  const base = await tempDir("opencode-deploy-lock-corrupt-");
  const lock = path.join(base, "deploy.lock.sqlite");
  try {
    const bytes = "not a SQLite database".repeat(100);
    await writeFile(lock, bytes);
    const rejectEffects = async () => { assert.fail("corrupt lock must prevent side effects"); };
    await assert.rejects(prepareBuild({ sourceDir: src, baseDir: base, exec: rejectEffects }));
    await assert.rejects(activateBuild("aaaaaaaaaaaaaaaa", { baseDir: base, systemctl: rejectEffects }));
    await assert.rejects(rollbackBuild({ baseDir: base, systemctl: rejectEffects }));
    assert.equal(await readFile(lock, "utf8"), bytes);
    assert.equal(await readLinkState(deploymentPaths(base).currentLink), null);
  } finally { await Promise.all([rm(src, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]); }
});

test("status reports links, service state and live/source without throwing", async () => {
  const base = await tempDir("opencode-deploy-status-");
  try {
    const paths = deploymentPaths(base);
    const cur = await seedBuild(base, "current");
    await pointLinkAtomically(paths.currentLink, cur.path);
    const status = await deploymentStatus({
      baseDir: base,
      sourceDir: base,
      systemctl: async () => "active",
      fetchHealth: async () => ({ ok: true, version: "0.10.0", buildId: cur.buildId }),
    });
    assert.equal(status.current?.buildId, cur.buildId);
    assert.equal(status.current?.runnable, true);
    assert.equal(status.previous, null);
    assert.equal(status.service.state, "active");
    assert.equal(status.live.reachable, true);
    assert.equal(status.live.buildId, cur.buildId);
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
