import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export const SERVICE_NAME = "opencode-connect.service";
export const BUILD_ID_RE = /^[0-9a-f]{16}$/;
const FIXED_SOURCE_FILES = ["package.json", "package-lock.json", "tsconfig.json"];

export type SourceMeta = {
  available: boolean;
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  dirty: boolean | null;
};

export type BuildRecord = {
  buildId: string;
  version: string;
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  dirty: boolean | null;
  builtAt: string;
  nodeVersion: string;
};

export type LinkState = { buildId: string; path: string } | null;

export type DeploymentPaths = {
  baseDir: string;
  buildsDir: string;
  currentLink: string;
  previousLink: string;
};

export function isValidBuildId(value: string): boolean {
  return BUILD_ID_RE.test(value);
}

export function resolveBaseDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const override = env.OPENCODE_CONNECT_LIB_DIR?.trim();
  if (override) return override;
  return path.join(home, ".local", "lib", "opencode-connect");
}

export function deploymentPaths(baseDir: string): DeploymentPaths {
  const base = path.resolve(baseDir);
  return {
    baseDir: base,
    buildsDir: path.join(base, "builds"),
    currentLink: path.join(base, "current"),
    previousLink: path.join(base, "previous"),
  };
}

export function buildDirFor(paths: DeploymentPaths, buildId: string): string {
  return path.join(paths.buildsDir, buildId);
}

export function healthUrl(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.OPENCODE_CONNECT_HEALTH_URL?.trim();
  if (direct) return direct;
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT?.trim() || "8788");
  return `http://${host}:${Number.isSafeInteger(port) ? port : 8788}/health`;
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function getSourceMeta(sourceDir: string): Promise<SourceMeta> {
  const commit = await git(["rev-parse", "HEAD"], sourceDir);
  if (!commit) return { available: false, commit: null, commitShort: null, branch: null, dirty: null };
  const [branchRaw, statusRaw] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], sourceDir),
    git(["status", "--porcelain"], sourceDir),
  ]);
  // status --porcelain prints nothing when clean but exec trims to null; any
  // output means dirty. A null here is ambiguous (clean vs git failure), so
  // re-check with an explicit exit-code probe only when needed.
  let dirty: boolean | null = null;
  if (statusRaw !== null) dirty = statusRaw.length > 0;
  else {
    try {
      await execFileAsync("git", ["diff", "--quiet"], { cwd: sourceDir, timeout: 10_000 });
      dirty = false;
    } catch (error: unknown) {
      dirty = error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === 1 ? true : null;
    }
  }
  return {
    available: true,
    commit,
    commitShort: commit.slice(0, 12),
    branch: branchRaw,
    dirty,
  };
}

async function collectSourceFiles(sourceDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of FIXED_SOURCE_FILES) {
    try {
      const stat = await fs.stat(path.join(sourceDir, name));
      if (stat.isFile()) found.push(name);
    } catch {
      // missing fixed file: hashing still proceeds; prepare validates later
    }
  }
  const srcDir = path.join(sourceDir, "src");
  const stack: string[] = [srcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push(path.relative(sourceDir, full));
      }
    }
  }
  return [...new Set(found)].sort();
}

export async function hashSourceTree(sourceDir: string): Promise<{ buildId: string; files: string[] }> {
  const files = await collectSourceFiles(sourceDir);
  const overall = createHash("sha256");
  overall.update(`count:${files.length}\n`);
  for (const rel of files) {
    const data = await fs.readFile(path.join(sourceDir, rel));
    const fileHash = createHash("sha256").update(data).digest("hex");
    overall.update(`${rel}\0${fileHash}\n`);
  }
  return { buildId: overall.digest("hex").slice(0, 16), files };
}

