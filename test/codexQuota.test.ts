import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { isCodexRolloutFilename, observeCodexQuota, type QuotaWatcher } from "../src/codexQuota.js";

const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const usage = { buckets: [] };

test("quota watcher invalidates only rollout filenames and coalesces bursts", async () => {
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  let closed = false;
  watcher.close = () => { closed = true; };
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, readUsage: async () => { reads++; return usage; },
    watch: () => watcher as unknown as QuotaWatcher, debounceMs: 10, minReadGapMs: 0,
  });
  await pause();
  assert.equal(reads, 1);
  watcher.emit("change", "change", "other.jsonl");
  watcher.emit("change", "change", "rollout-2026-01.jsonl");
  watcher.emit("change", "change", "nested/rollout-2026-01.jsonl");
  await pause(30);
  assert.equal(reads, 2);
  assert.equal(monitor.snapshot().watcher, "watching");
  monitor.close();
  assert.equal(closed, true);
  watcher.emit("change", "change", "rollout-2026-02.jsonl");
  await pause(30);
  assert.equal(reads, 2);
});

test("events during a quota read cause one trailing fresh read", async () => {
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  watcher.close = () => {};
  let reads = 0;
  let release: (() => void) | undefined;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => watcher as unknown as QuotaWatcher, debounceMs: 5, minReadGapMs: 0,
    readUsage: async () => {
      reads++;
      if (reads === 2) await new Promise<void>(resolve => { release = resolve; });
      return usage;
    },
  });
  await pause();
  watcher.emit("change", "change", "rollout-one.jsonl");
  await pause(15);
  watcher.emit("change", "change", "rollout-two.jsonl");
  await pause(15);
  release?.();
  await pause(20);
  assert.equal(reads, 3);
  monitor.close();
});

test("unavailable recursive watcher exposes manual refresh state and filename filtering", async () => {
  const states: Array<{ status: string; watcher: string }> = [];
  const monitor = observeCodexQuota({
    onChange: state => states.push({ status: state.status, watcher: state.watcher }),
    watch: () => { throw new Error("unsupported"); }, readUsage: async () => usage,
  });
  await pause();
  assert.deepEqual(monitor.snapshot().watcher, "manual");
  assert.equal(monitor.snapshot().status, "available");
  assert.ok(states.some(state => state.watcher === "manual"));
  assert.equal(isCodexRolloutFilename("nested/rollout-a.jsonl"), true);
  assert.equal(isCodexRolloutFilename("nested/other.jsonl"), false);
  assert.equal(isCodexRolloutFilename(null), false);
  monitor.close();
});

test("closing an active quota read cancels it and waits for settlement", async () => {
  let started!: () => void;
  const opened = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const monitor = observeCodexQuota({
    onChange: () => {},
    watch: () => { throw new Error("no watcher"); },
    readUsage: signal => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("cancelled"));
      }, { once: true });
      started();
    }),
  });
  await opened;
  await monitor.close();
  assert.equal(aborted, true);
  assert.notEqual(monitor.snapshot().status, "available");
});

test("remote quota resets use bounded timers and re-arm without an early read", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const timers = t.mock.method(globalThis, "setTimeout");
  const maxDelay = 2 ** 31 - 1;
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => { throw new Error("manual"); },
    readUsage: async () => {
      reads++;
      return { buckets: [{ bucketKey: "codex", primary: { usedPercent: 10, resetsAt: (maxDelay + 1000) / 1000, windowDurationMins: 300 }, secondary: null }] };
    },
    debounceMs: 5, minReadGapMs: 0,
  });
  await monitor.refresh();
  const initialReads = reads;
  assert.ok(timers.mock.calls.some(call => call.arguments[1] === maxDelay));
  assert.ok(timers.mock.calls.every(call => Number(call.arguments[1]) <= maxDelay));
  t.mock.timers.tick(maxDelay);
  await Promise.resolve();
  assert.equal(reads, initialReads);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(5);
  await Promise.resolve();
  assert.equal(reads, initialReads + 1);
  await monitor.close();
});

