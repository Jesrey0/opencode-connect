import { EventErrorCode } from "./eventsErrors.js";
import { createMcpHandler, ProtocolError, ProtocolErrorCode, type McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { ErrorRequestHandler } from "express";
import { createServer } from "./mcp.js";
import { OpenCodeBackend } from "./opencode.js";
import { HostBackend } from "./host.js";
import { Events } from "./events.js";
import { BrowserBackend } from "./browser/backend.js";

// Whole-request budget, separate from output/image and input-element bounds.
// Multi-step Unicode browser input and full permission sets can exceed 1 MiB.
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export function createHttpApp(handler: ReturnType<typeof createHttpHandler>, host = "127.0.0.1") {
  const app = createMcpExpressApp({ host, jsonLimit: `${MAX_REQUEST_BODY_BYTES}b` });
  // Express owns parsing when parsedBody is supplied to the SDK. Its default
  // error page includes stack/body diagnostics; publish only a safe wire error.
  const parserError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.status < 400 || error?.status >= 500 || typeof error?.status !== "number") return next(error);
    res.status(error.status).json({ jsonrpc: "2.0", id: null, error: {
      code: ProtocolErrorCode.InvalidRequest,
      message: error.status === 413 ? "MCP request exceeds 4 MiB" : "Invalid MCP HTTP request body",
    } });
  };
  app.use(parserError);
  app.all("/mcp", (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    return toNodeHandler(handler)(req, res, req.body);
  });
  return app;
}

// The SDK owns per-request metadata, version selection and wire validation.
export function createHttpHandler(backend = new OpenCodeBackend(), host = new HostBackend(), events?: Events, browser = new BrowserBackend()) {
  const handler = createMcpHandler(() => createServer(backend, host, events, browser), {
    legacy: "reject",
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: (error) => console.error("MCP request failed; details omitted", error instanceof ProtocolError ? { code: error.code } : {}),
  });
  return { ...handler, close: async () => { browser.close(); await handler.close(); }, fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    // The Node adapter passes Express's bounded, parsed body. Leave wire validation
    // to the SDK; this projection observes receipts before transport rejection.
    const body = options?.parsedBody as { method?: unknown; id?: unknown } | undefined;
    const method = body?.method ?? request.headers.get("mcp-method");
    if (events && method === "server/discover") {
      try {
        const context = request.headers.get("x-host-ingress-auth-context");
        if (!context) throw new ProtocolError(EventErrorCode.AuthorizationDenied, "Events authorization denied or unavailable");
        await events.authenticate(context);
      } catch {
        return Response.json({ jsonrpc: "2.0", id: typeof body?.id === "number" || typeof body?.id === "string" ? body?.id : null,
          error: { code: EventErrorCode.AuthorizationDenied, message: "Events authorization denied or unavailable" } }, { status: 401 });
      }
    }
    if (!events || method !== "events/subscribe") return handler.fetch(request, options);
    let response: Response | undefined;
    try {
      await events.lifecycle.subscription(async () => {
        response = await handler.fetch(request, options);
        const reply = await response.clone().json() as { result?: { id: string }; error?: { code: number; message: string } };
        if (reply.error) throw new ProtocolError(reply.error.code, "Events subscription rejected");
        if (!reply.result?.id) throw new Error("Events subscription returned no identity");
        return reply.result;
      });
      return response!;
    } catch {
      return response ?? Response.json({ jsonrpc: "2.0", id: typeof body?.id === "number" || typeof body?.id === "string" ? body?.id : null,
        error: { code: -32603, message: "Events subscription failed" } }, { status: 500 });
    }
  } };
}
