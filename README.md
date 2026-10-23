# OpenCode Connect

> OpenCode Connect is an independent project and is not affiliated with or
> endorsed by the OpenCode project or OpenAI.

OpenCode Connect **0.15.1** projects native OpenCode HostPlane operations
and WorkerPlane execution into MCP for ChatGPT's **0xOperator**.
It pins `@opencode/client` to **2.0.24**.

The connector provides bounded host files, commands, worktrees and native sessions,
plus optional [Chrome interaction](docs/browser-capability.md). Direct Codex sessions
run through the native OpenCode plugin in `packages/codex-plugin`, using Codex ACP.
The plugin and connector share this repository; they have separate runtime lifecycles.

```text
ChatGPT / 0xOperator
  -> shared host-ingress + OAuth
    /opencode-connect/mcp -> loopback 127.0.0.1:8788/mcp
      -> native OpenCode service
        -> native OpenCode sessions
        -> codex-sessions plugin RPC -> native Codex ACP sessions
```

## General Chat workflow

Enable OpenCode Connect in the conversation and state the objective, authorized
project directory or browser target, and any constraint that matters. Start with
the operation the task needs. Use readiness only for availability questions;
recover existing identities before creating replacement work.

| Intent | Starting point | Evidence to retain |
| --- | --- | --- |
| Find and read project content | `host.list`, `host.find`, `host.read` | Canonical `cwd`, file path, fingerprint and returned `nextCall` |
| Search contents or run a check | `command.startShell`, then `command.read` | `kind`, native handle `id`, canonical `cwd`, cursor, exit/drain evidence |
| Delegate fresh work | `opencode.create` with `cwd` and `task` | `runtime`, `sessionId`, OpenCode user `messageId` |
| Continue or fork known work | `opencode.continue`; `opencode.fork` for OpenCode | Existing session identity and returned admission identity |
| Follow or recover a worker | `opencode.wait`, `opencode.inspectActivity`, `opencode.inspectResult` | Exact prompt identity, outcome evidence and returned continuations |
| Learn native capabilities | `opencode.skills`, `opencode.skill`, current model/agent/runtime catalogs | Canonical IDs in the task's native location |
| Read Codex quota | `codex.quota {}` | Native quota windows and reset timestamps |
| Operate a browser | `browser.tabs`, exact `browser.attach`, `browser.snapshot` | Target, lease, current element references and application postconditions |

Public tools are purpose-specific. They do not accept internal `type`, `action`
or command-start `kind` selectors. `command.read` still needs the saved `kind`
(`shell` or `pty`); `command.observePersistentPty` takes `cwd` and `id` without it.
Follow returned `nextCall` objects exactly instead of reconstructing cursors.

For a bounded file read, call `host.read`:

```json
{"cwd":"/absolute/project","path":"README.md","limit":2000}
```

For a verification command, call `command.startShell`, then read its returned handle:

```json
{"cwd":"/absolute/project","command":"npm run check"}
```

For fresh OpenCode work, call `opencode.create`:

```json
{"cwd":"/absolute/project","task":"Fix the reported defect, verify its observable behavior, and report the changed files and remaining risks."}
```

OpenCode selects its configured model and agent when omitted. For Codex, add
`runtime: "codex"`; use the exposed native mode when needed. Retain the returned
runtime and session together. OpenCode wait requires its canonical user
`messageId`; Codex returns `messageId: null` and wait/inspection omit that field.
Do not retry an uncertain admission. Use the retained IDs and `status.recovery`
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
Canonical native IDs and cursor units remain distinct; prompt attachments do
not create subagents or select the executing agent.

Codex owns execution, sandbox modes, history and native session IDs. The plugin
owns ACP supervision; the connector calls its RPC. There is no intermediary
OpenCode model turn or CLI turn. `codex.quota` is a read-only App Server snapshot;
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
identity and native connectivity, not loaded Codex plugin identity or quota.
