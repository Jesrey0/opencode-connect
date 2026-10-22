# Architecture and clean-refactor audit

Audit date: 2026-10-22. Source baseline: `3796624`, isolated branch
`refactor/astra-clean-20261022`. Source, deterministic tests, installed contracts,
and live observations are separate evidence below.
Bounded progress updated 2026-10-23 from `6e3786b`; this is not a repeated
repository-wide audit. Main, live services and global configuration are untouched.

## Authoritative contracts

- Baseline Node `24.16.0` (this slice: `24.22.1`); installed/locked OpenCode client and plugin `2.0.24`.
  `npm run check:all` passes at baseline, including native directory loading and
  the 11-method connector/plugin RPC contract.
- Baseline read-only native discovery, server info, location and plugin inventory confirmed
  an existing `2.0.24` service and active `codex-subagent` plugin. No service was
  started/reloaded, no prompt admitted, and no global configuration changed.
- The supplied `docs.opencode.ai/docs/server/` URL serves V1 documentation.
  V2 [API](https://opencode.ai/v2/docs/api),
  [client](https://opencode.ai/v2/docs/build/client) and
  [RPC](https://opencode.ai/v2/docs/build/plugins/rpc) documentation, plus installed
  `@opencode/client/dist/promise/{client.d.ts,service.js}`, govern this adapter.
  `message.list` and `session.message.get` really are different current client
  namespaces. Service discovery does not start a process; `Service.ensure` can
  replace one and belongs only to explicit startup admission.
- Current stable [MCP specification](https://modelcontextprotocol.io/specification/)
  is `2026-07-28`, with per-request metadata and `server/discover`.
  [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
  explicitly requires this revision and the top-level `events` capability.
  These are current interoperability, not migration scaffolding.
- [OpenAI tool guidance](https://developers.openai.com/plugins/build/mcp-server)
  and [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
  govern descriptions, explicit schemas/annotations, authorization and useful
  results. Initialization-era examples do not override the stable wire contract.
  Event-triggered tasks currently require a supported Work/Cloud chat or dot;
  General Chat wake-up must not be inferred from webhook acknowledgement.
- MCP `inputRequired:{legacyShim:false}` and HTTP `legacy:"reject"` are current
  stable negotiation/rejection settings. They do not enable a compatibility route
  and must remain; the obsolete Windows HTTP browser path was unrelated.

## Ownership and consumer inventory

| Boundary | Consumers and evidence | Assessment |
| --- | --- | --- |
| HTTP/MCP | `server.ts` -> `http.ts` -> per-request `createServer`; `test/protocol.test.ts` exercises the real Node/Express boundary | Current MCP only, SDK-owned wire validation, explicit complexity/body budgets. Per-request server factory retained. |
| Authentication | Loopback Host/Origin middleware; external host-ingress owns OAuth; Events and browser leases validate forwarded grant context | No second OAuth implementation or invented scopes. Public challenge/expiry/revocation remain operator acceptance. |
| Tools/schema | Twelve core tool families in `mcp.ts`; individual browser actions in `browser/tools.ts`; `schema.ts` publishes strict unions with model-visible properties | No dynamic executor or V1 routes found. Core families still group operations; Directory review and operator ergonomics need a dedicated catalog redesign, not aliases. |
| Results/errors | `bounds.ts`, `results.ts`, runtime projections; browser has dispatch-aware errors and standard text diagnostics | Redaction, image separation, uncertainty, and both browser error representations are required behavior. Browser text errors have actual client-rendering consumers; do not delete as a guessed shim. |
| Worker lifecycle | `opencode.ts` consumed by MCP, console and Events; native creation/selection/permissions/readback; `runtime/result.ts` selects exact prompt segments | Keep canonical identities, fresh/resume/fork semantics, deletion fail-closed checks and fingerprint-pinned result scans. Native wait alone does not implement exact-prompt/action-required recovery. |
| Cancellation | `opencode.ts` -> `runtime/query.ts` and `codex.ts`; `test/query-cancellation.test.ts` crosses native reads/RPC | Read cancellation now propagates through native query follow-up reads and Codex runtime/session/permission reads; pre-cancelled and later batch work never dispatch. Mutation cancellation remains separate uncertainty work, not a read fallback. |
| Paging | `bounds.ts`, `catalog.ts`, `continuation.ts`; console and returned model `nextCall` objects | Native cursors and fingerprint pages serve different native contracts, not duplicate implementations. Do not merge them by inventing offsets. |
| Host/terminal | `host.ts` -> current file/VCS/worktree/shell/PTY APIs; `terminal.ts` owns bounded socket replay | Ordinary/persistent PTYs have different retention and cursor units. Containment and mutation readback remain; preflight file writes are not atomic CAS. |
| Events | `events.ts`, diagnostics, reconciliation, `server.ts` native observer; persisted JSON plus kernel lock | Callback DNS pinning, grant revalidation, HMAC, retries, exact IDs and bounded diagnostics are current requirements. Reconciliation timers repair missed live-only events, not legacy fallbacks. |
| Browser | MCP -> shared `BrowserBackend` -> private Python/Nodriver worker; Linux HTTP discovery/launch/close and Windows permission WebSocket | Verified Windows HTTP bypass removed: configuration rejects before discovery/consent; Windows tabs/attach require the caller's approved socket. Direct Linux launch and independent systemd ownership serve distinct lifecycles and remain. |
| Codex | Connector -> native RPC -> plugin `direct.js` -> ACP; read-only App Server readers for quota/history | No CLI model-turn delegation. Connector RPC declaration duplicates a method inventory, but importing the Effect-schema implementation into the Promise client is not a valid substitution. A schema-only shared contract needs separate design. |
| Quota | `usage.js` accepts native `rateLimitsByLimitId` and `rateLimits` | Comment calls the single bucket backward-compatible; deletion requires evidence from the current installed Codex protocol, not the comment alone. Not yet established obsolete. |
| Deployment | `deploy.ts` -> prepare/activate/rollback in `deployment.ts`; Events persistence | Both now use `fileLock.ts`. The audited PID-file mechanism could unlink a live lock between file creation and metadata write; its probing/reclamation path is removed. |
| Release validation | Shared hash/copy inventory; strict package-relative build record; sealed source and installed runtime inventories | Complete workspace/import graph, pruned integration/loader and compiled identity are verified on prepare/reuse/activation/rollback/runnable status. Static plugin file lists and old-record/cwd identity fallbacks removed in `6e3786b`. |
| Documentation/tests | Touched release/browser contracts describe the final design; dated acceptance docs retain evidence | Obsolete Windows HTTP success fixtures deleted, not aliased. Negative legacy-input tests and historical acceptance are independent evidence, not compatibility support or new live acceptance. |

## Completed bounded slices

1. **MCP validation boundary (`72517fa`).** Baseline `npm audit --json` reported affected
   direct SDK dependencies. [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453)
   requires both a patched server and explicit `maxToolInputElements`; upgrading
   alone does not enable protection. Raw HTTP bodies are bounded at their actual parser.
   [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp)
   does not affect the existing fresh-server factory, which must stay intact.
   Bearer-audience verification is owned by ingress, not the unused SDK OAuth
   middleware. Affected pins were updated without changing OpenCode or MCP revision.
2. **Exclusive ownership (`795f321`).** Deployment's PID-file lock was replaced
   with the existing SQLite exclusive-lock primitive, named for ownership rather
   than one consumer. One implementation serves both consumers. Tests cover
   concurrent deployments, lock I/O failure, normal release, process crash, and
   successor ownership. No old lock format reader, conversion, retry, or cleanup
   route remains.

3. **Release integrity and identity (`6e3786b`).** One mandatory workspace and
   strict sealed record cover source, generated output and installed dependencies.
   All runnable candidates repeat installed integration and compiled identity
   verification. Corrupt candidates are refused, never silently replaced or
   interpreted through an old record format.
4. **Read cancellation (`6e3786b`).** Carry the caller signal through native query
   reads and Codex read branches; abort the batch without interrupting sessions,
   replying to permissions or performing other mutations.
5. **Windows permission boundary (this slice).** Windows HTTP discovery and
   attachment were deleted. Only explicitly configured browser WebSockets or bounded
   `DevToolsActivePort` metadata lead to `browser.connect`; discovery, attachment
   and lease guards reuse that caller's approved socket. Linux retains HTTP.

These are completed slices, not a claim that the repository-wide refactor is
complete. Remaining work is bounded below.

## Environment and verification record

- `npm ci --include=dev`: completed. Baseline transitive `node-domexception` and
  `glob` deprecation warnings remain distinct from SDK advisories.
- Workspace `just --list` could not run because `just` is absent from the
  configured PATH. Inspected the root justfile: its check/test recipes target
  other checkouts, so repository gates run directly in this isolated worktree.
- Final focused checks, required gates and operator acceptance are recorded after
  implementation; no deployed-build or ChatGPT behavior is established by them.
- This slice reused the installed pinned browser environment; no setup or global
  configuration mutation was needed. `npm ci --include=dev` completed with the
  existing transitive deprecation and install-script approval notices. Its summary
  reported one moderate advisory; a separate immediate `npm audit --json` returned
  zero vulnerabilities. No dependency pins were changed in this slice.

### MCP boundary results

- Updated affected exact pins to server `2.3.1` and Express adapter `2.0.2`.
  `npm audit --json` reports zero vulnerabilities after installation.
- SDK validation now caps arguments at 4,096 elements. Node/Express and Fetch
  entries share a 4 MiB body limit. This explicit limit preserves large Unicode
  workflows while fixing Express's implicit 100 KiB rejection of supported input.
  The actual application factory is shared by production and HTTP tests; parser
  errors are sanitized at that boundary.
- Regression checks failed before configuration: over-budget nested input reached
  native execution, and a 128 KiB form answer hit an HTML parser error. Both pass
  after the change. Tests distinguish 4,096 from 4,097 elements, exact byte limit
  from one byte over, malformed bodies, and overlapping equal JSON-RPC IDs.
- **PASS:** `node --import tsx --test test/protocol.test.ts test/mcp.test.ts`
  (24 tests), `npm run check`. Existing cancellation, legacy rejection, Host/Origin,
  schema validation and near-1-MiB image checks pass on the updated SDK.

### Exclusive ownership results

- `fileLock.ts` is the sole ownership implementation. Deployment holds
  `deploy.lock.sqlite`; Events retains `store.lock.sqlite`. No PID probes,
  stale-lock reclamation, lock-file deletion, old-format readers or aliases.
- **PASS:** deployment and file-lock tests exercise simultaneous prepare/activate/
  rollback contenders, failed-build release, cross-process SIGKILL recovery with
  unchanged inode, corruption fail-closed, and repeated close versus a successor.
  All service actions in these tests are injected; no deployment occurred.

### Release integrity and cancellation results

- The previous slice's source changes are in `6e3786b`. Build/runtime identity
  shares one strict `build.json` parser; neither missing immutable metadata nor a
  caller's cwd can supply a source-mode or alternate-release identity.
- Deployment tests cover missing plugin imports, connector-only trees, source and
  runtime tampering, symlinks, mutable build tooling, compiled identity mismatch,
  reuse and corrupt referenced candidates. Their service actions are injected.
  No successful fixture activation establishes a deployed service or loaded
  native plugin.
- Cancellation regressions cover native catalogs, multi-read session diff,
  runtime reads and Codex runtime/session/pending permissions. They verify the
  in-flight request aborts, the original reason survives, no later query is sent,
  and no interrupt/prompt/permission mutation occurs. Pre-cancelled reads never
  connect. These checks remain in the required suite for this slice.

### Windows permission-boundary findings and results

- The bypass was real: `endpoint()` accepted Windows HTTP, and status, targets,
  attach and lease guards selected the HTTP path by scheme or missing approval.
  A success fixture explicitly asserted attachment without an approval handle.
- HTTP discovery is now named and scoped to Linux. Windows routing is selected by
  browser, never by a permissive scheme branch or approval absence. Removed the
  Windows HTTP 404 recovery hint, unreachable `approval_unavailable` path, old
  HTTP fixtures and redundant lease connection identity. No aliases, format
  adapters or fallback routes replace them.
- MCP schemas publish Windows-only required `connectionId` variants for tabs and
  attach; the private Python protocol enforces the same constraint. Linux uses no
  connection handle. Passive Windows status needs no approval and cannot open a
  consent socket. Approved sockets, exact targets, caller/token checks and
  transport-only detach retain their existing ownership semantics.
- All Windows endpoint configuration is owned by the worker. The deployment unit
  declares no browser endpoints; immutable staging already includes and hashes
  the worker source. No deployment/config migration is needed to enforce rejection
  in a future authorized release. Existing Windows HTTP configuration will fail
  closed, not be rewritten. No live configuration was inspected or changed.
- **Regression reproduced before fix:** Windows HTTP status sent two
  `/json/version` requests; schema and private protocol accepted Windows selection
  without an approved handle. The new negative tests rejected these behaviors.
- The opt-in Chrome run also exposed a stale 26-tool expectation that omitted
  the existing `browser.close`, and a no-process status fixture contaminated by
  parallel Chrome processes. Tests now assert the 27-tool catalog including close,
  isolate that fixture's process evidence, and restore the handler-owned backend
  in cleanup to avoid cascading lifecycle failures. Production behavior and valid
  assertions were preserved.
- **Required source gates PASS (2026-10-23):** `npm run check:all && npm run test:all && npm run build && npm run verify:integration` exited 0; 398/401 core tests passed (3 skipped) and 145/145 Codex plugin tests passed. No service deployment occurred.
- **Opt-in real-Chrome acceptance FAIL (2026-10-23):** `OPENCODE_CONNECT_BROWSER_TEST=1 npm run test:browser` exited 1: 85/91 passed, 6 failed, none skipped. Failures included scoped rename target lookup, focus/multipart entry, redacted navigation, iframe-navigation check, shared ingress lease verification and the enclosing browser acceptance parent. Some later lease errors cascaded from an earlier active lease, but the first failures are not explained. An isolated copy of the starting-HEAD browser file passed once; that comparison does not prove these failures environmental or establish the new source as live-safe.
- **Acceptance disposition:** The new fail-closed Windows permission contract has passing unit/integration regressions, but the browser source change is **NOT accepted for production deployment** while real-Chrome E2E remains red. The branch is a source checkpoint, not a completed overhaul. Investigate the first E2E failure and repeat the opt-in gate before release.

## Bounded uncompleted follow-ups

- Mutation cancellation/uncertainty and non-atomic host file-write preflight need
  separate task-shaped work; read cancellation does not prove mutation safety.
- Core tool-family ergonomics/Directory review and a potential schema-only Codex
  RPC inventory require dedicated design, not overlapping executors or aliases.
- Quota's single native `rateLimits` bucket has not been established obsolete by
  the installed protocol; it was not removed based only on a compatibility
  comment. This slice added no API research or quota changes.
- Public ingress OAuth expiry/revocation, General Chat behavior, current Windows
  Chrome consent, installed release activation and native plugin loading remain
  separate operator-owned acceptance. Live services/main were out of scope.
