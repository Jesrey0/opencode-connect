import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { BrowserBackend, BrowserError } from "./backend.js";
import { browserInputs, browserActionInputs, browserOutputs, browserErrorSchema, type BrowserMethod } from "./schemas.js";
import { errorOutputSchema } from "../results.js";
import * as z from "zod/v4";
import type { Events } from "../events.js";

// Accurate annotation values are part of the published MCP contract.
// Browser actions run on arbitrary external web pages, whose handlers may write
// or delete data. A harmless-looking click must not be labeled read-only.
type ToolSpec = { title: string; description: string; readOnly: boolean; destructive: boolean; openWorld: boolean };
const baseSpecs: Record<Exclude<BrowserMethod, "action">, ToolSpec> = {
  status: { title: "Check Chrome readiness", description: "Check whether the existing Linux or permitted Windows Chrome endpoint is reachable. No tab is selected or controlled.", readOnly: true, destructive: false, openWorld: false },
  connect: { title: "Request Windows Chrome access", description: "Request Chrome's own remote-debugging permission on the existing Windows browser. Requires user authorization and may open a permission prompt; does not select a tab.", readOnly: false, destructive: false, openWorld: true },
  tabs: { title: "List Chrome tabs", description: "List bounded, sanitized titles and URLs of Chrome tabs. Select an exact targetId for attachment; this does not activate or modify tabs.", readOnly: true, destructive: false, openWorld: true },
  launch: { title: "Launch or reuse Linux Chrome", description: "Reuse the persistent Linux Chrome profile or start its headed process if unavailable. Does not attach; preserves Chrome on disconnect.", readOnly: false, destructive: false, openWorld: false },
  attach: { title: "Attach to a Chrome tab", description: "Acquire a lease for exactly one listed tab in observe or control mode. A different caller cannot share this lease; release it when finished.", readOnly: false, destructive: false, openWorld: true },
  snapshot: { title: "Read Chrome page elements", description: "Read a bounded accessibility snapshot of the selected tab, including short-lived element references for precise interaction. Protected values are excluded.", readOnly: true, destructive: false, openWorld: true },
  workflow: { title: "Run bounded browser steps", description: "Execute up to 12 authorized steps within one deadline. Each target is resolved from a fresh accessibility observation by exact role/name and optional frameId; ambiguity stops execution. Every step requires an observable postcondition. Stops on failure and reports completedSteps and zero-based failedStep; never replay completed or uncertain steps. Rotates prior element references.", readOnly: false, destructive: true, openWorld: true },
  wait: { title: "Wait for page condition", description: "Observe an authorized tab until specified text, URL, selector visibility, document readiness, or mediaReady (audio/video has current data without error) is confirmed. A normal timeout returns timed_out and preserves the lease so observation can continue; no actions are replayed.", readOnly: true, destructive: false, openWorld: true },
  media: { title: "Inspect page media", description: "Inspect bounded audio/video elements in the selected tab, including hidden players, readiness, duration and short-lived references. Metadata does not verify spoken content or audio quality.", readOnly: true, destructive: false, openWorld: true },
  media_download: { title: "Retrieve page media", description: "Retrieve an observed audio/video source through the page's normal CORS permissions into a private host artifact, with byte limit and SHA-256. Supports accessible HTTP(S)/blob media; no DRM, MediaSource or access-control bypass. Returns a host path for playback or further inspection.", readOnly: false, destructive: false, openWorld: true },
  screenshot: { title: "Capture Chrome tab screenshot", description: "Capture a bounded JPEG screenshot of the selected tab. The image may contain private page content and is not persisted by the connector.", readOnly: true, destructive: false, openWorld: true },
  detach: { title: "Release Chrome attachment", description: "Release a lease or permission-mode connection without closing Chrome, its profile, or any tab.", readOnly: false, destructive: false, openWorld: false },
};
type ActionSpec = Omit<ToolSpec, "readOnly" | "openWorld"> & { toolName: string };
const actionSpecs: Record<string, ActionSpec> = {
  click: { toolName: "click", title: "Click page element", description: "Left-click an observed element using Chrome mouse input. May submit, publish, delete or otherwise change external data; inspect and obtain authorization for consequential effects.", destructive: true },
  rightClick: { toolName: "right_click", title: "Right-click page element", description: "Open a page element's context menu using a native right mouse event. Page handlers may change external data.", destructive: true },
  doubleClick: { toolName: "double_click", title: "Double-click page element", description: "Send two native left mouse clicks to an observed element. Double-click handlers may change external data.", destructive: true },
  hover: { toolName: "hover", title: "Hover over page element", description: "Move the mouse to an observed visible element without pressing a button. Hover handlers can update UI state but this tool does not submit data.", destructive: false },
  drag: { toolName: "drag", title: "Drag between page elements", description: "Drag from one observed element to another with native mouse input. Can reorder, upload, move or otherwise change page data.", destructive: true },
  typeText: { toolName: "type_text", title: "Type text into page element", description: "Insert user-authorized text through Chrome into an observed editable field. A site's auto-save or input handlers may publish it.", destructive: true },
  keyCombo: { toolName: "key_combo", title: "Press keyboard shortcut", description: "Press a bounded modifier-plus-key shortcut in an observed focused element using Chrome keyboard input. Shortcuts can trigger consequential page operations.", destructive: true },
  wheel: { toolName: "scroll_xy", title: "Scroll page element horizontally or vertically", description: "Scroll an observed scrollable page element programmatically using bounded horizontal and vertical deltas. This is not a trusted physical mouse wheel event and does not submit a form.", destructive: false },
  fill: { toolName: "fill", title: "Fill editable page field", description: "Set an observed editable field's value and emit input/change events. This is programmatic filling; page autosave may persist it. Password and disabled inputs are rejected.", destructive: true },
  select: { toolName: "select", title: "Choose page option", description: "Choose a native select option in an observed field. Emits input/change events and may trigger external side effects.", destructive: true },
  upload: { toolName: "upload", title: "Choose files for upload", description: "Upload through an observed file input or button that opens a file chooser. Intercepts Chrome's chooser and supplies only files from explicitly configured authorized roots. Paths must exist on the browser host; page handlers may transmit them.", destructive: true },
  keypress: { toolName: "keypress", title: "Press page key", description: "Press an allowed keyboard key on an observed element, including Enter which may submit a form. Can change external data.", destructive: true },
  scroll: { toolName: "scroll", title: "Scroll page element", description: "Programmatically scroll an observed element vertically by a bounded delta. This is not a trusted physical mouse-wheel event.", destructive: false },
  navigate: { toolName: "navigate", title: "Navigate Chrome tab", description: "Navigate the selected tab to an explicitly authorized HTTP/HTTPS URL. Can discard unsaved page state; does not choose a different tab.", destructive: true },
};

