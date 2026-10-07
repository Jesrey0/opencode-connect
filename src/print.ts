import { basename } from "node:path";
import { ConnectorError } from "./bounds.js";
import { PrintBridge, canonicalPrintFile } from "./printBridge.js";
import {
  printCapabilitiesSchema, printCancelSchema, printInspectSchema, printJobSchema, printMediaSchema,
  printQueueSchema, printSetMediaSchema, printStatusSchema, printSubmitSchema, printOutputSchemas,
  type PrintCapabilities, type PrintCancel, type PrintInspect, type PrintJob,
  type PrintMedia, type PrintQueue, type PrintSetMedia, type PrintStatus, type PrintSubmit,
} from "./printSchema.js";

export function statusArgs(): string[] { return ["status", "--json"]; }
export function capabilitiesArgs(input: PrintCapabilities = {}): string[] {
  const args = printCapabilitiesSchema.parse(input);
  return ["capabilities", ...(args.printer ? ["--printer", args.printer] : []), "--json"];
}
export function mediaGetArgs(input: PrintMedia = {}): string[] {
  printMediaSchema.parse(input);
  return ["media", "get", "--json"];
}
export function mediaSetArgs(input: PrintSetMedia): string[] {
  const args = printSetMediaSchema.parse(input);
  return ["media", "set", "--paper", args.paper, ...(args.media ? ["--media", args.media] : []), "--json"];
}
export function inspectArgs(filename: string): string[] {
  return ["inspect", "--stdin", "--filename", filename, "--json"];
}
export function submitArgs(input: Omit<PrintSubmit, "path" | "filename"> & { filename: string }): string[] {
  // Keep canonical CLI order: --json stays last for stable command construction tests.
  const optional: string[] = [];
  if (input.printer) optional.push("--printer", input.printer);
  if (input.copies !== undefined) optional.push("--copies", String(input.copies));
  if (input.paper) optional.push("--paper", input.paper);
  if (input.orientation) optional.push("--orientation", input.orientation);
  if (input.color) optional.push("--color", input.color);
  if (input.scale) optional.push("--scale", input.scale);
  return ["submit", "--stdin", "--filename", input.filename, ...optional, "--json"];
}
export function queueArgs(input: PrintQueue = {}): string[] {
  const args = printQueueSchema.parse(input);
  return ["queue", ...(args.printer ? ["--printer", args.printer] : []), "--json"];
}
export function jobArgs(input: PrintJob): string[] {
  const args = printJobSchema.parse(input);
  return ["job", "--printer", args.printer, "--id", args.id, "--json"];
}
export function cancelArgs(input: PrintCancel): string[] {
  const args = printCancelSchema.parse(input);
  return ["cancel", "--printer", args.printer, "--id", args.id, "--json"];
}

/** Print HostPlane owner. Each method is one bounded bar-print.exe call; no retries. */
export class PrintBackend {
  constructor(private readonly bridge: PrintBridge = new PrintBridge()) {}

  private async parsed<T>(payload: unknown, kind: keyof typeof printOutputSchemas): Promise<Record<string, unknown>> {
    const parsed = printOutputSchemas[kind].safeParse(payload);
    if (!parsed.success) throw new ConnectorError(`Print bridge returned an unexpected ${kind} payload`);
    return parsed.data as Record<string, unknown>;
  }

  status(input: PrintStatus = {}) { printStatusSchema.parse(input); return this.bridge.run(statusArgs()).then((p) => this.parsed(p, "status")); }
  capabilities(input: PrintCapabilities = {}) { return this.bridge.run(capabilitiesArgs(input)).then((p) => this.parsed(p, "capabilities")); }
  media(input: PrintMedia = {}) { return this.bridge.run(mediaGetArgs(input)).then((p) => this.parsed(p, "media")); }
  setMedia(input: PrintSetMedia) { return this.bridge.run(mediaSetArgs(input)).then((p) => this.parsed(p, "set_media")); }
  queue(input: PrintQueue = {}) { return this.bridge.run(queueArgs(input)).then((p) => this.parsed(p, "queue")); }
  job(input: PrintJob) { return this.bridge.run(jobArgs(input)).then((p) => this.parsed(p, "job")); }

  // Single attempt only: never retry submit/cancel after uncertain failure.
  cancel(input: PrintCancel) { return this.bridge.run(cancelArgs(input)).then((p) => this.parsed(p, "cancel")); }

  async inspect(input: PrintInspect) {
    const args = printInspectSchema.parse(input);
    const { realPath } = await canonicalPrintFile(args.path);
    const filename = args.filename ?? basename(realPath);
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
      throw new ConnectorError("Print filename must not contain path separators");
    }
    // Single attempt; stream raw bytes to child stdin, never base64 over MCP.
    return this.parsed(await this.bridge.run(inspectArgs(filename), realPath), "inspect");
  }

  async submit(input: PrintSubmit) {
    const args = printSubmitSchema.parse(input);
    const { realPath } = await canonicalPrintFile(args.path);
    const filename = args.filename ?? basename(realPath);
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
      throw new ConnectorError("Print filename must not contain path separators");
    }
    const { path: _path, ...rest } = args;
    // Single attempt only: a timeout or uncertain failure must be reconciled
    // via print.queue/print.job, never automatically resubmitted.
    return this.parsed(await this.bridge.run(submitArgs({ ...rest, filename }), realPath), "submit");
  }

  close(): void { this.bridge.close(); }
}
