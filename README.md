# OpenCode Connect

> OpenCode Connect is an independent project and is not affiliated with or
> endorsed by the OpenCode project or OpenAI.

OpenCode Connect **0.7.0** projects native OpenCode HostPlane operations,
Windows computer-use and printing adapters, and the canonical WorkerPlane
into MCP for ChatGPT's **0x0perator**. It pins `@opencode/client` to **2.0.24**. Codex Connect remains independently
owned and deployable.

```text
ChatGPT / 0x0perator
  -> shared host-ingress + host OAuth
    /opencode-connect/mcp -> loopback 127.0.0.1:8788/mcp
      -> @opencode/client 2.0.24 -> private OpenCode service
```

Shared host-ingress owns the public `/opencode-connect/mcp` route, rewrites it to
loopback `/mcp`, and validates OAuth centrally. Authorization and cookies are
stripped before the backend; the raw OpenCode API remains private. Live public-app
acceptance is a separate post-deployment check; source validation does not establish
it. The operator owns backend deployment, account binding/OAuth, and Git publication.
Documentation and Git publication do not activate a backend release; check deployed
build identity, service readiness, and ChatGPT tool discovery independently.

OpenCode owns sessions, message IDs, inbox admission, agents, permissions, and
the model catalog. There are no connector worker/command registries, local run
IDs, sidecars, compatibility aliases, or custom plugin RPC. A workstream stays
on its selected substrate. Worker identity is `sessionId` + canonical **user**
`messageId`; synthetic admission instead returns an **inboxId**.

## HostPlane

| Tool | Native surface |
| --- | --- |
| `host.inspect` | `list`, `read`, `find`, `vcs`, `vcsStatus`, `vcsBranch`, `vcsDiff`, `commands`, `terminalScreen`, `terminalSnapshot` |
| `host.write` | Native bounded UTF-8/base64 file write, explicit overwrite/fingerprint, persisted readback |
| `host.worktree` | Native project-owned `list`, `create`, `remove`, `refresh` |
| `command.start` | `shell`, `pty`, or experimental session-bound `persistentPty` |
| `command.read` | Native handle + canonical cwd/location + saved cursor; bounded output |
| `command.control` | Remove; PTY input, resize, Ctrl-C (`interrupt`), Ctrl-D (`ctrlD`) |

Each operation supplies an absolute `cwd`; responses return the native canonical
`location` and `cwd` where applicable. Save `kind`, `id`, canonical location,
and cursor together. Shell commands are strings interpreted by OpenCode's
selected native shell. PTY commands are executables with separate `args`.
Persistent PTY admission additionally requires a native `sessionId` whose
canonical location matches `cwd`. No command environment/configuration or
connect ticket is exported. Inventory uses explicit safe fields and excludes
auth, environment, provider request objects, config, and raw plugin/MCP errors.
Operator-chosen file contents and command output still require secret hygiene.

`find` is native filename search, bounded to 50 hits; `possiblyTruncated` is
conservative because the API has no continuation. For content search, use a
native shell command such as `rg --line-number --glob '*.ts' 'pattern' src`.
For patching, use native shell `git apply --check` followed by `git apply` with
a deliberately quoted patch/heredoc. Inspect conflicts and reread VCS state.
These run through the same command lifecycle; there is no second search/patch
engine or duplicate exec tool. Exact-version public APIs provide no live LSP,
symbol lookup, or formatter surface; the connector does not invent one.

Files are read with native `file.read`; file/list paths are checked against the
canonical location, including resolved symlinks. Reads page **bytes** and require
the previous fingerprint on continuation. UTF-8 pages return text; invalid or
split multibyte pages return base64 with encoding metadata, preserving bytes.
Directory/status/diff inventories page at most 50 entries and 96 KB serialized
entry data. Their fingerprints reject changed content between pages. `vcsBranch`
lists native branch names with an optional native `search` filter; connector
pages are fingerprinted like other inventories. VCS diff
inventory omits patches; select `file` to page its full patch with
`textOffset`/`textFingerprint` in UTF-16 code units. Native APIs materialize whole
files/lists/diffs before this bounded projection; this is a transport bound,
not a native ranged-read or memory-bound promise.

`host.write` requires `encoding`, `data`, and explicit `overwrite`.
New files require `overwrite: false` without a fingerprint; existing files require
`overwrite: true` plus `expectedFingerprint` from a native read. Payloads cap at
64 KiB decoded bytes (90,000 encoded characters), preserve UTF-8/BOM/Unicode,
and require canonical base64 when selected. Parent directories must already
exist. Canonical containment includes leaf and parent symlinks, including new
files; escaping or dangling symlinks fail. Native persisted byte readback supplies
size/fingerprint, not duplicate file contents. Fingerprint preflight is **not
atomic CAS**: concurrent file creation, editing or symlink replacement between
validation and native write is not excluded. Do not automatically retry uncertain
writes. Patching remains native shell `git apply`, not a connector patch engine.