export function registerBrowserTools(server: McpServer, backend: BrowserBackend, events?: Events) {
  if (!backend.enabled) return;

  const register = (name: string, spec: ToolSpec, inputSchema: z.ZodType, outputSchema: z.ZodType,
    invoke: (input: unknown) => { method: BrowserMethod; args: unknown }) => {
    server.registerTool(name, {
      title: spec.title,
      description: spec.description,
      inputSchema,
      outputSchema: z.union([outputSchema, browserErrorSchema, errorOutputSchema]),
      // Taking a new accessibility snapshot invalidates prior element refs.
      annotations: { readOnlyHint: spec.readOnly, destructiveHint: spec.destructive, openWorldHint: spec.openWorld, idempotentHint: spec.readOnly && !["browser.snapshot", "browser.media", "browser.media_download"].includes(name) },
    } as never, (async (input: unknown, context: ServerContext) => {
      try {
        let owner = "single-controller";
        if (events) {
          const authContext = context.http?.req?.headers.get("x-host-ingress-auth-context");
          if (!authContext) throw new BrowserError("authorization_denied", "Verified ingress authorization is required");
          const auth = await events.authenticate(authContext);
          owner = createHash("sha256").update(JSON.stringify([auth.principal, auth.clientId, auth.grantId])).digest("hex");
        }
        const { method, args } = invoke(input);
        const result = await backend.call(method, args, owner, context.mcpReq.signal);
        const { image, ...metadata } = result;
        return { structuredContent: metadata, content: typeof image === "string" ? [{ type: "image", mimeType: "image/jpeg", data: image }] : [] };
      } catch (error) {
        return { structuredContent: error instanceof BrowserError ? error.result() : new BrowserError("browser_unavailable", "Browser capability unavailable; details withheld").result(), content: [], isError: true };
      }
    }) as never);
  };

  for (const method of Object.keys(baseSpecs) as Exclude<BrowserMethod, "action">[]) {
    register("browser." + method, baseSpecs[method], browserInputs[method], browserOutputs[method],
      input => ({ method, args: input }));
  }
  for (const [kind, spec] of Object.entries(actionSpecs)) {
    if (!browserActionInputs[kind]) throw new Error("Missing browser action schema: " + kind);
    register("browser." + spec.toolName, { ...spec, readOnly: false, openWorld: true }, browserActionInputs[kind], browserOutputs.action,
      input => ({ method: "action", args: { ...(input as Record<string, unknown>), action: kind } }));
  }
}
