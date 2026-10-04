import type { AgentInfo, PermissionRule } from "@opencode/client";
import { checkFingerprint, fingerprint, page, textPage, type PageInput } from "./bounds.js";

export type PermissionContext =
  | { type: "agent"; agentId: string; location: { directory: string } }
  | { type: "session"; agentId: string; sessionId: string; location: { directory: string } };

// This is a lossless compaction of ordered rules, not a permission evaluator.
// Only a later universal rule or an identical matcher proves a rule redundant.
// Leave overlapping wildcards in their native order for runtime evaluation.
export function permissionSummary(rules: PermissionRule[], context: PermissionContext, input: PageInput = {}) {
  let baseline = -1;
  for (let index = 0; index < rules.length; index += 1) {
    if (rules[index].action === "*" && rules[index].resource === "*") baseline = index;
  }
  const seen = new Set<string>();
  const exceptions: (PermissionRule & { ruleIndex: number })[] = [];
  for (let index = rules.length - 1; index > baseline; index -= 1) {
    const rule = rules[index];
    const key = JSON.stringify([rule.action, rule.resource]);
    if (seen.has(key)) continue;
    seen.add(key);
    exceptions.unshift({ action: rule.action, resource: rule.resource, effect: rule.effect, ruleIndex: index });
  }
  // Include all source rules and context in continuation identity, even when a
  // source edit leaves the compact exceptions unchanged.
  const sourceFingerprint = fingerprint({ context, rules });
  const selected = contextualPage(exceptions, input, sourceFingerprint);
  return {
    context,
    basis: "orderedPermissionRules" as const,
    precedence: "lastMatchingRule" as const,
    defaultEffect: baseline < 0 ? "ask" as const : rules[baseline].effect,
    defaultRuleIndex: baseline < 0 ? null : baseline,
    sourceRuleCount: rules.length,
    shadowedRuleCount: rules.length - exceptions.length - (baseline < 0 ? 0 : 1),
    sourceFingerprint,
    exceptions: selected,
    excludedLayers: context.type === "agent"
      ? ["sessionRules", "savedApprovals", "policies"]
      : ["savedApprovals", "policies"],
    executionAuthority: "nativeRuntime" as const,
  };
}

export function contextualPage<T>(data: T[], input: PageInput, context: unknown) {
  const hash = fingerprint({ context, data });
  checkFingerprint(hash, input.fingerprint, input.offset ?? 0);
  return { ...page(data, { ...input, fingerprint: fingerprint(data) }), fingerprint: hash };
}

export function compactAgent(agent: AgentInfo, summary?: ReturnType<typeof permissionSummary>) {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    description: textPage(agent.description ?? "", 0, 512),
    model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : null,
    ...(summary ? { permissionSummary: summary } : {}),
  };
}
