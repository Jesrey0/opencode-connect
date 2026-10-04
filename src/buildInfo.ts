import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

export const SOURCE_BUILD_ID = "source";

export type BuildInfo = {
  buildId: string;
  version: string;
  release: boolean;
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  dirty: boolean | null;
  builtAt: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeRelease(parsed: Record<string, unknown>): BuildInfo | null {
  const buildId = asString(parsed.buildId);
  if (!buildId || !/^[0-9a-f]{16}$/.test(buildId)) return null;
  const version = asString(parsed.version) ?? VERSION;
  return {
    buildId,
    version,
    release: true,
    commit: asString(parsed.commit),
    commitShort: asString(parsed.commitShort),
    branch: asString(parsed.branch),
    dirty: typeof parsed.dirty === "boolean" ? parsed.dirty : null,
    builtAt: asString(parsed.builtAt),
  };
}

export function sourceBuildInfo(): BuildInfo {
  return {
    buildId: SOURCE_BUILD_ID,
    version: VERSION,
    release: false,
    commit: null,
    commitShort: null,
    branch: null,
    dirty: null,
    builtAt: null,
  };
}

async function tryRead(root: string): Promise<BuildInfo | null> {
  try {
    const raw = await readFile(resolve(root, "build.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeRelease(parsed);
  } catch {
    return null;
  }
}

// A prepared release carries build.json at its root and runs with that root as
// cwd (WorkingDirectory=current). A source checkout has no build.json, so it
// reports the explicit non-release identity instead of pretending to deploy.
export async function loadBuildInfo(cwd = process.cwd()): Promise<BuildInfo> {
  const fromCwd = await tryRead(cwd);
  if (fromCwd) return fromCwd;
  try {
    const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    if (moduleRoot !== cwd) {
      const fromModule = await tryRead(moduleRoot);
      if (fromModule) return fromModule;
    }
  } catch {
    // fall through to source identity
  }
  return sourceBuildInfo();
}
