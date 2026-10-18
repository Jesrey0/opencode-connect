import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readlink, readdir, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserInputs, browserOutputs, type BrowserMethod } from "./schemas.js";

const MAX_FRAME = 2 * 1024 * 1024;
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/browser");
// Source execution and compiled immutable releases share the same runtime assets.
const assets = fileURLToPath(import.meta.url).endsWith(".ts") ? dirname(fileURLToPath(import.meta.url)) : source;
export async function browserPython(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCODE_CONNECT_BROWSER_PYTHON) return env.OPENCODE_CONNECT_BROWSER_PYTHON;
  const lock = await readFile(join(assets, "requirements.lock"));
  const key = createHash("sha256").update(lock).digest("hex").slice(0, 16);
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode-connect/browser", key, "bin/python");
}
export function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !url.port) throw new Error("Browser endpoint must be an HTTP loopback IP with an explicit port and no path or credentials");
  return url.origin;
}
export class BrowserError extends Error {
  constructor(readonly code: string, message: string, readonly dispatched = false, readonly verification = "rejected") { super(message); }
  result() { return { error: this.message, errorCode: this.code, verification: this.verification, dispatched: this.dispatched, mutationMayHaveOccurred: this.dispatched }; }
}
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; cleanup: () => void; mutation: boolean };
type Options = { enabled?: boolean; env?: NodeJS.ProcessEnv; idleMs?: number; workerPath?: string; restartBackoffMs?: number; chromeLaunchMode?: "auto" | "direct" | "managed" };

