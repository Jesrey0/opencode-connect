# Architecture and clean-refactor audit

Audit date: 2026-10-22. Source baseline: `3796624`, isolated branch
`refactor/astra-clean-20261022`. Source, deterministic tests, installed contracts,
and live observations are separate evidence below.

## Authoritative contracts

- Node `24.16.0`; installed/locked OpenCode client and plugin `2.0.24`.
  `npm run check:all` passes at baseline, including native directory loading and
  the 11-method connector/plugin RPC contract.
- Read-only native discovery, server info, location and plugin inventory confirm
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

## Ownership and consumer inventory

| Boundary | Consumers and evidence | Assessment |
| --- | --- | --- |
| HTTP/MCP | `server.ts` -> `http.ts` -> per-request `createServer`; `test/protocol.test.ts` exercises the real Node/Express boundary | Current MCP only, SDK-owned wire validation. Keep per-request server factory. Harden SDK validation budget. |
| Authentication | Loopback Host/Origin middleware; external host-ingress owns OAuth; Events and browser leases validate forwarded grant context | No second OAuth implementation or invented scopes. Public challenge/expiry/revocation remain operator acceptance. |
| Tools/schema | Twelve core tool families in `mcp.ts`; individual browser actions in `browser/tools.ts`; `schema.ts` publishes strict unions with model-visible properties | No dynamic executor or V1 routes found. Core families still group operations; Directory review and operator ergonomics need a dedicated catalog redesign, not aliases. |
| Results/errors | `bounds.ts`, `results.ts`, runtime projections; browser has dispatch-aware errors and standard text diagnostics | Redaction, image separation, uncertainty, and both browser error representations are required behavior. Browser text errors have actual client-rendering consumers; do not delete as a guessed shim. |
| Worker lifecycle | `opencode.ts` consumed by MCP, console and Events; native creation/selection/permissions/readback; `runtime/result.ts` selects exact prompt segments | Keep canonical identities, fresh/resume/fork semantics, deletion fail-closed checks and fingerprint-pinned result scans. Native wait alone does not implement exact-prompt/action-required recovery. |
| Cancellation | Wait observer, browser requests and Codex quota propagate cancellation | Native batched queries drop the signal at `resolveNativeQuery`; some Codex read branches also omit it. Verified follow-up opportunity. Mutation cancellation needs separate uncertainty treatment. |
| Paging | `bounds.ts`, `catalog.ts`, `continuation.ts`; console and returned model `nextCall` objects | Native cursors and fingerprint pages serve different native contracts, not duplicate implementations. Do not merge them by inventing offsets. |
| Host/terminal | `host.ts` -> current file/VCS/worktree/shell/PTY APIs; `terminal.ts` owns bounded socket replay | Ordinary/persistent PTYs have different retention and cursor units. Containment and mutation readback remain; preflight file writes are not atomic CAS. |
| Events | `events.ts`, diagnostics, reconciliation, `server.ts` native observer; persisted JSON plus kernel lock | Callback DNS pinning, grant revalidation, HMAC, retries, exact IDs and bounded diagnostics are current requirements. Reconciliation timers repair missed live-only events, not legacy fallbacks. |
| Browser | MCP -> shared `BrowserBackend` -> private Python/Nodriver worker; explicit Linux launch/close and Windows attach | Browser/worker/lease lifetimes are distinct. Direct launch supports standalone source execution; systemd launch preserves Chrome across managed connector restart. Neither is proven obsolete. |
| Codex | Connector -> native RPC -> plugin `direct.js` -> ACP; read-only App Server readers for quota/history | No CLI model-turn delegation. Connector RPC declaration duplicates a method inventory, but importing the Effect-schema implementation into the Promise client is not a valid substitution. A schema-only shared contract needs separate design. |
| Quota | `usage.js` accepts native `rateLimitsByLimitId` and `rateLimits` | Comment calls the single bucket backward-compatible; deletion requires evidence from the current installed Codex protocol, not the comment alone. Not yet established obsolete. |
| Deployment | `deploy.ts` -> prepare/activate/rollback in `deployment.ts`; Events persistence | Both now use `fileLock.ts`. The audited PID-file mechanism could unlink a live lock between file creation and metadata write; its probing/reclamation path is removed. |
| Release validation | Hash/copy inventory; prepare verifies integration after prune; activation/rollback only check a short static file list | Verified gap: static plugin list omits `app-server.js` and `outcomes.js`; runnable checks do not rerun integration or rehash installed inputs. Needs deeper release-integrity work. |
| Documentation/tests | README contains old pin/probe and breaking-change narratives; dated audit docs retain evidence | Update touched contracts to final design. Historical acceptance is not current live acceptance. Do not erase independent evidence or tests merely because they mention rejected legacy input. |

## Selected implementation slice

1. **MCP validation boundary.** Baseline `npm audit --json` reports affected
   direct SDK dependencies. [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453)
   requires both a patched server and explicit `maxToolInputElements`; upgrading
   alone does not enable protection. Bound raw HTTP bodies at their actual parser.
   [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp)
   does not affect the existing fresh-server factory, which must stay intact.
   Bearer-audience verification is owned by ingress, not the unused SDK OAuth
   middleware. Update affected pins without changing OpenCode or MCP revision.
2. **Exclusive ownership.** Replace deployment's PID-file lock with the existing
   SQLite exclusive-lock primitive; give it an ownership-neutral name and use
   one implementation for both consumers. Test concurrent deployments, lock I/O
   failure, normal release, process crash, and successor ownership. No old lock
   format reader, conversion, retry, or cleanup route is needed.

These are prioritized slices, not a claim that the repository-wide refactor is
complete. Verified follow-up work is explicitly inventoried above.

## Environment and verification record

- `npm ci --include=dev`: completed. Baseline transitive `node-domexception` and
  `glob` deprecation warnings remain distinct from SDK advisories.
- Workspace `just --list` could not run because `just` is absent from the
  configured PATH. Inspected the root justfile: its check/test recipes target
  other checkouts, so repository gates run directly in this isolated worktree.
- Final focused checks, required gates and operator acceptance are recorded after
  implementation; no deployed-build or ChatGPT behavior is established by them.

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
