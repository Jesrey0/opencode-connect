# opencode-codex-subagent

> **Repository location:** This package is maintained inside the OpenCode Connect
> monorepo under packages/codex-plugin. Install dependencies using npm ci at
> the repository root (npm ci --include=dev for development) and test with npm test --workspace opencode-codex-subagent.
> Connector activation does not migrate/reload this plugin; coordinated loading
> and rollback are separate authorized actions. See [release lifecycle](../../docs/release-cutover.md).

An OpenCode 2.0.24 V2 plugin that registers the `codex-sessions` RPC for direct
Codex sessions over the Agent Client Protocol (ACP). It does not transform or
intercept OpenCode's built-in `subagent` tool; all native subagent behavior stays
owned by OpenCode.

## Design

The plugin registers only the `codex-sessions` RPC definition. A native OpenCode
agent named `codex`, like every other native agent, is handled by OpenCode's
built-in subagent implementation without plugin routing or permission evaluation.

## Safety model

Codex is external to OpenCode's command permission system, so direct-session
authority is bounded by the selected native ACP mode and by who answers
approvals. `codex-sessions` selects one native ACP session mode explicitly and queues
approvals for the operator instead of deciding them:

| Mode | Sandbox policy | Approval policy | Reviewer |
| --- | --- | --- | --- |
| `read-only` | `readOnly` | `on-request` | `user` |
| `workspace-write` | `workspaceWrite` | `on-request` | `user` |
| `agent` (default) | `workspaceWrite` | `on-request` | `auto_review` |
| `agent-full-access` | `dangerFullAccess` | `never` | `user` |

Each mode binds the native sandbox and reviewer exactly as Codex itself defines
it; this plugin never overrides either.

ACP filesystem and terminal delegation stays denied, because
Codex performs its tools natively rather than through the client.

## Historical turn outcomes

ACP remains the Codex execution protocol. Historical session reads use a separate
bounded, read-only Codex App Server lookup (`thread/read` and newest
`thread/turns/list`) to recover completed, failed, or interrupted turns after
adapter restart. Results are tied to the native session/thread ID and the ACP
session revision; a newer turn invalidates a cached outcome. Missing, active,
or unverifiable history is never labeled as completed. Historical reads never
select a session mode, run a turn, or answer an approval.

## Authorization

