import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, promises as fs, type ReadStream } from "node:fs";
import { join } from "node:path";
import { ConnectorError } from "./bounds.js";

export const PRINT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PRINT_MAX_OUTPUT_BYTES = 1_048_576;
export const PRINT_MAX_STDERR_BYTES = 65_536;
export const PRINT_TIMEOUT_MS = 30_000;

export type PrintSpawn = (executable: string, args: string[]) => ChildProcessWithoutNullStreams;

export class PrintBridgeError extends ConnectorError {
  constructor(readonly code: string, readonly detail?: unknown, message?: string) {
    super(message ?? `Print bridge request failed (${code}); reconcile printer state before retrying a mutation`);
  }
}

/**
 * Server-side executable only. Tool callers cannot supply an executable path.
 *
 * On Windows the LocalAppData default is authoritative. On WSL/Linux there is
 * no deterministic WSL-accessible default, so resolution returns null and the
 * caller must set server-side PRINT_BRIDGE_EXE. Never advertise a bogus
 * Linux-home or mixed Windows/POSIX path as a default.
 */
export function defaultPrintExecutable(): string | null {
  // LOCALAPPDATA is a native Windows path. WSL/Linux can inherit it, but
  // joining it with POSIX semantics produces an unusable mixed path.
  if (process.platform !== "win32") return null;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.trim()) return join(localAppData, "WindowsPrintBridge", "print-bridge.exe");
  return null;
}

export function resolvePrintExecutable(configured?: string): string {
  const explicit = configured ?? process.env.PRINT_BRIDGE_EXE;
  if (explicit && explicit.trim()) return explicit;
  const fallback = defaultPrintExecutable();
  if (fallback) return fallback;
  throw new PrintBridgeError("not_configured", undefined,
    "Print bridge executable is not configured; set server-side PRINT_BRIDGE_EXE to the WSL-accessible print-bridge.exe path (tool callers cannot supply an executable path)");
}

/** Canonicalize a host file path, require a regular file, and enforce the size bound. */
export async function canonicalPrintFile(inputPath: string, maxBytes: number = PRINT_MAX_FILE_BYTES): Promise<{ realPath: string; size: number }> {
  let realPath: string;
  try {
    const { realpath } = await import("node:fs/promises");
    realPath = await realpath(inputPath);
  } catch {
    throw new ConnectorError(`Print file is not accessible; provide an existing regular file (${safePathHint(inputPath)})`);
  }
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(realPath);
  } catch {
    throw new ConnectorError("Print file is not accessible; provide an existing regular file");
  }
  if (!stats.isFile()) throw new ConnectorError("Print file must be a regular file");
  if (stats.size > maxBytes) throw new ConnectorError(`Print file exceeds the ${maxBytes} byte limit`);
  return { realPath, size: stats.size };
}

function safePathHint(path: string): string {
  return path.length > 128 ? `${path.slice(0, 128)}…` : path;
}

function truncateText(text: string, limit = 500): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const NOT_JSON = Symbol("not-json");
function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return NOT_JSON; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsedCode(parsed: unknown): string | null {
  if (isRecord(parsed)) {
    if (typeof parsed.code === "string" && parsed.code) return parsed.code;
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    const nested = parsed.error;
    if (isRecord(nested) && typeof nested.code === "string" && nested.code) return nested.code;
  }
  return null;
}

function parsedMessage(parsed: unknown): string | null {
  if (isRecord(parsed)) {
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    const nested = parsed.error;
    if (isRecord(nested) && typeof nested.message === "string" && nested.message) return nested.message;
  }
  return null;
}

/** Short-lived print-bridge.exe runner. One spawn per call; no retries, no persistent child. */
export class PrintBridge {
  constructor(private readonly options: {
    spawn?: PrintSpawn;
    executable?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxFileBytes?: number;
  } = {}) {}

  executablePath(): string {
    return resolvePrintExecutable(this.options.executable);
  }

