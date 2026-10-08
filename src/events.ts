import { EventErrorCode } from "./eventsErrors.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { acquireStoreLock } from "./storeLock.js";
import { dirname, join } from "node:path";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { EventDiagnostics } from "./eventsDiagnostics.js";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export const EVENT_NAME = "opencode.session.terminal";
const MAX_ATTEMPTS = 8;
// One delivery tick serves several due subscriptions in stable admission order
// so a single slow callback cannot starve later ones. The bound is explicit:
// a tick never drains the queue, and per-delivery backoff, authorization and
// storage semantics are unchanged.
export const MAX_DELIVERIES_PER_TICK = 8;
const MAX_SUBSCRIPTIONS = 128;
const MIN_TTL = 60_000;
const MAX_TTL = 86_400_000;
const RETENTION = 86_400_000;
const VERIFY_CACHE = 300_000;
const ENDPOINT = "http://127.0.0.1:9001/_host-ingress/events/authorize/opencode-connect";
const canonicalId = z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$/u);
export const eventArgumentsSchema = z.object({ sessionId: canonicalId, messageId: canonicalId }).strict();
const authorizationSchema = z.object({ principal: z.string().min(1).max(4096), clientId: z.string().min(1).max(4096), grantId: z.string().min(1).max(4096), resource: z.string().max(4096).url().startsWith("https://").endsWith("/opencode-connect/mcp"), scope: z.literal("opencode-connect:access"), grantContext: z.string().min(1).max(4096) }).strict();

export type Authorization = { principal: string; clientId: string; grantId: string; resource: string; scope: string; grantContext: string };
type Stored = { id: string; authorization: Authorization; sessionId: string; messageId: string; url: string; secret: string; oldSecret?: string; rotationUntil?: number; verifiedUntil?: number; expiresAt: number | null; retiredAt: number | null; state: string; delivery?: { id: string; body: string; attempts: number; nextAt: number; state: string } };
type Store = { subscriptions: Record<string, Stored> };
type Subscribe = { name: string; arguments: { sessionId: string; messageId: string }; delivery: { mode: string; url: string; secret?: string }; ttlMs?: number | null; cursor?: string | null };
export type EventHooks = { authenticate?: (context: string) => Promise<Authorization>; valid?: (auth: Authorization) => Promise<boolean>; post?: (url: URL, body: string, headers: Record<string, string>) => Promise<{ status: number; body: Buffer }>; now?: () => number };

