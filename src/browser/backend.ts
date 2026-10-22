import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readlink, readdir, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodIssue } from "zod/v4";
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
const exec = promisify(execFile);
const CHROME_UNIT = "opencode-connect-chrome.service";

export async function browserEndpointReachable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const url = endpoint(env.OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT ?? "http://127.0.0.1:9222");
  if (new URL(url).hostname !== "127.0.0.1") return false;
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" });
    const value = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
    return response.ok && /^(Chrome|Chromium)\//.test(value.Browser ?? "") && !!value.webSocketDebuggerUrl;
  } catch { return false; }
}

// Only the root Chrome process in our dedicated systemd unit/profile is owned.
// An arbitrary Chrome on the same loopback endpoint is never sufficient proof.
export function isManagedChromeProcess(identity: {
  pid: number; executable: string; argv: string[]; cgroup: string; profile: string; port: string;
}): boolean {
  const executable = identity.executable.split("/").pop() ?? "";
  // Chrome may rewrite /proc/PID/cmdline into a single space-separated
  // process title; match complete flag tokens, not arbitrary substrings.
  const args = identity.argv.join(" ").split(/\s+/);
  return identity.pid > 1
    && /^(?:chrome|google-chrome(?:-stable)?|chromium(?:-browser)?)$/.test(executable)
    && identity.cgroup.split("\n").some(line =>
      line.endsWith("/" + CHROME_UNIT) ||
      // WSLg/Chrome may move the launched process into its own app scope;
      // systemd MainPID still binds it to the dedicated launcher unit.
      line.endsWith("/app-com.google.Chrome-" + identity.pid + ".scope"))
    && args.includes("--user-data-dir=" + identity.profile)
    && args.includes("--remote-debugging-port=" + identity.port)
    && args.includes("--remote-debugging-address=127.0.0.1");
}

async function managedUnit(env: NodeJS.ProcessEnv): Promise<{ state: string; pid: number }> {
  try {
    const { stdout } = await exec("systemctl", ["--user", "show", CHROME_UNIT,
      "--property=ActiveState", "--property=MainPID", "--no-pager"],
      { env, timeout: 3000, maxBuffer: 4096 });
    const values = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=", 2)));
    const pid = Number(values.MainPID);
    if (!["active", "inactive", "failed", "activating", "deactivating"].includes(values.ActiveState)
      || !Number.isSafeInteger(pid) || pid < 0) throw new Error("Invalid unit state");
    return { state: values.ActiveState, pid };
  } catch {
    throw new BrowserError("close_unavailable", "Cannot verify the dedicated Linux Chrome unit; nothing was stopped");
  }
}
export function browserErrorLayer(code: string) {
  if (["invalid_arguments", "invalid_browser", "invalid_operation", "unsafe_url", "authorization_denied"].includes(code)) return "validation";
  if (["invalid_lease", "invalid_connection", "lease_conflict", "observe_only", "approval_required", "approval_denied", "approval_timeout"].includes(code)) return "lease";
  if (["target_missing", "target_not_found", "target_closed", "ambiguous_target", "stale_reference", "document_changed", "invalid_frame", "not_actionable", "element_unavailable", "invalid_element", "invalid_option"].includes(code)) return "target";
  if (["unsupported_input", "input_unverifiable", "site_limit", "partial_input", "sequential_limit", "input_budget_exceeded", "cdp_error", "focus_changed", "protected_input", "invalid_upload", "upload_denied", "unsupported_chooser", "file_chooser_timeout"].includes(code)) return "input";
  if (["incomplete_observation", "observation_failed", "invalid_selector", "postcondition_unconfirmed"].includes(code)) return "observation";
  if (["disabled", "closed", "busy", "restart_limited", "setup_required", "version_mismatch", "worker_unavailable", "cancelled"].includes(code)) return "worker";
  if (["invalid_protocol", "transport_failure"].includes(code)) return "transport";
  if (["invalid_response", "too_large", "screenshot_too_large"].includes(code)) return "result";
  return "browser";
}
function argumentError(issues: ZodIssue[]): string {
  // Paths contain schema fields/array indices. Never expose Zod's message, input,
  // unrecognized keys or accepted literal values in these diagnostics.
  const issue = issues.find(item => item.code === "too_big" || item.code === "too_small") ?? issues[0];
  const path = issue?.path.map(part => typeof part === "number" ? `[${part}]` : String(part)).join(".").replace(/\.\[/g, "[") || "arguments";
  if (issue?.code === "too_big" || issue?.code === "too_small") {
    const bound = issue.code === "too_big" ? issue.maximum : issue.minimum;
    const unit = issue.origin === "string" ? " characters" : issue.origin === "array" ? " items" : "";
    return `Invalid browser arguments: ${path} ${issue.code === "too_big" ? "maximum" : "minimum"} ${bound}${unit}`;
  }
  return `Invalid browser arguments: ${path} ${issue?.code === "unrecognized_keys" ? "contains unsupported fields" : "does not match its schema"}`;
}
export class BrowserError extends Error {
  constructor(readonly code: string, message: string, readonly dispatched = false, readonly verification = "rejected") { super(message); }
  result() { return { error: this.message, errorCode: this.code, errorLayer: browserErrorLayer(this.code), verification: this.verification, dispatched: this.dispatched, mutationMayHaveOccurred: this.dispatched }; }
}
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; cleanup: () => void; mutation: boolean };
type Options = { enabled?: boolean; env?: NodeJS.ProcessEnv; idleMs?: number; workerPath?: string; restartBackoffMs?: number; chromeLaunchMode?: "auto" | "direct" | "managed" };
type Incident = { at: string; message: string };