Worktree operations discover `projectId` from canonical `cwd`; an optional supplied
ID must match. List is fingerprint-paged. Create requires an explicit absolute
canonical destination with an existing parent, and forwards optional native
branch/name from the selected location. Remove requires an inventoried directory
owned by that project, rejects its canonical root, and requires explicit `force`.
Create/remove/refresh read back native inventory. The combined lifecycle tool is
conservatively annotated destructive/non-idempotent, including list. Native
failures remain failures; safe error types are retained without raw native bodies.

Images are optional `read` results with `image: true`, limited to **1 MiB** and
signature-checked PNG, JPEG, GIF, or WebP. MCP returns one image block plus
metadata, without duplicate base64 in text or structured data. SVG/HTML and
oversized images fail. Object results return only MCP `structuredContent` with
`content: []`; image reads instead carry one image block. All 25 tools publish
explicit output schemas. Connector errors return structured `error` (and admission
`recovery` where applicable) with `isError: true`; SDK input errors retain SDK formatting.
The serialized `{ structuredContent }` projection has a repository-policy
**256 KiB** ceiling, independent of the **1 MiB decoded image** allowance.
Oversized JSON results fail explicitly; narrow the page or detail. OpenAI's
256 KiB requirement applies to complete outbound **event request bodies**, not
tool images or this repository's JSON projection policy.

## Windows computer use and printing

The current catalog exposes **25 tools**: 12 core status/HostPlane/WorkerPlane
tools, four `computer.*` tools, and nine `print.*` tools. They share this
connector's existing authenticated MCP endpoint; host ingress has no separate
public routes for Windows desktop control or printing.

| Family | MCP tools | Contract and prerequisites |
| --- | --- | --- |
| Computer Use | `computer.observe`, `computer.interact`, `computer.sequence`, `computer.screenshot` | [Windows Computer Use](docs/computer-use.md) and [bounded sequences](docs/computer-throughput.md). Requires Windows Computer Use and Windows PowerShell in the interactive desktop account. |
| Printing | `print.status`, `print.capabilities`, `print.media`, `print.declare`, `print.inspect`, `print.submit`, `print.queue`, `print.job`, `print.cancel` | [Printing HostPlane](docs/printing.md). Requires the separate Windows Print Bridge executable and a functioning Windows printer. |

Computer interaction and print submission have real desktop/physical side effects.
Tool discovery does **not** prove that the Windows bridge, a printer, a paper
tray, or an interactive session is available. The WSL deployment supplies the
bridge executable path from its **server-side** environment, never from MCP
tool arguments. Printing is generic HostPlane functionality, not part of BAR
or any specific application. See the linked documents for readbacks, bounds,
media declarations, and no-retry handling of uncertain effects.

## Command retention and cursor contracts

| Kind | Cursor unit | Native retention/expiry |
| --- | --- | --- |
| `shell` | bytes | In-memory location registry, max 25 exited jobs; file-backed output does not make handles restart durable |
| `pty` | JavaScript UTF-16 code units | 2 Mi code units of running replay, max 25 exited metadata entries; attaching after exit is unavailable |
| `persistentPty` | bytes | Experimental native session-bound daemon, head/tail and replay-loss metadata; an attached observer seeing exit triggers native removal |

Shell `list` contains running commands only. Save exited IDs yourself; there is
no recovery-by-output-file or connector registry. Removal terminates and forgets
a command. Location eviction, runtime restart, native eviction, removal, or
daemon loss can invalidate handles; missing handles fail visibly. The connector
makes no restart-durability promise for these native commands.

Shell `drained` is true only when a native terminal state (`exited`, `timeout`,
`killed`) was read **before** output and the returned `cursor >= size`. A running
shell at the output tail is not drained. Native shell output independently
UTF-8-decodes byte slices; splitting a multibyte character can produce replacement
characters. Responses declare `encoding: nativeUtf8` and that limitation. The
connector preserves native cursor/size behavior and does not reconstruct bytes.

PTY reads use bounded temporary native sockets. `replay` preserves requested,
available, and end offsets plus loss/truncation metadata. `replayComplete` means
the native replay marker arrived; clipped output may still need another page.
Persistent byte pages use UTF-8 or lossless base64 on split/invalid bytes. Ordinary
PTY pages avoid new surrogate splits, but native replay chunks/offsets can already
split Unicode; the connector cannot repair native loss. Ordinary exited metadata
returns `replayAvailable: false`, `drained: false`. If final PTY metadata readback
fails after replay capture, output/cursor/replay metadata survive. Responses set
`metadataVerified: false`, include a safe `metadataReadError` and
`lastConfirmedInfo` from before replay, and never claim drained. A native
`PtyNotFoundError` confirms `handleAvailable: false`; other readback failures leave
availability unknown (`null`). Socket detach does not confirm terminal state.
Persistent observer exit cleanup makes `command.read` destructive and
non-idempotent, not read-only. No retained-exit promise is made.

