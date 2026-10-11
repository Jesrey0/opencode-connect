// Native OpenCode query resolution: one branch per canonical query type.
//
// This module owns *what* a native query returns. The backend owns the request
// envelope (runtime dispatch, per-entry error capture, continuation attachment),
// so this layer stays a pure client-query-to-canonical-result translation.
//
// Catalog reads that must stabilize against native location initialization are
// supplied by the caller, because settling policy is a runtime concern.
import {
  isAgentNotFoundError,
  type ModelInfo,
  type OpenCodeClient,
} from "@opencode/client";
import { OPENCODE_RELEASE } from "../native.js";
// ConnectorError is aliased as Error so thrown validation surfaces sanitize
// through safeError instead of leaking native/client error messages.
import { page, textPage, integer, fingerprint, CatalogError, ConnectorError as Error, MESSAGE_PREVIEW_LIMIT, type PageInput } from "../bounds.js";
import { pageNextCall } from "../continuation.js";
import { compactAgent, contextualPage, permissionSummary } from "../catalog.js";
import {
  modelKey,
  isZeroCostModel,
  projectAgent,
  projectSkill,
  projectSession,
  projectMessage,
  projectPermission,
  projectInbox,
  projectToolFile,
  secretProjection,
} from "./projection.js";

type Client = OpenCodeClient;

// Native agent reads surface absence as a dedicated native error rather than an
// empty list, so a missing agent ID must stay distinguishable from "no agents".
async function readAgent(client: Client, agentId: string, cwd?: string) {
  try { return await client.agent.get({ agentID: agentId, ...(cwd ? { location: { directory: cwd } } : {}) }); }
  catch (error) {
    if (isAgentNotFoundError(error)) throw new CatalogError(agentId);
    throw error;
  }
}

/** The catalog reads that must stabilize before a query may trust them. */
export type QueryCatalogs = {
  stableModels(client: Client, cwd?: string): Promise<ModelInfo[]>;
  stableAgentCatalog(client: Client, cwd?: string, allowEmptyAfterTimeout?: boolean): Promise<Awaited<ReturnType<Client["agent"]["list"]>>>;
  stableProviders(client: Client, cwd?: string, allowEmptyAfterTimeout?: boolean): Promise<Awaited<ReturnType<Client["provider"]["list"]>>>;
};

type TextInput = { textOffset?: number; textLimit?: number; textFingerprint?: string };

/**
 * The native query contract. Declared here because this module is what exhausts
 * it; the backend re-exports it unchanged.
 */
export type NativeQueryInput = (
  | ({ type: "sessionDiff"; sessionId: string; from?: string; to?: string; context?: number; file?: string } & PageInput & TextInput)
  | ({ type: "inbox"; sessionId: string; inboxId?: string } & PageInput & TextInput)
  | ({ type: "skill"; cwd?: string; skillId: string } & TextInput)
  | ({ type: "tools"; sessionId: string; messageId: string } & PageInput)
  | ({ type: "tool"; sessionId: string; messageId: string; toolId: string; field: "input" | "content" | "error"; contentIndex?: number } & TextInput)
  | ({ type: "models"; cwd?: string; view?: "compact" | "full" } & PageInput)
  | ({ type: "agents"; cwd?: string; view?: "compact" | "full"; includeHidden?: boolean; includePermissionsSummary?: boolean } & PageInput)
  | ({ type: "agent"; cwd?: string; agentId: string; field?: "system" | "description" | "permissions" | "permissionSummary"; textOffset?: number; textLimit?: number; textFingerprint?: string } & PageInput)
  | ({ type: "messages"; sessionId: string; cursor?: string; order?: "asc" | "desc" } & PageInput)
  | { type: "message"; sessionId: string; messageId: string; field?: "summary" | "recent"; textOffset?: number; textLimit?: number; textFingerprint?: string }
  | ({ type: "permissions"; sessionId: string; section?: "rules" | "pending" | "summary" } & PageInput)
  | ({ type: "savedApprovals"; sessionId: string } & PageInput)
  | ({ type: "runtime"; cwd: string } & PageInput)
  | ({ type: "skills"; cwd?: string } & PageInput)
  | ({ type: "providers"; cwd?: string } & PageInput)
  | { type: "usage" }
  | { type: "sessions"; cursor?: string; limit?: number; cwd?: string; searchTerm?: string }
  | { type: "session"; sessionId: string });

