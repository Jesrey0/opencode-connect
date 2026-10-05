import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createHttpHandler } from "./http.js";
import type { Request, Response } from "express";
import { OpenCodeBackend } from "./opencode.js";
import { loadBuildInfo } from "./buildInfo.js";
import { bootstrapNative } from "./native.js";
import { safeError } from "./bounds.js";
import { Events } from "./events.js";
import { connectNative } from "./native.js";
import { ComputerBackend } from "./computer.js";
import { EventReconciler } from "./eventsReconciliation.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "8788");
const backend = new OpenCodeBackend();
const events = await Events.open();
await bootstrapNative();
await backend.health();
const BUILD = await loadBuildInfo();

const app = createMcpExpressApp({ host: HOST });

app.get("/", (_req: Request, res: Response) => res.type("text/plain").send("OpenCode Connect\n"));
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const upstream = await backend.health();
    res.json({ ok: true, name: "opencode-connect", version: BUILD.version, buildId: BUILD.buildId, build: BUILD, upstream });
  } catch (error) {
    res.status(503).json({ ok: false, name: "opencode-connect", version: BUILD.version, buildId: BUILD.buildId, build: BUILD, error: safeError(error) });
  }
});

// Local observation only: shared ingress routes only the authenticated /mcp path.
app.get("/observe", (_req: Request, res: Response) => res.json({ events: events.snapshot() }));

const computer = new ComputerBackend();
const mcp = createHttpHandler(backend, undefined, events, computer);
app.all("/mcp", (req: Request, res: Response) => {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  return toNodeHandler(mcp)(req, res, req.body);
});

app.listen(PORT, HOST, () => console.log(`OpenCode Connect listening on http://${HOST}:${PORT}/mcp`));

const reconciler = new EventReconciler(backend, events);
const reconcileEvents = (sessionId?: string) => reconciler.reconcile(sessionId);
const terminalHints = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]);
const eventSessionId = (event: { data?: unknown }) => event.data && typeof event.data === "object" && "sessionID" in event.data && typeof event.data.sessionID === "string" ? event.data.sessionID : undefined;
void (async () => {
  let delay = 1000;
  while (true) {
    try {
      const { client } = await connectNative();
      const controller = new AbortController();
      const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
      await reconcileEvents();
      delay = 1000;
      try {
        while (true) {
          const item = await iterator.next();
          if (item.done) break;
          if (terminalHints.has(item.value.type)) {
            const sessionId = eventSessionId(item.value);
            if (sessionId) await reconcileEvents(sessionId);
          }
        }
      } finally { controller.abort(); await iterator.return?.(); }
    } catch (error) { console.error("Events native observation unavailable", safeError(error)); }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
})();
const reconcileTimer = setInterval(() => { void reconcileEvents(); }, 30_000);
reconcileTimer.unref();
