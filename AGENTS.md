# Agent repository guide

## Mission and ownership
ChatGPT 0xOperator owns the orchestration of native HostPlane and WorkerPlane work. The principal owns scope and acceptance. OpenCode Connect is a Node 24 MCP connector. The Codex plugin is a native OpenCode extension inside the SAME repository; it is not an independent MCP server.

## Entry points
- src/server.ts, src/http.ts, src/mcp.ts: the external MCP/HTTP boundary.
- src/opencode.ts: public worker facade, admission and lifecycle orchestration.
- src/runtime/{query,result,projection}.ts: native query/inspect contracts, selection and pure projections; never import the facade from these modules.
- src/codex.ts and src/codexRpc.ts: connector-facing Codex adapter and importable RPC declaration; no direct CLI model turns.
- packages/codex-plugin/src/index.js: native plugin registration for direct Codex RPC.
- packages/codex-plugin/src/direct.js: Codex session RPC, modes and permissions.
- packages/codex-plugin/src/usage.js: read-only Codex quota App Server client.
- packages/codex-plugin/src/stdio.js: shared owned-child lifetime/stderr; protocol logic stays with ACP/quota.
- src/host.ts, src/terminal.ts: host inspection and shell/PTY support.
- src/events*.ts: event subscription, diagnostics and reconciliation.
- src/deployment.ts and src/deploy.ts: immutable release and rollback.
- src/console*.ts: local development console, not the MCP control plane.
- test/ and packages/codex-plugin/test/: independent and integration contracts.

## Contracts
OpenCode is authoritative for its own native session, agent, model and subagent behavior. Codex conversations retain native IDs; the plugin owns direct Codex ACP processes and mode selection, the connector owns MCP translation. Never substitute a Codex CLI model turn for connector RPC, or treat OpenCode token totals as ChatGPT Codex quota. Plugin and connector must agree on the codex-sessions method set and pinned OpenCode version.

## Working on this repository
Run npm ci --include=dev from the repository root. Run npm run check:all, npm run test:all and npm run build before a release. Run npm run verify:integration for the source/install RPC/version/loader check (no live service access). Do not edit generated dist/, node_modules/, or immutable release builds. If a console is active, use an isolated source copy rather than replace its toolchain/artifacts. Preserve installed configuration; connector activation does not migrate or reload the native plugin. Live MCP deployment, plugin loading and Git publication are distinct decisions. Every supported release contains the plugin workspace; native local loading uses its src/ directory. Any retained standalone plugin checkout is superseded, not a parallel source owner; retirement requires separate operator acceptance and authorization.

## Navigation
Read docs/architecture.md for dependency and deployment boundaries. Long operator protocol detail remains in README.md. Avoid creating a new cross-package utility layer for one call site; keep native implementation at the owning layer. Keep refactors behavioral and preserve bound/pagination/permission contracts.
