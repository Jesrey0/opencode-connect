import * as z from "zod/v4";
import type { OpenCodeClient } from "@opencode/client";
import { ConnectorError, safeError } from "./bounds.js";
import { nextCall } from "./continuation.js";

// Operator-direct Codex dispatch rides the native OpenCode RPC surface owned by the
// separately implemented `codex-direct` plugin definition. The connector owns only
// the bounded call contract: canonical plugin job identity, current status and the
// plugin's own result. It never creates a native OpenCode session, never borrows a
// worker identity, and never asks another model to run the task.
export const CODEX_DIRECT_RPC_ID = "codex-direct";
export const CODEX_PROMPT_LIMIT = 65_536;
export const CODEX_TIMEOUT_LIMIT_MS = 90_000;
export const CODEX_TIMEOUT_MS = 45_000;

// Portable plugin definition. The pinned client sends these schemas to the native
// service and resolves the plugin's payload without applying them here, so the
// declared outputs stay unknown and every field below is projected explicitly.
const codexDirect = {
  id: CODEX_DIRECT_RPC_ID,
  methods: {
    start: { input: z.object({ cwd: z.string().min(1), prompt: z.string().min(1) }), output: z.unknown() },
    inspect: { input: z.object({ jobId: z.string().min(1) }), output: z.unknown() },
    cancel: { input: z.object({ jobId: z.string().min(1) }), output: z.unknown() },
  },
  events: {},
};

export type CodexJob = {
  jobId: string;
  status: string;
  result: Record<string, unknown> | null;
  error: { type: string; messageOmitted: true } | null;
};

// Plugin payloads are untrusted native data. Only bounded tokens cross the
// boundary; message bodies, prompts, paths and provider state stay in the plugin.
const TOKEN = /^[\x21-\x7E]{1,64}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const ABORTS = new Set(["AbortError", "TimeoutError"]);

function nativeRecord(value: unknown, method: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError(`codex-direct ${method} returned no usable job record`);
  return value as Record<string, unknown>;
}

function nativeType(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("type" in error)) return null;
  const type = (error as { type: unknown }).type;
  return typeof type === "string" && TOKEN.test(type) ? type : null;
}

function nativeError(method: string, error: unknown, uncertainty: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = error && typeof error === "object" && "name" in error && typeof (error as { name: unknown }).name === "string" ? (error as { name: string }).name : "";
  if (ABORTS.has(name)) return new ConnectorError(`codex-direct ${method} did not answer within the connector call bound; ${uncertainty}`);
  const type = nativeType(error);
  return new ConnectorError(`codex-direct ${method} failed${type ? ` (${type})` : ""}; plugin error details omitted; reconcile the canonical job with opencode.query codexJob before retrying`);
}

export function codexJobId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || CONTROL.test(value)) throw new ConnectorError("codex-direct returned no usable canonical job id");
  return value;
}

export function codexStatus(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new ConnectorError("codex-direct returned no usable job status");
  return value;
}

function jobError(value: unknown): CodexJob["error"] {
  if (value === undefined || value === null) return null;
  const type = typeof value === "string" ? value : typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type : null;
  return { type: type && TOKEN.test(type) ? type : "unavailable", messageOmitted: true };
}

export function projectCodexJob(jobId: string, output: unknown): CodexJob {
  const job = nativeRecord(output, "inspect");
  if (job.jobId !== undefined && job.jobId !== jobId) throw new ConnectorError("codex-direct answered for a different job id; reconcile canonical job state before retrying");
  const result = job.result;
  return {
    jobId,
    status: codexStatus(job.status),
    result: result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : null,
    error: jobError(job.error),
  };
}

export function codexStartIdentity(output: unknown): { jobId: string; status: string } {
  const admitted = nativeRecord(output, "start");
  return { jobId: codexJobId(admitted.jobId), status: codexStatus(admitted.status) };
}

export function codexNextCall(jobId: string) {
  return nextCall("opencode.query", { queries: [{ type: "codexJob", jobId }] });
}

export async function codexStart(client: OpenCodeClient, input: { cwd: string; prompt: string }, timeoutMs: number): Promise<unknown> {
  try { return await client.rpc(codexDirect).start(input, { signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw nativeError("start", error, "admission is uncertain and no canonical job id was returned; do not retry automatically"); }
}

export async function codexCancel(client: OpenCodeClient, jobId: string, timeoutMs: number): Promise<string> {
  try { return codexStatus(nativeRecord(await client.rpc(codexDirect).cancel({ jobId }, { signal: AbortSignal.timeout(timeoutMs) }), "cancel").status); }
  catch (error) { throw nativeError("cancel", error, "cancellation is uncertain; do not retry automatically and reconcile canonical job state first"); }
}

export async function codexJob(client: OpenCodeClient, jobId: string, timeoutMs: number): Promise<CodexJob> {
  try { return projectCodexJob(jobId, await client.rpc(codexDirect).inspect({ jobId }, { signal: AbortSignal.timeout(timeoutMs) })); }
  catch (error) { throw nativeError("inspect", error, "the job record was not read; retry the read, not the mutation"); }
}

// Mutations never trust their own admission payload alone: the canonical job readback
// is the evidence, and an unreadable job keeps the plugin-reported identity instead of
// inventing one or discarding a job id that already exists.
export async function codexMutation(client: OpenCodeClient, jobId: string, reported: string, timeoutMs: number): Promise<CodexJob & { verified: boolean; readbackError: string | null }> {
  try {
    const job = await codexJob(client, jobId, timeoutMs);
    return { ...job, verified: true as const, readbackError: null };
  } catch (error) {
    return { jobId, status: reported, result: null, error: null, verified: false as const, readbackError: safeError(error) };
  }
}