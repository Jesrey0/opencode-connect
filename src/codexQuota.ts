import { watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readCodexUsage } from "../packages/codex-plugin/src/usage.js";
import type { ConsoleQuota } from "./consoleView.js";

const DEBOUNCE_MS = 500;
const MIN_READ_GAP_MS = 10_000;
const STALE_AFTER_MS = 10 * 60_000;

export type CodexQuotaState = ConsoleQuota & { observedAtMs: number | null; watcher: "watching" | "manual" };
export type QuotaWatcher = { close: () => void; on: (event: string, listener: (...args: any[]) => void) => unknown };

export function isCodexRolloutFilename(filename: string | Buffer | null): boolean {
  if (filename === null) return false;
  const name = path.basename(String(filename));
  return /^rollout-[^/]+\.jsonl$/i.test(name);
}

export function observeCodexQuota({
  onChange,
  sessionsPath = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions"),
  readUsage = (signal?: AbortSignal) => readCodexUsage({ signal }),
  watch = (directory) => fsWatch(directory, { recursive: true }) as QuotaWatcher,
  debounceMs = DEBOUNCE_MS,
  minReadGapMs = MIN_READ_GAP_MS,
  now = Date.now,
}: {
  onChange: (state: CodexQuotaState) => void;
  sessionsPath?: string;
  readUsage?: (signal?: AbortSignal) => Promise<NonNullable<ConsoleQuota["usage"]>>;
  watch?: (directory: string) => QuotaWatcher;
  debounceMs?: number;
  minReadGapMs?: number;
  now?: () => number;
}) {
  let watcher: QuotaWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  let stopped = false;
  const controller = new AbortController();
  let state: CodexQuotaState = { status: "connecting", usage: null, observedAtMs: null, watcher: "manual" };
  const publish = (next: CodexQuotaState) => { state = next; if (!stopped) onChange({ ...state }); };
  const clear = (timer: ReturnType<typeof setTimeout> | undefined) => { if (timer) clearTimeout(timer); };

  const scheduleReset = () => {
    clear(resetTimer);
    const resets = (state.usage?.buckets ?? []).flatMap(bucket => [bucket.primary?.resetsAt, bucket.secondary?.resetsAt])
      .filter((value): value is number => value !== null && value !== undefined && value * 1000 > now());
    if (!resets.length) return;
    resetTimer = setTimeout(() => { resetTimer = undefined; invalidate(); }, Math.max(0, Math.min(...resets) * 1000 - now()));
    resetTimer.unref?.();
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) { queued = true; return inFlight; }
    inFlight = (async () => {
      do {
        queued = false;
        try {
          const usage = await readUsage(controller.signal);
          const observedAtMs = now();
          publish({ status: "available", usage, observedAtMs, watcher: watcher ? "watching" : "manual" });
          clear(staleTimer);
          staleTimer = setTimeout(() => {
            staleTimer = undefined;
            if (!stopped && state.observedAtMs === observedAtMs) publish({ ...state, status: "stale" });
          }, STALE_AFTER_MS);
          staleTimer.unref?.();
          scheduleReset();
        } catch {
          publish({ ...state, status: state.usage ? "stale" : "unavailable", watcher: watcher ? "watching" : "manual" });
        }
      } while (queued && !stopped);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  function invalidate() {
    if (stopped) return;
    if (debounceTimer) return;
    const elapsed = state.observedAtMs === null ? Infinity : now() - state.observedAtMs;
    const delayMs = Math.max(debounceMs, minReadGapMs - elapsed);
    debounceTimer = setTimeout(() => { debounceTimer = undefined; void refresh(); }, delayMs);
    debounceTimer.unref?.();
  }

  try {
    watcher = watch(sessionsPath);
    watcher.on("change", (_event: unknown, filename: string | Buffer | null) => { if (isCodexRolloutFilename(filename)) invalidate(); });
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      publish({ ...state, status: state.usage ? "stale" : "unavailable", watcher: "manual" });
    });
  } catch {
    watcher = undefined;
  }
  void refresh();
  return {
    snapshot: () => ({ ...state }),
    refresh,
    async close() {
      if (stopped) return;
      stopped = true;
      clear(debounceTimer); clear(staleTimer); clear(resetTimer);
      watcher?.close(); watcher = undefined;
      controller.abort();
      await inFlight;
    },
  };
}