`host.inspect terminalScreen` uses native session terminal `read` with bounded
`lines` (1–1,000); `terminalSnapshot` selects a canonical persistent PTY `id`.
Both validate the owning session against `cwd`, return rendered text with native
screen cursor/size, and use fingerprinted text pages. Snapshots exclude the native
binary checkpoint. These are **rendered screen views**, not raw byte replay:
screen text offsets cannot be used as command replay cursors, and neither view
proves command success or output drain.

Socket detach is not process exit. Input returns `inputSent` and
`acknowledged: false`: native PTY input has **no durable acknowledgement**. A
bounded 250 ms send window helps transport delivery but proves no execution.
Never retry uncertain input automatically. Persistent input requires native
controller role; `takeover: true` explicitly requests ownership when needed.
`ctrlD` sends a terminal character, not pipe EOF. Shells support removal only;
use PTY input/interrupt/resize for interactive work. Read limits default to 12,000
and cap at 65,536 bytes/code units; live read waits cap at 2 s, attachment/replay
at 5 s. Shell timeout defaults to 120 s and caps at 24 hours.

## WorkerPlane

`status`, `opencode.start`, `opencode.wait`, `opencode.inspect`,
`opencode.query`, and `opencode.act` retain OpenCode's native worker identities.
Events wake bounded waits; persisted session/message state remains authoritative.
Stale/unrelated terminal hints cannot force completion; timeout reconciles canonical
state even when the terminal event was missed. SDK request cancellation or HTTP
disconnect releases the wait's native read/event observer without interrupting
the retained worker; use explicit `act interrupt` to stop native execution.

The pinned official MCP SDK per-request HTTP entry serves only `2026-07-28`
using `server/discover`, per-request `_meta`, and matching standard
`MCP-Protocol-Version`, `Mcp-Method`, and method-specific `Mcp-Name` headers.
Client capabilities are required; client identity follows the SDK's current
[protocol contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).
Input/output discovery uses JSON Schema 2020-12. Strict discriminated
unions own validation and publish model-visible properties plus variant restrictions.
The SDK owns version/metadata/header validation and wire errors. Legacy requests
and initialization are rejected with supported-version diagnostics; session
GET/DELETE return 405 and no MCP session is allocated. The SDK acknowledges
legacy notifications (including `notifications/initialized`) with empty 202,
without creating a server/exchange or accessing native state.
SDK Express localhost Host/Origin validation protects loopback; shared ingress
owns public OAuth, request-rate ceilings, and public exposure. When Events is
enabled, discovery additionally requires ingress authorization before SDK wire
validation, so unauthenticated discovery returns 401 first.
Connector-defined Events authorization and subscription-capacity failures use
application error codes `1001` and `1002`, outside the JSON-RPC reserved range.
Callback verification retains OpenAI Events' prescribed `-32015` code. See the
[current MCP error-allocation policy](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes).
Event methods and their capability are registered as the OpenAI MCP Events
extension. For continuation, explicitly create
an event-triggered Scheduled task using the connected plugin's event, exact worker
IDs as filters, and saved canonical-result/follow-up instructions. That task causes
ChatGPT to call `events/subscribe` and supply callback credentials. Confirm task
creation, callback verification and persisted activation before relying on it.
Installing/connecting the plugin or ending a response does not create this task.
Ordinary timed tasks, condition polling and Codex automations do not establish an
MCP event trigger. Verify task-creation support in the current surface before
starting gated acceptance work. Native terminal reconciliation follows exact result-selection
continuations across bounded passes, retaining the native fingerprint and resetting
stale scans rather than interpreting partial results.

Authenticated MCP Events exposes one event, `opencode.session.terminal`, with
required exact `sessionId` and initiating user `messageId` filters. It is
delivered only after OpenCode's persisted session/message state confirms that
prompt is terminal; callbacks are hints to inspect the exact prompt, not result
claims. `events/subscribe` verifies an HTTPS callback with a signed challenge;
deliveries use Standard Webhooks HMAC-SHA256 and a bounded eight-attempt retry
schedule. One delivery tick serves several due subscriptions in stable admission
order up to an explicit per-tick bound; it never drains the queue, and
per-delivery backoff, authorization, and storage semantics are unchanged.
Reconciliation and delivery failures record sanitized `reconciliationFailed` and
`deliveryFailed` lifecycle evidence without callback URLs, secrets, or raw
error bodies. Subscriptions and pending deliveries persist under
`$XDG_STATE_HOME/opencode-connect/events/`; omitted `ttlMs` expires after one
hour, finite TTL is clamped to one minute–24 hours, and `null` does not expire.
Use authenticated refresh (`events/subscribe` again) or exact
`events/unsubscribe` to manage a subscription. On restart subscriptions resume
only after current ingress grant validation. The private
`/_host-ingress/events/authorize/opencode-connect` contract authenticates the
forwarded `x-host-ingress-auth-context` and later checks the stored opaque grant
context; callback credentials and grant contexts are stored only in the private
state file. Events do not replay missed history; consumers should deduplicate by
stable `eventId` and reconcile with `opencode.inspect`.