  async run(args: string[], stdinFile?: string): Promise<Record<string, unknown>> {
    if (args.length < 1 || args.length > 24) throw new ConnectorError("Print request requires 1..24 bounded arguments");
    for (const arg of args) {
      if (arg.includes("\0")) throw new ConnectorError("Print argument must not contain NUL");
      if (Buffer.byteLength(arg) > 4096) throw new ConnectorError("Print argument exceeds 4 KiB");
    }
    const maxOutput = this.options.maxOutputBytes ?? PRINT_MAX_OUTPUT_BYTES;
    const maxFile = this.options.maxFileBytes ?? PRINT_MAX_FILE_BYTES;
    const timeoutMs = this.options.timeoutMs ?? PRINT_TIMEOUT_MS;
    // Throws not_configured before spawning when no server-side path exists.
    const executable = this.executablePath();

    let realFile: string | undefined;
    if (stdinFile !== undefined) {
      realFile = (await canonicalPrintFile(stdinFile, maxFile)).realPath;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawn ?? ((path, argv) => spawn(path, argv, { stdio: "pipe", shell: false, windowsHide: true })))(executable, args);
    } catch {
      throw new PrintBridgeError("bridge", undefined, "Print bridge could not start; reconcile printer state before retrying a mutation");
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let fileStream: ReadStream | undefined;
      let settled = false;
      const destroyFileStream = () => {
        // Release the file descriptor on every settlement path: timeout,
        // output overflow, child error/early close, or normal completion.
        try { fileStream?.destroy(); } catch { /* ignore */ }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        destroyFileStream();
        try { child.kill(); } catch { /* ignore */ }
        try { child.stdin.destroy(); } catch { /* ignore */ }
        try { child.stdout.destroy(); } catch { /* ignore */ }
        try { child.stderr.destroy(); } catch { /* ignore */ }
        reject(error);
      };
      const timer = setTimeout(() => fail(new PrintBridgeError("timeout", undefined, "Print bridge request timed out; printer state is uncertain, reconcile before retrying a mutation")), timeoutMs);
      // Consume stderr with a bound; on nonzero exit it may carry the
      // structured JSON error, otherwise it is truncated diagnostics only.
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= PRINT_MAX_STDERR_BYTES) stderr.push(chunk);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutput) {
          fail(new PrintBridgeError("too_large", undefined, "Print bridge response exceeds limit; reconcile printer state before retrying a mutation"));
          return;
        }
        stdout.push(chunk);
      });
      child.on("error", () => fail(new PrintBridgeError("bridge", undefined, "Print bridge could not start; reconcile printer state before retrying a mutation")));
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        destroyFileStream();
        const outText = Buffer.concat(stdout).toString("utf8");
        const errText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          // The companion writes structured JSON errors to stderr on nonzero
          // exit; stdout errors remain accepted for compatibility. Stderr is
          // authoritative when both parse to objects.
          const errResult = tryParseJson(errText);
          const outResult = tryParseJson(outText);
          const candidate = isRecord(errResult) ? errResult : isRecord(outResult) ? outResult : undefined;
          if (candidate) {
            const bridgeCode = parsedCode(candidate) ?? "bridge";
            const bridgeMessage = parsedMessage(candidate);
            reject(new PrintBridgeError(bridgeCode,
              { exitCode: code, error: candidate, stdout: truncateText(outText), stderr: truncateText(errText) },
              bridgeMessage ? `Print bridge reported ${bridgeCode}: ${truncateText(bridgeMessage)} (exit ${code})`
                : `Print bridge reported ${bridgeCode} (exit ${code}); reconcile printer state before retrying a mutation`));
            return;
          }
          if (outText !== "") {
            reject(new PrintBridgeError("invalid_json", { exitCode: code, output: truncateText(outText), stderr: truncateText(errText) },
              `Print bridge returned invalid JSON (exit ${code ?? "unknown"}): ${truncateText(outText || errText || "empty")}; reconcile printer state before retrying a mutation`));
            return;
          }
          reject(new PrintBridgeError("bridge", { exitCode: code, stderr: truncateText(errText) },
            `Print bridge exited ${code ?? "unknown"}: ${truncateText(errText || "no output")}; reconcile printer state before retrying a mutation`));
          return;
        }
        // Success still requires a JSON object on stdout.
        let parsed: unknown;
        try {
          parsed = outText ? JSON.parse(outText) : undefined;
        } catch {
          reject(new PrintBridgeError("invalid_json", { exitCode: code, output: truncateText(outText), stderr: truncateText(errText) },
            `Print bridge returned invalid JSON (exit ${code ?? "unknown"}): ${truncateText(outText || errText || "empty")}; reconcile printer state before retrying a mutation`));
          return;
        }
        if (!isRecord(parsed)) {
          reject(new PrintBridgeError("invalid_json", { output: truncateText(outText) }, "Print bridge returned a non-object JSON payload; reconcile printer state before retrying a mutation"));
          return;
        }
        resolve(parsed);
      };
      // Close fires after exit and after stdio closes, so it owns final parsing.
      // Listen once: a stale exit/close pair must not settle twice.
      child.once("close", finish);
      child.stdin.on("error", () => { /* finish/close carries the failure */ });

      if (realFile === undefined) {
        try { child.stdin.end(); } catch { fail(new PrintBridgeError("bridge", undefined, "Print bridge input failed; reconcile printer state before retrying a mutation")); }
        return;
      }
      // Stream raw file bytes to child stdin; never base64 file content over MCP.
      fileStream = createReadStream(realFile);
      let sent = 0;
      fileStream.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        sent += bytes;
        if (sent > maxFile) {
          destroyFileStream();
          fail(new ConnectorError(`Print file exceeds the ${maxFile} byte limit`));
          return;
        }
        let ok = false;
        try { ok = child.stdin.write(chunk); } catch { fail(new PrintBridgeError("bridge", undefined, "Print bridge input failed; reconcile printer state before retrying a mutation")); return; }
        if (!ok && fileStream && !fileStream.destroyed) fileStream.pause();
      });
      child.stdin.on("drain", () => { if (fileStream && !fileStream.destroyed) fileStream.resume(); });
      fileStream.on("end", () => { try { child.stdin.end(); } catch { /* ignore */ } });
      fileStream.on("error", () => fail(new ConnectorError("Print file could not be streamed; reconcile printer state before retrying a mutation")));
    });
  }

  close(): void {
    // Short-lived children own their lifecycle per run; nothing persistent to close.
  }
}
