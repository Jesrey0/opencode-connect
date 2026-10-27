// This evidence describes a successful runtime read, not a selected worker's
// effective tools, permissions, activity, or OS isolation. Keep API capability
// flags and native inventories at their existing owners.
export function runtimeDiagnostics(runtime: "opencode" | "codex") {
  return {
    capabilityScope: "connector-api" as const,
    context: { plane: "WorkerPlane" as const, runtime, platformContext: "separate" as const, hostContext: "hosted" as const, session: "not-selected" as const },
    hostInterface: { plane: "HostPlane" as const, transport: "MCP" as const, owner: "opencode-connect" as const },
    control: {
      service: "opencode" as const,
      interface: runtime === "codex" ? "plugin-rpc" as const : "native-api" as const,
      rpc: runtime === "codex" ? "codex-sessions" as const : null,
      evidence: runtime === "codex" ? "plugin-status" as const : "native-location-and-inventory" as const,
    },
    api: {
      sessionIdentity: ["runtime", "sessionId"],
      promptCorrelation: runtime === "opencode" ? "canonical-user-message" as const : "current-turn-only" as const,
      continuation: true,
      fork: runtime === "opencode",
      modelSelection: runtime === "opencode",
      agentSelection: runtime === "opencode",
      promptAttachments: runtime === "opencode",
      permissionRules: runtime === "opencode",
      nativeModes: runtime === "codex",
      nativeSessionEvents: runtime === "opencode",
    },
    effectiveTools: { status: "unavailable" as const, reason: "runtime-read-is-not-model-agent-scoped" as const },
    execution: { activity: "not-observed" as const, osSandbox: "not-observed" as const },
  };
}

export type RuntimeDiagnostics = ReturnType<typeof runtimeDiagnostics>;
