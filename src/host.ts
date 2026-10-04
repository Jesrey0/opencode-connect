import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { type OpenCodeClient, type ShellInfo1, type Pty, type PersistentPtyInfo } from "@opencode/client";
import { checkFingerprint, fingerprint, integer, OUTPUT_LIMIT, page, textPage, type PageInput } from "./bounds.js";
import { connectNative, type Connect } from "./native.js";
import { pageNextCall } from "./continuation.js";
import { terminalSocket, type SocketFactory } from "./terminal.js";
import { ConnectorError as Error, nativeErrorType } from "./bounds.js";

export type HostInspectInput = { cwd: string } & (
  | ({ type: "list"; path?: string } & PageInput)
  | { type: "read"; path: string; offset?: number; limit?: number; fingerprint?: string; image?: boolean }
  | { type: "find"; query: string; fileType?: "file" | "directory"; limit?: number }
  | { type: "vcs" }
  | ({ type: "vcsStatus" } & PageInput)
  | ({ type: "vcsBranch"; search?: string } & PageInput)
  | ({ type: "vcsDiff"; mode?: "working" | "branch" | "committed"; base?: string; file?: string; textOffset?: number; textLimit?: number; textFingerprint?: string } & PageInput)
  | ({ type: "commands"; sessionId?: string } & PageInput)
  | { type: "terminalScreen"; sessionId: string; lines?: number; textOffset?: number; textLimit?: number; textFingerprint?: string }
  | { type: "terminalSnapshot"; id: string; textOffset?: number; textLimit?: number; textFingerprint?: string }
);
export type HostWriteInput = { cwd: string; path: string; encoding: "utf8" | "base64"; data: string; overwrite: boolean; expectedFingerprint?: string };
export type WorktreeInput = { cwd: string; projectId?: string } & (
  | ({ action: "list" } & PageInput)
  | { action: "create"; directory: string; branch?: string; name?: string }
  | { action: "remove"; directory: string; force: boolean }
  | { action: "refresh" }
);
export type CommandHandle = { kind: "shell" | "pty" | "persistentPty"; cwd: string; id: string };
export type CommandStartInput = { cwd: string; command: string; title?: string } & (
  | { kind: "shell"; timeoutMs?: number }
  | { kind: "pty"; args?: string[] }
  | { kind: "persistentPty"; sessionId: string; args?: string[]; rows?: number; cols?: number }
);
export type CommandReadInput = CommandHandle & { cursor?: number; limit?: number; waitMs?: number };
export type CommandControlInput = CommandHandle & (
  | { action: "remove" }
  | { action: "resize"; rows: number; cols: number }
  | { action: "input"; text: string; takeover?: boolean }
  | { action: "interrupt" | "ctrlD"; takeover?: boolean }
);
const retention = {
  shell: "Native in-memory location registry; at most 25 exited jobs. Removal, location eviction or runtime restart loses the handle; output files do not make it restart-durable.",
  pty: "Native location registry; 2 Mi UTF-16 code units retained while running, at most 25 exited PTYs. No replay attachment after exit; metadata remains until removal/eviction/restart.",
  persistentPty: "Experimental native session-bound daemon retention with byte head/tail and replay-loss metadata. An attached observer seeing exit triggers native removal; removal/daemon loss can invalidate the handle. No connector restart-durability promise.",
};
export function projectShell(info: ShellInfo1) {
  return { id: info.id, status: info.status, cwd: info.cwd, pid: info.pid ?? null, exitCode: info.exit ?? null, signal: info.signal ?? null, time: info.time };
}
export function projectPty(info: Pty | PersistentPtyInfo) {
  return { id: info.id, cwd: info.cwd, status: info.status, pid: info.pid, exitCode: info.exitCode ?? null,
    ...("sessionID" in info ? { sessionId: info.sessionID, size: info.size, output: info.output } : {}) };
}
async function safePath(cwd: string, filename = ".") {
  const root = await realpath(cwd);
  const target = await realpath(path.resolve(root, filename));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("path or symlink leaves the canonical location");
  return target;
}
export function imageMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.subarray(0,4).toString("ascii") === "RIFF" && b.subarray(8,12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("only signature-checked PNG, JPEG, GIF and WebP images are supported");
}
export class HostBackend {
  constructor(private readonly connect: Connect = connectNative, private readonly sockets: SocketFactory = (url) => new WebSocket(url)) {}
  private async location(client: OpenCodeClient, cwd: string) {
    if (!path.isAbsolute(cwd)) throw new Error("cwd must be absolute");
    const location = await client.location.get({ location: { directory: cwd } });
    return { directory: location.directory };
  }
  async inspect(input: HostInspectInput) {
    const result = await this.inspectNative(input);
    return { ...result, nextCall: pageNextCall("host.inspect", input, result) };
  }
  private async inspectNative(input: HostInspectInput) {
    const { client } = await this.connect();
    const location = await this.location(client, input.cwd);
    if (input.type === "terminalScreen") {
      const session = await client.session.get({ sessionID: input.sessionId });
      if (session.location.directory !== location.directory) throw new Error("terminal session does not belong to this canonical location");
      const screen = await client.experimental.persistentPty.read({ sessionID: session.id, lines: integer(input.lines, 24, 1000, 1) });
      if (!screen) return { location, type: input.type, sessionId: session.id, available: false };
      await this.handle(client, { kind: "persistentPty", cwd: location.directory, id: screen.ptyID });
      return { location, type: input.type, sessionId: session.id, id: screen.ptyID, available: true, view: "renderedScreen", size: { rows: screen.screen.rows, cols: screen.screen.cols }, screenCursor: screen.screen.cursor, ...textPage(screen.screen.text, input.textOffset, input.textLimit, input.textFingerprint) };
    }
    if (input.type === "terminalSnapshot") {
      await this.handle(client, { kind: "persistentPty", cwd: location.directory, id: input.id });
      const snapshot = await client.experimental.persistentPty.snapshot({ ptyID: input.id });
      const session = await client.session.get({ sessionID: snapshot.info.sessionID });
      if (session.location.directory !== location.directory) throw new Error("snapshot session location changed");
      return { location, type: input.type, ...projectPty(snapshot.info), view: "renderedSnapshot", screenCursor: snapshot.cursor, checkpointIncluded: false, ...textPage(snapshot.text, input.textOffset, input.textLimit, input.textFingerprint) };
    }
    if (input.type === "list") {
      const target = await safePath(location.directory, input.path);
      const result = await client.file.list({ location, path: target });
      return { location: result.location, type: input.type, ...page(result.data.sort((a,b) => a.path.localeCompare(b.path)), input) };
    }
    if (input.type === "read") {
      const target = await safePath(location.directory, input.path);
      const bytes = await client.file.read({ location, path: target });
      const hash = fingerprint(bytes);
      const offset = integer(input.offset, 0, Number.MAX_SAFE_INTEGER);
      checkFingerprint(hash, input.fingerprint, offset);
      if (input.image) {
        if (offset !== 0) throw new Error("images cannot be paged");
        if (bytes.byteLength > 1_048_576) throw new Error("image exceeds the 1 MiB limit");
        return { location, type: input.type, path: target, size: bytes.byteLength, fingerprint: hash, image: { mimeType: imageMime(bytes), data: Buffer.from(bytes).toString("base64") } };
      }
      const limit = integer(input.limit, 12_000, OUTPUT_LIMIT, 1);
      // Native read materializes the whole file; the MCP projection is byte bounded.
      const end = Math.min(bytes.length, offset + limit);
      const data = bytes.subarray(offset, end);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
      catch { return { location, type: input.type, path: target, encoding: "base64", data: Buffer.from(data).toString("base64"), cursorUnit: "bytes", offset, nextOffset: end < bytes.length ? end : null, size: bytes.length, fingerprint: hash }; }
      return { location, type: input.type, path: target, encoding: "utf8", text, cursorUnit: "bytes", offset, nextOffset: end < bytes.length ? end : null, size: bytes.length, fingerprint: hash };
    }
    if (input.type === "find") {
      const limit = integer(input.limit, 25, 50, 1);
      const result = await client.file.find({ location, query: input.query, type: input.fileType, limit });
      return { location: result.location, type: input.type, data: result.data, limit, possiblyTruncated: result.data.length === limit, search: "native filename search; use native shell rg for content search" };
    }
    if (input.type === "vcs") {
      const [info, base] = await Promise.all([client.vcs.get({ location }), client.vcs.base({ location })]);
      return { location: info.location, type: input.type, info: info.data, base: base.data };
    }
    if (input.type === "vcsStatus") {
      const result = await client.vcs.status({ location });
      return { location: result.location, type: input.type, ...page(result.data, input) };
    }
    if (input.type === "vcsBranch") {
      const result = await client.vcs.branch.list({ location, ...(input.search === undefined ? {} : { search: input.search }) });
      return { location: result.location, type: input.type, search: input.search ?? null, ...page(result.data, input) };
    }
    if (input.type === "vcsDiff") {
      const result = await client.vcs.diff({ location, mode: input.mode ?? "working", base: input.base });
      if (input.file) {
        const file = result.data.find((entry) => entry.file === input.file);
        if (!file) throw new Error("file absent from native diff");
        return { location: result.location, type: input.type, file: file.file, additions: file.additions, deletions: file.deletions, status: file.status, ...textPage(file.patch, input.textOffset, input.textLimit, input.textFingerprint) };
      }
      return { location: result.location, type: input.type, ...page(result.data.map(({ patch, ...file }) => ({ ...file, patchSize: patch.length, patchFingerprint: fingerprint(patch) })), input) };
    }
    if (input.sessionId) {
      const session = await client.session.get({ sessionID: input.sessionId });
      if (session.location.directory !== location.directory) throw new Error("command session does not belong to this canonical location");
    }
    const [shells, ptys, persistent] = await Promise.all([client.shell.list({ location }), client.pty.list({ location }), input.sessionId ? client.experimental.persistentPty.list({ sessionID: input.sessionId }) : Promise.resolve([])]);
    return { location, type: input.type, ...page([
      ...shells.data.map((info) => ({ kind: "shell", ...projectShell(info), retention: retention.shell })),
      ...ptys.data.map((info) => ({ kind: "pty", ...projectPty(info), retention: retention.pty })),
      ...persistent.map((info) => ({ kind: "persistentPty", ...projectPty(info), retention: retention.persistentPty })),
    ], input), shellListScope: "running only; retained exited shell IDs must be saved by the caller" };
  }
  async write(input: HostWriteInput) {
    const { client } = await this.connect();
    const location = await this.location(client, input.cwd);
    const root = await realpath(location.directory);
    const requested = path.resolve(root, input.path);
    const parent = await safePath(root, path.dirname(requested));
    const target = path.join(parent, path.basename(requested));
    // lstat distinguishes a missing leaf from a dangling or escaping symlink.
    let exists = true;
    try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
    const resolved = exists ? await safePath(root, target) : target;
    if (exists) {
      if (!input.overwrite) throw new Error("existing file requires overwrite: true");
      if (!input.expectedFingerprint) throw new Error("updates require expectedFingerprint");
      checkFingerprint(fingerprint(await client.file.read({ location, path: resolved })), input.expectedFingerprint);
    } else if (input.overwrite || input.expectedFingerprint) throw new Error("new files require overwrite: false and no expectedFingerprint");
    if (input.data.length > 90_000) throw new Error("write payload exceeds encoded input bound");
    if (input.encoding === "base64" && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))) throw new Error("invalid canonical base64 payload");
    const bytes = Buffer.from(input.data, input.encoding === "utf8" ? "utf8" : "base64");
    if (input.encoding === "utf8" && bytes.toString("utf8") !== input.data) throw new Error("UTF-8 payload contains an unpaired surrogate");
    if (bytes.length > OUTPUT_LIMIT) throw new Error("write payload exceeds 64 KiB");
    if (input.encoding === "base64" && bytes.toString("base64") !== input.data) throw new Error("invalid canonical base64 payload");
    await client.file.write({ location, path: resolved, payload: bytes });
    const persisted = await client.file.read({ location, path: resolved });
    if (!Buffer.from(persisted).equals(bytes)) throw new Error("file write readback mismatch; mutation may have occurred");
    return { location, path: resolved, created: !exists, persisted: true, size: persisted.length, fingerprint: fingerprint(persisted), atomicCAS: false, containment: "checked before native write; concurrent filesystem replacement is not excluded" };
  }
  async worktree(input: WorktreeInput) {
    const { client } = await this.connect();
    if (!path.isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
    const location = await client.location.get({ location: { directory: input.cwd } });
    const projectId = location.project.id;
    if (input.projectId && input.projectId !== projectId) throw new Error("projectId does not match canonical location project");
    const list = await client.worktree.list({ projectID: projectId });
    if (input.action === "list") {
      const result = { projectId, location: { directory: location.directory }, ...page(list, input) };
      return { ...result, nextCall: pageNextCall("host.worktree", { ...input, cwd: location.directory, projectId }, result) };
    }
    if (input.action === "refresh") await client.worktree.refresh({ projectID: projectId });
    else {
      if (!path.isAbsolute(input.directory)) throw new Error("worktree directory must be absolute");
      if (input.action === "create") {
        const parent = await realpath(path.dirname(input.directory));
        const directory = path.join(parent, path.basename(input.directory));
        if (directory !== input.directory) throw new Error("worktree directory must be canonical");
        const created = await client.worktree.create({ projectID: projectId, from: location.directory, directory, branch: input.branch, name: input.name });
        const after = await client.worktree.list({ projectID: projectId });
        if (!after.some((entry) => entry.directory === created.directory)) throw new Error("worktree create readback mismatch; mutation may have occurred");
        return { action: input.action, projectId, directory: created.directory, persisted: true };
      }
      const directory = await realpath(input.directory);
      if (directory !== input.directory || !list.some((entry) => entry.directory === directory)) throw new Error("remove requires a canonical worktree owned by this project");
      if (directory === await realpath(location.project.canonical)) throw new Error("cannot remove canonical project root");
      await client.worktree.remove({ projectID: projectId, directory, force: input.force });
      const after = await client.worktree.list({ projectID: projectId });
      if (after.some((entry) => entry.directory === directory)) throw new Error("worktree removal readback mismatch; mutation may have occurred");
      return { action: input.action, projectId, directory, removed: true, persisted: true };
    }
    return { action: input.action, projectId, persisted: true, ...page(await client.worktree.list({ projectID: projectId })) };
  }
  async start(input: CommandStartInput) {
    const { client } = await this.connect();
    const location = await this.location(client, input.cwd);
    if (input.kind === "shell") {
      const response = await client.shell.create({ location, cwd: location.directory, command: input.command, timeout: integer(input.timeoutMs, 120_000, 86_400_000, 1) });
      return { kind: input.kind, location: response.location, ...projectShell(response.data), cursor: 0, cursorUnit: "bytes", retention: retention.shell };
    }
    if (input.kind === "pty") {
      const response = await client.pty.create({ location, cwd: location.directory, command: input.command, args: input.args, title: input.title });
      return { kind: input.kind, location: response.location, ...projectPty(response.data), cursor: 0, cursorUnit: "utf16CodeUnits", retention: retention.pty };
    }
    const session = await client.session.get({ sessionID: input.sessionId });
    if (session.location.directory !== location.directory) throw new Error("persistent PTY cwd must match canonical session location");
    const info = await client.experimental.persistentPty.create({ sessionID: input.sessionId, command: input.command, args: input.args ?? [], cwd: location.directory, title: input.title ?? "Operator terminal", env: {}, size: { rows: integer(input.rows, 24, 1000, 1), cols: integer(input.cols, 80, 1000, 1) } });
    return { kind: input.kind, location, ...projectPty(info), cursor: info.output.head, cursorUnit: "bytes", retention: retention.persistentPty };
  }
  private async handle(client: OpenCodeClient, input: CommandHandle) {
    const location = await this.location(client, input.cwd);
    if (input.kind === "shell") {
      const response = await client.shell.get({ location, id: input.id });
      return { location: response.location, info: response.data };
    }
    if (input.kind === "pty") {
      const response = await client.pty.get({ location, ptyID: input.id });
      return { location: response.location, info: response.data };
    }
    const info = await client.experimental.persistentPty.get({ ptyID: input.id });
    const session = await client.session.get({ sessionID: info.sessionID });
    if (session.location.directory !== location.directory) throw new Error("PTY handle does not belong to this canonical location");
    return { location, info };
  }
  async read(input: CommandReadInput) {
    const connection = await this.connect();
    const { client } = connection;
    const { location, info } = await this.handle(client, input);
    const cursor = integer(input.cursor, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(input.limit, 12_000, OUTPUT_LIMIT, 1);
    if (input.kind === "shell") {
      // Read terminal state BEFORE output, so a racing exit never declares older output drained.
      const result = await client.shell.output({ location, id: input.id, cursor, limit });
      return { kind: input.kind, location: result.location, ...projectShell(info as ShellInfo1), ...result.data, encoding: "nativeUtf8", decodingLimit: "Native shell slices bytes and independently decodes each page as UTF-8; split multibyte characters can be replaced. Cursor is still bytes; exact byte recovery is not promised.", cursorUnit: "bytes", drained: info.status !== "running" && result.data.cursor >= result.data.size, retention: retention.shell };
    }
    if (input.kind === "pty" && info.status === "exited") return { kind: input.kind, location, ...projectPty(info as Pty), cursor, cursorUnit: "utf16CodeUnits", output: "", replayAvailable: false, drained: false, retention: retention.pty };
    const result = await terminalSocket(connection, { ...input, kind: input.kind, cwd: location.directory, cursor, limit, waitMs: integer(input.waitMs, 250, 2000) }, this.sockets);
    try {
      const after = await this.handle(client, input);
      return { kind: input.kind, location: after.location, ...projectPty(after.info as Pty), ...result, lastConfirmedInfo: projectPty(after.info as Pty), metadataVerified: true, metadataReadError: null, handleAvailable: true, drained: input.kind === "persistentPty" && after.info.status === "exited" && "output" in after.info && result.cursor >= (after.info as PersistentPtyInfo).output.tail, retention: retention[input.kind] };
    } catch (error) {
      const type = nativeErrorType(error);
      return { kind: input.kind, location, ...projectPty(info as Pty), ...result, lastConfirmedInfo: projectPty(info as Pty), metadataVerified: false, metadataReadError: { type, message: "final native handle readback failed; last confirmed pre-replay metadata returned" }, handleAvailable: type === "PtyNotFoundError" ? false : null, drained: false, retention: retention[input.kind] };
    }
  }
  async control(input: CommandControlInput) {
    const connection = await this.connect();
    const { client } = connection;
    const { location } = await this.handle(client, input);
    if (input.action === "remove") {
      if (input.kind === "shell") await client.shell.remove({ location, id: input.id });
      else if (input.kind === "pty") await client.pty.remove({ location, ptyID: input.id });
      else await client.experimental.persistentPty.remove({ ptyID: input.id });
      return { kind: input.kind, location, id: input.id, removed: true };
    }
    if (input.kind === "shell") throw new Error("native shells support removal only; removal terminates and forgets the command");
    if (input.action === "resize") {
      const size = { rows: integer(input.rows, 24, 1000, 1), cols: integer(input.cols, 80, 1000, 1) };
      if (input.kind === "pty") await client.pty.update({ location, ptyID: input.id, size });
      else await client.experimental.persistentPty.update({ ptyID: input.id, size });
      const after = await this.handle(client, input);
      return { kind: input.kind, location: after.location, ...projectPty(after.info as Pty), resized: true };
    }
    const text = input.action === "input" ? input.text : input.action === "interrupt" ? "\u0003" : "\u0004";
    if (Buffer.byteLength(text) > 16_384) throw new Error("terminal input exceeds 16 KiB");
    const result = await terminalSocket(connection, { ...input, kind: input.kind, cwd: location.directory, cursor: 0, limit: 1, waitMs: 0, input: text }, this.sockets);
    return { kind: input.kind, location, id: input.id, action: input.action, inputSent: result.inputSent, acknowledged: false, delivery: "socket send attempted; native protocol has no durable input acknowledgement. Detach is not exit; Ctrl-D is a terminal character, not pipe EOF." };
  }
}