export async function readSourceVersion(sourceDir: string): Promise<string> {
  const raw = await fs.readFile(path.join(sourceDir, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) throw new Error("package.json has no version");
  return parsed.version;
}

export async function readLinkState(linkPath: string): Promise<LinkState> {
  let target: string;
  try {
    target = await fs.readlink(linkPath);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT") return null;
    throw error;
  }
  const resolved = path.resolve(path.dirname(linkPath), target);
  return { buildId: path.basename(resolved), path: resolved };
}

// Atomic symlink switch: create a sibling temp link, then rename over the
// destination. rename(2) within one directory is atomic for observers.
export async function pointLinkAtomically(linkPath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(tmp, { force: true });
  try {
    await fs.symlink(targetPath, tmp);
    await fs.rename(tmp, linkPath);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function acquireDeploymentLock(paths: DeploymentPaths, action: string): Promise<() => Promise<void>> {
  await fs.mkdir(paths.baseDir, { recursive: true });
  const lockPath = path.join(paths.baseDir, "deploy.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, action, createdAt: new Date().toISOString() }) + "\n");
      return async () => {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      };
    } catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "EEXIST")) throw error;
      let stale = false;
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid);
        if (!Number.isSafeInteger(pid) || pid <= 0) stale = true;
        else {
          try { process.kill(pid, 0); }
          catch (probe: unknown) {
            stale = !!(probe && typeof probe === "object" && "code" in probe && (probe as { code: unknown }).code === "ESRCH");
          }
        }
      } catch {
        stale = true;
      }
      if (stale && attempt === 0) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      throw new Error(`deployment busy: ${lockPath}`);
    }
  }
  throw new Error(`deployment busy: ${lockPath}`);
}

export async function loadBuildRecord(buildDir: string): Promise<BuildRecord> {
  const raw = await fs.readFile(path.join(buildDir, "build.json"), "utf8");
  let parsed: Partial<BuildRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<BuildRecord>;
  } catch {
    throw new Error(`invalid build.json in ${buildDir}`);
  }
  if (!parsed || typeof parsed.buildId !== "string" || !isValidBuildId(parsed.buildId)) {
    throw new Error(`invalid build.json in ${buildDir}`);
  }
  if (path.basename(path.resolve(buildDir)) !== parsed.buildId) throw new Error(`build.json mismatch in ${buildDir}`);
  if (typeof parsed.version !== "string" || typeof parsed.builtAt !== "string") {
    throw new Error(`incomplete build.json in ${buildDir}`);
  }
  return parsed as BuildRecord;
}

async function assertRunnableBuild(buildDir: string, buildId: string): Promise<void> {
  await loadBuildRecord(buildDir);
  try {
    const stat = await fs.stat(path.join(buildDir, "dist", "src", "server.js"));
    if (!stat.isFile()) throw new Error();
  } catch {
    throw new Error(`build ${buildId} is incomplete: missing dist/src/server.js`);
  }
  try {
    const stat = await fs.stat(path.join(buildDir, "node_modules"));
    if (!stat.isDirectory()) throw new Error();
  } catch {
    throw new Error(`build ${buildId} is incomplete: missing node_modules`);
  }
}

export async function copySourceTree(sourceDir: string, stageDir: string): Promise<void> {
  await fs.mkdir(stageDir, { recursive: true });
  for (const name of FIXED_SOURCE_FILES) {
    await fs.copyFile(path.join(sourceDir, name), path.join(stageDir, name));
  }
  await fs.cp(path.join(sourceDir, "src"), path.join(stageDir, "src"), { recursive: true });
}

export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<void>;

const defaultExec: ExecFn = async (cmd, args, cwd) => {
  await execFileAsync(cmd, args, { cwd, timeout: 300_000 });
};

export type PrepareResult = {
  buildId: string;
  path: string;
  reused: boolean;
  record: BuildRecord;
};

