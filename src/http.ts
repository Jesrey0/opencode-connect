import { EventErrorCode } from "./eventsErrors.js";
import { createMcpHandler, ProtocolError, type McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import { createServer } from "./mcp.js";
import { OpenCodeBackend } from "./opencode.js";
import { HostBackend } from "./host.js";
import { ComputerBackend } from "./computer.js";
import { PrintBackend } from "./print.js";
import { Events } from "./events.js";

// The SDK owns per-request metadata, version selection and wire validation.
export function createHttpHandler(backend = new OpenCodeBackend(), host = new HostBackend(), events?: Events, computer = new ComputerBackend(), print = new PrintBackend()) {
  const handler = createMcpHandler(() => createServer(backend, host, events, computer, print), {
    legacy: "reject",
    onerror: (error) => console.error("MCP request failed; details omitted", error instanceof ProtocolError ? { code: error.code } : {}),
  });
  return { ...handler, close: async () => { try { await handler.close(); } finally { computer.close(); print.close(); } }, fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
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