const now = () => Date.now();
const fail = (message: string, code: number = ProtocolErrorCode.InvalidParams) => new ProtocolError(code, message);
const callbackFailure = (reason: string) => new ProtocolError(EventErrorCode.CallbackEndpointError as ProtocolErrorCode, "CallbackEndpointError", { reason });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const live = (s: Stored) => s.state === "active" || s.state === "paused";
function validateArguments(value: Subscribe["arguments"]) { if (!eventArgumentsSchema.safeParse(value).success) throw fail("sessionId and messageId must be exact canonical IDs"); }
function signingKey(value: string) {
  if (value.length > 128 || !value.startsWith("whsec_")) throw fail("invalid signing secret");
  const key = Buffer.from(value.slice(6), "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== value.slice(6)) throw fail("invalid signing secret");
  return key;
}
export function standardWebhookSignature(secret: string, id: string, timestamp: string, body: string) {
  return `v1,${createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}
export function canonicalTerminalStatus(executionOutcome: unknown, result: { terminal?: boolean; selectionComplete?: boolean; outcome?: string } | null | undefined) {
  if (!result?.terminal || !result.selectionComplete) return null;
  if (executionOutcome === "interrupted") return "interrupted";
  if (executionOutcome === "failed" || result.outcome === "failed") return "failed";
  if (result.outcome === "completed") return "completed";
  if (result.outcome === "incomplete" || result.outcome === "unknown") return "incomplete";
  return null;
}
function addressIsPublic(value: string) {
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(value) === 6) {
    const segments = value.split(":").map((part) => parseInt(part || "0", 16));
    const first = segments[0] ?? 0;
    return (first & 0xe000) === 0x2000 && !(first === 0x2001 && ((segments[1] ?? 0) < 0x0200 || segments[1] === 0x0db8)) && first !== 0x2002 && !(first === 0x3fff && (segments[1] ?? 0) < 0x1000);
  }
  return false;
}
export function validateCallbackUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw fail("callback URL must be a verified public HTTPS URL"); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || value.length > 2048) throw fail("callback URL must be a verified public HTTPS URL");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) && !addressIsPublic(host)) throw fail("callback URL must be a verified public HTTPS URL");
  return url;
}
async function post(url: URL, body: string, headers: Record<string, string>, limit = 4096): Promise<{ status: number; body: Buffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("callback timeout")), 10_000);
  let rejectTimeout!: (error: unknown) => void;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const aborted = () => rejectTimeout(controller.signal.reason);
  controller.signal.addEventListener("abort", aborted, { once: true });
  try { return await Promise.race([postResolved(url, body, headers, limit, controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener("abort", aborted); }
}
async function postResolved(url: URL, body: string, headers: Record<string, string>, limit: number, signal: AbortSignal): Promise<{ status: number; body: Buffer }> {
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const resolved = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!resolved.length || resolved.some((entry) => !addressIsPublic(entry.address))) throw new Error("unsafe callback address");
  signal.throwIfAborted();
  const address = resolved[0]!.address;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { signal, method: "POST", servername: host, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers }, lookup: (_host, _options, done) => done(null, address, isIP(address)) }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) req.destroy(new Error("callback response too large")); else chunks.push(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("callback timeout")));
    req.on("error", reject); req.end(body);
  });
}

export class Events {
  private store: Store = { subscriptions: {} };
  private path: string;
  private releaseLock?: () => void;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private deliveryScheduled = false;
  private stateQueue: Promise<unknown> = Promise.resolve();
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.stateQueue.then(run);
    this.stateQueue = result.catch(() => {});
    return result;
  }
  readonly lifecycle = new EventDiagnostics(() => this.time());
  private storageFailed = false;
  private constructor(path: string, private readonly hooks: EventHooks) { this.path = path; }
  private time() { return this.hooks.now?.() ?? now(); }
  static async open(path = join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local/state"), "opencode-connect/events/store.json"), hooks: EventHooks = {}) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const instance = new Events(path, hooks);
    instance.releaseLock = acquireStoreLock(join(dirname(path), "store.lock.sqlite"));
    try {
      try {
        const raw = await readFile(path, "utf8");
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Events store exceeds bound");
        instance.store = JSON.parse(raw) as Store;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const time = instance.time();
      for (const sub of Object.values(instance.store.subscriptions)) {
        if (live(sub)) sub.state = sub.expiresAt !== null && sub.expiresAt <= time ? "expired" : "paused";
        if (sub.expiresAt !== null && sub.expiresAt <= time) instance.retire(sub, "expired");
      }
      await instance.persist();
      instance.lifecycle.record("subscriptionsRecovered", { count: Object.keys(instance.store.subscriptions).length });
      instance.timer = setInterval(() => { void instance.processDeliveries(); }, 1000);
      instance.timer.unref();
      return instance;
    } catch (error) {
      instance.releaseLock();
      throw error;
    }
  }
  async close() { clearInterval(this.timer); await this.stateQueue; this.releaseLock?.(); }
  private async persist() {
    try {
      const bytes = JSON.stringify(this.store);
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Events store exceeds bound");
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx" }); await rename(temp, this.path);
      this.storageFailed = false;
    } catch (error) { this.storageFailed = true; this.lifecycle.record("storageFailed"); throw error; }
  }
  private retire(sub: Stored, state: string) { sub.state = state; sub.retiredAt ??= this.time(); sub.secret = ""; delete sub.oldSecret; if (sub.delivery?.state === "pending") sub.delivery.state = state; }
  async authenticate(context: string): Promise<Authorization> {
    if (this.hooks.authenticate) return this.hooks.authenticate(context);
    const response = await fetch(ENDPOINT, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3000), headers: { "content-type": "application/json" }, body: JSON.stringify({ requestContext: context }) });
    if (response.status !== 200) throw fail("Events authorization denied or unavailable", EventErrorCode.AuthorizationDenied);
    const data = await response.json() as { allowed?: boolean; authorization?: unknown };
    const auth = authorizationSchema.safeParse(data?.authorization);
    if (data?.allowed !== true || !auth.success) throw fail("Events authorization denied or unavailable", EventErrorCode.AuthorizationDenied);
    return auth.data;
  }
  async valid(auth: Authorization) {
    if (this.hooks.valid) return this.hooks.valid(auth);
    const response = await fetch(ENDPOINT, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3000), headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization: auth }) });
    if (response.status === 403) return false;
    if (response.status !== 200) throw new Error("authorization unavailable");
    const data = await response.json() as { allowed?: boolean; authorization?: Authorization };
    return data?.allowed === true && authorizationSchema.safeParse(data.authorization).success &&
      Object.keys(auth).every((key) => data.authorization?.[key as keyof Authorization] === auth[key as keyof Authorization]);
  }
  catalog() { return { events: [{ name: EVENT_NAME, description: "A canonical OpenCode user prompt reached a terminal lifecycle state; inspect that exact prompt for its result.", delivery: ["webhook"], inputSchema: z.toJSONSchema(eventArgumentsSchema, { target: "draft-2020-12" }), payloadSchema: z.toJSONSchema(eventArgumentsSchema.extend({ status: z.enum(["completed", "failed", "interrupted", "incomplete"]) }), { target: "draft-2020-12" }) }] }; }
  targets() { return Object.values(this.store.subscriptions).filter(live).map(({ sessionId, messageId }) => ({ sessionId, messageId })); }
  subscribe(input: Subscribe, auth: Authorization, validate: (sessionId: string, messageId: string) => Promise<void>) {
    return this.serialize(() => this.admit(input, auth, validate));
  }
  private async admit(input: Subscribe, auth: Authorization, validate: (sessionId: string, messageId: string) => Promise<void>) {
    if (input.name !== EVENT_NAME || input.delivery?.mode !== "webhook" || input.cursor !== undefined && input.cursor !== null) throw fail("unsupported event subscription");
    validateArguments(input.arguments);
    const { sessionId, messageId } = input.arguments;
    const url = validateCallbackUrl(input.delivery.url); const secret = input.delivery.secret ?? ""; signingKey(secret);
    await validate(sessionId, messageId);
    if (!await this.valid(auth)) throw fail("Events authorization denied or unavailable", EventErrorCode.AuthorizationDenied);
    const identity = `sub_${hash([auth.principal, url.href, EVENT_NAME, sessionId, messageId])}`;
    const time = this.time();
    const ttl = input.ttlMs === undefined ? 3_600_000 : input.ttlMs === null ? null : Math.min(MAX_TTL, Math.max(MIN_TTL, input.ttlMs));
    for (const [key, sub] of Object.entries(this.store.subscriptions)) if (!live(sub) && (sub.expiresAt ?? sub.retiredAt ?? 0) + RETENTION <= time) delete this.store.subscriptions[key];
    if (!this.store.subscriptions[identity] && Object.keys(this.store.subscriptions).length >= MAX_SUBSCRIPTIONS) throw fail("Events subscription capacity exceeded", EventErrorCode.SubscriptionCapacityExceeded);
    const verifiedUntil = Math.max(0, ...Object.values(this.store.subscriptions).filter((sub) => live(sub) && sub.authorization.principal === auth.principal && sub.url === url.href && (sub.verifiedUntil ?? 0) > time).map((sub) => sub.verifiedUntil ?? 0));
    const verified = verifiedUntil > time;
    const trace = { subscriptionId: identity, sessionId, messageId };
    if (!verified) {
      this.lifecycle.record("verificationStarted", trace);
      const challenge = randomBytes(32).toString("hex");
      const verificationId = `msg_verification_${challenge}`;
      const verificationBody = JSON.stringify({ type: "verification", challenge });
      const verificationTime = Math.floor(time / 1000).toString();
      let verification: { status: number; body: Buffer };
      try { verification = await this.post(url, verificationBody, { "webhook-id": verificationId, "webhook-timestamp": verificationTime, "webhook-signature": standardWebhookSignature(secret, verificationId, verificationTime, verificationBody), "x-mcp-subscription-id": identity }); }
      catch (error) {
        const reason = error instanceof Error && error.message.includes("timeout") ? "timeout" : error instanceof Error && error.message.includes("unsafe") ? "unsafe_url" : "connection_failed";
        this.lifecycle.record("verificationFailed", { ...trace, reason });
        throw callbackFailure(reason);
      }
      let echoed: unknown;
      try { echoed = (JSON.parse(verification.body.toString("utf8")) as { challenge?: unknown }).challenge; } catch { /* fail closed below */ }
      const expected = Buffer.from(challenge); const received = Buffer.from(typeof echoed === "string" ? echoed : "");
      if (verification.status < 200 || verification.status >= 300 || received.length !== expected.length || !timingSafeEqual(expected, received)) {
        this.lifecycle.record("verificationFailed", { ...trace, reason: "challenge_failed", httpStatus: verification.status });
        throw callbackFailure("challenge_failed");
      }
      this.lifecycle.record("verificationSucceeded", { ...trace, httpStatus: verification.status });
    } else this.lifecycle.record("verificationCached", trace);
    if (!await this.valid(auth)) throw fail("Events authorization denied or unavailable", EventErrorCode.AuthorizationDenied);
    const previous = this.store.subscriptions[identity];
    const rotating = previous && previous.secret !== secret && previous.secret !== "";
    if (rotating && previous.oldSecret && (previous.rotationUntil ?? 0) > this.time()) {
      throw fail("signing secret rotation is still in progress");
    }
    const sub: Stored = { id: identity, authorization: auth, sessionId, messageId, url: url.href, secret, ...(rotating ? { oldSecret: previous.secret, rotationUntil: this.time() + 300_000 } : previous?.oldSecret && (previous.rotationUntil ?? 0) > time ? { oldSecret: previous.oldSecret, rotationUntil: previous.rotationUntil } : {}), verifiedUntil: verified ? verifiedUntil : this.time() + VERIFY_CACHE, expiresAt: ttl === null ? null : this.time() + ttl, retiredAt: null, state: "active", ...(previous?.delivery ? { delivery: previous.delivery } : {}) };
    this.store.subscriptions[identity] = sub;
    try { await this.persist(); }
    catch (error) {
      if (previous) this.store.subscriptions[identity] = previous;
      else delete this.store.subscriptions[identity];
      throw error;
    }
    this.lifecycle.record("subscriptionActivated", trace);
    return { id: identity, refreshBefore: sub.expiresAt === null ? null : new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(input: Omit<Subscribe, "ttlMs" | "cursor">, auth: Authorization) {
    return this.serialize(() => this.cancel(input, auth));
  }
  private async cancel(input: Omit<Subscribe, "ttlMs" | "cursor">, auth: Authorization) {
    if (input.name !== EVENT_NAME || input.delivery?.mode !== "webhook" || input.delivery.secret !== undefined) throw fail("invalid event cancellation");
    validateArguments(input.arguments);
    const { sessionId, messageId } = input.arguments;
    const url = validateCallbackUrl(input.delivery.url);
    const id = `sub_${hash([auth.principal, url.href, EVENT_NAME, sessionId, messageId])}`;
    const sub = this.store.subscriptions[id]; const changed = sub && sub.state !== "cancelled";
    if (sub) this.retire(sub, "cancelled"); await this.persist();
    if (changed) this.lifecycle.record("subscriptionCancelled", { subscriptionId: id, sessionId, messageId });
    return {};
  }
  observe(sessionId: string, messageId: string, status: string, timestamp = new Date().toISOString()) {
    return this.serialize(() => this.queueEvent(sessionId, messageId, status, timestamp));
  }
  private async queueEvent(sessionId: string, messageId: string, status: string, timestamp: string) {
    if (!["completed", "failed", "interrupted", "incomplete"].includes(status)) return;
    const id = `evt_${hash([EVENT_NAME, sessionId, messageId])}`;
    const queued: Stored[] = [];
    for (const sub of Object.values(this.store.subscriptions)) if (live(sub) && sub.sessionId === sessionId && sub.messageId === messageId && !sub.delivery) {
      const body = JSON.stringify({ eventId: id, name: EVENT_NAME, timestamp, data: { sessionId, messageId, status }, cursor: null });
      sub.delivery = { id, body, attempts: 0, nextAt: this.time(), state: "pending" };
      queued.push(sub);
    }
    await this.persist();
    for (const sub of queued) this.recordSubscription("eventQueued", sub);
  }
  private post(url: URL, body: string, headers: Record<string, string>) { return this.hooks.post ? this.hooks.post(url, body, headers) : post(url, body, headers); }
  processDeliveries() {
    if (this.deliveryScheduled) return Promise.resolve();
    this.deliveryScheduled = true;
    return this.serialize(() => this.deliver()).finally(() => { this.deliveryScheduled = false; });
  }
  diagnostics() { return Object.values(this.store.subscriptions).map((sub) => ({
    subscriptionId: sub.id, sessionId: sub.sessionId, messageId: sub.messageId,
    state: sub.state, expiresAtMs: sub.expiresAt, verifiedUntilMs: sub.verifiedUntil ?? null,
    eventId: sub.delivery?.id ?? null, attempts: sub.delivery?.attempts ?? 0,
    deliveryState: sub.delivery?.state ?? null,
  })); }
  snapshot() {
    const all = this.diagnostics();
    const states: Record<string, number> = {};
    for (const sub of all) states[sub.state] = (states[sub.state] ?? 0) + 1;
    // Bound diagnostic detail independently of the tool response ceiling.
    const subscriptions = all.slice(-32);
    while (Buffer.byteLength(JSON.stringify(subscriptions)) > 24 * 1024) subscriptions.shift();
    return { storageFailed: this.storageFailed, capacity: MAX_SUBSCRIPTIONS, states,
      subscriptionCount: all.length, subscriptionsTruncated: subscriptions.length < all.length,
      subscriptions, lifecycle: this.lifecycle.snapshot() };
  }
  private recordSubscription(stage: Parameters<EventDiagnostics["record"]>[0], sub: Stored,
    fields: Parameters<EventDiagnostics["record"]>[1] = {}) {
    this.lifecycle.record(stage, { subscriptionId: sub.id, sessionId: sub.sessionId, messageId: sub.messageId,
      ...(sub.delivery ? { eventId: sub.delivery.id, attempt: sub.delivery.attempts } : {}), ...fields });
  }
  private async deliver() {
    if (this.busy) return; this.busy = true;
    try {
      const time = this.time();
      let housekeeping = false;
      const expired: Stored[] = [];
      for (const [id, sub] of Object.entries(this.store.subscriptions)) {
        if (live(sub) && sub.expiresAt !== null && sub.expiresAt <= time) { this.retire(sub, "expired"); expired.push(sub); housekeeping = true; }
        if (sub.oldSecret && (sub.rotationUntil ?? 0) <= time) { delete sub.oldSecret; housekeeping = true; }
        if (!live(sub) && (sub.expiresAt ?? sub.retiredAt ?? 0) + RETENTION <= time) { delete this.store.subscriptions[id]; housekeeping = true; }
      }
      if (housekeeping) await this.persist();
      for (const sub of expired) this.recordSubscription("subscriptionExpired", sub);
      let dispatched = 0;
      for (const sub of Object.values(this.store.subscriptions)) {
        if (dispatched >= MAX_DELIVERIES_PER_TICK) break;
        if (!live(sub) || !sub.delivery || sub.delivery.state !== "pending" || sub.delivery.nextAt > this.time()) continue;
        let authorized = false;
        try { authorized = await this.valid(sub.authorization); } catch {
          if (sub.state !== "paused") { sub.state = "paused"; await this.persist(); this.recordSubscription("subscriptionPaused", sub, { reason: "authorization" }); }
          continue;
        }
        if (!authorized) { this.retire(sub, "revoked"); await this.persist(); this.recordSubscription("subscriptionRevoked", sub, { reason: "authorization" }); continue; }
        const dispatchTime = this.time();
        if (sub.expiresAt !== null && sub.expiresAt <= dispatchTime) { this.retire(sub, "expired"); await this.persist(); this.recordSubscription("subscriptionExpired", sub); continue; }
        if (sub.oldSecret && (sub.rotationUntil ?? 0) <= dispatchTime) delete sub.oldSecret;
        if (sub.state !== "active") { sub.state = "active"; await this.persist(); this.recordSubscription("subscriptionResumed", sub); }
        const delivery = sub.delivery;
        if (delivery.attempts >= MAX_ATTEMPTS) { delivery.state = "exhausted"; await this.persist(); this.recordSubscription("deliveryOutcome", sub, { outcome: "exhausted" }); continue; }
        delivery.attempts++; delivery.nextAt = dispatchTime + Math.pow(2, delivery.attempts) * 1000; await this.persist();
        this.recordSubscription("deliveryAttempt", sub);
        dispatched += 1;
        const timestamp = Math.floor(this.time() / 1000).toString();
        let httpStatus: number | undefined;
        try {
          let signatures = standardWebhookSignature(sub.secret, delivery.id, timestamp, delivery.body);
          if (sub.oldSecret && (sub.rotationUntil ?? 0) > this.time()) signatures += ` ${standardWebhookSignature(sub.oldSecret, delivery.id, timestamp, delivery.body)}`;
          const result = await this.post(validateCallbackUrl(sub.url), delivery.body, { "webhook-id": delivery.id, "webhook-timestamp": timestamp, "webhook-signature": signatures, "x-mcp-subscription-id": sub.id });
          httpStatus = result.status;
          if (result.status >= 200 && result.status < 300) delivery.state = "delivered";
          else if ((result.status >= 300 && result.status < 400) || result.status === 410 || result.status === 413 || (result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429) || delivery.attempts >= MAX_ATTEMPTS) delivery.state = "exhausted";
        } catch { if (delivery.attempts >= MAX_ATTEMPTS) delivery.state = "exhausted"; }
        await this.persist();
        this.recordSubscription("deliveryOutcome", sub, { ...(httpStatus === undefined ? {} : { httpStatus }), outcome: delivery.state === "delivered" ? "delivered" : delivery.state === "exhausted" ? "exhausted" : httpStatus === undefined ? "transportFailed" : "retry" });
        if (delivery.state === "delivered") this.recordSubscription("callbackAcknowledged", sub, { httpStatus });
      }
    } catch { this.lifecycle.record("deliveryFailed"); console.error("Events delivery/storage failure"); }
    finally { this.busy = false; }
  }
}