The direct RPC is inert unless `enableCodex: true`. Whether enabled or disabled,
the plugin registers no tool override and does not inspect agent permission rules.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/immutable-build/packages/codex-plugin/src",
      "options": { "enableCodex": true },
    },
  ]
}
```

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `enableCodex` | `false` | Explicit opt-in. |
| `cwd` | OpenCode's session directory | Workspace for the Codex session. |
| `timeoutMs` | `600000` | Bounded runtime for one turn. |
| `nodePath` | `node` (PATH) | Node binary used to launch codex-acp. |
| `codexAcpEntry` | resolved from the package | Override the codex-acp entrypoint. |
| `codexPath` | CODEX_PATH, then codex on PATH | Installed Codex CLI for read-only quota snapshots (not ACP prompt execution). |

The child is launched with an **explicit `node` invocation**. `process.execPath`
is never used, so the backend does not depend on the OpenCode runtime's binary.

## Layout

```
src/index.js        plugin registration for direct codex-sessions RPC
src/direct.js       native Codex session supervision and codex-sessions RPC
src/codex.js        ACP client app, safety envelope, and transport
src/usage.js        bounded read-only Codex App Server quota reader
src/stdio.js        shared owned-process shutdown and bounded stderr
scripts/            live non-prompt ACP handshake against the real binary
test/               in-process fake ACP agent, stdio ACP fixture, suites
```

## Verification

From the source checkout's package directory:

```bash
npm test     # no network and no Codex quota
npm run check
```

`node scripts/live-acp-handshake.mjs` is an optional, separately authorized live
diagnostic. It creates a native Codex session and switches its mode even though it
sends no model prompt. It is not part of source validation or shipped release
inputs. Do not run it as a supposedly side-effect-free check.

`npm test` covers the disabled path and proves native tools remain untouched.
Direct-session coverage includes selected-mode application before each prompt,
continuation inheritance and reapplication, explicit mode after an unrecoverable
restart, reviewable vs. truncated approval detail, exact-option resolution,
stale/unknown/cross-session rejection, request-ID non-reuse, bounded queue
behaviour, interruption and disposal settling parked decisions, and unchanged
OpenCode behaviour.

Transport coverage exercises the real spawn + newline-delimited ACP stdio
transport and proves both shutdown paths: a cooperative agent exits on stdin
EOF without ever being signalled, and an uncooperative agent together with its
own child is reaped through the owned process group.

## Limitations

- Model and reasoning-effort selection are not exposed; Codex picks its own
  default.
- Direct Codex sessions are not OpenCode subagents and do not create native
  OpenCode child sessions.

## Loading and release lifecycle

Configure the immutable release's `packages/codex-plugin/src` directory, not
the package root. OpenCode 2.0.24's local-directory loader resolves `server` or
`index` inside that directory; it does not use the package's `main` or `exports`.
The npm workspace export independently resolves to the same `src/index.js`.
There is no package-root directory entry wrapper. The pinned loader contract is
tested without plugin setup or live service access.
Helpers and the native RPC declaration are imported from their owning source
modules (`codex.js`, `usage.js`, and `direct.js`), not re-exported by the plugin entry.

The operator accepted commit `0ac3e16`, release `6ab67427dc237b56`, on October 11,
2026 with the plugin loaded from the release's immutable `src` directory. This
is a dated acceptance record, not a promise about current configuration. See
the [release lifecycle runbook](../../docs/release-cutover.md) for verification,
separate connector/plugin rollback, and standalone-checkout retirement gates.

## Direct operator sessions

The `codex-sessions` plugin RPC exposes `start`, `inspect`, `wait`, `interrupt`,
`delete`, `list`, `messages`, `status`, `permissions`, `respondPermission`, and `usage`.

### Codex quota snapshot

The read-only `usage({})` RPC opens a short-lived Codex App Server client and reads
`account/rateLimits/read` plus optional non-refreshing account metadata.
It returns native quota buckets with their available primary/secondary used
percentages, window duration and reset timestamps. It cannot start a model
turn or change authentication. Account identities, tokens, and provider error
bodies are never returned; requests and shutdown are bounded.
The reader sends the fixed `initialized` handshake notification and rejects all
server-initiated requests. Caller cancellation and plugin disposal reach the
quota reader; supplementary account failure cannot hide a timeout/cancellation.
Quota reads use a 15s budget plus bounded process shutdown, a 1 MiB wire ceiling
and at most 64 buckets. Reset timestamps are native Unix seconds; `readAtMs` is
milliseconds. No availability percentage is synthesized.

The quota binary is `codexPath`, then `CODEX_PATH`, then `codex` on PATH. ACP
instead uses `CODEX_PATH` or codex-acp's bundled CLI. These can be different
versions/installations; source checks do not verify their live account binding.

These are **Codex** account quotas, separate from OpenCode token usage and from
ChatGPT General Chat Plus message limits. No model-to-quota-bucket mapping is
inferred. OpenCode Connect accesses it through its existing read-only query
with `{ runtime: "codex", type: "usage" }`; no extra MCP tool is needed.

Codex execution and persistence stay owned by the native backend.

### Session modes

`start({ cwd, task, mode })` selects the session mode. A fresh session defaults
to `agent`; any of the four modes may be named explicitly, and a mode the agent
does not advertise fails the turn rather than falling back.

The mode is applied **before every prompt**, including the first one after a
load: Codex resets a loaded session to its initial mode, so relying on the mode
set at creation would silently run a later turn under a different sandbox.

`start({ sessionId, task })` inherits the mode this adapter applied and still
remembers. After an adapter restart or a cache eviction that mode is **not**
recoverable, so an omitted `mode` on a continuation is rejected with
`codex-sessions.mode_required` rather than defaulting to something wider. Pass
`mode` explicitly to continue a recovered session.

Loading native history never asserts a mode or an execution outcome: Codex
reports its post-load mode, which is a transient state rather than the mode the
conversation ran under, so `inspect`, `messages`, and `permissions` report
`mode: null` and `modeKnown: false` for a recovered session.

### Pending approvals

Codex asks the ACP client to resolve each approval. The adapter parks the
request and publishes it rather than answering it:

```jsonc
{
  "requestId": "0f1d...-...",
  "sessionId": "native-session-id",
  "action": "Run a command",
  "details": {
    "command": "rm -rf /tmp/x", "cwd": "/tmp",
    "locations": ["/tmp/x"], "diffs": [],
    "content": "Remove a temporary directory",
    "truncated": false, "truncatedFields": []
  },
  "options": [{ "optionId": "allow_once", "name": "Yes, just this once", "kind": "allow_once" }],
  "reviewable": true
}
```

- `wait` returns `wakeReason: "actionRequired"` with `pendingActions` as soon as
  a decision is parked, rather than waiting out the full timeout.
- `respondPermission({ sessionId, requestId, optionId })` resolves exactly one
  request with exactly one advertised `optionId`. Unknown, already-answered, and
  cross-session request IDs are rejected, as is an `optionId` the agent never
  advertised.
- Request IDs are globally unique and never reused, so an answered ID cannot be
  replayed onto a later request after a history refresh or a restart.
- The queue is bounded per session (default 8). Beyond the bound a request is
  cancelled rather than buffered, and a request naming a different session is
  never parked as this session's decision.

**Reviewability.** An operator must be able to read what they authorize. The
adapter surfaces the command, working directory, touched paths, the agent's
readable summary, and each native diff's `oldText`/`newText`, bounded to 16 KiB
of text and 1 KiB per path. Nothing else from `rawInput` is copied, so
credentials and provider configuration cannot ride along.

When any of that detail was cut, the entry is marked `truncated` with the
affected `truncatedFields` and `reviewable: false`, and an allowing option is
rejected with `codex-sessions.unreviewable_request`. Rejecting and cancelling
stay available, so an unreadable request can always be refused.

### Shutdown

Interruption, turn completion, timeout, and disposal all settle pending
requests, so no decision outlives its turn and no queue entry leaks.

Transport shutdown is graceful first. ACP over stdio treats stdin EOF as "the
client is gone", so the agent is given a bounded 5s window to exit and reap its
own children before it is signalled at all. Only an agent that ignores EOF is
then sent `SIGTERM`, and after a further 2s, `SIGKILL`.

codex-acp runs Codex as its own child, so signalling only the ACP process would
leave that Codex process alive holding the native thread — which is exactly the
failure where a `session/delete` immediately after a terminal `wait` fails with
an active-writer error. The child is therefore spawned `detached` on POSIX so it
leads its own process group, and termination signals the whole owned group.

For the same reason, a terminal `wait` awaits the turn's transport cleanup before
reporting, and the session admission lock is released only after cleanup. A
caller that observes `wakeReason: "terminal"` can act on the session immediately.

### Bounds

Two execution slots and one metadata connection bound process concurrency.
Supervision records expire after ten minutes and cap at 64; eviction does not
remove native conversations. Answers cap at 64 KiB and history at 128 messages
and 256 KiB of text, with explicit truncation and completeness flags. RPC errors
omit provider bodies. Prompt admission supplies no canonical user message ID,
and inspection and bounded waiting observe the current session turn; exact-prompt
selection is unsupported. History replay recovers native message IDs, while a
restarted adapter recovers conversation history but reports execution outcome as
unknown. Native session listing and deletion require their advertised
capabilities. Plugin disposal interrupts and reaps active children.
