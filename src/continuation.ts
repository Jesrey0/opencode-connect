type ReadTool = "opencode.inspect" | "opencode.query" | "host.inspect" | "host.worktree";
export function nextCall(tool: ReadTool, args: Record<string, unknown>) {
  return { tool, arguments: args };
}

// Caller-owned continuation arguments only; nothing executes or replays them.
// Mutation responses and command.read (persistent exit cleanup) do not use this.
export function pageNextCall(tool: ReadTool, args: Record<string, unknown>, result: unknown) {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  const input = { ...args };
  if (value.location && typeof value.location === "object" && "directory" in value.location) input.cwd = value.location.directory;
  const paging = value.textPaging as { nextOffset?: number | null; fingerprint?: string } | undefined;
  if (typeof paging?.nextOffset === "number") {
    input.textOffset = paging.nextOffset;
    input.textFingerprint = paging.fingerprint;
  } else if (typeof value.nextOffset === "number") {
    input.offset = value.nextOffset;
    input.fingerprint = value.fingerprint;
    if (tool === "host.inspect" && input.type === "read" && typeof value.path === "string") input.path = value.path;
  } else {
    const cursor = value.cursor as { next?: string | null } | undefined;
    if (typeof cursor?.next !== "string") return null;
    input.cursor = cursor.next;
    delete input.order;
  }
  return tool === "opencode.query" ? nextCall(tool, { queries: [input] }) : nextCall(tool, input);
}

export function queryNextCall(query: Record<string, unknown>, result: unknown) {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  const summary = value.permissionSummary as { exceptions?: unknown } | undefined;
  const args = { ...query };
  if (value.location && typeof value.location === "object" && "directory" in value.location && ("cwd" in query || ["agent", "agents", "models", "skills", "providers"].includes(String(query.type)))) args.cwd = value.location.directory;
  const selected = summary?.exceptions ?? (query.type === "agent" && query.field === "permissions" ? value.permissions : query.type === "permissions" ? value.rules ?? value.pending : result);
  return pageNextCall("opencode.query", args, selected);
}
