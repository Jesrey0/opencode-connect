# OpenCode Connect

> OpenCode Connect is an independent project and is not affiliated with or
> endorsed by the OpenCode project or OpenAI.

OpenCode Connect **0.17.0** projects native host operations and runtime-scoped
worker execution into MCP for ChatGPT's **0xOperator**.
It pins `@opencode/client` to **2.0.24**.

The connector provides bounded host files, commands, worktrees and native sessions,
plus optional [Chrome interaction](docs/browser-capability.md). Direct Codex sessions
run through the native OpenCode plugin in `packages/codex-plugin`, using Codex ACP.
The plugin and connector share this repository; they have separate runtime lifecycles.
OpenCode remains the unified control surface for both worker runtimes.

```text
ChatGPT / 0xOperator
  -> shared host-ingress + OAuth
    /opencode-connect/mcp -> loopback 127.0.0.1:8788/mcp
      -> native OpenCode service
        -> native OpenCode sessions
        -> codex-sessions plugin RPC -> native Codex ACP sessions
```

## Plane boundaries

**PlatformPlane** is the isolated ChatGPT app or web environment. **HostPlane** is
this MCP integration and its Linux execution environment. **WorkerPlane** is hosted
on HostPlane, with separate OpenCode Runtime and Codex Runtime contexts and native
tool surfaces. A worker's tools are not the PlatformPlane MCP catalog. Context
separation does not imply a separate Linux user, filesystem or container.

The connector may compose bounded native calls while preserving native execution
ownership, identities and evidence. It owns explicit transport, observation,
leases and delivery state. Direct host work does not require a model worker.

Codex has a separate worker runtime but its connector control path depends on the
OpenCode service and plugin RPC. Plugin reload/disposal can stop supervised Codex
children; restarting the connector alone does not reload the plugin.

## Deployment scope

OpenCode Connect is a **self-hosted, single-user integration**, not a hosted
service or one-click MCP installation. The diagram above shows one deployment
topology: `host-ingress` is a separately managed service, not part of this
repository, and its route and port are deployment-specific examples. Discovering
the MCP tool schema does not establish that the backing system is deployable.

Operators must independently provide and maintain:

- **Host and OpenCode:** A persistent host with Node 24+ running the connector,
  plus a private OpenCode service compatible with the pinned 2.0.24 client.
- **ChatGPT connectivity:** An HTTPS ingress with appropriate OAuth/authentication
  and routing to the connector's private `/mcp` endpoint. Never expose the
  loopback connector or native OpenCode API as an unauthenticated public service.
- **Workers:** OpenCode's provider/model configuration and permissions. Direct
  Codex sessions additionally require loading the included native plugin into
  OpenCode and configuring its Codex runtime; connector and plugin lifecycles
  remain independent.
- **Optional browser access:** A separately configured Chrome environment;
  see [Browser capability](docs/browser-capability.md).

See [Architecture](docs/architecture.md), [MCP contract](docs/mcp-contract.md)
and [Release lifecycle](docs/release-cutover.md) for component boundaries and
validation. Local development does not require the public ChatGPT ingress.

## General Chat workflow

Enable OpenCode Connect in the conversation and state the objective, authorized
project directory or browser target, and any constraint that matters. Start with
the operation the task needs. Use readiness only for availability questions;
recover existing identities before creating replacement work.

| Intent | Starting point | Evidence to retain |
| --- | --- | --- |
| Find and read project content | `file.list`, `file.find`, `file.read` | Canonical `cwd`, file path, fingerprint and returned `nextCall` |
| Search contents or run a check | `command.run`; follow returned `command.read` continuation | Native handle `id`, canonical `cwd`, cursor, exit/drain evidence |
| Use an interactive terminal | `terminal.start` or session-bound `terminal.startPersistent` | Native handle, terminal kind, canonical `cwd`, replay cursor and loss metadata |
| Delegate fresh work | `opencode.create` with `cwd` and `task` | `runtime`, `sessionId`, OpenCode user `messageId` |
| Continue or fork known work | `opencode.continue`; `opencode.fork` for OpenCode | Existing session identity and returned admission identity |
| Follow or recover a worker | `opencode.wait`, `opencode.activity`, `opencode.result` | Exact prompt identity, outcome evidence and returned continuations |
| Inspect runtime context and API capabilities | `opencode.runtime` with the intended runtime | Connector capability scope, native inventory, Codex loaded-plugin identity, supported correlation |
| Read Codex quota | `opencode.codexQuota {}` | Native quota windows and reset timestamps |
| Operate a browser | `browser.tabs`, exact `browser.attach`, `browser.snapshot` | Target, lease, current element references and application postconditions |

The catalog groups host operations by resource: `file.*`, `git.*`, `command.*`,
`terminal.*` and `browser.*`. Worker operations remain under `opencode.*`, including
Codex plugin control and `opencode.codexQuota`. `connector.readiness` checks the
connector and native service without reading worker histories.

Shell reads/removal take `cwd` and `id`, without `kind`. Ordinary PTY replay uses
`terminal.read`; persistent replay uses `terminal.observePersistent`, whose native
exit cleanup can retire a handle. Terminal controls require the saved `kind`
(`pty` or `persistentPty`). Follow returned `nextCall` objects exactly instead of
reconstructing cursors. See [Catalog migration](docs/catalog-migration.md) for all
0.17.0 name and argument changes; legacy public aliases are not retained.

For a bounded file read, call `file.read`:

```json
{"cwd":"/absolute/project","path":"README.md","limit":2000}
```

