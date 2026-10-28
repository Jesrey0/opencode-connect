# Catalog migration to 0.17.0

Version 0.17.0 changes the public MCP catalog. Update tool names, shell/terminal
routing, read-result access and saved continuation identities together. Legacy
public aliases are not retained. Native sessions, process handles, canonical cwd
and prompt IDs keep their native meanings.

## Namespace map

Host operations are grouped by resource. Worker control remains unified under
`opencode.*`, including the Codex plugin; `runtime: "codex"` selects its supported
operations. The native OpenCode service owns the Codex plugin lifecycle.

| 0.16.0 name | 0.17.0 name |
| --- | --- |
| `status.readiness` | `connector.readiness` |
| `status.recovery` | `opencode.recovery` |
| `host.list`, `host.read`, `host.find`, `host.write` | `file.list`, `file.read`, `file.find`, `file.write` |
| `host.vcs` | `git.repository` |
| `host.vcsStatus` | `git.status` |
| `host.vcsBranch` | `git.branches` |
| `host.vcsDiff` | `git.diff` |
| `host.worktreeList` | `git.worktrees` |
| `host.worktreeCreate` | `git.createWorktree` |
| `host.worktreeRemove` | `git.removeWorktree` |
| `host.worktreeRefresh` | `git.refreshWorktrees` |
| `host.commands` | `command.list` for shells; `terminal.list` for PTYs |
| `host.terminalScreen` | `terminal.screen` |
| `host.terminalSnapshot` | `terminal.snapshot` |
| `opencode.inspectActivity` | `opencode.activity` |
| `opencode.inspectResult` | `opencode.result` |
| `opencode.tools` | `opencode.toolCalls` |
| `opencode.tool` | `opencode.toolCall` |
| `opencode.command` | `opencode.invokeCommand` |
| `codex.quota` | `opencode.codexQuota` |

`opencode.toolCalls` and `opencode.toolCall` inspect executed native call evidence.
They do not discover a worker's effective tools. `opencode.invokeCommand` invokes
a native session command; HostPlane shell execution uses `command.run`.

## Shell and terminal routing

| 0.16.0 operation | 0.17.0 operation and input change |
| --- | --- |
| `command.startShell` | `command.run` with `waitMs: 0`; omit the ineffective legacy `title` field |
| `command.run` | Same bounded foreground shell workflow |
| `command.read` with `kind: "shell"` | `command.read`; omit `kind` and the shell-ignored `waitMs` |
| `command.remove` with `kind: "shell"` | `command.remove`; omit `kind` |
| `command.startPty` | `terminal.start` |
| `command.startPersistentPty` | `terminal.startPersistent` |
| `command.read` with `kind: "pty"` | `terminal.read`; omit `kind` |
| `command.observePersistentPty` | `terminal.observePersistent` |
| `command.remove` with PTY kind | `terminal.remove`; retain `kind` |
| `command.resize` | `terminal.resize`; retain PTY `kind` |
| `command.input` | `terminal.input`; retain PTY `kind` |
| `command.interrupt` | `terminal.interrupt`; retain PTY `kind` |
| `command.ctrlD` | `terminal.sendCtrlD`; retain PTY `kind` |

Shell admission:

```json
{"cwd":"/absolute/project","command":"npm run check","waitMs":0}
```

Shell output recovery:

```json
{"cwd":"/native/canonical/project","id":"saved-native-shell-id","cursor":0,"limit":12000}
```

`command.read` and `command.remove` are shell-only and reject a `kind` input.
Terminal start operations select ordinary or persistent native admission by tool
name. `terminal.read` reads ordinary PTYs; `terminal.observePersistent` reads
persistent PTYs and retains native observer-exit cleanup, so it can remove an
exited handle. It remains destructive and non-idempotent. Terminal control
operations require `kind: "pty"|"persistentPty"`.

`command.list` lists running shells in canonical cwd and rejects `sessionId`.
Retained exited shell handles require saved IDs. `terminal.list` lists ordinary
PTYs in canonical cwd; an explicit `sessionId` additionally selects that
session's persistent PTYs. It does not discover persistent terminals across all
sessions. Kind/session filtering precedes fingerprinted pagination.

Retain the native cursor unit: shells and persistent PTYs use bytes; ordinary
PTY replay uses UTF-16 code units. Rendered `terminal.screen` and
`terminal.snapshot` text have independent text paging. Input has no durable
acknowledgement; renaming does not make uncertain input safe to retry.

## Direct read results and continuations

Purpose-specific `opencode.*` query reads now return their typed result directly
in MCP `structuredContent`. Replace:

```javascript
const page = response.structuredContent.results[0].result;
```

with:

```javascript
const page = response.structuredContent;
```

For example, `opencode.models` exposes `data`, paging, `location`, `view` and
`nextCall` directly. Session/message reads retain their runtime-specific native
cursor or fingerprint structure; this change does not normalize those distinct
pagination contracts. Errors are safe root objects with MCP `isError: true`.
The generic backend query envelope remains private.

Follow the returned `{tool,arguments}` continuation. Old saved continuations
must be migrated by operation, including shell/terminal kind routing and removal
of rejected fields. Where the source changed, reread a fresh page rather than
reuse a stale fingerprint. Do not drop runtime, canonical message IDs, selection
fingerprints or native cursors during migration. Never migrate or replay an
uncertain mutation as if it were a read continuation.

## Discovery defaults and browser schemas

`opencode.models` defaults to compact view, retaining native IDs, enabled state,
pricing, input modalities and variant IDs. Request `view: "full"` for native
specifications. Membership and native availability are not filtered or inferred
from pricing.

Browser operation names, authority and native semantics are unchanged.
`browser.workflow` discovery shares repeated target/postcondition/timeout
constraints while keeping action-specific fields visible and strict branch
constraints intact. Every workflow step still requires its exact target and
observable postcondition; ambiguity, authorization, bounds and uncertain
mutation handling are unchanged.

## Deployment and connector refresh

Deploy and verify the server catalog before refreshing ChatGPT. Use
[Release lifecycle](release-cutover.md) to determine whether the unchanged loaded
plugin can stay in place or a coordinated native reload is required. A
connector-only activation may legitimately leave the plugin on an earlier
immutable build; record both actual identities.

After cutover, refresh a ChatGPT connection that still exposes the old names.
Verify the new names and arguments in the actual conversation, then exercise
representative calls. Host-side MCP discovery proves server state, not installed
PlatformPlane exposure. Preserve that distinction in acceptance records.
