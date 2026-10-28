type ReadTool =
  | "opencode.result"
  | "opencode.sessionDiff" | "opencode.inbox" | "opencode.skill" | "opencode.toolCalls" | "opencode.toolCall"
  | "opencode.models" | "opencode.agents" | "opencode.agent" | "opencode.messages" | "opencode.message"
  | "opencode.permissions" | "opencode.savedApprovals" | "opencode.runtime" | "opencode.skills"
  | "opencode.providers" | "opencode.usage" | "opencode.sessions" | "opencode.session"
  | "file.list" | "file.read" | "file.find" | "git.repository" | "git.status"
  | "git.branches" | "git.diff" | "command.list" | "terminal.screen"
  | "terminal.snapshot" | "git.worktrees" | "terminal.list" | "command.read";
type QueryTool = Exclude<Extract<ReadTool, `opencode.${string}`>, "opencode.result">;

const queryTools = {
  sessionDiff: "opencode.sessionDiff", inbox: "opencode.inbox", skill: "opencode.skill", tools: "opencode.toolCalls",
  tool: "opencode.toolCall", models: "opencode.models", agents: "opencode.agents", agent: "opencode.agent",
  messages: "opencode.messages", message: "opencode.message", permissions: "opencode.permissions",
  savedApprovals: "opencode.savedApprovals", runtime: "opencode.runtime", skills: "opencode.skills",
  providers: "opencode.providers", usage: "opencode.usage", sessions: "opencode.sessions", session: "opencode.session",
} as const satisfies Record<string, QueryTool>;
export function queryToolName(type: string): QueryTool {
  const tool = queryTools[type as keyof typeof queryTools];
  if (!tool) throw new Error("unsupported query type has no public tool");
  return tool;
}
export function nextCall(tool: ReadTool, args: Record<string, unknown>) {
  return { tool, arguments: args };
}

// Caller-owned continuation arguments only; nothing executes or replays them.
// Mutation responses and persistent command observation do not use this.
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
    if (tool === "file.read" && typeof value.path === "string") input.path = value.path;
  } else {
    const cursor = value.cursor as { next?: string | null } | undefined;
    if (typeof cursor?.next !== "string") return null;
    input.cursor = cursor.next;
    delete input.order;
  }
  return nextCall(tool, input);
}

export function queryNextCall(query: Record<string, unknown>, result: unknown) {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  const args = { ...query };
  if (value.location && typeof value.location === "object" && "directory" in value.location && ("cwd" in query || ["agent", "agents", "models", "skills", "providers"].includes(String(query.type)))) args.cwd = value.location.directory;
  const selected = query.type === "agent" && query.field === "permissions" ? value.permissions : query.type === "permissions" ? value.rules ?? value.pending : result;
  const tool = queryToolName(String(query.type));
  delete args.type;
  return pageNextCall(tool, args, selected);
}
