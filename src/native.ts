import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { ConnectorError } from "./bounds.js";

export const OPENCODE_RELEASE = "2.0.24";
const CATALOG_ATTEMPTS = 40;
const CATALOG_SETTLE_MS = 200;

export type Connection = { client: OpenCodeClient; baseUrl: string; info: Awaited<ReturnType<OpenCodeClient["server"]["info"]>> };
export type Connect = () => Promise<Connection>;

let initializedPid: number | undefined;
let initializing: { pid: number; promise: Promise<void> } | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForNativeCatalogs(
  client: OpenCodeClient,
  attempts = CATALOG_ATTEMPTS,
  settleMs = CATALOG_SETTLE_MS,
): Promise<void> {
  let previous: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [models, agents, providers] = await Promise.all([
      client.model.list(),
      client.agent.list(),
      client.provider.list(),
    ]);
    const modelIds = models.data.filter((model) => model.enabled).map((model) => model.providerID + "/" + model.id).sort();
    const agentIds = agents.data.map((agent) => agent.id).sort();
    const providerIds = providers.data.map((provider) => provider.id).sort();
    const snapshot = JSON.stringify({ modelIds, agentIds, providerIds });
    if (modelIds.length > 0 && agentIds.length > 0 && providerIds.length > 0 && snapshot === previous) return;
    previous = snapshot;
    if (attempt + 1 < attempts) await sleep(settleMs);
  }
  throw new Error("OpenCode native catalogs did not initialize");
}

async function ensureNativeCatalogs(client: OpenCodeClient, pid: number): Promise<void> {
  if (initializedPid === pid) return;
  if (!initializing || initializing.pid !== pid) {
    const promise = waitForNativeCatalogs(client).then(() => {
      initializedPid = pid;
    });
    initializing = { pid, promise };
  }
  const current = initializing;
  try {
    await current.promise;
  } finally {
    if (initializing === current) initializing = undefined;
  }
}

export async function bootstrapNative(): Promise<void> {
  await Service.ensure({ version: OPENCODE_RELEASE });
}

export async function connectNative(): Promise<Connection> {
  const endpoint = await Service.discover({ version: OPENCODE_RELEASE });
  if (!endpoint) throw new ConnectorError("native OpenCode service is unavailable; ordinary calls do not start, replace or recover the service");
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const info = await client.server.info();
  if (info.version !== OPENCODE_RELEASE) throw new Error(`OpenCode release mismatch: expected ${OPENCODE_RELEASE}, found ${info.version}`);
  await ensureNativeCatalogs(client, info.pid);
  return { client, info, baseUrl: endpoint.url };
}