test("only the displayed Codex bucket schedules a quota reset read", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let reads = 0;
  let ready!: () => void;
  const firstRead = new Promise<void>(resolve => { ready = resolve; });
  const monitor = observeCodexQuota({
    onChange: state => { if (state.status === "available") ready(); }, watch: () => { throw new Error("manual"); },
    readUsage: async () => {
      reads++;
      return { buckets: [
        { bucketKey: "another-limit", primary: { usedPercent: 2, resetsAt: 1, windowDurationMins: 300 }, secondary: null },
        { bucketKey: "codex", primary: { usedPercent: 10, resetsAt: 20, windowDurationMins: 300 }, secondary: null },
      ] };
    },
    debounceMs: 5, minReadGapMs: 0,
  });
  await firstRead;
  assert.equal(reads, 1);
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(5);
  await Promise.resolve();
  assert.equal(reads, 1);
  t.mock.timers.tick(18_995);
  t.mock.timers.tick(5);
  await Promise.resolve();
  assert.equal(reads, 2);
  await monitor.close();
});

test("failed quota reads respect the read gap during rollout event bursts", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  watcher.close = () => {};
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => watcher as unknown as QuotaWatcher,
    readUsage: async () => { reads++; throw new Error("unavailable"); },
    debounceMs: 5, minReadGapMs: 100,
  });
  await Promise.resolve();
  assert.equal(reads, 1);
  for (let elapsed = 0; elapsed < 100; elapsed += 5) {
    watcher.emit("change", "rename", "rollout-busy.jsonl");
    t.mock.timers.tick(5);
    await Promise.resolve();
  }
  assert.equal(reads, 2);
  await monitor.close();
});

test("a synchronous quota reader failure does not block later refreshes", async () => {
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => { throw new Error("manual"); },
    readUsage: () => { reads++; throw new Error("reader failed"); },
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  await monitor.refresh();
  assert.equal(reads, 2);
  await monitor.close();
});

test("manual quota refresh supersedes a pending watcher refresh", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  watcher.close = () => {};
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => watcher as unknown as QuotaWatcher,
    readUsage: async () => { reads++; return usage; },
    debounceMs: 10, minReadGapMs: 100,
  });
  await Promise.resolve();
  watcher.emit("change", "change", "rollout-new.jsonl");
  t.mock.timers.tick(50);
  await monitor.refresh();
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(reads, 2);
  await monitor.close();
});

test("simultaneous close calls both await the active quota reader", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => { throw new Error("manual"); },
    readUsage: async () => { await pending; return usage; },
  });
  let firstSettled = false;
  let secondSettled = false;
  const first = monitor.close().then(() => { firstSettled = true; });
  const second = monitor.close().then(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  release();
  await Promise.all([first, second]);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
});

test("immediate close does not launch a quota reader after cancellation", async () => {
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => { throw new Error("manual"); },
    readUsage: async () => { reads++; return usage; },
  });
  await monitor.close();
  assert.equal(reads, 0);
});

test("a watcher close failure cannot prevent quota reader cancellation", async () => {
  let aborted = false;
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  watcher.close = () => { throw new Error("watcher close failed"); };
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => watcher as unknown as QuotaWatcher,
    readUsage: signal => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("cancelled"));
      }, { once: true });
    }),
  });
  await Promise.resolve(); // Allow the reader to subscribe before cancellation.
  await monitor.close();
  assert.equal(aborted, true);
});

test("a quota read resolving after close cannot publish success or restore timers", async t => {
  const timers = t.mock.method(globalThis, "setTimeout");
  let resolve!: (value: typeof usage) => void;
  const states: string[] = [];
  const monitor = observeCodexQuota({
    onChange: state => states.push(state.status),
    watch: () => { throw new Error("manual"); },
    readUsage: () => new Promise(done => { resolve = done; }),
  });
  await Promise.resolve(); // The reader must have started before its late resolution is tested.
  const closing = monitor.close();
  resolve(usage);
  await closing;
  assert.deepEqual(states, []);
  assert.equal(monitor.snapshot().status, "connecting");
  assert.equal(timers.mock.callCount(), 0);
});

test("continuous rollout events do not slide the quota refresh deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  watcher.close = () => {};
  let reads = 0;
  const monitor = observeCodexQuota({
    onChange: () => {}, watch: () => watcher as unknown as QuotaWatcher,
    readUsage: async () => { reads++; return usage; }, debounceMs: 10, minReadGapMs: 100,
  });
  await monitor.refresh();
  const initialReads = reads;
  for (let elapsed = 0; elapsed < 100; elapsed += 5) {
    watcher.emit("change", "change", "rollout-busy.jsonl");
    t.mock.timers.tick(5);
    await Promise.resolve();
  }
  assert.equal(reads, initialReads + 1);
  await monitor.close();
});
