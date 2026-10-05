import * as z from "zod/v4";
import { ConnectorError } from "./bounds.js";
import { WindowsComputerBridge, type ComputerStep, type ComputerTransport } from "./computerBridge.js";
import { computerObserveSchema, computerInteractSchema, computerScreenshotSchema, computerOutputSchemas, type ComputerObserve, type ComputerInteract } from "./computerSchema.js";

const get = (path: string): ComputerStep => ({ method: "GET", path });
const post = (path: string, body?: unknown): ComputerStep => ({ method: "POST", path, ...(body === undefined ? {} : { body }) });
const windowPath = (handle: string, operation: string) => `/v1/windows/${encodeURIComponent(handle)}/${operation}`;

/** HostPlane owner. Each composition is a single bounded, serialized Windows transaction. */
export class ComputerBackend {
  constructor(private readonly transport: ComputerTransport = new WindowsComputerBridge()) {}

  async observe(input: ComputerObserve) {
    const args = computerObserveSchema.parse(input);
    let step: ComputerStep;
    switch (args.type) {
      case "capabilities": step = get("/v1/capabilities"); break;
      case "windows": step = get("/v1/windows"); break;
      case "state": step = get(windowPath(args.handle, "state")); break;
      case "find": {
        const { type: _, ...body } = args;
        step = post("/v1/elements/find", body); break;
      }
      case "inspect": step = post("/v1/elements/inspect", { handle: args.handle, locator: args.locator }); break;
    }
    const [data] = await this.transport.request([step]);
    return computerOutputSchemas.observe.parse({ type: args.type, data });
  }

  async interact(input: ComputerInteract) {
    const args = computerInteractSchema.parse(input);
    const steps: ComputerStep[] = [];
    const activated = "activate" in args && args.activate === true;
    if (activated) steps.push(post(windowPath(args.handle!, "activate")));
    const semantic = args.action === "focus" || args.action === "setValue" || args.action === "invoke";
    switch (args.action) {
      case "activate": steps.push(post(windowPath(args.handle, "activate"))); break;
      case "close": steps.push(post(windowPath(args.handle, "close"))); break;
      case "focus": steps.push(post("/v1/elements/focus", { handle: args.handle, locator: args.locator })); break;
      case "setValue": steps.push(post("/v1/actions/set-value-located", { handle: args.handle, locator: args.locator, value: args.value })); break;
      case "invoke": steps.push(post("/v1/actions/invoke-located", { handle: args.handle, locator: args.locator })); break;
      case "keySequence": steps.push(post("/v1/input/key-sequence", { chords: args.chords.map((chord) => ({ ...chord, modifiers: chord.modifiers ?? [] })) })); break;
      case "move": steps.push(post("/v1/input/move", { x: args.x, y: args.y })); break;
      case "click": steps.push(post("/v1/input/pointer-click", { x: args.x, y: args.y, button: args.button, count: args.count })); break;
      case "scroll": steps.push(post("/v1/input/scroll", { delta: args.delta, ...(args.x === undefined ? {} : { x: args.x, y: args.y }) })); break;
    }
    const readback = semantic && (!("readback" in args) || args.readback !== false);
    if (readback) steps.push(post("/v1/elements/inspect", { handle: args.handle, locator: args.locator }));
    const data = await this.transport.request(steps);
    const index = activated ? 1 : 0;
    return computerOutputSchemas.interact.parse({ action: args.action, result: data[index], ...(activated ? { activation: data[0] } : {}), ...(readback ? { state: data[index + 1] } : {}) });
  }

  async screenshot(input: z.infer<typeof computerScreenshotSchema>) {
    const { handle } = computerScreenshotSchema.parse(input);
    const [data] = await this.transport.request([get(handle ? windowPath(handle, "screenshot") : "/v1/desktop/screenshot")]);
    if (data && typeof data === "object" && "png" in data && typeof data.png === "string" && data.png.length > 1_398_104) throw new ConnectorError("Computer screenshot exceeds the 1 MiB PNG limit");
    const { png } = z.object({ png: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict().parse(data);
    const bytes = Buffer.from(png, "base64");
    if (bytes.length > 1_048_576) throw new ConnectorError("Computer screenshot exceeds the 1 MiB PNG limit");
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new ConnectorError("Computer screenshot is not a PNG with an IHDR header");
    const metadata = computerOutputSchemas.screenshot.parse({ target: handle ? "window" : "desktop", ...(handle ? { handle } : {}), mimeType: "image/png", size: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    return { metadata, image: { type: "image" as const, mimeType: "image/png", data: png } };
  }

  close() { this.transport.close(); }
}