export class BrowserBackend {
  readonly enabled: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private worker?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<string, Pending>();
  private buffer = Buffer.alloc(0);
  private idle?: NodeJS.Timeout;
  private lastError: string | null = null;
  private starts: number[] = [];
  private nextStart = 0;
  private closed = false;
  private launchPromise?: Promise<Record<string, unknown>>;
  private consentPending = false;
  constructor(private readonly options: Options = {}) {
    this.env = options.env ?? process.env;
    this.enabled = options.enabled ?? this.env.OPENCODE_CONNECT_BROWSER === "1";
  }
  private resetIdle() {
    clearTimeout(this.idle);
    if (this.worker && !this.pending.size) {
      this.idle = setTimeout(() => this.stop("Browser worker idle; attach again"), this.options.idleMs ?? 300000);
      this.idle.unref();
    }
  }
  private stop(message: string, code = "worker_unavailable") {
    const worker = this.worker; this.worker = undefined;
    clearTimeout(this.idle); this.buffer = Buffer.alloc(0);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer); item.cleanup();
      item.reject(new BrowserError(code, message, item.mutation, code === "timed_out" ? "timed_out" : item.mutation ? "inconclusive" : "rejected"));
    }
    this.pending.clear();
    // Only the owned Python PID. Chrome is never a member of its process lifetime.
    worker?.kill("SIGKILL");
  }
  close() { this.closed = true; this.stop("Browser connector closed; attach again"); }
  private async start() {
    if (this.closed) throw new BrowserError("closed", "Browser connector is closed");
    if (this.starting) return this.starting;
    if (this.worker) return;
    this.starting = this.spawnWorker();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async spawnWorker() {
    const now = Date.now(); this.starts = this.starts.filter(time => now - time < 60000);
    if (now < this.nextStart || this.starts.length >= 3) throw new BrowserError("restart_limited", "Browser worker restart backoff; retry a fresh attachment later");
    const python = await browserPython(this.env);
    try { await access(python, constants.X_OK); } catch { throw new BrowserError("setup_required", "Browser Python environment is unavailable; run npm run browser:setup during explicit setup"); }
    if (this.closed) throw new BrowserError("closed", "Browser connector is closed");
    this.starts.push(now);
    const worker = spawn(python, ["-B", this.options.workerPath ?? join(assets, "worker.py")], { env: { ...this.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" }, stdio: "pipe" });
    this.worker = worker;
    worker.stdin.on("error", () => { if (this.worker === worker) this.stop("Browser IPC write failed; leases invalidated"); });
    worker.stdout.on("error", () => { if (this.worker === worker) this.stop("Browser IPC read failed; leases invalidated"); });
    worker.on("error", () => { if (this.worker === worker) { this.lastError = "Browser worker could not start"; this.stop(this.lastError); } });
    worker.on("exit", () => { if (this.worker === worker) { this.lastError = "Browser worker exited; leases invalidated"; this.nextStart = Date.now() + (this.options.restartBackoffMs ?? 1000); this.stop(this.lastError); } });
    // Do not retain raw stderr: CDP diagnostics may contain page content or values.
    worker.stderr.on("data", () => { this.lastError = "Browser worker diagnostic emitted; details withheld"; });
    worker.stdout.on("data", (chunk: Buffer) => {
      if (this.worker !== worker) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const at = this.buffer.indexOf(10);
        if (at < 0) { if (this.buffer.length > MAX_FRAME) this.stop("Browser IPC frame exceeds limit"); break; }
        if (at > MAX_FRAME) { this.stop("Browser IPC frame exceeds limit"); break; }
        const frame = this.buffer.subarray(0, at); this.buffer = this.buffer.subarray(at + 1);
        let reply: { id: string; ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string; dispatched?: boolean; verification?: string } };
        try {
          reply = JSON.parse(frame.toString("utf8"));
          if (!reply || typeof reply.id !== "string" || typeof reply.ok !== "boolean" || (reply.ok ? !reply.result || typeof reply.result !== "object" : !reply.error || typeof reply.error.code !== "string" || typeof reply.error.message !== "string")) throw new Error();
        } catch { this.stop("Invalid browser IPC response"); break; }
        const item = this.pending.get(reply.id);
        if (!item) { this.stop("Uncorrelated browser IPC response"); break; }
        this.pending.delete(reply.id); clearTimeout(item.timer); item.cleanup();
        if (reply.ok) item.resolve(reply.result!);
        else item.reject(new BrowserError(reply.error!.code, reply.error!.message, reply.error!.dispatched, reply.error!.verification));
      }
      this.resetIdle();
    });
    try {
      const hello = await this.send("hello", {}, "connector", 10000);
      if (hello.protocol !== 1 || hello.nodriver !== "0.50.6") throw new BrowserError("version_mismatch", "Browser protocol or Nodriver version mismatch; rerun browser setup");
    } catch (error) {
      this.stop("Browser worker negotiation failed");
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("worker_unavailable", "Browser worker negotiation failed");
    }
  }
  private send(method: string, params: Record<string, unknown>, owner: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(new BrowserError("cancelled", "Browser request cancelled"));
    if (!this.worker || this.pending.size >= 16) return Promise.reject(new BrowserError("busy", "Browser worker unavailable or request queue full"));
    clearTimeout(this.idle);
    const id = randomUUID();
    const wire = JSON.stringify({ version: 1, id, method, params, owner, deadline: Date.now() + timeoutMs }) + "\n";
    if (Buffer.byteLength(wire) > MAX_FRAME) return Promise.reject(new BrowserError("too_large", "Browser request exceeds limit"));
    return new Promise((resolve, reject) => {
      const abort = () => this.stop("Browser request cancelled; leases invalidated; never replay an uncertain action");
      const timer = setTimeout(() => {
        const item = this.pending.get(id); if (!item) return;
        this.pending.delete(id); item.cleanup();
        reject(new BrowserError("timed_out", "Browser request timed out; attach again and inspect before retrying", method === "action", "timed_out"));
        this.stop("Browser deadline reached; leases invalidated", "timed_out");
      }, timeoutMs + 500);
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener("abort", abort), mutation: method === "action" });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const worker = this.worker!;
      worker.stdin.write(wire, error => { if (error && this.worker === worker) this.stop("Browser IPC write failed; leases invalidated"); });
    });
  }
  async call(method: BrowserMethod, input: unknown, owner = "single-controller", signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.enabled) throw new BrowserError("disabled", "Browser capability disabled; enable after setup and acceptance");
    if (this.closed) throw new BrowserError("closed", "Browser connector is closed");
    if (signal?.aborted) throw new BrowserError("cancelled", "Browser request cancelled");
    const parsed = browserInputs[method].safeParse(input);
    if (!parsed.success) throw new BrowserError("invalid_arguments", "Invalid browser arguments; consult the tool schema");
    if (this.consentPending || (method === "connect" && this.pending.size)) throw new BrowserError("busy", "Browser request in progress; wait for the explicit connection result");
    const consent = method === "connect";
    if (consent) this.consentPending = true;
    try {
      if (method === "launch") {
        this.launchPromise ??= this.launch(parsed.data as { headless: boolean }, signal);
        try { return await this.launchPromise; } finally { this.launchPromise = undefined; }
      }
      await this.start();
      const params = parsed.data as Record<string, unknown>;
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
      const result = await this.send(method, params, owner, timeoutMs, signal);
      if (method === "status") return { ...browserOutputs.status.parse({ ...result, enabled: true, worker: "running", lastError: this.lastError ?? result.lastError ?? null }), linuxProcesses: await linuxProcesses() };
      const { image, ...metadata } = result;
      if (Buffer.byteLength(JSON.stringify(metadata)) > 262144) throw new BrowserError("too_large", "Browser result exceeds 256 KiB; request a smaller observation");
      const validated = browserOutputs[method].safeParse(metadata);
      if (!validated.success) { this.stop("Invalid browser result contract"); throw new BrowserError("invalid_response", "Browser result failed validation"); }
      if (method === "screenshot") {
        if (typeof image !== "string" || image.length > 1400000 || Buffer.from(image, "base64").length !== metadata.bytes) throw new BrowserError("invalid_response", "Invalid browser screenshot");
        return { ...validated.data, image };
      }
      return validated.data;
    } finally { if (consent) this.consentPending = false; this.resetIdle(); }
  }
  private async launch(input: { headless: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const check = () => {
      if (this.closed || signal?.aborted) throw new BrowserError("cancelled", "Chrome launch cancelled; any already launched Chrome is preserved");
    };
    const url = endpoint(this.env.OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT ?? "http://127.0.0.1:9222");
    const reachable = async () => {
      try {
        const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        const value = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
        return response.ok && /^(Chrome|Chromium)\//.test(value.Browser ?? "") && !!value.webSocketDebuggerUrl;
      } catch { return false; }
    };
    const existing = await reachable(); check();
    if (existing) return { browser: "linux", reused: true, reachable: true, pid: null };
    if (new URL(url).hostname !== "127.0.0.1") throw new BrowserError("launch_unavailable", "Linux launch requires the IPv4 loopback endpoint");
    const candidates = [this.env.OPENCODE_CONNECT_BROWSER_CHROME, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((item): item is string => !!item);
    let executable: string | undefined;
    for (const candidate of candidates) { try { await access(candidate, constants.X_OK); executable = candidate; break; } catch {} }
    if (!executable) throw new BrowserError("chrome_missing", "Linux Chrome not installed; configure OPENCODE_CONNECT_BROWSER_CHROME");
    const profile = join(this.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode-connect/chrome-linux");
    await mkdir(profile, { recursive: true, mode: 0o700 });
    check();
    const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${new URL(url).port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", ...(input.headless ? ["--headless=new"] : []), "about:blank"];
    // Detached children still belong to a systemd service's control group.
    // A connector restart kills them unless Chrome is started in its own unit.
    // Preserve direct process-group ownership outside this managed service
    // (including isolated integration tests and ordinary standalone CLI use).
    const cgroup = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
    const managed = this.options.chromeLaunchMode === "managed"
      || (this.options.chromeLaunchMode !== "direct" && cgroup.includes("/opencode-connect.service"));
    let pid: number | null = null;
    let failed = false;
    if (managed) {
      const launchArgs = ["--user", "--unit=opencode-connect-chrome", "--collect",
        `--setenv=DISPLAY=${this.env.DISPLAY ?? ":0"}`,
        ...(this.env.XAUTHORITY ? [`--setenv=XAUTHORITY=${this.env.XAUTHORITY}`] : []),
        executable, ...args];
      const launched = spawn("systemd-run", launchArgs, { stdio: "ignore", env: this.env });
      const started = await new Promise<boolean>(resolve => {
        launched.once("error", () => resolve(false));
        launched.once("close", code => resolve(code === 0));
      });
      check();
      if (!started) throw new BrowserError("launch_failed", "Could not start systemd-managed Chrome; inspect the opencode-connect-chrome user unit");
    } else {
      const child = spawn(executable, args, { detached: true, stdio: "ignore", env: { ...this.env, DISPLAY: this.env.DISPLAY ?? ":0" } });
      child.on("error", () => { failed = true; });
      pid = child.pid ?? null;
      child.unref();
    }
    const until = Date.now() + 10000;
    while (Date.now() < until && !failed) {
      check();
      if (await reachable()) return { browser: "linux", reused: false, reachable: true, pid };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new BrowserError("launch_failed", "Chrome debug endpoint unavailable after launch; inspect the dedicated Linux profile, display and process unit; Chrome was preserved");
  }
}

async function linuxProcesses() {
  const found: { pid: number; debugging: boolean }[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const executable = await readlink(`/proc/${name}/exe`);
      if (!/\/(chrome|google-chrome|chromium)(-browser|-stable)?$/.test(executable)) continue;
      const args = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0");
      // Chrome can rewrite argv into one space-separated process-title string.
      const command = args.join(" ");
      if (!/(?:^|\s)--type=/.test(command)) found.push({ pid: Number(name), debugging: /(?:^|\s)--remote-debugging-port=\d+/.test(command) });
    } catch {}
    if (found.length >= 20) break;
  }
  return found;
}