For a verification command, call `command.run`:

```json
{"cwd":"/absolute/project","command":"npm run check","waitMs":10000}
```

A short command returns output, native exit status and drain evidence in one call.
If it is still running, output is undrained, or observation failed, retain its
native handle and follow `nextCall`. `waitMs` bounds observation after admission;
`timeoutMs` independently limits process execution. Wait expiry or cancellation
does not kill or restart the command. Use `waitMs: 0` for admission without
foreground observation. Interactive terminals use an executable plus separate
`args` through `terminal.start` or `terminal.startPersistent`.

Catalog reads return directly typed objects. For example, `opencode.models`
returns its `data`, paging and `nextCall` at the result root. Model discovery
defaults to compact entries retaining native IDs, enabled state, pricing, input
modalities and variants; request `view: "full"` for specifications.

For fresh OpenCode work, call `opencode.create`:

```json
{"cwd":"/absolute/project","task":"Fix the reported defect, verify its observable behavior, and report the changed files and remaining risks."}
```

OpenCode selects its configured model and agent when omitted. For Codex, add
`runtime: "codex"`; use the exposed native mode when needed. Retain the returned
runtime and session together. OpenCode wait requires its canonical user
`messageId`; Codex returns `messageId: null` and wait/inspection omit that field.
Do not retry an uncertain admission. Use the retained IDs and `opencode.recovery`
when recovery is necessary.

Worker completion is result evidence. Verify the requested artifact or state at
its owning source before reporting success. Resolve pending actions within the
authorized scope. Delete accepted idle workers with `opencode.delete`, explicitly
supplying `runtime` and `sessionId`, before retiring their working directory.

For browser work, choose an exact discovered tab and observe before acting. Linux
Chrome is the default. Windows requires an explicitly authorized `browser.connect`
and Chrome's permission handshake before discovery and attachment. Bind changes
to the intended object and verify both the changed value and material neighboring
state. Release the lease with `browser.detach`; Chrome and its profile persist.

PlatformPlane `$0xOperator` guidance is managed separately by ChatGPT. Native
runtime knowledge is discovered with `opencode.skills` in the relevant `cwd`,
then loaded with `opencode.skill` using its canonical ID. Resolve references from
the returned skill path. Neither installed skill library is mirrored here.

## Native invariants

OpenCode owns its catalogs, defaults, permissions, sessions, messages, inbox,
ordering and lifecycle. The connector preserves those facts and adds bounded
projection, sanitized errors, exact identity recovery and mutation readback.
Bounded composition does not introduce a second process registry or session engine.
Canonical native IDs and cursor units remain distinct; prompt attachments do
not create subagents or select the executing agent.

Codex owns execution, sandbox modes, history and native session IDs. The plugin
owns ACP supervision; the connector calls its RPC. There is no intermediary
OpenCode model turn or CLI turn. `opencode.codexQuota` is a read-only App Server snapshot;
`opencode.usage` is OpenCode token activity. Neither is General Chat message quota.
Recovered Codex turn outcomes require correlated native history; history alone
does not establish the earlier mode or objective success.

Mutations can be uncertain after timeout or connection loss. Reconcile persisted
state before any retry. Cancellation of a read/wait releases observation without
stopping a worker. Use the explicit interrupt operation when stopping execution
is authorized. Direct HostPlane authority is separate from worker permissions.

## Documentation

| Document | Owns |
| --- | --- |
| [MCP contract](docs/mcp-contract.md) | OpenAI requirements, transport/auth boundary, focused tools, native projections, bounds, permissions and recovery |
| [Architecture](docs/architecture.md) | Source ownership, dependencies, console, service lifetime and persistence |
| [Catalog migration](docs/catalog-migration.md) | 0.17.0 names, shell/terminal routing, direct read results and client refresh |
| [Browser capability](docs/browser-capability.md) | Setup, Linux/Windows consent, targets, workflows, input, verification and cleanup |
| [Operator acceptance](docs/operator-acceptance.md) | General Chat prompt-selection cases, complete workflow evidence and reproducible local probes |
| [Release lifecycle](docs/release-cutover.md) | Immutable builds, connector/plugin acceptance and coordinated rollback |
| [Codex plugin](packages/codex-plugin/README.md) | Direct ACP sessions, modes, approvals, history and quota |
| [Agent guide](AGENTS.md) | Repository engineering boundaries |

## Development and release

Node 24 or newer is required. From the repository root:

```bash
npm ci --include=dev
npm run check:all
npm run test:all
npm run build
npm run verify:integration
git diff --check
```

`check:all` includes release identity and native-client checks. Integration checks
the installed workspace, pinned OpenCode version, native loader and RPC method
contract without contacting a live service. Build cleans generated `dist` first.
Use an isolated source copy when a console depends on the checkout's toolchain.

Source validation, Git publication, immutable release preparation, connector
activation, native plugin loading and live ChatGPT acceptance are distinct gates.
Follow the [release runbook](docs/release-cutover.md); preserve installed configuration
and the matching connector/plugin rollback pair. `/health` proves connector
identity and native connectivity. Use `opencode.runtime` with `runtime: "codex"`
for loaded package/build-record identity and capability evidence; this is separate
from release integrity verification and quota. Byte-identical plugin runtime
inputs can remain loaded during a connector-only activation after compatibility
and identity verification; the loaded plugin may therefore name an earlier build.
After activation, refresh stale ChatGPT connections and verify the exposed catalog
before treating the new tool names as available.
