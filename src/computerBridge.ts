import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as z from "zod/v4";
import { ConnectorError } from "./bounds.js";
import { WINDOWS_COMPUTER_BRIDGE } from "./computerBridgeScript.js";

export type ComputerStep = { method: "GET" | "POST"; path: string; body?: unknown };
export interface ComputerTransport { request(steps: ComputerStep[]): Promise<unknown[]>; close(): void }
export type BridgeSpawn = (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
export type ComputerBridgeCode = "bridge" | "transport" | "timeout" | "http" | "too_large" | "png" | "invalid_json" | "activation" | "element_not_found" | "locator_not_found";
export class ComputerBridgeError extends ConnectorError {
  constructor(readonly code: ComputerBridgeCode, readonly completedSteps?: number, readonly status?: number, message?: string) {
    super(message ?? `Computer bridge request failed (${code}${status ? `, status ${status}` : ""}, completed steps ${completedSteps})${uncertain}`);
  }
}
const replySchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string().regex(/^wcu-\d+$/), ok: z.literal(true), results: z.array(z.unknown()).min(1).max(3) }).strict(),
  z.object({ id: z.string().regex(/^wcu-\d+$/), ok: z.literal(false), code: z.enum(["bridge", "transport", "timeout", "http", "too_large", "png", "invalid_json", "activation", "element_not_found", "locator_not_found"]), completedSteps: z.number().int().min(0).max(3), status: z.number().int().min(100).max(599).optional() }).strict(),
]);
type Pending = { resolve: (data: unknown[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; count: number };
const uncertain = "; reconcile observed state before retrying a mutation";

/** One lazy Windows process for all MCP exchanges; stdout is bounded NDJSON only. */
export class WindowsComputerBridge implements ComputerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;
  constructor(private readonly options: { spawn?: BridgeSpawn; executable?: string; timeoutMs?: number } = {}) {}

  private start() {
    if (this.child) return this.child;
    const executable = this.options.executable ?? process.env.OPENCODE_COMPUTER_PWSH ?? "/mnt/c/Program Files/PowerShell/7/pwsh.exe";
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_COMPUTER_BRIDGE, "utf16le").toString("base64")];
    let child: ChildProcessWithoutNullStreams;
    try { child = (this.options.spawn ?? ((path, argv) => spawn(path, argv, { stdio: "pipe", shell: false, windowsHide: true })))(executable, args); }
    catch { throw new ComputerBridgeError("bridge", undefined, undefined, `Computer bridge could not start${uncertain}`); }
    this.child = child;
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    // Consume stderr without retaining or logging any of its potentially sensitive bytes.
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => this.fail(child, "Computer bridge stderr failed"));
    child.stdin.on("error", () => this.fail(child, "Computer bridge input failed"));
    child.stdout.on("error", () => this.fail(child, "Computer bridge output failed"));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      buffered += decoder.write(chunk);
      while (true) {
        const end = buffered.indexOf("\n");
        if (end < 0) break;
        if (Buffer.byteLength(buffered.slice(0, end)) > 2_097_152) { this.fail(child, "Computer bridge response exceeds limit"); return; }
        const line = buffered.slice(0, end).replace(/\r$/, "");
        buffered = buffered.slice(end + 1);
        let reply: z.infer<typeof replySchema>;
        try { reply = replySchema.parse(JSON.parse(line)); }
        catch { this.fail(child, "Computer bridge returned an invalid response"); return; }
        const pending = this.pending.get(reply.id);
        if (!pending || (reply.ok && reply.results.length !== pending.count)) { this.fail(child, "Computer bridge response correlation failed"); return; }
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.results);
        else pending.reject(new ComputerBridgeError(reply.code, reply.completedSteps, reply.status));
      }
      if (Buffer.byteLength(buffered) > 2_097_152) this.fail(child, "Computer bridge response exceeds limit");
    });
    child.on("error", () => this.fail(child, "Computer bridge could not start"));
    child.on("exit", () => this.fail(child, "Computer bridge exited"));
    child.on("close", () => this.fail(child, "Computer bridge closed"));
    return child;
  }

  private fail(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ComputerBridgeError(reason.includes("timed out") ? "timeout" : "bridge", undefined, undefined, reason + uncertain)); }
    this.pending.clear();
    child.kill();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }

  async request(steps: ComputerStep[]): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new ConnectorError("Computer bridge is closed"));
    if (steps.length < 1 || steps.length > 3) return Promise.reject(new ConnectorError("Computer request requires 1..3 bounded steps"));
    if (this.pending.size >= 64) return Promise.reject(new ConnectorError("Computer bridge has 64 pending requests; try later"));
    const id = `wcu-${++this.sequence}`;
    const line = JSON.stringify({ id, steps }) + "\n";
    if (Buffer.byteLength(line) > 65536) return Promise.reject(new ConnectorError("Computer request exceeds 64 KiB"));
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, "Computer bridge request timed out"), this.options.timeoutMs ?? 15000);
      this.pending.set(id, { resolve, reject, timer, count: steps.length });
      // Each write is one complete frame. Node preserves write order and handles backpressure;
      // the admission/size caps bound queued bytes to 4 MiB.
      try { child.stdin.write(line, "utf8", (error) => { if (error) this.fail(child, "Computer bridge write failed"); }); }
      catch { this.fail(child, "Computer bridge write failed"); }
    });
  }

  close() {
    this.closed = true;
    if (this.child) this.fail(this.child, "Computer bridge closed");
  }
}
