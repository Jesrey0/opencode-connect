/**
 * Fail-closed authorization for the external `codex` subagent.
 *
 * A package plugin cannot drive OpenCode's interactive permission prompt, so
 * this module deliberately never returns "allowed" for anything other than an
 * explicit `allow` rule. `ask` and `deny` both fail closed.
 *
 * It evaluates the agent's configured permission rules directly. Saved
 * interactive approvals and permission-evaluation hooks are OpenCode-internal
 * and are not reachable from a package plugin, so an authorization decision can
 * only come from static rules on the parent agent.
 */

/** Matches a value against an OpenCode permission glob pattern. */
export function wildcardMatch(input, pattern) {
  if (typeof input !== "string" || typeof pattern !== "string") return false
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * Resolves the effective `subagent` effect for an agent name.
 * Last matching rule wins. Anything unresolved is `ask`, which fails closed.
 */
export function resolveSubagentEffect(rules, agent) {
  if (!Array.isArray(rules)) return "ask"
  const matched = rules.filter(
    (rule) => wildcardMatch("subagent", rule?.action) && wildcardMatch(agent, rule?.resource),
  )
  return matched.at(-1)?.effect ?? "ask"
}

/**
 * Decides whether the parent agent may launch the external codex backend.
 *
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function authorizeCodexSubagent({ permissions, parentAgent, codexAgent = "codex" }) {
  const effect = resolveSubagentEffect(permissions, codexAgent)
  if (effect === "allow") return { allowed: true }

  const who = parentAgent ? `Parent agent "${parentAgent}"` : "The calling agent"
  if (effect === "deny")
    return {
      allowed: false,
      reason:
        `${who} is not allowed to launch the external "${codexAgent}" subagent: ` +
        `its subagent permission for "${codexAgent}" resolves to "deny".`,
    }

  return {
    allowed: false,
    reason:
      `${who} is not allowed to launch the external "${codexAgent}" subagent: ` +
      `its subagent permission for "${codexAgent}" resolves to "ask", and a plugin cannot ` +
      `prompt for it. Add an explicit rule to the parent agent, for example ` +
      `{ "action": "subagent", "resource": "${codexAgent}", "effect": "allow" }.`,
  }
}