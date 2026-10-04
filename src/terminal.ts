import type { Connection } from "./native.js";
import { ConnectorError as Error } from "./bounds.js";

export type SocketFactory = (url: URL) => WebSocket;
type Read = { kind: "pty" | "persistentPty"; cwd: string; id: string; cursor: number; limit: number; waitMs: number; input?: string; takeover?: boolean };
type Replay = { requestedOffset: number; availableOffset: number; endOffset: number; truncated: boolean };
export async function terminalSocket(connection: Connection, input: Read, factory: SocketFactory) {
  const { client } = connection;
  const persistent = input.kind === "persistentPty";
  const token = persistent
    ? await client.experimental.persistentPty.connectToken({ ptyID: input.id, "x-opencode-ticket": "1" })
    : (await client.pty.connect.token({ ptyID: input.id, location: { directory: input.cwd }, "x-opencode-ticket": "1" })).data;
  const base = new URL(connection.baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const url = new URL(`api/${persistent ? "experimental/persistent-pty" : "pty"}/${encodeURIComponent(input.id)}/connect`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", token.ticket);
  url.searchParams.set("cursor", String(input.cursor));
  if (persistent) {
    url.searchParams.set("role", input.input === undefined ? "observer" : "controller");
    url.searchParams.set("attachment_id", crypto.randomUUID());
    url.searchParams.set("takeover", String(input.takeover ?? false));
  } else url.searchParams.set("location[directory]", input.cwd);
  // Tickets stay private to this short-lived native transport, never in results/errors/logs.
  let socket: WebSocket;
  try { socket = factory(url); } catch { throw new Error("native terminal socket creation failed"); }
  socket.binaryType = "arraybuffer";
  return new Promise<{ output: string | null; encoding: "utf8" | "base64"; data?: string; cursor: number; cursorUnit: "bytes" | "utf16CodeUnits"; replayAvailable: true; replay: Replay; replayComplete: boolean; truncated: boolean; inputSent: boolean; detached: true }>((resolve, reject) => {
    let done = false;
    let ready = false;
    let replayComplete = false;
    let inputSent = false;
    let cursor = input.cursor;
    let replay: Replay = { requestedOffset: input.cursor, availableOffset: input.cursor, endOffset: input.cursor, truncated: false };
    let output = "";
    let bytes = Buffer.alloc(0);
    let replayUnits = 0;
    let truncated = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const hard = setTimeout(() => finish(new Error("native terminal attachment/replay timed out; input delivery may be uncertain")), 5000);
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(hard);
      clearTimeout(idle);
      socket.close();
      if (error) { reject(error); return; }
      let encoded: { output: string | null; encoding: "utf8" | "base64"; data?: string } = { output, encoding: "utf8" };
      if (persistent) {
        try { encoded = { output: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), encoding: "utf8" }; }
        catch { encoded = { output: null, encoding: "base64", data: bytes.toString("base64") }; }
      }
      resolve({ ...encoded, cursor, cursorUnit: persistent ? "bytes" : "utf16CodeUnits", replayAvailable: true, replay, replayComplete, truncated, inputSent, detached: true });
    }
    function markReady() {
      ready = true;
      if (input.input !== undefined) {
        try { socket.send(input.input); inputSent = true; }
        catch { finish(new Error("native terminal input send failed; delivery is uncertain")); return; }
        // Sending and socket detach are transport facts, never durable execution acknowledgement.
        idle = setTimeout(() => finish(), 250);
      } else if (truncated || (persistent ? bytes.length : output.length) >= input.limit) finish();
      else idle = setTimeout(() => finish(), input.waitMs);
    }
    socket.addEventListener("error", () => finish(new Error("native terminal socket failed; input delivery may be uncertain")));
    socket.addEventListener("close", () => {
      if (!ready) finish(new Error("native terminal detached before replay completed; input delivery may be uncertain"));
      else finish();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (done) return;
      try {
        if (persistent && typeof event.data === "string") {
          const meta = JSON.parse(event.data);
          if (meta.type === "attached") {
            if (input.input !== undefined && meta.role !== "controller") { finish(new Error("native terminal controller unavailable; explicitly request takeover to send input")); return; }
            const r = meta.replay;
            if (!r || ![r.requestedOffset, r.availableOffset, r.endOffset].every(Number.isSafeInteger)) throw new Error("invalid replay offsets");
            replay = { requestedOffset: r.requestedOffset, availableOffset: r.availableOffset, endOffset: r.endOffset, truncated: r.truncated === true };
            cursor = Math.max(Math.min(input.cursor, replay.endOffset), replay.availableOffset);
          } else if (meta.type === "replay_complete") {
            replayComplete = true;
            markReady();
          } else if (meta.type === "error") throw new Error("native control failed");
          return;
        }
        if (!persistent && event.data instanceof ArrayBuffer) {
          const frame = new Uint8Array(event.data);
          if (frame[0] !== 0) throw new Error("unexpected PTY control frame");
          const meta = JSON.parse(new TextDecoder().decode(frame.subarray(1)));
          if (!Number.isSafeInteger(meta.cursor) || meta.cursor < 0) throw new Error("invalid PTY cursor");
          // The marker follows all replay chunks. Native replay may have dropped its old head.
          const start = meta.cursor - replayUnits;
          replay = { requestedOffset: input.cursor, availableOffset: start, endOffset: meta.cursor, truncated: input.cursor < start };
          cursor = start + output.length;
          replayComplete = true;
          markReady();
          return;
        }
        if (persistent) {
          if (!(event.data instanceof ArrayBuffer)) throw new Error("unexpected terminal output frame");
          const chunk = Buffer.from(event.data);
          const take = Math.min(chunk.length, Math.max(0, input.limit - bytes.length));
          bytes = Buffer.concat([bytes, chunk.subarray(0, take)]);
          cursor += take;
          if (take < chunk.length) truncated = true;
        } else {
          if (typeof event.data !== "string") throw new Error("unexpected PTY output frame");
          const chunk = event.data;
          if (!ready) replayUnits += chunk.length;
          // Once a replay frame was clipped, retain its contiguous prefix only.
          // Later frames still contribute to the native replay marker, never the page.
          if (truncated && input.input === undefined) return;
          let take = Math.min(chunk.length, Math.max(0, input.limit - output.length));
          if (take > 0 && take < chunk.length && /[\uD800-\uDBFF]/u.test(chunk.charAt(take - 1))) take -= 1;
          if (input.input === undefined && take === 0 && chunk.length > 0 && output.length === 0) { finish(new Error("ordinary PTY page limit cannot contain the next Unicode character")); return; }
          output += chunk.slice(0, take);
          if (ready) cursor += take;
          if (take < chunk.length) truncated = true;
        }
        // Until the replay marker, keep counting/discarding frames without retaining unbounded data.
        if (ready && input.input === undefined && (truncated || (persistent ? bytes.length : output.length) >= input.limit)) finish();
      } catch { finish(new Error("invalid native terminal frame; input delivery may be uncertain")); }
    });
  });
}