export async function resolveNativeQuery(client: Client, query: NativeQueryInput, catalogs: QueryCatalogs): Promise<unknown> {
  if (query.type === "skill") {
    const skills = (await client.skill.list(query.cwd ? { location: { directory: query.cwd } } : undefined)).data;
    const skill = skills.find((entry) => entry.id === query.skillId);
    if (!skill) throw new Error("canonical skill absent from catalog");
    return { ...projectSkill(skill), ...textPage(skill.content, query.textOffset, query.textLimit, query.textFingerprint) };
  }
  if (query.type === "sessionDiff") {
    const session = await client.session.get({ sessionID: query.sessionId });
    for (const id of [query.from, query.to]) if (id) await client.session.message.get({ sessionID: session.id, messageID: id });
    const diff = await client.session.diff({ sessionID: session.id, from: query.from, to: query.to, context: integer(query.context, 3, 1000) });
    const file = query.file ? diff.find((entry) => entry.file === query.file) : undefined;
    if (query.file && !file) throw new Error("file absent from native session diff");
    return { sessionId: session.id, from: query.from ?? null, to: query.to ?? null, ...(file ? { file: file.file, additions: file.additions, deletions: file.deletions, status: file.status, ...textPage(file.patch, query.textOffset, query.textLimit, query.textFingerprint) } : page(diff.map(({ patch, ...entry }) => ({ ...entry, patchSize: patch.length, patchFingerprint: fingerprint(patch) })), query)) };
  }
  if (query.type === "inbox") {
    await client.session.get({ sessionID: query.sessionId });
    const inbox = await client.session.inbox.list({ sessionID: query.sessionId });
    const selected = query.inboxId ? inbox.find((entry) => entry.id === query.inboxId) : undefined;
    if (query.inboxId && !selected) throw new Error("inbox entry not pending in targeted session");
    return selected ? { ...projectInbox(selected), ...textPage("text" in selected.payload ? selected.payload.text : "", query.textOffset, query.textLimit, query.textFingerprint) } : page(inbox.map(projectInbox), query);
  }
  if (query.type === "tools" || query.type === "tool") {
    const message = await client.session.message.get({ sessionID: query.sessionId, messageID: query.messageId });
    if (message.type !== "assistant") throw new Error("tool evidence requires canonical assistant message");
    const tools = message.content.filter((part) => part.type === "tool");
    const identity = { sessionId: query.sessionId, messageId: message.id };
    if (query.type === "tools") return { ...identity, ...page(tools.map((part) => ({ id: part.id, name: part.name, status: part.state.status, time: part.time, executed: part.executed ?? null })), query) };
    const tool = tools.find((entry) => entry.id === query.toolId);
    if (!tool) throw new Error("canonical tool absent from targeted message");
    const state = tool.state;
    let text = "";
    let contentType: string | null = null;
    let contentTotal = 0;
    let file: { mime: string; name: string | null; encoding: string; uriOmitted: boolean } | null = null;
    if (query.field === "input") text = typeof state.input === "string" ? state.input : JSON.stringify(secretProjection(state.input));
    if (query.field === "error" && state.status === "error") text = JSON.stringify({ type: state.error.type, status: state.error.status ?? null, messageOmitted: true });
    if (query.field === "content") {
      const content = "content" in state ? state.content ?? [] : [];
      contentTotal = content.length;
      const selected = content[integer(query.contentIndex, 0, Number.MAX_SAFE_INTEGER)];
      if (!selected) throw new Error("tool content index absent");
      contentType = selected.type;
      if (selected.type === "text") text = selected.text;
      else {
        const projected = projectToolFile(selected);
        text = projected.text;
        file = projected.file;
      }
    }
    return { ...identity, toolId: tool.id, name: tool.name, status: state.status, time: tool.time, executed: tool.executed ?? null, field: query.field, contentType, contentTotal, contentIndex: query.contentIndex ?? 0, file, ...textPage(text, query.textOffset, query.textLimit, query.textFingerprint) };
  }
  if (query.type === "models") {
    const models = await catalogs.stableModels(client, query.cwd);
    const data = models.map((model) => ({
      id: modelKey(model),
      free: isZeroCostModel(model),
      enabled: model.enabled,
      modalities: model.capabilities.input,
      variants: model.variants.map((variant) => variant.id),
      ...(query.view === "compact" ? {} : {
      name: model.name,
      providerId: model.providerID,
      family: model.family ?? null,
      canonical: model.canonical ?? null,
      status: model.status,
      capabilities: model.capabilities,
      compatibility: model.compatibility ?? null,
      releasedAtMs: model.time.released,
      contextWindow: model.limit.context,
      inputLimit: model.limit.input ?? null,
      outputLimit: model.limit.output,
      }),
    }));
    return { view: query.view ?? "full", ...page(data, query) };
  }
  if (query.type === "agents") {
    const response = await catalogs.stableAgentCatalog(client, query.cwd, true);
    const location = response.location;
    const view = query.view ?? "compact";
    const includeHidden = query.includeHidden ?? false;
    const agents = response.data.filter((agent) => includeHidden || !agent.hidden);
    const data = agents.map((agent) => {
      const summary = query.includePermissionsSummary ? permissionSummary(agent.permissions, { type: "agent", agentId: agent.id, location }) : undefined;
      return view === "full" ? { ...projectAgent(agent), ...(summary ? { permissionSummary: summary } : {}) } : compactAgent(agent, summary);
    });
    return {
      location, catalog: "effective", provenanceAvailable: false, view, includesBuiltins: true, includesHidden: includeHidden,
      hiddenCount: response.data.filter((agent) => agent.hidden).length,
      ...contextualPage(data, query, { location, view, includeHidden, includePermissionsSummary: query.includePermissionsSummary ?? false }),
    };
  }
  if (query.type === "skills") {
    const response = await client.skill.list(query.cwd ? { location: { directory: query.cwd } } : undefined);
    return page(response.data.map(projectSkill), query);
  }
  if (query.type === "providers") {
    const response = await catalogs.stableProviders(client, query.cwd, true);
    return page(response.data.map((provider) => ({ id: provider.id, name: provider.name, activation: provider.activation })), query);
  }
  if (query.type === "usage") {
    return client.session.stats();
  }
  if (query.type === "sessions") {
    const [response, active] = await Promise.all([
      client.session.list({ limit: integer(query.limit, 25, 50, 1), ...(query.cursor ? { cursor: query.cursor } : { order: "desc" as const }), directory: query.cwd, search: query.searchTerm }),
      client.session.active(),
    ]);
    return { sessions: response.data.map((session) => projectSession(session, active)), cursor: response.cursor };
  }
  if (query.type === "agent") {
    const response = await readAgent(client, query.agentId, query.cwd);
    const agent = response.data;
    const field = query.field ?? "system";
    const context = { type: "agent" as const, agentId: agent.id, location: response.location };
    return field === "permissionSummary"
      ? { id: agent.id, location: response.location, field, permissionSummary: permissionSummary(agent.permissions, context, query) }
      : { ...projectAgent(agent), location: response.location, field, ...(field === "permissions" ? { permissions: page(agent.permissions, query) } : textPage(agent[field] ?? "", query.textOffset, query.textLimit, query.textFingerprint)) };
  }
  if (query.type === "messages") {
    if (query.cursor && query.order) throw new Error("native message cursor cannot be combined with order");
    const response = await client.message.list({ sessionID: query.sessionId, limit: integer(query.limit, 25, 50, 1), ...(query.cursor ? { cursor: query.cursor } : { order: query.order ?? "desc" }) });
    return { messages: response.data.map((message) => projectMessage(message, 0, MESSAGE_PREVIEW_LIMIT, undefined, query.sessionId, true)), cursor: response.cursor };
  }
  if (query.type === "message") {
    const message = await client.session.message.get({ sessionID: query.sessionId, messageID: query.messageId });
    if (query.field) {
      if (message.type !== "compaction") throw new Error("field recovery requires a canonical compaction message");
      const full = query.field === "summary" && "summary" in message ? message.summary
        : query.field === "recent" && "recent" in message ? message.recent : null;
      if (full === null) throw new Error("compaction message has no such native text field");
      const paged = textPage(full, query.textOffset, query.textLimit, query.textFingerprint);
      return { id: message.id, type: message.type, createdAtMs: message.time.created, status: message.status, reason: message.reason, field: query.field, ...paged, nextCall: pageNextCall("opencode.query", { type: "message", sessionId: query.sessionId, messageId: message.id, field: query.field, ...(query.textLimit === undefined ? {} : { textLimit: query.textLimit }) }, paged) };
    }
    return projectMessage(message, query.textOffset, query.textLimit, query.textFingerprint, query.sessionId);
  }
  if (query.type === "permissions") {
    const session = await client.session.get({ sessionID: query.sessionId });
    if (query.section === "summary") {
      if (!session.agent) throw new Error("session has no persisted agent; cannot summarize its permission rules");
      const agent = (await readAgent(client, session.agent, session.location.directory)).data;
      return { sessionId: session.id, agentId: agent.id, location: session.location,
        permissionSummary: permissionSummary([...agent.permissions, ...(session.permissions ?? [])], { type: "session", agentId: agent.id, sessionId: session.id, location: session.location }, query),
      };
    }
    const requests = query.section === "pending" ? await client.permission.list({ sessionID: session.id }) : [];
    return { sessionId: session.id, defaultPolicyPreserved: session.permissions === undefined, section: query.section ?? "rules", ...((query.section ?? "rules") === "rules" ? { rules: page(session.permissions ?? [], query) } : { pending: page(requests.map(projectPermission), query) }), precedence: "session rules follow agent rules; omission preserves native default policy; explicit deny beats saved approval" };
  }
  if (query.type === "savedApprovals") {
    const session = await client.session.get({ sessionID: query.sessionId });
    const saved = await client.permission.saved.list({ projectID: session.projectID });
    return { projectId: session.projectID, ...page(saved, query) };
  }
  if (query.type === "runtime") {
    const location = { directory: query.cwd };
    const [runtime, plugins, mcp, commands] = await Promise.all([client.location.get({ location }), client.plugin.list({ location }), client.mcp.list({ location }), client.command.list({ location })]);
    const inventory = [
      ...plugins.data.map((plugin) => ({ type: "plugin", id: plugin.id ?? null, sourceType: plugin.source.type, features: plugin.features, status: plugin.state.status })),
      ...mcp.data.map((server) => ({ type: "mcp", name: server.name, status: server.status.status })),
      ...commands.data.map((command) => ({ type: "command", name: command.name })),
    ];
    return { location: { directory: runtime.directory }, projectId: runtime.project.id, opencodeRelease: OPENCODE_RELEASE, ...page(inventory, query), capabilities: { files: true, fileWrite: true, worktrees: true, sessionDiff: true, inbox: true, toolEvidence: true, skillContent: true, modelVariant: true, promptAttachments: true, sessionCommands: true, skillInvoke: true, compactionAdmission: true, vcs: true, shells: true, pty: true, persistentPty: "experimental", terminalScreen: true, terminalSnapshot: true, contentSearch: "native shell rg", patch: "native shell git apply", liveLsp: false, symbols: false, formatter: false } };
  }
  if (query.type === "session") {
    const [session, active] = await Promise.all([
      client.session.get({ sessionID: query.sessionId }),
      client.session.active(),
    ]);
    return projectSession(session, active);
  }
  // Adding a query to the public union must add a resolver, not silently fall
  // through to a session read with an absent identity.
  const unsupported: never = query;
  throw new Error("unsupported native query type");
}
