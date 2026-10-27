# Architecture and operator navigation

## Environment topology and native ownership

- **PlatformPlane** is the isolated ChatGPT app or web environment where the operator runs.
- **HostPlane** is OpenCode Connect's MCP integration and Linux execution environment.
- **WorkerPlane** consists of worker contexts hosted on HostPlane, with their respective OpenCode Runtime or Codex Runtime. Their native tools and policies are scoped to those runtime contexts.

```text
PlatformPlane: isolated ChatGPT / MCP client
  -> authenticated ingress
    -> HostPlane: OpenCode Connect MCP adapter / Linux
      -> native OpenCode location APIs (files, processes, Git, worktrees)
      -> OpenCode service -> WorkerPlane: OpenCode agent sessions
                          -> codex-sessions plugin -> WorkerPlane: Codex ACP sessions
      -> connector browser adapter -> Python / Nodriver / Chrome CDP
```

Planes describe environments and execution contexts, not tool-name prefixes or
independent OS security domains. OpenCode and Codex worker tools do not become
direct MCP operations merely because they are hosted on the same Linux account.
Native sandbox/approval modes and workspace controls define restrictions.

The integration projects native capabilities and permits bounded composition of
native calls. Native services retain authoritative execution, conversation and
turn evidence. Adapters explicitly own transport, observation, leases,
subscriptions, delivery and bounded supervision. Adapter-owned identities are
labeled; they never fabricate native runtime identities, supported permissions,
capabilities or successful outcomes. This architecture includes native OpenCode
API projection, Codex ACP/plugin supervision and a separate browser adapter.

For deterministic work, `command.run` composes native shell admission and bounded
observation without allocating an AI worker or a second process registry. A
worker's foreground shell is a separate agent interface. No public session-free
agent-tool invocation is assumed. Native start/read/control remain available.

### Runtime capability evidence

`opencode.runtime` describes the connector API in the requested runtime context.
Its diagnostics state the HostPlane interface, control dependency, session identity
and supported correlation/settings. OpenCode retains paged plugin/MCP/command
inventory. Codex retains native capability flags and adds loaded-plugin identity.
Neither inventory nor static API support is an effective model/agent-tool catalog,
a current execution-state observation, or an OS-sandbox attestation.

| Connector capability | OpenCode | Codex |
| --- | --- | --- |
| Native session identity | runtime + sessionId | runtime + native ACP sessionId |
| Wait correlation | Canonical user messageId | Current session turn; no exact-prompt correlation |
| Continuation | Native session | Native session; mode must be known or explicitly supplied after recovery |
| Model/agent selection, fork, prompt attachments | Supported by native routes | Unsupported by this bridge |
| Permission configuration | Native ordered rules and pending requests | Native mode and exact advertised approval options |
| Control path | OpenCode native API | OpenCode service -> codex-sessions plugin RPC -> ACP |
| Tool surface | Selected native agent/model context | Native Codex runtime; PlatformPlane MCPs are not forwarded by ACP admission |

The shared `opencode.*` facade selects a runtime; it does not assert capability
parity. Published schemas reject unsupported combinations. Preserve the runtime
with every saved session reference and the canonical prompt ID where supported.

Codex loaded identity is captured from the loaded package's manifest and its
package-relative release record. `nativeVersion` is the manifest's declared
OpenCode pin, not a fresh service probe. Source identity, unavailable metadata and
old plugins that do not report identity are explicit. A build-record identity
is provenance evidence, not a fresh integrity hash or security attestation.

## Repository topology (Node 24 and npm workspaces)
- Root package: opencode-connect, the MCP adapter, HostPlane and OpenCode session facade (src/).
- Workspace package: packages/codex-plugin, the native OpenCode V2 plugin, direct Codex ACP backend and read-only App Server quota reader. It is not another MCP server.
- Independent tests: test/ and packages/codex-plugin/test/.
- Docs, scripts, CI and the root package-lock.json are shared governance. The workspace owns its manifest but not an independent lock file.

There are two runtime components and one source/install lock. This repository is the sole source owner. PlatformPlane `$0xOperator` guidance is separately managed by ChatGPT, while runtime-specific operator knowledge lives in native OpenCode global skills under `~/.config/opencode/skills/` and is discovered at runtime; neither is mirrored into this repository. A legacy standalone plugin checkout, if one still exists, is superseded rather than a parallel source owner and may be retired only after independent acceptance and rollback verification.

