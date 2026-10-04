import { createHash } from "node:crypto";

export const TEXT_LIMIT = 12_000;
export const OUTPUT_LIMIT = 65_536;
export const PAGE_LIMIT = 50;
// Message inventory previews stay compact so default and max native pages fit the
// 256 KiB structured-result envelope for bounded native content. Full text remains
// available on demand through type:message with lossless fingerprinted text
// pagination. Unbounded native identities can still exceed the envelope; those
// results fail explicitly so the caller narrows the page instead of silently
// truncating.
export const MESSAGE_PREVIEW_LIMIT = 512;
export const COMPACTION_PREVIEW_LIMIT = 128;
export const MESSAGE_TOOL_PREVIEW_LIMIT = 10;
export class ConnectorError extends Error {}
export class CatalogError extends ConnectorError {
  readonly code = "AGENT_NOT_FOUND";
  constructor(readonly agentId: string) { super(`AGENT_NOT_FOUND: ${agentId}`); }
}
export class AdmissionError extends ConnectorError {
  constructor(message: string, readonly recovery: { sessionId: string; stage: string; promptSubmitted: false | null }) { super(message); }
}
export function nativeErrorType(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const type = "_tag" in error ? error._tag : "name" in error ? error.name : null;
  return typeof type === "string" && ["InvalidRequestError", "UnauthorizedError", "ForbiddenError", "ConflictError", "SessionNotFoundError", "ProjectNotFoundError", "PtyNotFoundError", "ShellNotFoundError", "ServiceUnavailableError", "WorktreeError"].includes(type) ? type : null;
}
export function safeError(error: unknown): string {
  // Only connector-authored validation is safe. SDK/HTTP errors can contain provider
  // bodies, request headers or tickets and must not export their message/cause.
  if (error instanceof ConnectorError) return error.message;
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
  return `native operation failed${nativeErrorType(error) ? ` (${nativeErrorType(error)})` : ""}${status === null ? "" : ` (status ${status})`}; details omitted; reconcile persisted state before retrying a mutation`;
}
export type PageInput = { offset?: number; limit?: number; fingerprint?: string };
export function integer(value: number | undefined, fallback: number, max: number, min = 0, field = "value"): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new ConnectorError(`${field} must be an integer between ${min} and ${max}`);
  return result;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value)).digest("hex");
}
export function checkFingerprint(actual: string, expected?: string, offset = 0) {
  if (offset > 0 && !expected) throw new ConnectorError("continuation requires the previous fingerprint");
  if (expected && actual !== expected) throw new ConnectorError("content changed; restart pagination");
}
export function page<T>(data: T[], input: PageInput = {}) {
  const offset = integer(input.offset, 0, Number.MAX_SAFE_INTEGER, 0, "offset");
  const limit = integer(input.limit, 25, PAGE_LIMIT, 1, "limit");
  const hash = fingerprint(data);
  checkFingerprint(hash, input.fingerprint, offset);
  const selected: T[] = [];
  let size = 2;
  for (const entry of data.slice(offset, offset + limit)) {
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (size + bytes > 96_000) {
      if (selected.length === 0) throw new ConnectorError("single page entry exceeds 96 KB; request specific text detail");
      break;
    }
    selected.push(entry);
    size += bytes;
  }
  const end = offset + selected.length;
  return { data: selected, offset, nextOffset: end < data.length ? end : null, total: data.length, fingerprint: hash };
}
export function textPage(text: string, offset = 0, limit = TEXT_LIMIT, expected?: string) {
  integer(offset, 0, Number.MAX_SAFE_INTEGER);
  integer(limit, TEXT_LIMIT, TEXT_LIMIT, 1);
  const hash = fingerprint(text);
  checkFingerprint(hash, expected, offset);
  if (offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(offset)) && /[\uD800-\uDBFF]/u.test(text.charAt(offset - 1))) throw new ConnectorError("text offset splits a Unicode character");
  // Avoid cutting a surrogate pair while preserving native JavaScript cursor units.
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1;
  if (end === offset && offset < text.length) throw new ConnectorError("text limit cannot contain the next character");
  return { text: text.slice(offset, end), textPaging: { offset, nextOffset: end < text.length ? end : null, size: text.length, cursorUnit: "utf16CodeUnits" as const, fingerprint: hash }, truncated: end < text.length };
}
