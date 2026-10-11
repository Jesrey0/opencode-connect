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