## Module ownership
- src/http.ts owns the Node/Express application and Fetch MCP entry, with one request-body budget. src/mcp.ts owns the SDK tool-input complexity budget. The SDK creates a fresh MCP server per request; shared backends retain native supervision state without sharing protocol exchanges.
- src/fileLock.ts owns kernel-managed exclusive ownership for Events persistence and deployment mutations. Each owner holds a dedicated SQLite connection for its whole critical section and never unlinks the lock file.
- src/buildInfo.ts owns the strict release record and package-relative runtime identity. src/deployment.ts owns canonical source staging, installed integrity and release lifecycle validation; there is no cwd identity fallback or old-record adapter.
- src/opencode.ts is the public WorkerPlane facade: admission, wait/act orchestration, runtime routing and query envelopes.
- src/runtime/capabilities.ts describes connector API context and restrictions; it does not duplicate live native model/agent/tool catalogs.
- src/runtime/query.ts owns the native query union and exhaustive resolution, reading native catalogs directly.
- src/runtime/result.ts owns the inspection contract and bounded, fingerprint-pinned assistant selection. It imports only projections/bounds/continuations, never the facade.
- src/runtime/projection.ts owns pure native projections and outcome-evidence shapes. Callers import helpers from their owning modules; the facade does not re-export them.
- src/codex.ts validates the connector-facing RPC boundary; src/codexRpc.ts owns the importable connector declaration. It never executes plugin code or Codex turns directly.
- packages/codex-plugin/src/identity.js captures package-relative loaded implementation metadata; build-record evidence is distinct from release integrity verification.
- packages/codex-plugin/src/index.js registers the plugin; direct.js owns native sessions/RPC; codex.js owns the ACP backend; app-server.js owns the read-only App Server JSON-RPC transport; usage.js owns quota read authorization and projection; stdio.js owns shared child-process lifetime and bounded stderr handling. The two protocol transports depend on stdio.js, not on each other.
- Local plugin configuration names packages/codex-plugin/src, whose index.js is resolved by the pinned native directory loader. npm package exports also resolve to src/index.js; there is no package-root directory wrapper.

## Call path
External ChatGPT -> opencode-connect HTTP/MCP -> OpenCode 2.0.24 native client -> OpenCode private service.

