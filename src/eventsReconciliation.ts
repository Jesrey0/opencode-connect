import type { OpenCodeBackend } from "./opencode.js";
import { canonicalTerminalStatus, type Events } from "./events.js";
import { safeError } from "./bounds.js";

type Target = { sessionId: string; messageId: string };
type Input = Parameters<OpenCodeBackend["inspect"]>[0];

// Native hints trigger recovery; only complete canonical selection queues an event.
export class EventReconciler {
  private continuations = new Map<string, Input>();
  private busy = false;
  constructor(private readonly backend: Pick<OpenCodeBackend, "inspect">,
    private readonly events: Pick<Events, "targets" | "observe" | "lifecycle">) {}
  async reconcile(sessionId?: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      const targets = this.events.targets();
      const keys = new Set(targets.map((target) => JSON.stringify(target)));
      for (const key of this.continuations.keys()) if (!keys.has(key)) this.continuations.delete(key);
      for (const target of targets) {
        if (sessionId && target.sessionId !== sessionId) continue;
        const key = JSON.stringify(target);
        try {
          // Carry native scan arguments between bounded reconciliation passes.
          // A stale fingerprint fails closed and restarts selection next time.
          for (let page = 0; page < 4; page++) {
            const input = this.continuations.get(key) ?? { ...target, detail: "result" as const };
            const inspected = await this.backend.inspect(input) as { session?: { executionOutcome?: unknown }; result?: {
              terminal?: boolean; selectionComplete?: boolean; outcome?: string; completedAtMs?: number;
              nextCall?: { tool?: string; arguments?: Input };
            } };
            const result = inspected.result;
            const status = canonicalTerminalStatus(inspected.session?.executionOutcome, result);
            if (status) {
              await this.events.observe(target.sessionId, target.messageId, status,
                result?.completedAtMs ? new Date(result.completedAtMs).toISOString() : new Date().toISOString());
              this.continuations.delete(key); break;
            }
            const next = result?.nextCall;
            if (!result?.terminal || next?.tool !== "opencode.inspect" || !this.sameTarget(target, next.arguments)) {
              this.continuations.delete(key); break;
            }
            this.continuations.set(key, next.arguments!);
          }
        } catch (error) {
          this.continuations.delete(key);
          // Sanitized lifecycle evidence only: session/message IDs and a
          // fixed reason. Raw errors can carry provider bodies or tickets.
          this.events.lifecycle.record("reconciliationFailed", { sessionId: target.sessionId, messageId: target.messageId, reason: "internal" });
          console.error("Events canonical reconciliation failed", safeError(error));
        }
      }
    } finally { this.busy = false; }
  }
  private sameTarget(target: Target, input?: Input) {
    return input?.sessionId === target.sessionId && input.messageId === target.messageId && input.detail === "result";
  }
}
