import type { AgentInfo } from "@opencode/client";
import { checkFingerprint, fingerprint, page, textPage, type PageInput } from "./bounds.js";

export function contextualPage<T>(data: T[], input: PageInput, context: unknown) {
  const hash = fingerprint({ context, data });
  checkFingerprint(hash, input.fingerprint, input.offset ?? 0);
  return { ...page(data, { ...input, fingerprint: fingerprint(data) }), fingerprint: hash };
}

export function compactAgent(agent: AgentInfo) {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    description: textPage(agent.description ?? "", 0, 512),
    model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : null,
  };
}