The pinned native package declarations and OpenCode V2 [API](https://opencode.ai/v2/docs/api),
[client](https://opencode.ai/v2/docs/build/client), and
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc) contracts own this integration.
V1 server examples do not define V2 selection, message or plugin behavior.
For Codex: the connector calls the codex-sessions RPC, registered by the workspace plugin in the OpenCode service. Direct Codex uses ACP sessions. This control path depends on the OpenCode service; plugin disposal closes supervised Codex children. The plugin does not intercept OpenCode's native subagent tool. Quota reads call the installed Codex App Server with a short-lived read-only client.

For optional browser operations: the existing MCP handler shares one connector-owned
`src/browser/backend.ts` across requests. It supervises `src/browser/worker.py` over
private pipes. The worker uses pinned Nodriver connection/CDP APIs to an explicitly
selected Chrome target. `src/browser/schemas.ts` and `tools.ts` own validation and
projection. Linux Chrome is launched independently when explicitly requested and
survives worker/connector cleanup. Python source and lock are hashed release assets;
the explicit setup environment lives outside immutable builds. See
[browser capability](browser-capability.md) for configuration and ownership.

## Dependency rules
- The root package pins @opencode/client and the plugin pins @opencode/plugin to exactly the same 2.0.24 release; scripts/verify-integration.mjs enforces this.
- A root override makes the pinned plugin use the connector's patched Zod range, replacing its vulnerable exact dependency without changing the native OpenCode version.
- The connector must not import the plugin's implementation to run a Codex turn; RPC remains the sole runtime interface. The source verifier imports the real connector declaration using Node 24's native type stripping and the installed workspace's authoritative direct.js definition without running setup, checks installed/locked versions and exact method sets. test/codex.test.ts crosses the real native client/MCP boundary into injected plugin handlers, without a model turn. Plugin helper imports also go directly to their owners, not through index.js or direct.js aliases.
- The root package-lock.json owns both package dependency trees. Avoid reintroducing a nested lockfile.
- Hashing and copying share one inventory: root manifests/tsconfig, all regular files under src/ and scripts/, and the plugin manifest and src/. Tests/docs/node_modules/dist are not staged. Runtime assets cannot be shipped unhashed; symlinked source inputs fail explicitly. Plugin code changes require a new release ID.
- Every source/release must declare the complete plugin workspace; connector-only trees are rejected. Prepare checks snapshot identity before building and after pruning, seals source and generated/installed runtime inventories, and verifies pruned workspace import/RPC, native directory-entry and compiled identity contracts. Reuse, activation, rollback and runnable status repeat these checks; no static plugin file list substitutes for the actual import graph and inventory. Corrupt existing candidates are never implicitly replaced. This is build/install validation, not verification of the plugin loaded by the live service.
- Generated artifacts are not sources of truth. Changes to config and service are separate from test results.

## Local development
Install development dependencies with: npm ci --include=dev (even when NODE_ENV=production)
Check with: npm run check:all
Test with: npm run test:all
Build the connector with: npm run build
Verify plugin contract with: npm run verify:integration
Verify source release identity with: npm run verify:release (also in check:all)

To run plugin-only tests: npm test --workspace opencode-codex-subagent

Focused tests: node --import tsx --test test/runtime-modules.test.ts test/codex.test.ts test/deployment.test.ts; node --test packages/codex-plugin/test/codex-usage.test.js packages/codex-plugin/test/stdio.test.js. Existing catalog/message/result/wait suites continue to protect moved behavior. Tests inject services and spawn fixtures only; verify:integration does not contact a running OpenCode service.

Do not replace checkout node_modules or rebuild its dist beneath an active console. Use a temporary source validation copy when the checkout toolchain is pruned. Source tests, a staged installation, and live acceptance are distinct evidence.

## Deployment boundary and acceptance
Only an authorized operator may prepare/activate/rollback a release or change/reload OpenCode plugin configuration.

Connector deployment stages the workspace but manages only opencode-connect.service. It does not update global plugin configuration or reload the independent OpenCode service. /health proves connector identity/native connectivity, not loaded plugin identity or quota functionality. Switching current alone must not be treated as a plugin reload.

Inspect active OpenCode sessions, supervised Codex children and dependent consoles before a native plugin reload. Reload/disposal is a worker lifecycle event; do not infer independent availability from runtime-context separation.

For each coordinated deployment, record the old plugin configuration and connector build, validate the source gates, then separately authorize preparation, plugin loading and connector activation. Use the explicit immutable builds/<buildId>/packages/codex-plugin/src path to make the loaded version auditable. Preserve existing plugin options. Verify the native plugin inventory, RPC capabilities, direct-session behavior and read-only quota at their owning runtime after the authorized load.

Rollback automation swaps connector current/previous only. Restore the corresponding immutable plugin path/configuration and verify its native reload separately. Treat the recorded pre-cutover connector build and plugin path as the rollback pair for that deployment; no historical release is a permanent default baseline. A rollback candidate is valid only if it contains the complete workspace, a sealed release record and passes integrity/integration/identity checks. Unsealed historical records and connector-only releases are outside the supported release invariant; independently prepare and accept rollback candidates before cutover. See [release lifecycle](release-cutover.md) for the coordinated acceptance and recovery gates; re-inspect runtime identity before acting.

## Live console

The read-only terminal console shows both OpenCode and Codex native inventories,
with runtime-labeled rows and runtime-specific detail routing. On the dashboard,
`1`, `2`, and `3` select all, OpenCode, or Codex sessions; `/` incrementally
filters title, ID, cwd, model, agent, mode, or effort, with Backspace to edit,
Enter to finish, and Esc to clear. `a` restricts the list to verified running
sessions, `?` opens local help, and the footer shows context-sensitive commands.
`t` opens an inspect-only attention list of observed `pending` requests; arrows,
page keys, or j/k navigate, Enter opens the associated session, and Esc returns.
It never approves or answers requests. Counts are observed requests, not a global
queue: OpenCode pending reads cover observed active sessions on a best-effort
basis, and Codex pending reads cover supervised sessions only. Failed reads and
stale snapshots can leave the list incomplete.
Counts describe the observed inventory, not all historical sessions. OpenCode
usage totals and Codex quota are separate measurements. Codex combines one
native history page with supervised workers, including workers absent from that
page. Native ACP history alone has no turn outcome; the bounded, read-only Codex
App Server lookup correlates `thread/read` metadata with the newest native turn.
Historical `completed`, `failed`, and `interrupted` states appear only when
verified by native turn history. Correlated `thread/read` may also provide the
persisted thread model, provider, and reasoning effort even when no terminal turn
is available; those settings do not make execution known. Missing metadata stays
unavailable. Session mode is shown only when this adapter locally supervised and
applied it; recovered historical modes are never inferred. Unavailable,
in-progress, or mismatched execution history remains `unverified`. ACP still
owns execution, and no history read starts or resumes a turn.
Unsupported or
disconnected Codex RPC leaves OpenCode visible and marks partial visibility;
history and supervised-status failures are independent. Codex supervised status uses the five-second fallback cadence, while
expensive native Codex history discovery is cached for five minutes (including
failed reads). Dashboard `r` explicitly refreshes history and quota. Native Codex history reads have a twelve-second deadline to accommodate
ACP startup, while supervised status keeps a three-second deadline. The plugin
releases metadata-read ownership on cancellation. Codex detail shows the latest 25 bounded native
message previews (up to 512 characters each), replaces each history snapshot,
and never advertises live deltas. The inspector separates verified/unknown session
execution evidence from replay, native history completeness from the console page
limit, and native output truncation from preview truncation. Failed reads retain
and mark prior replay stale, including an empty replay. No quota reads or
session mutations are performed by this inventory view.

The console also resolves active OpenCode sessions missing from the bounded
recent page. Pending permissions show only a generic request label; native
resource strings and tool-call titles are not displayed.

For OpenCode, the console streams assistant text while a selected session is
followed. Tool-only steps show tool names and status, excluding their inputs,
outputs. Reasoning parts show a dim **activity-only** marker: `active` from native
start/delta events or an incomplete part's timing, `ended` from native end events
or completed part timing, and `observed` when persisted parts lack active/end
evidence. These markers are not reasoning summaries or worker-completion claims.
All reasoning text (live and persisted), provider state and request objects stay
excluded. The pinned native surface does not provide a separate guaranteed-safe
reasoning summary field.
Native page order is authoritative for identities read together, correcting even
previously retained provisional order. Text and reasoning overlays share
first-activity anchors only for missing/in-flight identities and a cache of at
most 128 assistant IDs, with at most 64 reasoning identities per assistant;
persisted activity retains the first 64 reasoning parts per message so appending
parts cannot displace earlier end evidence. Persisted end timing wins
over in-flight deltas. Unflushed messages and ended reasoning identities are never
evicted to admit new overlays. Completed readback frees payload overlays, but
payload-free ordering anchors remain while earlier identities are missing.
Anchors are bounded to 128 IDs and released only when earlier identities have
native readback. At capacity, new identities are skipped until slots can safely
be released or the view is reopened; persisted reads remain available.
Opening an OpenCode view reads back to its latest operator
prompt within 500 native messages; subsequent refreshes read one recent page and
update loaded history by canonical message ID. Refreshes do not discard earlier
loaded operator messages or unflushed streamed text. Home/PgUp scroll back;
End/G resumes following. Reopen an existing console process after source updates
to load the new observer.

## Service and persistence ownership

`npm run dev` starts the local source server at `127.0.0.1:8788/mcp` by default.
`HOST` and `PORT` come from the process environment; there is no global dotenv
loader. Native service lifecycle admission occurs only at connector startup.
Ordinary calls discover the native service and fail when unavailable; they never
start, replace or recover it. The raw OpenCode API stays private.

Events persist JSON state at
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode-connect/events/store.json`.
A dedicated SQLite connection holds an exclusive kernel-managed transaction on
sibling `store.lock.sqlite` for the store's lifetime. Close, process crash and
reboot release ownership; startup failure releases it too. Keep this on a local
filesystem with SQLite locking. Never delete or replace the lock file while a
connector runs. A second owner fails closed; lock I/O/corruption is not a stale
lock. Deployment activation stops/restarts the managed connector service.

Optional browser dependencies and profiles live outside immutable release trees.
Browser cleanup, connector restart and native plugin reload have separate owners;
see the [browser lifecycle](browser-capability.md#ownership-privacy-and-lifecycle).