Event lifecycle diagnostics are available in the existing authenticated `status`
tool's `events` field and at local `GET /observe` under `events`; shared ingress
exposes only `/mcp`, not this observation endpoint. Diagnostics include sanitized
subscription IDs, exact session/message IDs, expiration/verification-cache times,
delivery IDs/state/attempts, aggregate state counts and `storageFailed`.
Subscription summaries are bounded to the latest 32 stored entries and 24 KiB;
`subscriptionsTruncated` reports omissions. The latest 128 lifecycle records are
also capped at 24 KiB; process counters retain totals across truncated records.
Both counters and recent records reset on restart. Persisted state remains
separate from this process trace.

Lifecycle stages cover subscription receipt/acceptance/rejection, callback verification
(start/success/cache/failure), persisted activation, cancellation/expiry/revocation,
authorization pause/resume, subscriptions recovery, queueing, delivery
attempts/outcomes, delivery failure, callback acknowledgement, storage failure,
and reconciliation failure.
Every record is emitted as sanitized `mcp_events` structured service-log data.
Callback URLs, signing secrets, challenge bodies, grant contexts and raw error
bodies are excluded. `callbackAcknowledged` means HTTP receipt; it does not prove
ChatGPT ran the follow-up or displayed a reply. `events/subscribe` receipt is recorded
at the HTTP entry before SDK wire validation; discovery authorization rejections,
`events/list`/`events/unsubscribe` handling,
and unparsable-transport failures record no lifecycle entry.
Ingress rejections before forwarding require evidence at that owning boundary.

