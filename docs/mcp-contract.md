# MCP contract

This document owns the connector's public transport, tool, projection and recovery
contracts. Live MCP discovery owns the exact deployed schemas. OpenCode owns its
native catalogs, selection, permissions, lifecycle, ordering and identities; the
connector does not add another native policy layer. Native browser operations have
their own [browser contract](browser-capability.md).

## OpenAI requirements and interface design

The [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server),
[metadata guidance](https://developers.openai.com/plugins/guides/optimize-metadata),
[tool reference](https://developers.openai.com/plugins/reference), and
[plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) govern
the ChatGPT-facing interface:

- Expose focused user-goal operations with accurate descriptions, explicit input
  and output schemas, and stable native identifiers. Keep important cross-tool
  instructions within the first 512 characters of server instructions.
- Publish accurate read-only, destructive, open-world and idempotent hints. Hints
  describe effects; they do not grant authority or replace server-side checks.
- Keep results concise and useful. Structured results must match the advertised
  output schema; ordinary structured results need no duplicate JSON text.
- Evaluate direct, indirect and negative prompts against actual selected tools,
  arguments and outcomes. Use the [operator acceptance matrix](operator-acceptance.md).
  Metadata bytes and backend timings alone do not establish ChatGPT ergonomics.
- Validate live client exposure after metadata changes using OpenAI's
  [connection testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt).
  Source tests, connection refresh and successful live actions are separate evidence.

Public OAuth discovery, token validation, resource-metadata challenges and grant
revocation belong to shared host-ingress. Its public route is
`/opencode-connect/mcp`; it forwards to loopback `/mcp` after stripping public
Authorization and Cookie headers. Per-tool auth declarations must reflect that
owning boundary. Do not invent `noauth`, scopes or a second OAuth implementation.
Validate challenges, authorized calls and expired/revoked grants at ingress under
the [OpenAI authentication contract](https://developers.openai.com/plugins/build/auth).

The repository projects the current MCP wire contract. Initialization examples in
other guides do not justify a legacy protocol adapter. The explicit rejection
settings and negative protocol tests enforce the supported boundary.

## Transport and discovery

The pinned official MCP SDK per-request HTTP entry serves only `2026-07-28`
using `server/discover`, per-request `_meta`, and matching standard
`MCP-Protocol-Version`, `Mcp-Method`, and method-specific `Mcp-Name` headers.
Client capabilities are required; client identity follows the SDK's current
[protocol contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).
The HTTP entry caps complete request bodies at **4 MiB**, including metadata,
at both the Express parser and Fetch handler. This accommodates multi-step
Unicode browser input and full permission/attachment sets. SDK tool validation
allows at most **4,096 object keys and array elements** across one argument tree,
independently of byte size; oversized input fails before tool execution.
Parser failures return sanitized JSON errors without body or stack diagnostics.
Input/output discovery uses JSON Schema 2020-12. Strict discriminated
unions own validation and publish model-visible properties plus variant restrictions.
Discovery includes concise server instructions for shared identity, command
lifecycle and recovery rules. Purpose-specific tools have selector-free inputs;
internal backend discriminators are not public arguments.
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
## Events and continuation

Event methods and their capability are registered as the OpenAI MCP Events
extension. When the current platform supports event-triggered tasks, create one using the
connected plugin's event, exact worker IDs as filters, and saved canonical-result
inspection and follow-up instructions. That task causes
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
schedule. One delivery tick considers at most eight due subscriptions, counting
authorization-unavailable grants toward its work bound and rotating its
starting position to avoid starvation. It never drains the queue, and
per-delivery backoff, authorization, and storage semantics are unchanged.
An event already durably queued for delivery does not remain a native
reconciliation target; the queue owns its retries, including after restart.
Shutdown rejects new state mutations and drains accepted work before
releasing the exclusive Events store lock.
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
stable `eventId` and reconcile with `opencode.inspectResult`.

Event lifecycle diagnostics are available in the authenticated `status.recovery`
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

PlatformPlane guidance decides whether the current ChatGPT surface actually
supports post-turn continuation. Discover the native global `opencode-connect` skill and its Events reference
through `opencode.skills` and `opencode.skill` for task-specific operating guidance. After event
changes, rescan the connector and confirm the event appears alongside tools.
Request native ChatGPT monitoring with exact session/message IDs and verify
callback success plus persisted activation before ending a response or releasing
a gated test worker. A native wait, backend restart or webhook `2xx` is not
post-turn chat acceptance. See the
[official MCP Events contract](https://developers.openai.com/plugins/build/mcp-events).

## HostPlane

| Tool | Native surface |
| --- | --- |
| `host.list`, `host.read`, `host.find`, `host.vcs`, `host.vcsStatus`, `host.vcsBranch`, `host.vcsDiff`, `host.commands`, `host.terminalScreen`, `host.terminalSnapshot` | One purpose-specific native host read each |
| `host.write` | Native bounded UTF-8/base64 file write, explicit overwrite/fingerprint, persisted readback |
| `host.worktreeList`, `host.worktreeCreate`, `host.worktreeRemove`, `host.worktreeRefresh` | One purpose-specific native project worktree operation each |
| `command.startShell`, `command.startPty`, `command.startPersistentPty` | Start one native command kind |
| `command.read` | Read-only shell/ordinary PTY replay; native handle + canonical cwd/location + saved cursor |
| `command.observePersistentPty` | Persistent replay with native observer exit cleanup; can remove the exited handle |
| `command.remove`, `command.resize`, `command.input`, `command.interrupt`, `command.ctrlD` | One purpose-specific native command control each |

Each operation supplies an absolute `cwd`; responses return the native canonical
`location` and `cwd` where applicable. Save `kind`, `id`, canonical location,
and cursor together. Shell commands are strings interpreted by OpenCode's
selected native shell. PTY commands are executables with separate `args`.
Persistent PTY admission additionally requires a native `sessionId` whose
canonical location matches `cwd`. No command environment/configuration or
connect ticket is exported. Inventory uses explicit safe fields and excludes
auth, environment, provider request objects, config, and raw plugin/MCP errors.
Operator-chosen file contents and command output still require secret hygiene.

Host and command operations are distinct purpose-specific tools; no generic
operation-selector executor or compatibility alias is exposed. For example,
`host.list` accepts `{"cwd":"/workspace"}` and `host.read` accepts
`{"cwd":"/workspace","path":"README.md","limit":2000}`. Replace
`/workspace` with the authorized absolute directory. `command.startShell` starts
a shell process. Unknown fields remain rejected.

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
Create/remove/refresh read back native inventory. `host.worktreeList` is read-only
and idempotent. Create/remove are destructive and non-idempotent; refresh changes
cached inventory without creating/removing worktrees and is idempotent. Native
failures remain failures; safe error types are retained without raw native bodies.

Images are optional `read` results with `image: true`, limited to **1 MiB** and
signature-checked PNG, JPEG, GIF, or WebP. MCP returns one image block plus
metadata, without duplicate base64 in text or structured data. SVG/HTML and
oversized images fail. Ordinary object results use MCP `structuredContent` with `content: []`; image
reads carry one image block. Browser tool errors also include concise sanitized
standard text so clients that render only content retain the cause and dispatch evidence. Every tool publishes an explicit output schema. Connector errors return structured `error` (and admission
`recovery` where applicable) with `isError: true`; their existing envelopes are
included in each advertised output schema. SDK input errors retain SDK formatting;
strict union errors omit arbitrary unknown field names rather than echoing them.
The serialized `{ structuredContent }` projection has a repository-policy
**256 KiB** ceiling, independent of the **1 MiB decoded image** allowance.
Oversized JSON results fail explicitly; narrow the page or detail. OpenAI's
256 KiB requirement applies to complete outbound **event request bodies**, not
tool images or this repository's JSON projection policy.

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
Persistent observer exit cleanup makes `command.observePersistentPty` destructive
and non-idempotent. `command.read` accepts only shells and ordinary PTYs and is
read-only. No retained-exit promise is made for persistent observation.

`host.terminalScreen` uses native session terminal `read` with bounded
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

`status.readiness`, `status.recovery`, `opencode.create`, `opencode.continue`,
`opencode.fork`, `opencode.wait`, `opencode.inspectActivity`, `opencode.inspectResult`, individually
named `opencode.*` query tools, and individually named `opencode.*` session action
tools retain OpenCode's native worker identities. Actions include `opencode.steer`,
`opencode.updateInbox`, `opencode.respondPermission`, `opencode.switchModel`, and
`opencode.delete`; each action tool has its own selector-free input schema.
Set `runtime: "codex"` to operate native Codex sessions through the same tools.
Codex has its own session IDs and a narrower capability contract, described below.
Events wake bounded waits; persisted session/message state remains authoritative.
Stale/unrelated terminal hints cannot force completion; timeout reconciles canonical
state even when the terminal event was missed. SDK request cancellation or HTTP
disconnect releases the wait's native read/event observer without interrupting
the retained worker; use `opencode.interrupt` to stop native execution.

For a quick availability check, use `status.readiness`; use `status.recovery` for
active/recent worker inventory and result evidence. These have separate inputs;
readiness performs no worker inventory reads.
It returns connector version/build identity and OpenCode readiness without reading
worker/session history or Codex RPC. Component summaries cover events and the local
browser supervisor; they do not probe Chrome, validate a lease, or verify the Codex
plugin or quota. An unavailable OpenCode returns `ready: false` with connector
identity and a sanitized issue. `status.recovery` accepts an optional runtime to
select that worker inventory and preserves existing result evidence.
Use `browser.status` for browser endpoint and attachment diagnosis. See the
[operator acceptance matrix](operator-acceptance.md) for measurement and
the remaining ChatGPT workflow checks.

Semantic activity and recent-message summaries use 512 UTF-16-unit text previews
so long Unicode history stays bounded in recovery or action-required responses.
`opencode.messages` pages likewise return 512-unit previews with canonical message
IDs, explicit truncation/paging metadata, at most 10 tool summaries per assistant
entry (`toolCount`/`toolsTruncated` mark the remainder; recover the rest through
`opencode.tools`), and a lossless read-only `nextCall` per entry. Preview
continuations page the remainder at the full on-demand width; an explicit
`opencode.message` `textLimit` is preserved instead. Recover complete text through
`opencode.message`, which defaults to full text on demand. Compaction entries carry
128-unit summary/recent previews with sizes plus fingerprinted `summaryNextCall`/
`recentNextCall` (or `opencode.message` with `field: summary|recent`) for exact recovery.
Bounded native content keeps default and max pages inside the 256 KiB envelope;
unbounded native fields can still exceed it, in which case the result fails
explicitly and the caller narrows the page. Native opaque cursors and order are
preserved; rows are never skipped and cursors never invented to fit a byte cap.

Scalar `agent` is the executing session selection; omission on fresh work lets
OpenCode choose its configured default. `agents[]` is structured prompt context
and does not admit delegated child execution. Native agent APIs are list/get only; the connector
does not create, update or delete agent definitions. Catalog mode/model/rules are
native facts, not a connector permission mode.

Fresh starts require `cwd`; model and agent are optional. Omitted selections are
left out of native `session.create` so OpenCode chooses its configured defaults.
Resume and fork inherit cwd/model/variant/agent without requiring callers to replay
them. An explicit model or agent must match persisted native selection before any
mutation. Agent IDs are canonical IDs, not display names. Responses read native
selection after prompt admission and report nullable model/agent only when native
state remains unset.
For active work use `opencode.steer`; for idle continuation use
`opencode.continue` with `sessionId`.
Fresh starts accept a native `variant` with an explicit model, included in native
creation. Resume/fork inherit canonical variant and reject any variant override;
responses include the post-admission native `modelVariant`.

`opencode.create`, `opencode.continue`, `opencode.fork`, `opencode.steer` and native session commands accept structured native `files`, `agents`
and `skills`. Files use SDK input `{ uri, name?, description?, mention? }`, not
the persisted attachment shape. Inline files use canonical base64 data URIs,
bounded to 64 KiB decoded; URI credentials are rejected. Agents use canonical
`name` IDs; skills use canonical `id` (native catalogs validate both). Mentions
are exact `{ start, end, text }` UTF-16 prompt ranges. Each kind caps at 20,
text at 64 KiB and serialized attachments at 128 KiB. File contents/URIs and
operator-chosen prompts are not confidentiality boundaries. Native prompt/session
endpoints validate agent and skill identities. User prompts retain
their canonical user message identity, not a synthetic admission identity.

Purpose-specific query tools include `opencode.models`, `opencode.agents`,
`opencode.agent`, `opencode.skills`, `opencode.skill`, `opencode.providers`,
`opencode.usage`, `opencode.sessions`, `opencode.session`, `opencode.messages`,
`opencode.message`, `opencode.sessionDiff`, `opencode.inbox`, `opencode.tools`,
`opencode.tool`, `opencode.permissions`, `opencode.savedApprovals`, and
`opencode.runtime`, plus the separate `codex.quota` read. There is no batch query executor.
Each query output has one fixed-identity result entry; errors in that entry also
set the MCP tool error flag. Catalog/inventory pages use
`offset`, `limit`, `fingerprint`; native session/message pages use opaque
native cursors instead. Agent details include description, system,
steps, paged permissions, mode, hidden status and model, excluding `request`.
Session inventories explicitly identify `runtime` on the page and each record.
OpenCode `status` derives from native active state and execution outcome;
`executionOutcome` preserves native `succeeded|failed|interrupted`, not assistant
result success. Inventory `outcome` is `unknown`, with `outcomeBasis: "unavailable"`:
no assistant-result evidence is read by listing. `createdAtMs`, `updatedAtMs`,
`idleAtMs`, and `archivedAtMs` preserve native timestamps when available.
Codex ACP listing supplies metadata. A bounded, read-only Codex App Server lookup
can add verified terminal execution with `outcomeBasis: "nativeTurnHistory"`.
Without that correlated evidence, `status`/`executionOutcome` are `null` and outcome
is unknown. The optional native RFC3339 update time becomes `updatedAtMs`; other
timestamps are `null` (unavailable, not proof of no archive).
Codex retains native cursor/page size/ordering and accepts only `cwd` and `cursor`;
`limit`, search and offset/fingerprint filters are rejected, never ignored.
Titles are displayed, not classified. No archive action is implemented.
Select `field: permissions` for independent rule pages. Full system/description recovery uses `opencode.agent`, `agentId`, selected `field`
and text pagination. `opencode.message` likewise recovers full user/assistant text by
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

`opencode.agents` defaults to a compact **effective** native catalog, including
built-ins and configured agents. Hidden internal agents are excluded unless
`includeHidden: true`. The response returns the native resolved `location`,
`hiddenCount`, page totals and fingerprint. Supply `cwd` to select the project;
omission uses native location resolution. Model, agent and provider queries read
their native endpoints directly and preserve native empty results.
The pinned client
does not expose agent provenance, so `provenanceAvailable: false` is explicit;
the connector never guesses builtin/global/project origin from an ID.

```json
{"cwd":"/absolute/project","includeHidden":false}
```

Compact entries contain canonical ID/name, mode, hidden status, a 512-unit
description preview and model. They omit system instructions, provider request
objects and raw rule chains. `view: full` restores full projected entries;
individual `opencode.agent` fields retain paged instruction/raw rule recovery.
The catalog is bounded to 50 entries per page (default 25). Invalid limits are
schema errors with field/bounds; direct backend pagination names `limit` or
`offset`. Missing individual agents return `errorCode: AGENT_NOT_FOUND` and the
requested `agentId`, without leaking native error bodies.

Raw ordered agent permissions remain available through `opencode.agent` with `field: permissions`; raw ordered session rules and pending requests remain available
through `opencode.permissions`. No connector-derived permission summary is exposed.

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
through `opencode.message` to avoid rescanning long history. An active session does
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

Retry projections read canonical assistant message metadata, without caching
event hints or interpreting private provider payloads. Current retry recovery
reads at most 20 recent messages and
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
`textNextCall` selects the exact assistant via `opencode.message` after selection
completes. Query and host pages return `nextCall` with their fingerprint or native
cursor, including canonical location when available. If an untargeted bounded
scan has no user identity yet, continuation reads native message pages to recover
it rather than guessing a target. These are argument objects, not callbacks or
automatic replay. Mutations and persistent observer command reads have no
automatic continuation. `host.worktreeList` continuations remain read-only.

`opencode.switchModel` and `opencode.switchAgent` delegate validation to their native
session endpoints and return persisted session readback. These are separate, **non-atomic**
operations; switching one must not be treated as switching both. `switchModel`
accepts an optional native `variant`. Omitting model `variant` delegates
resolution to OpenCode; read back its resolved `modelVariant`. `setPermissions` replaces ordered
canonical rules and checks persisted readback. `synthetic` accepts text,
description, native delivery (`steer`/`queue`), and optional resume, returning the
real inbox identity; it is not a user prompt and is not passed to `wait` as one.

Delete one exact native session with
`opencode.delete { "runtime": "opencode"|"codex", "sessionId": "…" }`.
Deletion requires explicit runtime in both MCP validation and the facade.
OpenCode preflight refuses native active execution, pending permission requests,
forms or inbox work, and fails closed when that state cannot be read. Codex refuses
locally supervised execution/admission and pending approvals; ACP listing does
not expose authoritative external execution state. These checks are not an atomic
cross-client exclusion guarantee. Resolve/interrupt work explicitly and reconcile
before deletion; inventory alone is not delete authorization.
`deleted: true` requires OpenCode typed not-found readback or Codex absence from a
complete bounded native catalog scan. Codex without native delete/list support
refuses before mutation. Partial scans, remaining records or failed readback are
not success. Never automatically retry uncertain deletion.
`DELETE_NOT_FOUND` is a pre-mutation refusal only: OpenCode's typed
`SessionNotFoundError` from `session.get`, or Codex's `unknown_session` after a
complete bounded native catalog scan before submitting delete. A failed/partial
scan is `DELETE_PREFLIGHT_FAILED`, not not-found. ACP delete-request failures,
including not-found-like rejections after submission, remain uncertain; no
transport failure is inferred to mean absence.
Known application failures return MCP `isError` and safe `errorCode`, `reason`,
`mutationMayHaveOccurred`: `DELETE_RUNTIME_REQUIRED`, `DELETE_NOT_FOUND`, `DELETE_SESSION_ACTIVE`,
`DELETE_PENDING_APPROVAL`, `DELETE_PENDING_FORM`, `DELETE_PENDING_INBOX`,
`DELETE_PREFLIGHT_FAILED`, `DELETE_UNSUPPORTED`, `DELETE_BUSY`, `DELETE_FAILED`,
or `DELETE_UNVERIFIED`. Schema rejection occurs before application execution;
platform/tool permission or transport rejection outside this service cannot be
observed or diagnosed by the connector. Native error bodies are omitted.

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
`command` and `invokeSkill` delegate identity validation to their native session
endpoints. Both upstream operations return `void`, so the connector
returns submission without inventing user `messageId`/inbox identity or completion.
`revertStage`, `revertClear`, and `revertCommit` preserve OpenCode's staged revert
boundary: stage selects a canonical message (and optional native files choice),
clear discards staging, and commit applies the staged revert. Staging is not a
one-shot undo; commit acts on native staged state.
Native **session commands** differ from HostPlane shell/PTY commands. No universal
raw RPC or credential/configuration action is exposed. Never automatically retry
uncertain admission or mutation; reconcile native state first.

### Codex sessions

Use `opencode.create` with `runtime: "codex"`, `task`, and an existing absolute
`cwd`. Admission returns the actual native Codex `sessionId` after session setup
and native mode selection. Fresh sessions default to native `agent` mode.
Optional `mode` selects `read-only`, `workspace-write`, `agent`, or
`agent-full-access`. ACP prompt execution continues asynchronously;
`messageId` is null because ACP does not return a canonical user prompt ID at
admission. Retain the runtime and session ID together. Never retry uncertain
admission automatically; a known session ID remains available for reconciliation.

`opencode.inspectActivity`, `opencode.inspectResult`, and `opencode.wait` accept the same runtime and session ID.
They observe the current session turn, not an exact historical prompt. Omit
`messageId`; `capabilities.exactPromptWait` is false. Results retain the native
assistant ID when available, bounded text pagination and explicit truncation.
Wait is bounded to 40 seconds. A terminal result distinguishes native prompt
completion from objective success. Pending native permissions wake wait with
`actionRequired` and appear in `pendingActions`. After adapter restart or cache eviction,
native conversation history is recoverable. A separate read-only App Server lookup
can establish the newest terminal turn when its thread identity and session
revision match. Such results carry `outcomeBasis: "nativeTurnHistory"`; missing,
in-progress or mismatched evidence leaves outcome unknown and wait returns
`executionUnavailable`. Recovered mode remains unknown even when a turn outcome
is verified.

Continue an idle session with `opencode.continue runtime: "codex" sessionId task`.
Continuation inherits cwd and the locally known mode. If selection was lost
after cache eviction or restart, continuation requires an explicit `mode`;
native history does not prove the previous selection. Interrupt with
`opencode.interrupt`; this preserves the conversation. Execution
capacity remains reserved until the ACP process is reaped. Delete an idle native
session with `opencode.delete` and explicit `runtime: "codex"`. The plugin has two execution slots, one bounded
metadata connection, and a 64-entry expiring supervision cache. Cache eviction
never deletes native Codex sessions.

`opencode.sessions`, `opencode.session`, `opencode.messages`, `opencode.message`,
`opencode.runtime`, and `opencode.permissions` with `section: "pending"` accept
`runtime: "codex"`. Native history
replay supplies canonical user and assistant IDs. Message inventories page a
bounded history snapshot with offsets and fingerprints; full text recovery uses
native message IDs. `historyComplete: false` and `outputTruncated` disclose
retention limits. Missing exact messages fail without selecting another result.
Session inventories use the ACP native cursor. `status.recovery` with `runtime: "codex"` reports
locally supervised sessions; native inventories use `opencode.sessions`.

Codex inherits its own configured model and uses native sandbox and approval
presets. Native `agent` grants workspace writes with automatic approval review;
`workspace-write` routes escalation to the operator, `read-only` selects the
native read-only sandbox, and `agent-full-access` explicitly disables sandbox
and approval checks. Choose full access only for an authorized need.

Answer pending permissions with `opencode.respondPermission`, `runtime: "codex"`,
the owning `sessionId`, `requestId`, and exact offered
`optionId`. Native options are not translated to OpenCode decisions. Inspect
the bounded command or diff first; truncated requests cannot be approved.
Stale, foreign, and duplicate replies fail. Handle requests within the task
authority without repeatedly interrupting the user for routine implementation.

Codex executes native tools; ACP filesystem and terminal client access remain
disabled. Model and agent selection, fork, attachments, active steering, inbox,
compaction and MCP Events are not exposed for Codex. Unsupported operations fail
explicitly instead of reaching OpenCode or fabricating IDs. Ordinary native
OpenCode operations retain their existing behavior.

## Permissions and authority

`opencode.create.permissions` is optional for fresh sessions only. Omission preserves the
native default policy. There is no `permissionMode`, read-only alias, or blanket
allow shortcut. Explicit canonical rules are `{ action, resource, effect }`,
where effect is `allow`, `deny`, or `ask`. Session rules follow agent rules, so
broad session allow can override agent restrictions. Explicit configured deny is
checked before saved approvals. Call `opencode.permissions` with `section: rules` (default) or `section: pending`; each
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

The native model catalog alone owns current availability. The connector does not
filter disabled models or derive a `free` eligibility judgment. Model entries
retain native `enabled`, cost tiers, capability and compatibility metadata. Query
the catalog in the selected native location.
