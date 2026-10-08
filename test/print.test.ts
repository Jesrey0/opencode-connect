import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { ComputerBackend } from "../src/computer.js";
import type { ComputerTransport } from "../src/computerBridge.js";
import { nativeFixture } from "./native-fixture.js";
import {
  PrintBridge, PrintBridgeError, defaultPrintExecutable, resolvePrintExecutable,
  canonicalPrintFile, PRINT_MAX_FILE_BYTES,
} from "../src/printBridge.js";
import {
  PrintBackend, statusArgs, capabilitiesArgs, mediaGetArgs, mediaSetArgs,
  inspectArgs, submitArgs, queueArgs, jobArgs, cancelArgs,
} from "../src/print.js";
import {
  printSubmitSchema, printInspectSchema, printCapabilitiesSchema, printSetMediaSchema,
} from "../src/printSchema.js";

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function openFdCount(): Promise<number | null> {
  try { return (await readdir("/proc/self/fd")).length; }
  catch { return null; }
}

async function waitForFdCount(target: number, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (true) {
    const count = await openFdCount();
    if (count === null) return;
    if (count <= target) return;
    if (Date.now() - start > timeoutMs) throw new Error(`fd leak waiting for ${label}: ${count} > ${target}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FakePrintProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  chunks: Buffer[] = [];
  killed = false;
  stdin: Writable;
  constructor(options: { stallStdin?: boolean } = {}) {
    super();
    if (options.stallStdin) {
      // Accept nothing: backpressure stalls the file source while its fd is open.
      this.stdin = new Writable({ write: (chunk, _enc, _cb) => { this.chunks.push(Buffer.from(chunk as Buffer)); /* never acknowledge */ } });
    } else {
      this.stdin = new Writable({ write: (chunk, _enc, cb) => { this.chunks.push(Buffer.from(chunk as Buffer)); cb(); } });
    }
  }
  child() { return this as unknown as ChildProcessWithoutNullStreams; }
  kill() { this.killed = true; return true; }
  stdinBytes() { return Buffer.concat(this.chunks); }
  succeed(payload: unknown) {
    this.stdout.write(Buffer.from(JSON.stringify(payload)));
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit("close", 0));
  }
  succeedText(text: string) {
    this.stdout.write(Buffer.from(text));
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit("close", 0));
  }
  failJson(code: number, payload: unknown) {
    if (payload !== undefined) this.stdout.write(Buffer.from(JSON.stringify(payload)));
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit("close", code));
  }
  failText(code: number, text: string) {
    this.stdout.write(Buffer.from(text));
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit("close", code));
  }
  failStderrJson(code: number, payload: unknown) {
    if (payload !== undefined) this.stderr.write(Buffer.from(JSON.stringify(payload)));
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit("close", code));
  }
  failBothJson(code: number, stdoutPayload: unknown, stderrPayload: unknown) {
    this.stdout.write(Buffer.from(JSON.stringify(stdoutPayload)));
    this.stderr.write(Buffer.from(JSON.stringify(stderrPayload)));
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit("close", code));
  }
  closeNow(code: number | null) {
    this.emit("close", code);
  }
}

function printFixture(options: { timeoutMs?: number; maxOutputBytes?: number; maxFileBytes?: number; executable?: string; stallStdin?: boolean } = {}) {
  const processes: FakePrintProcess[] = [];
  const invocations: { executable: string; args: string[] }[] = [];
  const bridge = new PrintBridge({
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    maxFileBytes: options.maxFileBytes,
    executable: options.executable,
    spawn: (executable, args) => {
      invocations.push({ executable, args });
      const child = new FakePrintProcess({ stallStdin: options.stallStdin });
      processes.push(child);
      return child.child();
    },
  });
  return { bridge, processes, invocations };
}

function withPrintEnv(env: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["LOCALAPPDATA", "APPDATA", "PRINT_BRIDGE_EXE"]) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("print command construction matches the companion CLI contract", () => {
  assert.deepEqual(statusArgs(), ["status", "--json"]);
  assert.deepEqual(capabilitiesArgs({}), ["capabilities", "--json"]);
  assert.deepEqual(capabilitiesArgs({ printer: "Lab" }), ["capabilities", "--printer", "Lab", "--json"]);
  assert.deepEqual(mediaGetArgs({}), ["media", "get", "--json"]);
  assert.deepEqual(mediaSetArgs({ paper: "A4" }), ["media", "set", "--paper", "A4", "--json"]);
  assert.deepEqual(mediaSetArgs({ paper: "A4", media: "Plain" }), ["media", "set", "--paper", "A4", "--media", "Plain", "--json"]);
  assert.deepEqual(inspectArgs("doc.pdf"), ["inspect", "--stdin", "--filename", "doc.pdf", "--json"]);
  assert.deepEqual(
    submitArgs({ filename: "doc.pdf", printer: "Lab", copies: 2, paper: "A4", orientation: "Landscape", color: "Grayscale", scale: "Fit" }),
    ["submit", "--stdin", "--filename", "doc.pdf", "--printer", "Lab", "--copies", "2", "--paper", "A4", "--orientation", "Landscape", "--color", "Grayscale", "--scale", "Fit", "--json"],
  );
  assert.deepEqual(submitArgs({ filename: "doc.pdf" }), ["submit", "--stdin", "--filename", "doc.pdf", "--json"]);
  assert.deepEqual(queueArgs({}), ["queue", "--json"]);
  assert.deepEqual(queueArgs({ printer: "Lab" }), ["queue", "--printer", "Lab", "--json"]);
  assert.deepEqual(jobArgs({ printer: "Lab", id: "42" }), ["job", "--printer", "Lab", "--id", "42", "--json"]);
  assert.deepEqual(cancelArgs({ printer: "Lab", id: "42" }), ["cancel", "--printer", "Lab", "--id", "42", "--json"]);
  for (const args of [statusArgs(), capabilitiesArgs({}), mediaGetArgs({}), queueArgs({})]) {
    assert.equal(args.at(-1), "--json");
  }
});

test("print schemas validate copies 1..99 plus paper/orientation/color/scale and reject executable paths", () => {
  assert.equal(printSubmitSchema.safeParse({ path: "/tmp/a.pdf", copies: 1 }).success, true);
  assert.equal(printSubmitSchema.safeParse({ path: "/tmp/a.pdf", copies: 99, paper: "A4", orientation: "Landscape", color: "Grayscale", scale: "Fit" }).success, true);
  assert.equal(printSubmitSchema.safeParse({ path: "/tmp/a.pdf", orientation: "Auto", color: "Auto", scale: "Actual" }).success, true);
  for (const bad of [
    { path: "/tmp/a.pdf", copies: 0 }, { path: "/tmp/a.pdf", copies: 100 }, { path: "/tmp/a.pdf", copies: 101 }, { path: "/tmp/a.pdf", copies: 1.5 },
    { path: "/tmp/a.pdf", paper: "" }, { path: "/tmp/a.pdf", paper: "x".repeat(129) },
    { path: "/tmp/a.pdf", orientation: "Sideways" }, { path: "/tmp/a.pdf", color: "Mono" }, { path: "/tmp/a.pdf", scale: "Stretch" },
    { path: "/tmp/a.pdf", printer: "" }, { path: "/tmp/a.pdf", filename: "a/b.pdf" }, { path: "/tmp/a.pdf", filename: "a\\b.pdf" },
    { path: "/tmp/a.pdf", executable: "/evil/print-bridge.exe" },
  ]) assert.equal(printSubmitSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(printInspectSchema.safeParse({ path: "/tmp/a.pdf", executable: "/evil" }).success, false);
  assert.equal(printCapabilitiesSchema.safeParse({ printer: "Lab", executable: "/evil" }).success, false);
  assert.equal(printSetMediaSchema.safeParse({ paper: "A4", media: "Plain", executable: "/evil" }).success, false);
});

test("print executable resolves server-side; WSL/Linux without config fails clearly without spawning", async () => {
  withPrintEnv({ LOCALAPPDATA: join(tmpdir(), "FakeLocalAppData"), APPDATA: undefined, PRINT_BRIDGE_EXE: undefined }, () => {
    if (process.platform === "win32") {
      assert.equal(defaultPrintExecutable(), join(tmpdir(), "FakeLocalAppData", "WindowsPrintBridge", "print-bridge.exe"));
      assert.equal(resolvePrintExecutable(), join(tmpdir(), "FakeLocalAppData", "WindowsPrintBridge", "print-bridge.exe"));
    } else {
      // WSL/Linux may inherit a Windows LOCALAPPDATA; never form a mixed path.
      assert.equal(defaultPrintExecutable(), null);
      assert.throws(() => resolvePrintExecutable(), /not configured.*PRINT_BRIDGE_EXE/);
    }
  });
  withPrintEnv({ LOCALAPPDATA: undefined, APPDATA: undefined, PRINT_BRIDGE_EXE: "/srv/bin/print-bridge.exe" }, () => {
    assert.equal(defaultPrintExecutable(), null);
    assert.equal(resolvePrintExecutable(), "/srv/bin/print-bridge.exe");
    assert.equal(new PrintBridge({ executable: "/srv/explicit/print-bridge.exe" }).executablePath(), "/srv/explicit/print-bridge.exe");
  });
  // No LOCALAPPDATA and no override: no bogus Linux-home default is advertised.
  withPrintEnv({ LOCALAPPDATA: undefined, APPDATA: undefined, PRINT_BRIDGE_EXE: undefined }, () => {
    assert.equal(defaultPrintExecutable(), null);
    assert.throws(() => resolvePrintExecutable(), /not configured.*PRINT_BRIDGE_EXE/);
  });
  // Missing configuration rejects before spawning any child process.
  const spawned: string[] = [];
  const savedLocal = process.env.LOCALAPPDATA;
  const savedApp = process.env.APPDATA;
  const savedExe = process.env.PRINT_BRIDGE_EXE;
  try {
    delete process.env.LOCALAPPDATA; delete process.env.APPDATA; delete process.env.PRINT_BRIDGE_EXE;
    const bridge = new PrintBridge({ spawn: (executable, args) => { spawned.push(executable); throw new Error("must not spawn without configuration"); } });
    await assert.rejects(bridge.run(["status", "--json"]), (e) => e instanceof PrintBridgeError && e.code === "not_configured" && /PRINT_BRIDGE_EXE/.test(e.message));
    assert.equal(spawned.length, 0);
  } finally {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
    if (savedApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedApp;
    if (savedExe === undefined) delete process.env.PRINT_BRIDGE_EXE; else process.env.PRINT_BRIDGE_EXE = savedExe;
  }
});

test("print file validation requires a regular bounded file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-file-"));
  try {
    const file = join(dir, "doc.pdf");
    await writeFile(file, "hello");
    const resolved = await canonicalPrintFile(file);
    assert.equal(resolved.size, 5);
    await assert.rejects(canonicalPrintFile(join(dir, "missing.pdf")), /regular file|accessible/);
    await assert.rejects(canonicalPrintFile(dir), /regular file/);
    await assert.rejects(canonicalPrintFile(file, 4), /exceeds/);
    assert.ok((await stat(file)).isFile());
    assert.equal(PRINT_MAX_FILE_BYTES, 25 * 1024 * 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("inspect/submit stream raw file bytes to child stdin without base64 over MCP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-stream-"));
  try {
    const bytes = Buffer.from('$([Console]::WriteLine("X"))\nété😀\0binary\xff', "binary");
    const file = join(dir, "doc.pdf");
    await writeFile(file, bytes);
    const f = printFixture({ executable: "/srv/bin/print-bridge.exe" });
    const backend = new PrintBackend(f.bridge);
    const inspectCall = backend.inspect({ path: file });
    await waitFor(() => f.processes.length > 0, "inspect spawn");
    await waitFor(() => f.processes[0].chunks.length > 0, "inspect stdin bytes");
    // MCP input carries only a host path, never file bytes or base64.
    assert.equal(JSON.stringify({ path: file }).includes(bytes.toString("base64")), false);
    f.processes[0].succeed({ filename: basename(file), pages: 3 });
    const inspected = await inspectCall;
    assert.deepEqual(f.invocations[0].args, ["inspect", "--stdin", "--filename", basename(file), "--json"]);
    assert.deepEqual(f.processes[0].stdinBytes(), bytes);

    const g = printFixture({ executable: "/srv/bin/print-bridge.exe" });
    const submitBackend = new PrintBackend(g.bridge);
    const submitCall = submitBackend.submit({ path: file, printer: "Lab", copies: 2, paper: "A4", orientation: "Portrait", color: "Color", scale: "Fit" });
    await waitFor(() => g.processes.length > 0, "submit spawn");
    await waitFor(() => g.processes[0].chunks.length > 0, "submit stdin bytes");
    g.processes[0].succeed({ jobId: "7" });
    const submitted = await submitCall;
    assert.deepEqual((submitted as Record<string, unknown>).jobId, "7");
    assert.deepEqual(g.invocations[0].args, ["submit", "--stdin", "--filename", basename(file), "--printer", "Lab", "--copies", "2", "--paper", "A4", "--orientation", "Portrait", "--color", "Color", "--scale", "Fit", "--json"]);
    assert.deepEqual(g.processes[0].stdinBytes(), bytes);
    assert.equal(JSON.stringify(inspected).includes(bytes.toString("base64")), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("print bridge parses stderr structured errors and stays compatible with stdout errors", async () => {
  // Companion contract: structured JSON errors arrive on stderr on nonzero exit.
  const s = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const stderrCall = s.bridge.run(["status", "--json"]);
  await waitFor(() => s.processes.length > 0, "stderr-error spawn");
  s.processes[0].failStderrJson(1, { code: "printer_offline", message: "printer is offline", details: { printer: "Lab" } });
  await assert.rejects(stderrCall, (e) => e instanceof PrintBridgeError
    && e.code === "printer_offline"
    && /printer is offline/.test(e.message)
    && JSON.stringify(e.detail).includes("printer_offline"));

  const nested = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const nestedCall = nested.bridge.run(["queue", "--json"]);
  await waitFor(() => nested.processes.length > 0, "nested stderr-error spawn");
  nested.processes[0].failStderrJson(2, { error: { code: "job_not_found", message: "no such job" } });
  await assert.rejects(nestedCall, (e) => e instanceof PrintBridgeError && e.code === "job_not_found" && /no such job/.test((e as Error).message));

  // Compatibility: structured errors on stdout keep working.
  const f = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const statusCall = f.bridge.run(["status", "--json"]);
  await waitFor(() => f.processes.length > 0, "stdout-error spawn");
  f.processes[0].failJson(1, { code: "spool_full", message: "spool full" });
  await assert.rejects(statusCall, (e) => e instanceof PrintBridgeError && e.code === "spool_full" && JSON.stringify(e.detail).includes("spool_full"));

  // Stderr is authoritative when both streams carry structured errors.
  const b = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const bothCall = b.bridge.run(["status", "--json"]);
  await waitFor(() => b.processes.length > 0, "dual-error spawn");
  b.processes[0].failBothJson(1, { code: "legacy_code", message: "legacy" }, { code: "new_code", message: "current" });
  await assert.rejects(bothCall, (e) => e instanceof PrintBridgeError && e.code === "new_code");

  // Non-JSON stdout on failure stays invalid_json; malformed success JSON fails too.
  const h = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const invalid = h.bridge.run(["status", "--json"]);
  await waitFor(() => h.processes.length > 0, "invalid-json spawn");
  h.processes[0].failText(1, "not json");
  await assert.rejects(invalid, (e) => e instanceof PrintBridgeError && e.code === "invalid_json");

  const m = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const malformedSuccess = m.bridge.run(["status", "--json"]);
  await waitFor(() => m.processes.length > 0, "malformed-success spawn");
  m.processes[0].succeedText("not json");
  await assert.rejects(malformedSuccess, (e) => e instanceof PrintBridgeError && e.code === "invalid_json");

  const n = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const nonObject = n.bridge.run(["status", "--json"]);
  await waitFor(() => n.processes.length > 0, "non-object spawn");
  n.processes[0].succeed([1, 2, 3]);
  await assert.rejects(nonObject, (e) => e instanceof PrintBridgeError && e.code === "invalid_json");
});

test("print bridge bounds output/time and makes a single submit attempt", async () => {
  const t = printFixture({ timeoutMs: 15, executable: "/srv/bin/print-bridge.exe" });
  await assert.rejects(t.bridge.run(["status", "--json"]), (e) => e instanceof PrintBridgeError && e.code === "timeout");
  assert.equal(t.processes[0].killed, true);

  const o = printFixture({ maxOutputBytes: 8, executable: "/srv/bin/print-bridge.exe" });
  const oversized = o.bridge.run(["status", "--json"]);
  await waitFor(() => o.processes.length > 0, "oversized spawn");
  o.processes[0].stdout.write(Buffer.from(JSON.stringify({ large: "x".repeat(100) })));
  await assert.rejects(oversized, (e) => e instanceof PrintBridgeError && e.code === "too_large");

  // Submit/cancel make a single attempt: one spawn per call, no automatic retry.
  const dir = await mkdtemp(join(tmpdir(), "print-once-"));
  try {
    const file = join(dir, "a.pdf");
    await writeFile(file, "data");
    const once = printFixture({ executable: "/srv/bin/print-bridge.exe" });
    const backend = new PrintBackend(once.bridge);
    const call = backend.submit({ path: file });
    await waitFor(() => once.processes.length > 0, "single-attempt spawn");
    await waitFor(() => once.processes[0].chunks.length > 0, "single-attempt stdin");
    once.processes[0].failStderrJson(1, { code: "spool_full", message: "spool full" });
    await assert.rejects(call, /spool_full/);
    assert.equal(once.processes.length, 1);
    assert.equal(once.invocations.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("print file stream is destroyed on early child close without leaking fds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-earlyclose-"));
  try {
    const file = join(dir, "doc.pdf");
    await writeFile(file, Buffer.alloc(1024 * 1024, 7));
    const baseline = await openFdCount();
    const f = printFixture({ executable: "/srv/bin/print-bridge.exe" });
    const backend = new PrintBackend(f.bridge);
    const call = backend.inspect({ path: file });
    await waitFor(() => f.processes.length > 0, "early-close spawn");
    // Child exits before the file source drains; the open ReadStream must be
    // destroyed so its file descriptor is released on every settlement path.
    f.processes[0].closeNow(1);
    await assert.rejects(call, (e) => e instanceof PrintBridgeError);
    assert.equal(f.processes[0].killed, false);
    if (baseline !== null) await waitForFdCount(baseline, "early-close fd release");
    // The bridge stays usable for a later call after the early close.
    const retry = backend.inspect({ path: file });
    await waitFor(() => f.processes.length > 1, "post-close spawn");
    f.processes[1].succeed({ pages: 2 });
    assert.deepEqual((await retry as Record<string, unknown>).pages, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("print file stream is destroyed on timeout while the source is stalled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-stall-"));
  try {
    const file = join(dir, "doc.pdf");
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024, 9));
    const baseline = await openFdCount();
    const f = printFixture({ executable: "/srv/bin/print-bridge.exe", timeoutMs: 50, stallStdin: true });
    const backend = new PrintBackend(f.bridge);
    await assert.rejects(backend.inspect({ path: file }), (e) => e instanceof PrintBridgeError && e.code === "timeout");
    assert.equal(f.processes[0].killed, true);
    if (baseline !== null) await waitForFdCount(baseline, "timeout fd release");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("print MCP tools coexist with computer tools without changing computer behavior", async () => {
  const native = nativeFixture(() => { throw new Error("must not access OpenCode"); });
  const transport: ComputerTransport = { request: async () => [[{ handle: "0x1234", processId: 1, title: "App", bounds: { x: 0, y: 0, width: 1, height: 1 }, executablePath: null, processName: "app" }]], close: () => {} };
  const f = printFixture({ executable: "/srv/bin/print-bridge.exe" });
  const server = createServer(
    new OpenCodeBackend(native.connect),
    new HostBackend(native.connect),
    undefined,
    new ComputerBackend(transport),
    new PrintBackend(f.bridge),
  );
  const client = new Client({ name: "print-compat", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const name of ["computer.observe", "computer.interact", "computer.sequence", "computer.screenshot"]) assert.ok(names.includes(name), name);
    for (const name of ["print.status", "print.capabilities", "print.media", "print.set_media", "print.inspect", "print.submit", "print.queue", "print.job", "print.cancel"]) assert.ok(names.includes(name), name);
    assert.equal(tools.find((t) => t.name === "print.submit")!.annotations!.destructiveHint, true);
    assert.match(tools.find((t) => t.name === "print.submit")!.description!, /physical paper side effect/);
    assert.match(tools.find((t) => t.name === "print.set_media")!.description!, /human declaration of loaded physical media/);
    assert.equal(tools.find((t) => t.name === "print.status")!.annotations!.readOnlyHint, true);
    assert.deepEqual(tools.find((t) => t.name === "print.cancel")!.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false });

    const computerResult = await client.callTool({ name: "computer.observe", arguments: { type: "windows" } });
    assert.equal(computerResult.isError, undefined);

    const statusCall = client.callTool({ name: "print.status", arguments: {} });
    await waitFor(() => f.processes.length > 0, "compat status spawn");
    f.processes[0].succeed({ printers: [] });
    const statusResult = await statusCall;
    assert.equal(statusResult.isError, undefined);

    const dir = await mkdtemp(join(tmpdir(), "print-mcp-"));
    try {
      const file = join(dir, "doc.pdf");
      await writeFile(file, "payload");
      const inspectCall = client.callTool({ name: "print.inspect", arguments: { path: file } });
      await waitFor(() => f.processes.length > 1, "compat inspect spawn");
      f.processes[1].succeed({ pages: 1 });
      const inspected = await inspectCall;
      assert.equal(inspected.isError, undefined);
      for (const copies of [0, 100]) {
        const rejected = await client.callTool({ name: "print.submit", arguments: { path: file, copies } });
        assert.equal(rejected.isError, true, `copies=${copies}`);
      }
      assert.equal(f.processes.length, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  } finally { await client.close(); await server.close(); }
});

test("print inspect rejects directories and oversized files before spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-prespawn-"));
  try {
    const f = printFixture({ executable: "/srv/bin/print-bridge.exe" });
    const backend = new PrintBackend(f.bridge);
    await assert.rejects(backend.inspect({ path: dir }), /regular file/);
    const file = join(dir, "big.pdf");
    await writeFile(file, "12345");
    await assert.rejects(backend.inspect({ path: file, filename: "bad/name" }), /separators|path/);
    const tiny = new PrintBridge({
      maxFileBytes: 4,
      executable: "/srv/bin/print-bridge.exe",
      spawn: () => { throw new Error("must not spawn for oversized files"); },
    });
    await assert.rejects(new PrintBackend(tiny).inspect({ path: file }), /exceeds/);
    assert.equal(f.invocations.length, 0);
    await mkdir(join(dir, "sub"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
