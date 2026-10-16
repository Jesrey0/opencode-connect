import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { ConnectorError } from "./bounds.js";

export const OPENCODE_RELEASE = "2.0.24";

export type Connection = { client: OpenCodeClient; baseUrl: string; info: Awaited<ReturnType<OpenCodeClient["server"]["info"]>> };
export type Connect = () => Promise<Connection>;

export async function bootstrapNative(): Promise<void> {
  await Service.ensure({ version: OPENCODE_RELEASE });
}

export async function connectNative(): Promise<Connection> {
  const endpoint = await Service.discover({ version: OPENCODE_RELEASE });
  if (!endpoint) throw new ConnectorError("native OpenCode service is unavailable; ordinary calls do not start, replace or recover the service");
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const info = await client.server.info();
  if (info.version !== OPENCODE_RELEASE) throw new Error(`OpenCode release mismatch: expected ${OPENCODE_RELEASE}, found ${info.version}`);
  return { client, info, baseUrl: endpoint.url };
}
