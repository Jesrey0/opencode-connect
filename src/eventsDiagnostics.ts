import { EventErrorCode } from "./eventsErrors.js";
// Process-local evidence. Never accept callback URLs, secrets or raw errors.
export type EventStage = "subscriptionReceived" | "subscriptionAccepted" | "subscriptionRejected"
  | "verificationStarted" | "verificationSucceeded" | "verificationCached" | "verificationFailed"
  | "subscriptionActivated" | "subscriptionCancelled" | "subscriptionExpired" | "subscriptionRevoked"
  | "subscriptionPaused" | "subscriptionResumed" | "subscriptionsRecovered"
  | "eventQueued" | "deliveryAttempt" | "deliveryOutcome" | "deliveryFailed" | "callbackAcknowledged" | "storageFailed"
  | "reconciliationFailed";
type Fields = { requestId?: number; subscriptionId?: string; sessionId?: string; messageId?: string;
  eventId?: string; attempt?: number; httpStatus?: number; errorCode?: number; count?: number;
  outcome?: "delivered" | "retry" | "exhausted" | "transportFailed";
  reason?: "authorization" | "invalidSubscriptionOrPrompt" | "callbackVerification" | "capacity"
    | "internal" | "challenge_failed" | "timeout" | "unsafe_url" | "connection_failed" };
type Record = Fields & { stage: EventStage; timestampMs: number };

export class EventDiagnostics {
  private counters: Partial<{ [K in EventStage]: number }> = {};
  private recent: Record[] = [];
  private recentBytes = 0;
  private sequence = 0;
  constructor(private readonly time: () => number) {}
  record(stage: EventStage, fields: Fields = {}) {
    // Explicit projection is also enforced at runtime, even for untyped callers.
    const entry: Record = { stage, timestampMs: this.time() };
    for (const key of ["requestId", "subscriptionId", "sessionId", "messageId", "eventId", "attempt", "httpStatus", "errorCode", "count", "outcome", "reason"] as const) {
      if (fields[key] !== undefined) Object.assign(entry, { [key]: fields[key] });
    }
    this.counters[stage] = Math.min(Number.MAX_SAFE_INTEGER, (this.counters[stage] ?? 0) + 1);
    this.recent.push(entry);
    this.recentBytes += Buffer.byteLength(JSON.stringify(entry));
    while (this.recent.length > 128 || this.recentBytes > 24 * 1024) {
      this.recentBytes -= Buffer.byteLength(JSON.stringify(this.recent.shift()!));
    }
    console.info(`mcp_events ${JSON.stringify(entry)}`);
  }
  async subscription<T extends { id: string }>(run: () => Promise<T>): Promise<T> {
    const requestId = ++this.sequence;
    this.record("subscriptionReceived", { requestId });
    try {
      const result = await run();
      this.record("subscriptionAccepted", { requestId, subscriptionId: result.id });
      return result;
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : undefined;
      const reason = errorCode === EventErrorCode.AuthorizationDenied ? "authorization" : errorCode === -32602 ? "invalidSubscriptionOrPrompt"
        : errorCode === EventErrorCode.CallbackEndpointError ? "callbackVerification" : errorCode === EventErrorCode.SubscriptionCapacityExceeded ? "capacity" : "internal";
      this.record("subscriptionRejected", { requestId, reason, ...(errorCode === undefined ? {} : { errorCode }) });
      throw error;
    }
  }
  snapshot() { return { scope: "process" as const, evidence: { counters: { ...this.counters }, recent: this.recent.map((entry) => ({ ...entry })) } }; }
}
