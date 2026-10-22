import { lstat, readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { basename, dirname, resolve } from "node:path";
import * as z from "zod/v4";
import { VERSION } from "./version.js";

export const SOURCE_BUILD_ID = "source";
const BUILD_ID_RE = /^[0-9a-f]{16}$/;
const nullableString = z.string().min(1).nullable();
const checksum = z.string().regex(/^[0-9a-f]{64}$/);
const buildRecordSchema = z.object({
  buildId: z.string().regex(BUILD_ID_RE), version: z.string().min(1),
  commit: nullableString, commitShort: nullableString, branch: nullableString,
  dirty: z.boolean().nullable(), builtAt: z.iso.datetime(), nodeVersion: z.string().min(1),
  integrity: z.object({ sourceHash: checksum, runtimeHash: checksum }).strict(),
}).strict();
export type BuildRecord = z.infer<typeof buildRecordSchema>;

export function isValidBuildId(value: string): boolean { return BUILD_ID_RE.test(value); }

// Deployment and runtime identity use exactly the same complete release record.
export async function loadBuildRecord(root: string): Promise<BuildRecord> {
  if (!(await lstat(resolve(root, "build.json"))).isFile()) throw new Error(`invalid build.json in ${root}: expected a regular file`);
  const raw = await readFile(resolve(root, "build.json"), "utf8");
  let record: BuildRecord;
  try { record = buildRecordSchema.parse(JSON.parse(raw)); }
  catch { throw new Error(`invalid build.json in ${root}`); }
  if (basename(resolve(root)) !== record.buildId) throw new Error(`build.json mismatch in ${root}`);
  if (!record.integrity.sourceHash.startsWith(record.buildId)) throw new Error(`build.json source identity mismatch in ${root}`);
  return record;
}

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

// Identity belongs to the loaded package, never the caller's working directory.
// Built checkouts can also run in source mode. An immutable build directory may
// never downgrade to source identity when its record is missing or malformed.
export async function loadBuildInfo(root = dirname(findPackageJSON(import.meta.url)!)): Promise<BuildInfo> {
  let record: BuildRecord;
  try {
    record = await loadBuildRecord(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !isValidBuildId(basename(resolve(root)))) return sourceBuildInfo();
    throw error;
  }
  if (record.version !== VERSION) throw new Error("build.json version does not match the loaded connector");
  const { nodeVersion, integrity, ...info } = record;
  return { ...info, release: true };
}
