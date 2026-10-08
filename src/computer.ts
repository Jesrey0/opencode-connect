import * as z from "zod/v4";
import { ConnectorError, safeError } from "./bounds.js";
import { WindowsComputerBridge, ComputerBridgeError, type ComputerStep, type ComputerTransport } from "./computerBridge.js";
import { computerObserveSchema, computerInteractSchema, computerScreenshotSchema, computerOutputSchemas, computerSequenceSchema, windowHandleSchema, type ComputerObserve, type ComputerInteract, type ComputerSequence, type ComputerWait } from "./computerSchema.js";

const get = (path: string): ComputerStep => ({ method: "GET", path });
const post = (path: string, body?: unknown): ComputerStep => ({ method: "POST", path, ...(body === undefined ? {} : { body }) });
const windowPath = (handle: string, operation: string) => `/v1/windows/${encodeURIComponent(handle)}/${operation}`;

export interface ComputerTiming { now(): number; sleep(ms: number): Promise<void> }
const defaultTiming: ComputerTiming = { now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
class WaitTimeout extends ConnectorError {
  constructor(readonly polls: number) { super("Computer wait condition was not satisfied before its deadline"); }
}

/** HostPlane owner. Each composition is a single bounded, serialized Windows transaction. */
export class ComputerBackend {
  constructor(private readonly transport: ComputerTransport = new WindowsComputerBridge(), private readonly timing: ComputerTiming = defaultTiming) {}
  private tail?: Promise<void>;
  private pending = 0;

  // Serialize whole sequences, including waits, with all other backend tool calls.
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 64) return Promise.reject(new ConnectorError("Computer backend has 64 pending requests; try later"));
    this.pending++;
    const result = this.tail ? this.tail.then(operation) : (async () => operation())();
    const tail = result.then(() => { this.pending--; }, () => { this.pending--; });
    this.tail = tail;
    void tail.then(() => { if (this.tail === tail) this.tail = undefined; });
    return result;
  }

  observe(input: ComputerObserve) { return this.serialized(() => this.executeObserve(input)); }
  interact(input: ComputerInteract) { return this.serialized(() => this.executeInteract(computerInteractSchema.parse(input))); }
  screenshot(input: z.infer<typeof computerScreenshotSchema>) { return this.serialized(() => this.executeScreenshot(input)); }

  sequence(input: ComputerSequence) {
    // Validate every step before any mutation, including contracts on later steps.
    const args = computerSequenceSchema.parse(input);
    const start = this.timing.now();
    return this.serialized(async () => {
      const results: z.infer<typeof computerOutputSchemas.sequence>["results"] = [];
      let completedSteps = 0;
      let stoppedAt: number | null = null;
      for (const [index, step] of args.steps.entries()) {
        const stepStart = this.timing.now();
        try {
          const result = step.action === "waitFor" ? await this.executeWait(step) : await this.executeInteract(step);
          if ("result" in result && "success" in result.result && !result.result.success) throw new ConnectorError("Computer action reported success=false; reconcile observed state before retrying a mutation");
          results.push({ index, success: true, elapsedMs: this.elapsed(stepStart), result });
          completedSteps++;
        } catch (error) {
          results.push({ index, success: false, action: step.action, elapsedMs: this.elapsed(stepStart), error: {
            code: error instanceof WaitTimeout ? "wait_timeout" : error instanceof ComputerBridgeError ? error.code : "operation_failed",
            message: safeError(error),
            ...(error instanceof WaitTimeout ? { polls: error.polls } : {}),
            ...(error instanceof ComputerBridgeError ? { completedSteps: error.completedSteps, status: error.status } : {}),
          } });
          stoppedAt = index;
          break;
        }
      }
      return computerOutputSchemas.sequence.parse({ success: stoppedAt === null, results, totalElapsedMs: this.elapsed(start), completedSteps, stoppedAt });
    });
  }

  private elapsed(start: number) { return Math.max(0, this.timing.now() - start); }

  private async waitObservation(input: ComputerObserve, remainingMs: number, polls: number, immediateCheck = false) {
    // timeoutMs=0 means one immediate observation, not zero time for the
    // observation transport itself. The bridge request remains independently
    // bounded by its own request timeout.
    if (immediateCheck) return this.executeObserve(input);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.executeObserve(input),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WaitTimeout(polls)), remainingMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async executeWait(args: ComputerWait) {
    const timeoutMs = args.timeoutMs ?? 3000;
    const deadline = this.timing.now() + timeoutMs;
    let polls = 0;
    while (true) {
      if (polls > 0 && this.timing.now() > deadline) throw new WaitTimeout(polls);
      polls++;
      const condition = args.condition;
      let satisfied = false;
      if (condition.type === "windowPresent") {
        const observation = await this.waitObservation({ type: "windows" }, deadline - this.timing.now(), polls,
          timeoutMs === 0 && polls === 1);
        if (observation.type !== "windows") throw new ConnectorError("Unexpected window observation");
        const present = observation.data.some((window) => condition.title !== undefined ? window.title === condition.title
          : BigInt(`0x${windowHandleSchema.parse(window.handle).replace(/^0x/i, "")}`) === BigInt(`0x${condition.handle!.replace(/^0x/i, "")}`));
        satisfied = present === condition.expected;
      } else {
        try {
          const observation = await this.waitObservation({ type: "inspect", handle: condition.handle, locator: condition.locator },
            deadline - this.timing.now(), polls, timeoutMs === 0 && polls === 1);
          if (observation.type !== "inspect") throw new ConnectorError("Unexpected element observation");
          const { type, expected } = condition.predicate;
          const actual = type === "exists" ? true : type === "valueEquals" ? observation.data.value : type === "nameEquals" ? observation.data.name : observation.data[type];
          satisfied = actual === expected;
        } catch (error) {
          // WCU 0.4 uses locator_not_found; element_not_found is also accepted.
          if (!(error instanceof ComputerBridgeError) || !["element_not_found", "locator_not_found"].includes(error.code) || condition.predicate.type !== "exists") throw error;
          satisfied = condition.predicate.expected === false;
        }
      }
      const remaining = deadline - this.timing.now();
      if (satisfied && (remaining >= 0 || (timeoutMs === 0 && polls === 1)))
        return { action: "waitFor" as const, satisfied: true as const, polls };
      if (remaining < 0) throw new WaitTimeout(polls);
      if (remaining <= 0) throw new WaitTimeout(polls);
      await this.timing.sleep(Math.min(args.pollIntervalMs ?? 100, remaining));
    }
  }

  private async executeObserve(input: ComputerObserve) {
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

  private async executeInteract(args: ComputerInteract) {
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
      case "drag": {
        const { action: _, ...body } = args;
        steps.push(post("/v1/input/drag", body)); break;
      }
      case "scroll": steps.push(post("/v1/input/scroll", { delta: args.delta, ...(args.x === undefined ? {} : { x: args.x, y: args.y }) })); break;
    }
    const readback = semantic && (!("readback" in args) || args.readback !== false);
    if (readback) steps.push(post("/v1/elements/inspect", { handle: args.handle, locator: args.locator }));
    const data = await this.transport.request(steps);
    const index = activated ? 1 : 0;
    return computerOutputSchemas.interact.parse({ action: args.action, result: data[index], ...(activated ? { activation: data[0] } : {}), ...(readback ? { state: data[index + 1] } : {}) });
  }

  private async executeScreenshot(input: z.infer<typeof computerScreenshotSchema>) {
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
