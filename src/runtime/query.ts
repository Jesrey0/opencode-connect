// Native OpenCode query resolution: one branch per canonical query type.
//
// This module owns *what* a native query returns. The backend owns the request
// envelope (runtime dispatch, per-entry error capture, continuation attachment),
// so this layer stays a pure client-query-to-canonical-result translation.
//
import {
  isAgentNotFoundError,
  type OpenCodeClient,
} from "@opencode/client";
import { OPENCODE_RELEASE } from "../native.js";
// ConnectorError is aliased as Error so thrown validation surfaces sanitize
// through safeError instead of leaking native/client error messages.
import { page, textPage, integer, fingerprint, CatalogError, ConnectorError as Error, MESSAGE_PREVIEW_LIMIT, type PageInput } from "../bounds.js";
import { pageNextCall, queryToolName } from "../continuation.js";
import { compactAgent, contextualPage } from "../catalog.js";
import { runtimeDiagnostics } from "./capabilities.js";
import {
  modelKey,
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
async function readAgent(client: Client, agentId: string, cwd?: string, signal?: AbortSignal) {
  try { return await client.agent.get({ agentID: agentId, ...(cwd ? { location: { directory: cwd } } : {}) }, { signal }); }
  catch (error) {
    if (isAgentNotFoundError(error)) throw new CatalogError(agentId);
    throw error;
  }
}

type TextInput = { textOffset?: number; textLimit?: number; textFingerprint?: string };

/**
 * The native query contract. Declared here because this module is what exhausts
 * it; the facade composes it with runtime routing.
 */
export type NativeQueryInput = (
  | ({ type: "sessionDiff"; sessionId: string; from?: string; to?: string; context?: number; file?: string } & PageInput & TextInput)
  | ({ type: "inbox"; sessionId: string; inboxId?: string } & PageInput & TextInput)
  | ({ type: "skill"; cwd?: string; skillId: string } & TextInput)
  | ({ type: "tools"; sessionId: string; messageId: string } & PageInput)
  | ({ type: "tool"; sessionId: string; messageId: string; toolId: string; field: "input" | "content" | "error"; contentIndex?: number } & TextInput)
  | ({ type: "models"; cwd?: string; view?: "compact" | "full" } & PageInput)
  | ({ type: "agents"; cwd?: string; view?: "compact" | "full"; includeHidden?: boolean } & PageInput)
  | ({ type: "agent"; cwd?: string; agentId: string; field?: "system" | "description" | "permissions"; textOffset?: number; textLimit?: number; textFingerprint?: string } & PageInput)
  | ({ type: "messages"; sessionId: string; cursor?: string; order?: "asc" | "desc" } & PageInput)
  | { type: "message"; sessionId: string; messageId: string; field?: "summary" | "recent"; textOffset?: number; textLimit?: number; textFingerprint?: string }
  | ({ type: "permissions"; sessionId: string; section?: "rules" | "pending" } & PageInput)
  | ({ type: "savedApprovals"; sessionId: string } & PageInput)
  | ({ type: "runtime"; cwd: string } & PageInput)
  | ({ type: "skills"; cwd?: string } & PageInput)
  | ({ type: "providers"; cwd?: string } & PageInput)
  | { type: "usage" }
  | { type: "sessions"; cursor?: string; limit?: number; cwd?: string; searchTerm?: string }
  | { type: "session"; sessionId: string });

export async function resolveNativeQuery(client: Client, query: NativeQueryInput, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (query.type === "skill") {
    const skills = (await client.skill.list(query.cwd ? { location: { directory: query.cwd } } : undefined, { signal })).data;
    const skill = skills.find((entry) => entry.id === query.skillId);
    if (!skill) throw new Error("canonical skill absent from catalog");
    return { ...projectSkill(skill), ...textPage(skill.content, query.textOffset, query.textLimit, query.textFingerprint) };
  }
  if (query.type === "sessionDiff") {
    const session = await client.session.get({ sessionID: query.sessionId }, { signal });
    for (const id of [query.from, query.to]) if (id) await client.session.message.get({ sessionID: session.id, messageID: id }, { signal });
    const diff = await client.session.diff({ sessionID: session.id, from: query.from, to: query.to, context: integer(query.context, 3, 1000) }, { signal });
    const file = query.file ? diff.find((entry) => entry.file === query.file) : undefined;
    if (query.file && !file) throw new Error("file absent from native session diff");
    return { sessionId: session.id, from: query.from ?? null, to: query.to ?? null, ...(file ? { file: file.file, additions: file.additions, deletions: file.deletions, status: file.status, ...textPage(file.patch, query.textOffset, query.textLimit, query.textFingerprint) } : page(diff.map(({ patch, ...entry }) => ({ ...entry, patchSize: patch.length, patchFingerprint: fingerprint(patch) })), query)) };
  }
  if (query.type === "inbox") {
    await client.session.get({ sessionID: query.sessionId }, { signal });
    const inbox = await client.session.inbox.list({ sessionID: query.sessionId }, { signal });
    const selected = query.inboxId ? inbox.find((entry) => entry.id === query.inboxId) : undefined;
    if (query.inboxId && !selected) throw new Error("inbox entry not pending in targeted session");
    return selected ? { ...projectInbox(selected), ...textPage("text" in selected.payload ? selected.payload.text : "", query.textOffset, query.textLimit, query.textFingerprint) } : page(inbox.map(projectInbox), query);
  }
  if (query.type === "tools" || query.type === "tool") {
    const message = await client.session.message.get({ sessionID: query.sessionId, messageID: query.messageId }, { signal });
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
    const response = await client.model.list(query.cwd ? { location: { directory: query.cwd } } : undefined, { signal });
    const view = query.view ?? "compact";
    const data = response.data.map((model) => ({
      id: modelKey(model),
      enabled: model.enabled,
      cost: model.cost,
      modalities: model.capabilities.input,
      variants: model.variants.map((variant) => variant.id),
      ...(view === "compact" ? {} : {
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
    return { location: response.location, view, ...contextualPage(data, query, { location: response.location, view }) };
  }
  if (query.type === "agents") {
    const response = await client.agent.list(query.cwd ? { location: { directory: query.cwd } } : undefined, { signal });
    const location = response.location;
    const view = query.view ?? "compact";
    const includeHidden = query.includeHidden ?? false;
    const agents = response.data.filter((agent) => includeHidden || !agent.hidden);
    const data = agents.map((agent) => view === "full" ? projectAgent(agent) : compactAgent(agent));
    return {
      location, catalog: "effective", provenanceAvailable: false, view, includesBuiltins: true, includesHidden: includeHidden,
      hiddenCount: response.data.filter((agent) => agent.hidden).length,
      ...contextualPage(data, query, { location, view, includeHidden }),
    };
  }
  if (query.type === "skills") {
    const response = await client.skill.list(query.cwd ? { location: { directory: query.cwd } } : undefined, { signal });
    return { location: response.location, ...contextualPage(response.data.map(projectSkill), query, { location: response.location }) };
  }
  if (query.type === "providers") {
    const response = await client.provider.list(query.cwd ? { location: { directory: query.cwd } } : undefined, { signal });
    return { location: response.location, ...contextualPage(response.data.map((provider) => ({ id: provider.id, name: provider.name, activation: provider.activation })), query, { location: response.location }) };
  }
  if (query.type === "usage") {
    return client.session.stats(undefined, { signal });
  }
  if (query.type === "sessions") {
    const [response, active] = await Promise.all([
      client.session.list({ limit: integer(query.limit, 25, 50, 1), ...(query.cursor ? { cursor: query.cursor } : { order: "desc" as const }), directory: query.cwd, search: query.searchTerm }, { signal }),
      client.session.active({ signal }),
    ]);
    return { runtime: "opencode", sessions: response.data.map((session) => ({ ...projectSession(session, active), outcomeBasis: "unavailable" })), cursor: response.cursor };
  }
  if (query.type === "agent") {
    const response = await readAgent(client, query.agentId, query.cwd, signal);
    const agent = response.data;
    const field = query.field ?? "system";
    return { ...projectAgent(agent), location: response.location, field, ...(field === "permissions" ? { permissions: page(agent.permissions, query) } : textPage(agent[field] ?? "", query.textOffset, query.textLimit, query.textFingerprint)) };
  }
  if (query.type === "messages") {
    if (query.cursor && query.order) throw new Error("native message cursor cannot be combined with order");
    const response = await client.message.list({ sessionID: query.sessionId, limit: integer(query.limit, 25, 50, 1), ...(query.cursor ? { cursor: query.cursor } : { order: query.order ?? "desc" }) }, { signal });
    return { messages: response.data.map((message) => projectMessage(message, 0, MESSAGE_PREVIEW_LIMIT, undefined, query.sessionId, true)), cursor: response.cursor };
  }
  if (query.type === "message") {
    const message = await client.session.message.get({ sessionID: query.sessionId, messageID: query.messageId }, { signal });
    if (query.field) {
      if (message.type !== "compaction") throw new Error("field recovery requires a canonical compaction message");
      const full = query.field === "summary" && "summary" in message ? message.summary
        : query.field === "recent" && "recent" in message ? message.recent : null;
      if (full === null) throw new Error("compaction message has no such native text field");
      const paged = textPage(full, query.textOffset, query.textLimit, query.textFingerprint);
      return { id: message.id, type: message.type, createdAtMs: message.time.created, status: message.status, reason: message.reason, field: query.field, ...paged, nextCall: pageNextCall(queryToolName("message"), { sessionId: query.sessionId, messageId: message.id, field: query.field, ...(query.textLimit === undefined ? {} : { textLimit: query.textLimit }) }, paged) };
    }
    return projectMessage(message, query.textOffset, query.textLimit, query.textFingerprint, query.sessionId);
  }
  if (query.type === "permissions") {
    const session = await client.session.get({ sessionID: query.sessionId }, { signal });
    const requests = query.section === "pending" ? await client.permission.list({ sessionID: session.id }, { signal }) : [];
    return { sessionId: session.id, section: query.section ?? "rules", ...((query.section ?? "rules") === "rules" ? { rules: page(session.permissions ?? [], query) } : { pending: page(requests.map(projectPermission), query) }) };
  }
  if (query.type === "savedApprovals") {
    const session = await client.session.get({ sessionID: query.sessionId }, { signal });
    const saved = await client.permission.saved.list({ projectID: session.projectID }, { signal });
    return { projectId: session.projectID, ...page(saved, query) };
  }
  if (query.type === "runtime") {
    const location = { directory: query.cwd };
    const [runtime, plugins, mcp, commands] = await Promise.all([client.location.get({ location }, { signal }), client.plugin.list({ location }, { signal }), client.mcp.list({ location }, { signal }), client.command.list({ location }, { signal })]);
    const inventory = [
      ...plugins.data.map((plugin) => ({ type: "plugin", id: plugin.id ?? null, sourceType: plugin.source.type, features: plugin.features, status: plugin.state.status })),
      ...mcp.data.map((server) => ({ type: "mcp", name: server.name, status: server.status.status })),
      ...commands.data.map((command) => ({ type: "command", name: command.name })),
    ];
    return { runtime: "opencode", diagnostics: runtimeDiagnostics("opencode"), location: { directory: runtime.directory }, projectId: runtime.project.id, opencodeRelease: OPENCODE_RELEASE, ...page(inventory, query) };
  }
  if (query.type === "session") {
    const [session, active] = await Promise.all([
      client.session.get({ sessionID: query.sessionId }, { signal }),
      client.session.active({ signal }),
    ]);
    return projectSession(session, active);
  }
  // Adding a query to the public union must add a resolver, not silently fall
  // through to a session read with an absent identity.
  const unsupported: never = query;
  throw new Error("unsupported native query type");
}
