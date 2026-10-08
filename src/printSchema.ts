import * as z from "zod/v4";

const printerName = z.string().min(1).max(256).describe("Printer name as shown by print capabilities or status.");
const paperName = z.string().min(1).max(128).describe("Paper size name, e.g. A4, Letter.");
const mediaType = z.string().min(1).max(128).describe("Media type declared as loaded, e.g. Plain, Photo.");
const jobId = z.string().min(1).max(256).describe("Print job ID returned by submit or queue.");
const hostPath = z.string().min(1).max(4096).describe("Absolute host file path streamed to print-bridge.exe stdin.");
const fileName = z.string().min(1).max(255)
  .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes("\0"), "filename must not contain path separators")
  .describe("Filename reported to the print bridge, without directories.");

export const printStatusSchema = z.object({}).strict();
export const printCapabilitiesSchema = z.object({ printer: printerName.optional() }).strict();
export const printMediaSchema = z.object({}).strict();
export const printSetMediaSchema = z.object({ paper: paperName, media: mediaType.optional() }).strict();
export const printInspectSchema = z.object({ path: hostPath, filename: fileName.optional() }).strict();
export const printSubmitSchema = z.object({
  path: hostPath,
  filename: fileName.optional(),
  printer: printerName.optional(),
  copies: z.number().int().min(1).max(99).optional().describe("Copy count 1..99."),
  paper: paperName.optional(),
  orientation: z.enum(["Auto", "Portrait", "Landscape"]).optional(),
  color: z.enum(["Auto", "Color", "Grayscale"]).optional(),
  scale: z.enum(["Fit", "Actual"]).optional(),
}).strict();
export const printQueueSchema = z.object({ printer: printerName.optional() }).strict();
export const printJobSchema = z.object({ printer: printerName, id: jobId }).strict();
export const printCancelSchema = z.object({ printer: printerName, id: jobId }).strict();

export type PrintStatus = z.infer<typeof printStatusSchema>;
export type PrintCapabilities = z.infer<typeof printCapabilitiesSchema>;
export type PrintMedia = z.infer<typeof printMediaSchema>;
export type PrintSetMedia = z.infer<typeof printSetMediaSchema>;
export type PrintInspect = z.infer<typeof printInspectSchema>;
export type PrintSubmit = z.infer<typeof printSubmitSchema>;
export type PrintQueue = z.infer<typeof printQueueSchema>;
export type PrintJob = z.infer<typeof printJobSchema>;
export type PrintCancel = z.infer<typeof printCancelSchema>;

// Bridge --json payloads are external printer state. Accept any JSON object and
// project it through the 256 KiB MCP structured-result envelope. Non-object
// payloads are rejected by the backend; structured bridge errors cross as
// PrintBridgeError detail instead of silent data.
const bridgeObject = z.object({}).loose();
export const printOutputSchemas = {
  status: bridgeObject,
  capabilities: bridgeObject,
  media: bridgeObject,
  set_media: bridgeObject,
  inspect: bridgeObject,
  submit: bridgeObject,
  queue: bridgeObject,
  job: bridgeObject,
  cancel: bridgeObject,
};