export async function prepareBuild(options: {
  sourceDir: string;
  baseDir?: string;
  exec?: ExecFn;
}): Promise<PrepareResult> {
  const sourceDir = path.resolve(options.sourceDir);
  const paths = deploymentPaths(options.baseDir ?? resolveBaseDir());
  const releaseLock = await acquireDeploymentLock(paths, "prepare");
  try {
  const exec = options.exec ?? defaultExec;
  const { buildId } = await hashSourceTree(sourceDir);
  const target = buildDirFor(paths, buildId);
  try {
    const record = await loadBuildRecord(target);
    await assertRunnableBuild(target, buildId);
    return { buildId, path: target, reused: true, record };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT") {
      // fall through to fresh build
    } else if (error instanceof Error && /incomplete|invalid|mismatch/.test(error.message)) {
      const [current, previous] = await Promise.all([
        readLinkState(paths.currentLink),
        readLinkState(paths.previousLink),
      ]);
      const protectedBy = [
        current?.path === target ? "current" : null,
        previous?.path === target ? "previous" : null,
      ].filter(Boolean);
      if (protectedBy.length > 0) {
        throw new Error(`refusing to replace corrupt build ${buildId}: referenced by ${protectedBy.join(" and ")}`);
      }
      await fs.rm(target, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
  const meta = await getSourceMeta(sourceDir);
  const version = await readSourceVersion(sourceDir);
  const stage = path.join(paths.buildsDir, `.stage-${buildId}-${process.pid}`);
  await fs.rm(stage, { recursive: true, force: true });
  try {
    await fs.mkdir(paths.buildsDir, { recursive: true });
    await copySourceTree(sourceDir, stage);
    // Build in the isolated release tree with the full locked toolchain, then
    // prune development-only dependencies so the installed release remains
    // self-contained without depending on the checkout's node_modules.
    await exec("npm", ["ci", "--include=dev"], stage);
    await exec("npm", ["run", "build"], stage);
    await exec("npm", ["prune", "--omit=dev"], stage);
    const record: BuildRecord = {
      buildId,
      version,
      commit: meta.commit,
      commitShort: meta.commitShort,
      branch: meta.branch,
      dirty: meta.dirty,
      builtAt: new Date().toISOString(),
      nodeVersion: process.version,
    };
    await fs.writeFile(path.join(stage, "build.json"), `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(stage, target);
    return { buildId, path: target, reused: false, record };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  } finally {
    await releaseLock();
  }
}

export function parseHealthPayload(body: unknown): { buildId: string | null; version: string | null; ok: boolean } {
  if (!body || typeof body !== "object") return { buildId: null, version: null, ok: false };
  const record = body as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version : null;
  const buildId = typeof record.buildId === "string" ? record.buildId : null;
  return { buildId, version, ok: record.ok === true };
}

export type SystemctlFn = (action: "is-active" | "restart" | "stop") => Promise<string>;

export const defaultSystemctl: SystemctlFn = async (action) => {
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", action, SERVICE_NAME], { timeout: 60_000 });
    return stdout.trim();
  } catch (error: unknown) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String((error as { stdout: unknown }).stdout).trim() : "";
    if (action === "is-active" && stdout) return stdout;
    throw new Error(`systemctl --user ${action} ${SERVICE_NAME} failed${stdout ? `: ${stdout}` : ""}`);
  }
};

export type FetchHealthFn = (url: string) => Promise<unknown>;

export const defaultFetchHealth: FetchHealthFn = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok && response.status !== 503) throw new Error(`/health returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
};

export async function waitForBuild(options: {
  expectedBuildId: string;
  url?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchHealth?: FetchHealthFn;
}): Promise<{ buildId: string | null; version: string | null }> {
  const url = options.url ?? healthUrl();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const deadline = Date.now() + timeoutMs;
  let last = { buildId: null as string | null, version: null as string | null, ok: false };
  let lastError: string | null = null;
  while (Date.now() <= deadline) {
    try {
      last = parseHealthPayload(await fetchHealth(url));
      lastError = null;
      if (last.ok && last.buildId === options.expectedBuildId) return last;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() + intervalMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const actual = last.buildId === null && lastError ? `unreachable (${lastError})` : String(last.buildId);
  const health = last.ok ? "" : " with unhealthy status";
  throw new Error(`verification failed: expected healthy build ${options.expectedBuildId}, got ${actual}${health}`);
}

export type ActivateResult = {
  buildId: string;
  path: string;
  previousBuildId: string | null;
};

export class ActivationFailedError extends Error {
  readonly rollback: "ok" | "failed" | "not-needed";
  readonly rollbackError: string | null;
  constructor(message: string, rollback: "ok" | "failed" | "not-needed", rollbackError: string | null = null) {
    super(message);
    this.name = "ActivationFailedError";
    this.rollback = rollback;
    this.rollbackError = rollbackError;
  }
}

export async function activateBuild(
  buildId: string,
  options: {
    baseDir?: string;
    url?: string;
    timeoutMs?: number;
    systemctl?: SystemctlFn;
    fetchHealth?: FetchHealthFn;
  } = {},
): Promise<ActivateResult> {
  if (!isValidBuildId(buildId)) throw new Error(`invalid buildId: ${buildId}`);
  const paths = deploymentPaths(options.baseDir ?? resolveBaseDir());
  const releaseLock = await acquireDeploymentLock(paths, "activate");
  try {
  const systemctl = options.systemctl ?? defaultSystemctl;
  const target = buildDirFor(paths, buildId);
  await assertRunnableBuild(target, buildId);
  const oldCurrent = await readLinkState(paths.currentLink);
  if (oldCurrent && oldCurrent.path === target) {
    await systemctl("restart");
    await waitForBuild({ expectedBuildId: buildId, url: options.url, timeoutMs: options.timeoutMs, fetchHealth: options.fetchHealth });
    const prev = await readLinkState(paths.previousLink);
    return { buildId, path: target, previousBuildId: prev?.buildId ?? null };
  }
  const oldPrevious = await readLinkState(paths.previousLink);
  let wasActive = true;
  try {
    wasActive = (await systemctl("is-active")).trim() === "active";
  } catch {
    wasActive = false;
  }
  if (oldCurrent) await pointLinkAtomically(paths.previousLink, oldCurrent.path);
  await pointLinkAtomically(paths.currentLink, target);
  try {
    await systemctl("restart");
    await waitForBuild({ expectedBuildId: buildId, url: options.url, timeoutMs: options.timeoutMs, fetchHealth: options.fetchHealth });
    return { buildId, path: target, previousBuildId: oldCurrent?.buildId ?? null };
  } catch (error) {
    const activationError = error instanceof Error ? error.message : String(error);
    if (!oldCurrent) {
      throw new ActivationFailedError(`${activationError} (no previous target to restore)`, "not-needed");
    }
    try {
      await pointLinkAtomically(paths.currentLink, oldCurrent.path);
      if (oldPrevious) await pointLinkAtomically(paths.previousLink, oldPrevious.path);
      else await fs.rm(paths.previousLink, { force: true });
      if (wasActive) {
        await systemctl("restart");
        await waitForBuild({
          expectedBuildId: oldCurrent.buildId,
          url: options.url,
          timeoutMs: options.timeoutMs,
          fetchHealth: options.fetchHealth,
        });
      } else {
        await systemctl("stop");
      }
      throw new ActivationFailedError(`${activationError} (rolled back to ${oldCurrent.buildId})`, "ok");
    } catch (rollbackError) {
      if (rollbackError instanceof ActivationFailedError) throw rollbackError;
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new ActivationFailedError(`${activationError} (rollback failed: ${detail})`, "failed", detail);
    }
  }
  } finally {
    await releaseLock();
  }
}

export type RollbackResult = {
  buildId: string;
  path: string;
  previousBuildId: string | null;
};

export async function rollbackBuild(options: {
  baseDir?: string;
  url?: string;
  timeoutMs?: number;
  systemctl?: SystemctlFn;
  fetchHealth?: FetchHealthFn;
} = {}): Promise<RollbackResult> {
  const paths = deploymentPaths(options.baseDir ?? resolveBaseDir());
  const releaseLock = await acquireDeploymentLock(paths, "rollback");
  try {
  const systemctl = options.systemctl ?? defaultSystemctl;
  const current = await readLinkState(paths.currentLink);
  const previous = await readLinkState(paths.previousLink);
  if (!previous) throw new Error("no previous build to roll back to");
  if (!isValidBuildId(previous.buildId)) throw new Error(`previous target is not a build: ${previous.path}`);
  await assertRunnableBuild(previous.path, previous.buildId);
  // Swap so rollback stays reversible: previous becomes current, old current
  // becomes the new previous.
  await pointLinkAtomically(paths.currentLink, previous.path);
  if (current) await pointLinkAtomically(paths.previousLink, current.path);
  else await fs.rm(paths.previousLink, { force: true });
  try {
    await systemctl("restart");
    await waitForBuild({
      expectedBuildId: previous.buildId,
      url: options.url,
      timeoutMs: options.timeoutMs,
      fetchHealth: options.fetchHealth,
    });
  } catch (error) {
    const rollbackError = error instanceof Error ? error.message : String(error);
    try {
      if (current) await pointLinkAtomically(paths.currentLink, current.path);
      else await fs.rm(paths.currentLink, { force: true });
      await pointLinkAtomically(paths.previousLink, previous.path);
      await systemctl("restart");
      if (current) {
        await waitForBuild({
          expectedBuildId: current.buildId,
          url: options.url,
          timeoutMs: options.timeoutMs,
          fetchHealth: options.fetchHealth,
        });
      }
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(`rollback failed: ${rollbackError}; restore failed: ${detail}`);
    }
    throw new Error(`rollback failed: ${rollbackError}; restored ${current?.buildId ?? "original no-current state"}`);
  }
  const nextPrevious = await readLinkState(paths.previousLink);
  return { buildId: previous.buildId, path: previous.path, previousBuildId: nextPrevious?.buildId ?? null };
  } finally {
    await releaseLock();
  }
}

export type DeploymentStatus = {
  baseDir: string;
  current: { buildId: string; path: string; valid: boolean; runnable: boolean } | null;
  previous: { buildId: string; path: string; valid: boolean; runnable: boolean } | null;
  service: { state: string };
  live: { reachable: boolean; buildId: string | null; version: string | null; ok: boolean; error: string | null };
  drift: boolean | null;
  source: (SourceMeta & { dir: string }) | null;
};

export async function deploymentStatus(options: {
  baseDir?: string;
  sourceDir?: string;
  url?: string;
  systemctl?: SystemctlFn;
  fetchHealth?: FetchHealthFn;
} = {}): Promise<DeploymentStatus> {
  const baseDir = path.resolve(options.baseDir ?? resolveBaseDir());
  const paths = deploymentPaths(baseDir);
  const systemctl = options.systemctl ?? defaultSystemctl;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const url = options.url ?? healthUrl();
  const [current, previous] = await Promise.all([
    readLinkState(paths.currentLink),
    readLinkState(paths.previousLink),
  ]);
  let serviceState = "unknown";
  try {
    serviceState = (await systemctl("is-active")).trim() || "unknown";
  } catch (error) {
    serviceState = error instanceof Error ? `error: ${error.message}` : "unknown";
  }
  let live: DeploymentStatus["live"] = { reachable: false, buildId: null, version: null, ok: false, error: null };
  try {
    const parsed = parseHealthPayload(await fetchHealth(url));
    live = { reachable: true, buildId: parsed.buildId, version: parsed.version, ok: parsed.ok, error: null };
  } catch (error) {
    live = { reachable: false, buildId: null, version: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let source: DeploymentStatus["source"] = null;
  const sourceDir = options.sourceDir ?? process.cwd();
  try {
    const meta = await getSourceMeta(path.resolve(sourceDir));
    source = { ...meta, dir: path.resolve(sourceDir) };
  } catch {
    source = null;
  }
  const describe = async (link: LinkState) => {
    if (!link) return null;
    const valid = isValidBuildId(link.buildId);
    let runnable = false;
    if (valid) {
      try {
        await assertRunnableBuild(link.path, link.buildId);
        runnable = true;
      } catch {
        runnable = false;
      }
    }
    return { buildId: link.buildId, path: link.path, valid, runnable };
  };
  const [currentStatus, previousStatus] = await Promise.all([describe(current), describe(previous)]);
  const drift = current && live.reachable && live.buildId ? current.buildId !== live.buildId : null;
  return { baseDir, current: currentStatus, previous: previousStatus, service: { state: serviceState }, live, drift, source };
}