export class BrowserBackend {
  readonly enabled: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private worker?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<string, Pending>();
  private buffer = Buffer.alloc(0);
  private idle?: NodeJS.Timeout;
  private currentIssue: string | null = null;
  private lastIncident: Incident | null = null;
  private browserIssues = new Map<string, string | null>();
  private starts: number[] = [];
  private nextStart = 0;
  private closed = false;
  private launchPromise?: Promise<Record<string, unknown>>;
  private closingChrome = false;
  private consentPending = false;
  constructor(private readonly options: Options = {}) {
    this.env = options.env ?? process.env;
    this.enabled = options.enabled ?? this.env.OPENCODE_CONNECT_BROWSER === "1";
  }
  // Local supervisor state only; endpoint and lease readiness require status.
  snapshot() { return { enabled: this.enabled, worker: this.worker ? "running" : "stopped", currentIssue: this.currentIssue }; }
  private recordIncident(message: string) { this.lastIncident = { at: new Date().toISOString(), message }; }
  private resetIdle() {
    clearTimeout(this.idle);
    if (this.worker && !this.pending.size) {
      this.idle = setTimeout(() => {
        this.stop("Browser worker released after inactivity; previous attachment handles expired; attach explicitly", "worker_unavailable", null);
      }, this.options.idleMs ?? 300000);
      this.idle.unref();
    }
  }
  private stop(message: string, code = "worker_unavailable", currentIssue: string | null = message, incident = true) {
    if (this.worker) { this.currentIssue = currentIssue; if (incident) this.recordIncident(message); }
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
  close() { this.closed = true; this.stop("Browser connector closed; attach again"); this.currentIssue = "Browser connector is closed"; }
  private async start() {
    if (this.closed) throw new BrowserError("closed", "Browser connector is closed");
    if (this.starting) return this.starting;
    if (this.worker) return;
    this.starting = this.spawnWorker();
    try { await this.starting; } catch (error) {
      if (error instanceof BrowserError) {
        this.currentIssue = error.message;
        if (error.code !== "restart_limited" && this.lastIncident?.message !== error.message) this.recordIncident(error.message);
      }
      throw error;
    } finally { this.starting = undefined; }
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
    worker.on("error", () => { if (this.worker === worker) this.stop("Browser worker could not start"); });
    worker.on("exit", () => { if (this.worker === worker) { this.nextStart = Date.now() + (this.options.restartBackoffMs ?? 1000); this.stop("Browser worker exited; leases invalidated"); } });
    // Do not retain raw stderr: CDP diagnostics may contain page content or values.
    worker.stderr.on("data", () => { if (this.worker === worker) this.recordIncident("Browser worker diagnostic emitted; details withheld"); });
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
          if (!reply || typeof reply.id !== "string" || typeof reply.ok !== "boolean" || (reply.ok
            ? !reply.result || typeof reply.result !== "object" || Array.isArray(reply.result)
            : !reply.error || typeof reply.error.code !== "string" || typeof reply.error.message !== "string"
              || reply.error.dispatched !== undefined && typeof reply.error.dispatched !== "boolean"
              || reply.error.verification !== undefined && !["rejected", "failed", "inconclusive", "timed_out"].includes(reply.error.verification))) throw new Error();
        } catch { this.stop("Invalid browser IPC response; attach and inspect before continuing", "invalid_response"); break; }
        const item = this.pending.get(reply.id);
        if (!item) { this.stop("Uncorrelated browser IPC response; attach and inspect before continuing", "invalid_response"); break; }
        this.pending.delete(reply.id); clearTimeout(item.timer); item.cleanup();
        if (reply.ok) item.resolve(reply.result!);
        else {
          const dispatched = reply.error!.dispatched ?? item.mutation;
          const verification = reply.error!.dispatched === undefined && item.mutation ? "inconclusive"
            : reply.error!.verification ?? (dispatched ? "inconclusive" : "rejected");
          item.reject(new BrowserError(reply.error!.code, reply.error!.message, dispatched, verification));
        }
      }
      this.resetIdle();
    });
    try {
      const hello = await this.send("hello", {}, "connector", 10000);
      if (hello.protocol !== 1 || hello.nodriver !== "0.50.6") throw new BrowserError("version_mismatch", "Browser protocol or Nodriver version mismatch; rerun browser setup");
      this.currentIssue = null;
      this.browserIssues.clear();
    } catch (error) {
      this.stop(error instanceof BrowserError ? error.message : "Browser worker negotiation failed");
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
        reject(new BrowserError("timed_out", "Browser request timed out; attach again and inspect before retrying", method === "action" || method === "workflow", "timed_out"));
        this.stop("Browser deadline reached; leases invalidated", "timed_out");
      }, timeoutMs + 500);
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener("abort", abort), mutation: method === "action" || method === "workflow" });
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
    if (!parsed.success) throw new BrowserError("invalid_arguments", argumentError(parsed.error.issues));
    if (this.closingChrome) throw new BrowserError("busy", "Linux Chrome shutdown is in progress");
    if (this.consentPending || (method === "connect" && this.pending.size)) throw new BrowserError("busy", "Browser request in progress; wait for the explicit connection result");
    const consent = method === "connect";
    if (consent) this.consentPending = true;
    try {
      if (method === "launch") {
        this.launchPromise ??= this.launch(parsed.data as { headless: boolean }, signal);
        try { return await this.launchPromise; } finally { this.launchPromise = undefined; }
      }
      if (method === "close") {
        if (this.launchPromise || this.pending.size) throw new BrowserError("busy", "Browser activity in progress; retry explicit close later");
        this.closingChrome = true;
        try { return await this.closeManagedChrome(signal); }
        finally { this.closingChrome = false; }
      }
      await this.start();
      // The adapter serializes requests. Queuing a short request behind a long
      // wait would spend its deadline before dispatch and could kill the worker.
      if (this.pending.size) throw new BrowserError("busy", "Browser request in progress; wait for its result before sending another request");
      const params = parsed.data as Record<string, unknown>;
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
      const result = await this.send(method, params, owner, timeoutMs, signal);
      const mutation = method === "action" || method === "workflow";
      const resultError = (code: string, message: string) => {
        if (mutation || code === "invalid_response") this.stop("Browser result rejected; leases invalidated");
        return new BrowserError(code, message + (mutation ? "; action outcome unverified; attach and inspect before continuing" : ""), mutation, mutation ? "inconclusive" : "failed");
      };
      if (method === "status") {
        const validated = browserOutputs.status.safeParse({ ...result, enabled: true, worker: "running", lastIncident: this.lastIncident });
        if (!validated.success) throw resultError("invalid_response", "Browser status result failed validation");
        const { browser, currentIssue } = validated.data;
        if (currentIssue && this.browserIssues.get(browser) !== currentIssue) this.recordIncident(currentIssue);
        this.browserIssues.set(browser, currentIssue);
        return { ...validated.data, lastIncident: this.lastIncident, linuxProcesses: await linuxProcesses() };
      }
      const { image, ...metadata } = result;
      if (Buffer.byteLength(JSON.stringify(metadata)) > 262144) throw resultError("too_large", "Browser result exceeds 256 KiB; request a smaller observation");
      const validated = browserOutputs[method].safeParse(metadata);
      if (!validated.success) throw resultError("invalid_response", "Browser result failed validation");
      if (method === "connect" || method === "attach") this.browserIssues.delete(String(params.browser));
      if (method === "detach") this.browserIssues.clear();
      if (method === "screenshot") {
        if (typeof image !== "string" || image.length > 1400000 || Buffer.from(image, "base64").length !== metadata.bytes) throw resultError("invalid_response", "Invalid browser screenshot");
        return { ...validated.data, image };
      }
      return validated.data;
    } finally { if (consent) this.consentPending = false; this.resetIdle(); }
  }
  private async closeManagedChrome(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const check = () => {
      if (this.closed || signal?.aborted) throw new BrowserError("cancelled", "Linux Chrome shutdown cancelled before dispatch");
    };
    check();
    const url = endpoint(this.env.OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT ?? "http://127.0.0.1:9222");
    if (new URL(url).hostname !== "127.0.0.1") throw new BrowserError("close_unavailable", "Managed Chrome requires an IPv4 loopback endpoint");
    const profile = join(this.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode-connect/chrome-linux");
    const port = new URL(url).port;
    const unit = await managedUnit(this.env);
    check();
    if (unit.state === "inactive" || unit.state === "failed") {
      if (await browserEndpointReachable(this.env) || await chromeProfileRunning(profile))
        throw new BrowserError("unowned_browser", "An unowned Chrome endpoint or profile process exists; nothing was stopped");
      return { browser: "linux", closed: true, alreadyClosed: true, reachable: false };
    }
    if (unit.state !== "active" || unit.pid <= 1) throw new BrowserError("unowned_browser", "Managed Chrome ownership is uncertain; nothing was stopped");
    try {
      const [executable, argv, cgroup] = await Promise.all([
        readlink(`/proc/${unit.pid}/exe`),
        readFile(`/proc/${unit.pid}/cmdline`, "utf8"),
        readFile(`/proc/${unit.pid}/cgroup`, "utf8"),
      ]);
      if (!isManagedChromeProcess({ pid: unit.pid, executable, argv: argv.split("\0").filter(Boolean), cgroup, profile, port }))
        throw new Error("Unowned process");
    } catch {
      throw new BrowserError("unowned_browser", "Linux Chrome unit does not own the expected process/profile/port; nothing was stopped");
    }
    check();
    // A systemd unit is the authority for its own process group; never send
    // signals to inferred PIDs or any Windows/unmanaged Chrome instance.
    try {
      await exec("systemctl", ["--user", "stop", CHROME_UNIT], { env: this.env, timeout: 12000, maxBuffer: 4096 });
    } catch {
      throw new BrowserError("close_failed", "Managed Chrome shutdown failed; inspect the dedicated unit");
    }
    const deadline = Date.now() + 4000;
    do {
      const after = await managedUnit(this.env);
      if ((after.state === "inactive" || after.state === "failed")
        && !await browserEndpointReachable(this.env) && !await chromeProfileRunning(profile)) {
        this.stop("Linux Chrome closed on explicit request; reattach after launch", "worker_unavailable", null, false);
        return { browser: "linux", closed: true, alreadyClosed: false, reachable: false };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new BrowserError("close_unverified", "Linux Chrome shutdown outcome could not be verified; inspect status before retrying");
  }
  private async launch(input: { headless: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const check = () => {
      if (this.closed || signal?.aborted) throw new BrowserError("cancelled", "Chrome launch cancelled; any already launched Chrome is preserved");
    };
    const url = endpoint(this.env.OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT ?? "http://127.0.0.1:9222");
    const reachable = () => browserEndpointReachable(this.env);
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


// An inactive unit plus a closed CDP port is not sufficient if Chrome migrated
// to another cgroup or restarted without a debugging endpoint.
async function chromeProfileRunning(profile: string): Promise<boolean> {
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const exe = (await readlink(`/proc/${name}/exe`)).split("/").pop() ?? "";
      if (!/^(?:chrome|google-chrome(?:-stable)?|chromium(?:-browser)?)$/.test(exe)) continue;
      const args = (await readFile(`/proc/${name}/cmdline`, "utf8")).replace(/\0/g, " ").split(/\s+/);
      if (args.includes("--user-data-dir=" + profile)) return true;
    } catch {}
  }
  return false;
}
