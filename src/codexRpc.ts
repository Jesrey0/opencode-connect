import * as z from "zod/v4";

// Connector-facing native RPC declaration, separate from response projection so
// the source/install verifier can import the real contract before a TS build.
export const CodexSessionsDefinition = {
  id: "codex-sessions",
  methods: Object.fromEntries([
    "start", "inspect", "wait", "interrupt", "delete", "messages",
    "list", "status", "permissions", "respondPermission", "usage",
  ].map(method => [method, { input: z.unknown(), output: z.unknown() }])),
  events: {},
};