The account plugin's OpenCode Events reference owns platform subscription and
post-turn acceptance instructions. After event changes, rescan the connector and
confirm the event appears alongside tools. Request native ChatGPT monitoring
with exact session/message IDs and verify callback success plus persisted activation
before ending a response or releasing a gated test worker. A native wait, backend
restart or webhook `2xx` is not post-turn chat acceptance. See the
[official MCP Events contract](https://developers.openai.com/plugins/build/mcp-events).

Semantic activity and recent-message summaries use 512 UTF-16-unit text previews
so long Unicode history stays bounded in recovery or action-required responses.
`query messages` pages likewise return 512-unit previews with canonical message
IDs, explicit truncation/paging metadata, at most 10 tool summaries per assistant
entry (`toolCount`/`toolsTruncated` mark the remainder; recover the rest through
`query tools`), and a lossless read-only `nextCall` per entry. Preview
continuations page the remainder at the full on-demand width; an explicit
`type: message` `textLimit` is preserved instead. Recover complete text through
`query message`, which defaults to full text on demand. Compaction entries carry
128-unit summary/recent previews with sizes plus fingerprinted `summaryNextCall`/
`recentNextCall` (or `type: message` `field: summary|recent`) for exact recovery.
Bounded native content keeps default and max pages inside the 256 KiB envelope;
unbounded native fields can still exceed it, in which case the result fails
explicitly and the caller narrows the page. Native opaque cursors and order are
preserved; rows are never skipped and cursors never invented to fit a byte cap.

Catalog the effective native agents and ordered permissions before selecting
execution. Scalar `agent` is the executing session selection; omission on fresh
work selects `build`. `agents[]` is structured prompt context and does not admit
delegated child execution. Native agent APIs are list/get only; the connector
does not create, update or delete agent definitions. Catalog mode/model/rules are
native facts, not a connector permission mode.

Fresh starts require `cwd` and an explicit canonical `provider/model`. Resume and
fork inherit cwd/model/agent, reject conflicting overrides, and require the
canonical model on each start. Agent IDs are canonical IDs, not display names. Scalar `agent` on resume/fork
may be omitted to inherit; an explicit value must match persisted selection.
For active work use `steer`; for idle continuation use `start` with `sessionId`.
Fresh starts accept a catalog-validated `variant`, included in native creation and read back before
the first prompt. Resume/fork inherit canonical variant and reject any variant
override; responses include `modelVariant`.

Start/steer and native session commands accept structured native `files`, `agents`
and `skills`. Files use SDK input `{ uri, name?, description?, mention? }`, not
the persisted attachment shape. Inline files use canonical base64 data URIs,
bounded to 64 KiB decoded; URI credentials are rejected. Agents use canonical
`name` IDs; skills use canonical `id` (native catalogs validate both). Mentions
are exact `{ start, end, text }` UTF-16 prompt ranges. Each kind caps at 20,
text at 64 KiB and serialized attachments at 128 KiB. File contents/URIs and
operator-chosen prompts are not confidentiality boundaries. User prompts retain
their canonical user message identity, not a synthetic admission identity.

`query` supports models, agents, one agent, skills, providers, usage, native session
pages, one session, native message pages, one message, session diffs, inbox,
tool inventories, one tool, permissions, project saved
approvals, and sanitized runtime inventory. Catalog/inventory pages use
`offset`, `limit`, `fingerprint`; native session/message pages use opaque
native cursors instead. Agent details include description, system,
steps, paged permissions, mode, hidden status and model, excluding `request`.
Select `field: permissions` for independent rule pages. Full system/description recovery uses `type: agent`, `agentId`, selected `field` and
text pagination. `type: message` likewise recovers full user/assistant text by
canonical ID. `field: summary|recent` pages the exact native compaction summary
or recent text of a canonical compaction message with fingerprinted continuation.
Session `cost`/`tokens` are cumulative session totals (`usageBasis:
"cumulativeSessionTotals"`); assistant and completed/failed compaction entries
project their own request `requestTokens`/`requestCost` (`requestUsageBasis`
names the native request, `"unavailable"` when absent). Current context-window
occupancy is `unknown`: the pinned native surface exposes cumulative totals and
per-request usage only, never a context-used percentage, so none is projected.
Native session/message cursors are opaque; pass the returned cursor
without `order` on continuation. Text pages use UTF-16 code units and require a
fingerprint at nonzero offsets. Usage or complex unpaged state may hit the
256 KiB ceiling; narrower queries must be used rather than silently truncating.
The pinned client exposes `session.context` as a whole-session read and
`session.log` as a stream (including follow mode), neither with a stable bounded
projection; therefore no context/log query variants are exposed. Provider catalog
`activation` is native configuration state, not authentication or connectivity.
The pinned provider/model catalog provides no reliable sanitized auth/connection
signal; catalog activation does not imply successful execution.

### Agent catalog introspection

`query agents` defaults to a compact **effective** native catalog, including
built-ins and configured agents. Hidden internal agents are excluded unless
`includeHidden: true`. The response returns the native resolved `location`,
`hiddenCount`, page totals and fingerprint. Supply `cwd` to select the project;
omission uses native location resolution. Agent/provider reads reconcile
the native location update stream during bounded initialization, so a transient
empty catalog is not exposed as ready state. If the bounded window ends empty,
those queries preserve that native empty catalog rather than inventing entries.
Model reads instead fail explicitly when the catalog does not stabilize.
The pinned client
does not expose agent provenance, so `provenanceAvailable: false` is explicit;
the connector never guesses builtin/global/project origin from an ID.

```json
{"type":"agents","cwd":"/absolute/project","includePermissionsSummary":true}
```

Compact entries contain canonical ID/name, mode, hidden status, a 512-unit
description preview and model. They omit system instructions, provider request
objects and raw rule chains. `view: full` restores full projected entries;
individual `query agent` fields retain paged instruction/raw rule recovery.
The catalog is bounded to 50 entries per page (default 25). Invalid limits are
schema errors with field/bounds; direct backend pagination names `limit` or
`offset`. Missing individual agents return `errorCode: AGENT_NOT_FOUND` and the
requested `agentId`, without leaking native error bodies.

`includePermissionsSummary: true` adds a structured **agent-rule** summary.
It keeps the last universal baseline, removes earlier universal-shadowed rules
and duplicate matchers, and preserves overlapping wildcard exceptions in native
order. It does not implement a second wildcard matcher or permission authority.
`defaultEffect`, `defaultRuleIndex`, exception `ruleIndex`, `shadowedRuleCount`,
and source fingerprints make overriding rules visible. A final universal allow
has zero surviving exceptions; earlier `.env` asks or plan denials are not
misrepresented as effective restrictions.

Use `query agent field: permissionSummary` to independently page a summary's
`exceptions` with their fingerprint. Use `query permissions section: summary`
for the current persisted agent plus session rules in the session's location.
Unset session agents fail explicitly. These reads are not an atomic snapshot of
all runtime authority. `context` identifies agent versus session scope, and
`excludedLayers` lists saved approvals/policies plus session rules for an agent
summary. Summaries cannot predict every runtime decision, parent/child authority,
or direct HostPlane access. Native evaluation remains authoritative. Continuation
fingerprints include source rules and context, so changes to shadowed rules,
resolved location, view, hidden filter or summary selection invalidate pages.

Additional query details:

- `skill` selects canonical `skillId` and pages full native content.
- `sessionDiff` forwards native `from`/`to` message boundaries scoped to
  `sessionId` and optional `context` (0–1,000). Inventory is fingerprint-paged;
  selected `file` recovers independent patch text pages. It is not a host VCS diff.
- `inbox` pages pending native identities/types/delivery with bounded previews;
  selected `inboxId` pages text. Absence means absent from pending inbox, not
  proof of delivery, cancellation or execution success.
- `tools` pages an assistant message's independent tool inventory beyond summary
  limits. `tool` selects exact `sessionId`/`messageId`/`toolId`, with explicit
  `field: input|content|error`, native timing/status and `contentIndex` for outputs.
  Text output and selected input use fingerprinted text pages. Structured input
  omits credential/config/env/request/provider-state keys. Selected file outputs
  expose bounded name/mime metadata only (`encoding: metadataOnly`,
  `uriOmitted: true`); the connector never fetches a URI automatically and
  returns no inline file bytes or reference text. Error detail preserves type/status but omits
  native message bodies. Reasoning/provider state/request objects stay excluded.
  Arbitrary tool text/input can still contain secrets; select
  evidence deliberately. Existing message/tool summaries remain available.

Result inspection scans up to **500 messages per call** via meaningful native
pagination. It selects the latest assistant inside the requested user's prompt
segment, stopping at the next user boundary; a latest user with no assistant has an
unknown result and cannot inherit an earlier answer. It never falls back to another
prompt when a target is missing. If incomplete, retain `selectionCursor`,
`candidateAssistantMessageId`, and `selectionFingerprint` with the original
`sessionId`/`messageId`. Continue until `selectionComplete`. Session changes
between/during pages reject the scan and require restarting. Text pagination is
separate from selection completeness; recover the selected `assistantMessageId`
through `query message` to avoid rescanning long history. An active session does
not advertise a final selection.

`status` remains execution lifecycle (`inProgress`, `completed`, `failed`,
`interrupted`, `idle`); `executionOutcome` preserves native session outcome.
Derived `outcome` uses selected assistant evidence: `completed` requires a
persisted completion time, `finish: stop` and no error; `failed` retains the
selected error type/status or error finish; other selected finishes are
`incomplete`. Active, unscanned, missing-assistant or unfinished selections are
`unknown`. `outcomeBasis`/`outcomeEvidence` identify the exact assistant and
finish; provider bodies remain omitted. Assistant completion does not verify the
user objective or a host change: inspect the owning filesystem, VCS, process,
tests or deployed service independently. Native idle/execution success is never
substituted for assistant-result evidence.

Native provider retry/backoff is observable through `retry` on status workers,
semantic inspection and active wait responses, selected results (`result.retry`),
and projected assistant messages. It contains the canonical `assistantMessageId`,
native `attempt`, `nextAttemptAtMs`, and error type/status; error messages, bodies,
headers and provider state are omitted. Retrying workers retain `inProgress` and
an unknown final outcome. A scheduled time is native evidence, not a connector
countdown or a guarantee of when the next request starts; passing that time alone
does not clear retry state. Wait continues through backoff until native execution
ends, input is required, or its bounded timeout expires. Step failures and retry
events alone never authorize terminal notifications.

In pinned OpenCode 2.0.22, the [native retry runner](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/runner/retry.ts)
publishes durable `session.retry.scheduled` events, and the [message projector](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/message-updater.ts)
sets `assistant.retry`, clearing it on the next step start, step failure, or
execution termination. The [service active-session endpoint](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/server/src/handlers/session.ts)
only returns `type: running`; the client's legacy `session.status` retry union is
not a recoverable service status snapshot. These projections therefore read
canonical message metadata, without caching event hints or interpreting private
provider payloads. Current retry recovery reads at most 20 recent messages and
stops at the newest assistant or user/idle boundary. `retry: null` means no retry
was observed in that bounded view, not that the provider cannot retry. A failed
extra status read preserves inventory and exposes sanitized `retryReadError`;
exact inspection failures still error. Selected-result retry belongs to the
requested prompt segment, which may differ from current session activity.

The connector submits the canonical prompt once. OpenCode owns same-session
provider retry decisions and delays, including immediate termination for hard
provider failures. Retry observation never admits another prompt, changes its
identity, or replays an uncertain admission; retain the returned recovery identity
and reconcile canonical state.

Status and untargeted terminal semantic recovery scan at most 500 messages per
worker; active workers stay unknown without a result scan. Extra result reads
that fail or race removal retain readiness/inventory and report unknown,
unavailable evidence with a sanitized read error. Exact requested inspection
failures still error. Selection and text fingerprints retain their independent
contracts.

Read-only continuations return `{ tool, arguments }`: result `nextCall` continues
selection with original canonical IDs/cursor/candidate/fingerprint;
`textNextCall` selects the exact assistant via `query message` after selection
completes. Query and host pages return `nextCall` with their fingerprint or native
cursor, including canonical location when available. If an untargeted bounded
scan has no user identity yet, continuation reads native message pages to recover
it rather than guessing a target. These are argument objects, not callbacks or
automatic replay. Mutations and persistent observer command reads have no
automatic continuation. `host.worktree` continuation is list-only despite the
combined tool's conservative lifecycle annotations.

`act switchModel` and `act switchAgent` validate their separate canonical
catalogs and return persisted session readback. These are separate, **non-atomic**
operations; switching one must not be treated as switching both. `switchModel`
accepts an optional catalog-validated `variant`. Omitting model `variant` delegates
resolution to OpenCode; read back its resolved `modelVariant`. `setPermissions` replaces ordered
canonical rules and checks persisted readback. `synthetic` accepts text,
description, native delivery (`steer`/`queue`), and optional resume, returning the
real inbox identity; it is not a user prompt and is not passed to `wait` as one.

`cancelInbox`/`updateInbox` require a pending `inboxId` in the targeted session
and reconcile native pending inventory after mutation. `removeSavedApproval`
removes one project-scoped saved approval by exact `approvalId` resolved from
the targeted session, failing when the ID is absent from that project and
verifying absence after removal. Never automatically retry uncertain removal. If update races delivery,
absence leaves `deliveryVerified: false` and `persisted: false`, not a fabricated
delivery result. `compact` returns its native compaction `inboxId` with `status: "admitted"` and
`completed: false`, plus `correlationSupported: true` and a bounded
verifyNextCall reads the exact native compaction message using its admission
ID. Native inbox IDs are SessionMessage IDs. Verify matching message ID, type and
running/completed/failed status; missing messages and inbox absence prove neither
success nor failure. The message includes its reason, model when available,
summary/recent previews and per-request usage. Recover exact summary/recent
fields through fingerprinted continuations; no timing heuristic or connector
registry is needed.
`command` validates native session command `name` and `invokeSkill` validates
canonical `skillId`. Both upstream operations return `void`, so the connector
returns submission without inventing user `messageId`/inbox identity or completion.
`revertStage`, `revertClear`, and `revertCommit` preserve OpenCode's staged revert
boundary: stage selects a canonical message (and optional native files choice),
clear discards staging, and commit applies the staged revert. Staging is not a
one-shot undo; commit acts on native staged state.
Native **session commands** differ from HostPlane shell/PTY commands. No universal
raw RPC or credential/configuration action is exposed. Never automatically retry
uncertain admission or mutation; reconcile native state first.

## Permissions and authority

`start.permissions` is optional for fresh sessions only. Omission preserves the
native default policy. There is no `permissionMode`, read-only alias, or blanket
allow shortcut. Explicit canonical rules are `{ action, resource, effect }`,
where effect is `allow`, `deny`, or `ask`. Session rules follow agent rules, so
broad session allow can override agent restrictions. Explicit configured deny is
checked before saved approvals. Query `permissions` with `section: rules` (default) or `section: pending`; each
section has independent fingerprinted pagination. Project-scoped saved approvals
have their own query.

Agent names such as `plan` and `explore` are **not** evidence of a constrained
reviewer; inspect the current native ordered rules. A session can use:

```json
[
  {"action":"*","resource":"*","effect":"deny"},
  {"action":"read","resource":"*","effect":"allow"},
  {"action":"glob","resource":"*","effect":"allow"},
  {"action":"grep","resource":"*","effect":"allow"},
  {"action":"external_directory","resource":"*","effect":"deny"},
  {"action":"read","resource":"*.env","effect":"deny"},
  {"action":"read","resource":"*.env.*","effect":"deny"}
]
```

The initial deny blocks edit, shell, Code Mode, subagents and unknown actions.
This is permission-checked worker authority, **not an OS sandbox**. Grep/glob
match queries/patterns, not confidentiality boundaries. Child agents have their
own policy, so this reviewer must not launch them. Allowed tests execute
repository code with host authority. Direct authenticated HostPlane calls do
not inherit worker permissions. No global configuration changes are needed.

The native model catalog alone owns current availability. Price metadata across
all canonical tiers determines `free` regardless of model name or provider: every
tier must explicitly price input/output/cache read/cache write at zero; missing
pricing is not free. The connector adds no provider filter, name heuristic or
duplicate model policy. Model entries retain native capability and compatibility
metadata. Query the catalog in the selected native location.

## Source, packaging and validation

Account-plugin source is owned outside this backend at `~/plugins/0x0perator/`. That
neutral user-root tree contains `0xoperator`, `0xoperator-codex`, and
`0xoperator-opencode` plus the account manifests, assets, and assembler. This
repository owns only the OpenCode Connect backend; account plugins are independently
versioned and published.

```bash
npm test
npm run check
npm run build
git diff --check
```

The canonical build cleans repository-owned `dist` before TypeScript compilation
so deleted source artifacts cannot survive into deployment.

Tests exercise the pinned official client against deterministic native HTTP/wire
fixtures, lifecycle/bounds, Unicode, permission forwarding/readback, sanitized
queries, result recovery beyond 100/500 messages, mutation between pages, and
MCP discovery/image/transport limits. Real HTTP calls exercise the core MCP surface and verify the full 25-tool catalog,
output-schema validation, structured-only results, near-1-MiB PNG reads,
legacy/malformed-wire rejection without native access, localhost Host/Origin
protection, and cancellation without worker interruption. Published `tools/list` schemas expose root
and nested query object properties/discriminator enums alongside strict variant
constraints; JSON Schema validation tests verify unsupported combinations and
bounds independently of the Zod parser. Native session outcomes and exact
assistant error/finish evidence are tested separately, including partial recovery
failures and latest prompts without an assistant. Retry fixtures verify native
backoff, next-step clearing, immediate 403 and exhausted transient failures,
terminal notification gating, sanitized metadata and single prompt admission
across status/inspect/wait/result recovery. An isolated 2.0.22 service with a local
mock provider also verified a 429 scheduled retry followed by success with one
prompt admission, then immediate 403 termination on a second prompt in the same
session. The service emitted `session.retry.scheduled` and exposed matching
assistant metadata; no legacy `session.status` event was observed in that probe.
Source-side disposable live checks used the
existing exact-version runtime for shell decoding/drain and ordinary/persistent
PTY replay/input/resize/expiry. Those checks do not replace operator-owned public
MCP/OAuth acceptance or worker/deployment verification. Live ChatGPT event-triggered
wake-up acceptance requires genuine task/callback credentials and remains a
separate operator check; deterministic webhook receipt is not ChatGPT acceptance.

Node 24+ is required. `npm run dev` starts the local source server; defaults are
loopback `127.0.0.1:8788/mcp`. HOST/PORT come from the process environment;
there is no user-global dotenv loader. Service authentication stays inside the
official client/service API. Secrets remain outside the repository.

Events retain their JSON state at
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode-connect/events/store.json`.
A dedicated built-in SQLite connection holds an exclusive kernel-managed lock
at sibling `store.lock.sqlite` for the store's entire lifetime. Ownership is
released on close, process crash (including SIGKILL), or reboot; it does not
rely on PID liveness or shutdown cleanup. Startup failures also release ownership.
Keep this state on a local filesystem with working SQLite file locking, and
**never delete or replace `store.lock.sqlite` while a connector is running**.
A genuine second owner fails closed; storage/locking errors are not treated as
stale locks. The former PID-only `store.lock` is ignored. Stop all old-version
connector processes before upgrading; deployment activation already stops/restarts
the managed service. Old and new versions must not share a store concurrently.

Native service lifecycle admission occurs only at connector startup. Ordinary calls use native discovery and fail explicitly when unavailable; they never start, replace or recover the service. Health and MCP errors omit raw upstream bodies. Failed starts preserve a known sessionId and admission stage; promptSubmitted null means delivery is uncertain and requires reconciliation.

Native worktree branch is an existing Git reference, not a new branch name. Omit branch and supply name to use native worktree branch creation; errors retain the canonical SDK error type without raw command/provider output.

## Live console

The native terminal console streams assistant text while a selected session is
followed. Tool-only steps show tool names and status, excluding their inputs,
outputs. Reasoning parts show a dim **activity-only** marker: `active` from native
start/delta events or an incomplete part's timing, `ended` from native end events
or completed part timing, and `observed` when persisted parts lack active/end
evidence. These markers are not reasoning summaries or worker-completion claims.
All reasoning text (live and persisted), provider state and request objects stay
excluded; 2.0.22's [native part schema](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/schema/src/session-message.ts)
and [provider round-trip tests](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/test/session-runner.test.ts)
expose no separate guaranteed-safe reasoning summary field.
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
Opening a view reads back to its latest operator
prompt within 500 native messages; subsequent refreshes read one recent page and
update loaded history by canonical message ID. Refreshes do not discard earlier
loaded operator messages or unflushed streamed text. Home/PgUp scroll back;
End/G resumes following. Reopen an existing console process after source updates
to load the new observer.

## Deployment (operator)

States stay distinct: **source** (Git checkout) is never executed live;
**build** is the content-hashed release under
`~/.local/lib/opencode-connect/builds/<buildId>/`; **deployed** is the
`current` symlink target; **live** is what `/health` reports.

Build identity is the 16-hex SHA-256 over `package.json`,
`package-lock.json`, `tsconfig.json` and `src/**/*.ts`. A dirty tree is
allowed; commit/branch/dirty metadata is observability-only in `build.json`.
Identical content reuses the existing build directory and never rebuilds.

```bash
npm run build
npm run deploy -- prepare                 # isolated build, then production-only runtime deps
npm run deploy -- status                  # current/previous, service, live health, source
npm run deploy -- activate <buildId>      # switch current, restart only opencode-connect.service, verify /health
npm run deploy -- rollback                 # switch to previous, restart, verify; reversible via second rollback
```

`prepare` copies runtime sources into a staging directory, installs the full
locked toolchain, compiles there, prunes development-only dependencies, writes
`build.json`, and renames into place. It never uses the checkout
`node_modules`/`dist`.
`activate` preserves the old `current` target in `previous`, restarts only
`opencode-connect.service` (`systemctl --user`), and polls `/health` until the
exact `buildId` matches. On verification failure it restores the old target
and unit state when possible and reports rollback failure separately.
`rollback` swaps `current`/`previous` so a second rollback restores.

`/health` reports `{ version, buildId, build }` alongside `upstream`.
Deployed releases report their content hash; source runs (`npm run dev`,
checkout `dist`) report the explicit non-release identity `buildId: "source"`.

The unit template at `deploy/systemd/opencode-connect.service` points at
`~/.local/lib/opencode-connect/current` for both working directory and
`ExecStart`. It expects a stable Node executable at `~/.local/bin/node`, so a
version manager can be upgraded without baking a user name or version-specific
NVM path into the unit. It does not touch ingress, OAuth, ngrok, or other services.
The operator owns unit installation, activation and runtime verification.
