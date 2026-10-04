import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode/client";
import type { Connection } from "../src/native.js";

export type NativeRequest = { path: string; method: string; query: URLSearchParams; body: Record<string, unknown>; bytes?: Uint8Array };
export function nativeFixture(handler: (request: NativeRequest) => unknown | Promise<unknown>) {
  const requests: NativeRequest[] = [];
  const client = OpenCode.make({ baseUrl: "http://native.invalid", fetch: async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const binary = options?.body instanceof Uint8Array;
    const request = { path: url.pathname, method: options?.method ?? "GET", query: url.searchParams, body: options?.body && !binary ? JSON.parse(String(options.body)) : {}, ...(binary ? { bytes: options.body as Uint8Array } : {}) };
    requests.push(request);
    const value = await handler(request);
    if (value instanceof Response) return value;
    if (value === undefined) return new Response(null, { status: 204 });
    return Response.json(value);
  } });
  const connection: Connection = { client, baseUrl: "http://native.invalid", info: { version: "2.0.22", pid: 1, urls: [], paths: { tmp: "/tmp" } } };
  return { client, requests, connection, connect: async () => connection };
}
export function session(cwd = "/tmp"): SessionInfo {
  return { id: "s", projectID: "p", agent: "build", model: { providerID: "openai", id: "a" }, location: { directory: cwd }, time: { created: 1, updated: 2, idle: 2 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, outcome: "succeeded" };
}
export function user(id: string, time = 1): SessionMessageInfo {
  return { id, type: "user", sessionID: "s", text: "task", time: { created: time } } as SessionMessageInfo;
}
export function assistant(id: string, text: string, time = 2): SessionMessageInfo {
  return { id, type: "assistant", sessionID: "s", agent: "build", model: { providerID: "openai", id: "a" }, content: [{ type: "text", text }], time: { created: time, completed: time }, finish: "stop" } as SessionMessageInfo;
}
export class FakeSocket extends EventTarget {
  binaryType = "arraybuffer";
  sent: unknown[] = [];
  closed = false;
  send(data: unknown) { this.sent.push(data); }
  close() { this.closed = true; }
  frame(data: string | ArrayBuffer) { this.dispatchEvent(new MessageEvent("message", { data })); }
  end() { this.dispatchEvent(new Event("close")); }
  fail() { this.dispatchEvent(new Event("error")); }
  asWebSocket() { return this as unknown as WebSocket; }
}
export function binary(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer; }
export function meta(cursor: number) { return binary(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify({ cursor }))])); }
