# MCP tool granularity review and resolution

Review date: 23 October 2026. Review baseline: `ff631c22f907321d4e315b3d2b3b1a74cf8792ea` (`0.14.2`). Implemented source version: `0.15.0`.

Version 0.15.0 closes the three demonstrated contract gaps, consolidates the two confirmed browser gesture pairs, and separates persistent command observation and Codex quota from their broader reads. Status, worker lifecycle, native query, worktree and consequential mutation boundaries remain distinct. The click variants retain their explicit gesture names: this review established no routing benefit from merging them.

This is a source review and decision record. Current MCP discovery remains authoritative. Source verification does not establish live deployment or client refresh. No deployed service, plugin release or installed configuration was changed.

## Resolution in 0.15.0

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| Unsupported runtime/field combinations | Public schemas reject unsupported Codex queries/actions, exact-prompt wait IDs, wrong permission sections, native history cursors and unsupported session filters before connection. Adapter guards remain. | Independent JSON Schema validation and actual MCP calls reject all covered combinations without connecting; supported OpenCode and Codex cases still validate. |
| Unmarked focused query errors | Failed native queries and failed Codex quota reads set MCP `isError: true`, retaining sanitized typed evidence. | Forced native and RPC failures are flagged; private upstream text is absent and no quota fallback occurs. |
| Family-wide focused outputs | Each query publishes exactly one result at index zero with its owning query type. Activity and result inspection have separate OpenCode branches and retain shared Codex inspection. | Wrong identities, indexes, cardinality and inspection branches reject; opaque native fields and the existing wire envelope remain accepted. |
| Keyboard/scroll duplication | `browser.keypress` accepts optional validated modifiers. `browser.scroll` accepts optional `deltaX` and performs one instant scroll for both axes. Retired aliases and private dispatch branches are removed. | MCP dispatch, schema/Python boundary tests and real Chrome preserve shortcut selection, plain keys, axis bounds, CSS-independent instant scrolling and vertical-only horizontal-position preservation. |
| Persistent command-read lifecycle | `command.read` accepts shells/ordinary PTYs with read-only annotations. `command.observePersistentPty` supplies the persistent kind internally and retains destructive native observer cleanup. | Input/output identities are disjoint. Both native PTY replay paths still cross the HTTP boundary and retain metadata-unavailable evidence. |
| Token activity versus quota | `opencode.usage` is OpenCode-only; `codex.quota {}` uses the existing read-only plugin RPC without a model turn. | The real native client reaches the installed workspace RPC harness, returns sanitized windows, and issues no native model calls. HTTP cancellation still aborts quota collection. |

Caller migration is documented in [the README](../README.md#mcp-tool-contracts-in-015). Catalog discovery measures 71 core tools and 25 optional browser tools, still 96 total; the goal is clearer contracts rather than a fixed tool count.

| Serialized discovery measurement | Review baseline 0.14.2 | Implemented 0.15.0 |
| --- | ---: | ---: |
| Input schema bytes | 134,853 | 127,111 |
| Output schema bytes | 177,782 | 169,235 |
| Complete tool array bytes | 346,110 | 330,096 |

These source measurements do not establish model token use, routing accuracy or live latency.

Acceptance completed:

- The three contract regression tests failed against the original implementation and pass after correction; the dedicated contract file now contains five passing tests.
- `npm run check:all`, `npm run test:all`, `npm run build` and `npm run verify:integration` passed. The core suite passed 408 tests with three opt-in skips; the native plugin suite passed 145 tests.
- The separate opt-in browser suite passed all 39 tests, including its Python boundary checks and real Chrome acceptance/recovery cases in an isolated profile.
- The operator fixture benchmark verified 20 readiness and 20 recovery trials. Readiness made one native request per trial; recovery made 35 for the bounded inventory fixture.

The baseline analysis below records the evidence and initial dispositions that led to these changes.

## Decision criteria

A separate tool earns its place when it exposes a distinct caller intent, different authority or lifecycle effects, materially different evidence, or a useful independently bounded contract. Mapping to a different native endpoint alone is insufficient. Identical input schemas alone do not imply redundancy: session interruption and deletion have different effects despite similar identifiers.

Parameters suit variations within one operation, including pagination, filters, dimensions, key modifiers and scroll axes. Keep runtime selection together when it means the same task with native differences; restrict unsupported combinations at the public boundary. Consider schema size and selection ambiguity alongside semantic clarity. Tool count is not a performance measurement.

## Catalog measurements

Both source revisions were enumerated through actual MCP SDK `tools/list` responses using the same installed SDK and in-memory transport, with browser tools enabled and no live runtime requests. The baseline is `1a53908613d0632531400b5001ed391665fed051`, immediately before the host/command, query, action and worker lifecycle splits.

| Measurement | Before splits | Current |
| --- | ---: | ---: |
| Core tools | 12 | 69 |
| Optional browser tools | 27 | 27 |
| Total tools | 39 | 96 |
| Input schema JSON bytes | 143,452 | 134,853 |
| Name, title, description and input schema JSON bytes | 156,213 | 156,686 |
| Output schema JSON bytes | 96,411 | 177,782 |
| Complete tool array JSON bytes | 257,355 | 346,110 |

The name/title/description/input representation increased 0.30%; inputs alone decreased 5.99%. The complete tool array increased 34.49%, primarily through output schema repetition. The earlier merge review's 40.16% reduction compared two already split 96-tool revisions, rather than the original 39-tool catalog. Both comparisons are valid for their respective baselines.

These are serialized byte measurements, not model tokens, tool-selection accuracy or ChatGPT latency. The host may expose or retrieve tool metadata differently. No routing improvement or regression is established by these sizes.

| Current family | Tools | Input schema bytes | Complete tool-object bytes |
| --- | ---: | ---: | ---: |
| Status | 2 | 429 | 6,460 |
| Host | 15 | 6,470 | 39,747 |
| Command | 9 | 3,385 | 19,143 |
| OpenCode/Codex | 43 | 35,946 | 137,685 |
| Browser | 27 | 88,623 | 142,978 |

The browser accounts for 65.72% of input schema bytes. Its action schemas repeatedly carry the shared postcondition contract, making a redundant browser action more expensive than a small terminal convenience tool. Browser definitions were already split before this modernization.

All 96 source tool names match the connector tools exposed in the reviewing conversation after normalizing transport names. This establishes name coverage, not equality of live and source schemas or acceptance of live actions.

## Contract findings

### 1. Public schemas advertise unsupported Codex calls

The common runtime parameter accepts Codex on eleven native-only queries and sixteen native-only session actions. The Codex adapter supports only seven query types and three action types. The public wait schema also accepts a Codex `messageId`, which the adapter explicitly rejects. Supported Codex queries have further restrictions absent from the public schema: permissions require `section: pending`, session inventory rejects `limit` and search, and message history rejects native cursors and compaction fields.

Independent JSON Schema validation and actual MCP calls reproduced these mismatches:

| Tool and input | Published schema | Actual dispatch |
| --- | --- | --- |
| `opencode.models {runtime: codex}` | Accepts | Unsupported query |
| `opencode.switchModel {runtime: codex, sessionId, model}` | Accepts | Unsupported action |
| `opencode.permissions {runtime: codex, sessionId}` | Accepts | Requires pending-request section |
| `opencode.sessions {runtime: codex, limit: 25}` | Accepts | Rejects caller-selected limit |
| `opencode.messages {runtime: codex, sessionId, cursor}` | Accepts | Rejects native cursor |
| `opencode.wait {runtime: codex, sessionId, messageId}` | Accepts | Exact-prompt waiting unsupported |

These probes reached no native HTTP endpoint. Rejection is safe, but the public contract needlessly invites calls that cannot succeed. Restrict known unsupported runtimes and express supported field combinations in both JSON Schema and runtime validation. Preserve the adapter guards for non-MCP callers. This projects the existing bridge contract; it must not invent new native selection policy or duplicate dynamic catalogs.

Owners: [public query schemas](../src/mcp.ts#L134), [public wait schema](../src/mcp.ts#L341), [action registration](../src/mcp.ts#L440), [Codex action boundary](../src/codex.ts#L149), [Codex query boundary](../src/codex.ts#L174).

### 2. A failed focused query can appear successful at the MCP boundary

Each focused query still goes through a batch-oriented backend that catches errors inside `results[]`. The MCP adapter returns this object without setting `isError`. A deliberately failed OpenCode model-catalog read returned an error entry with the MCP error flag absent. An unsupported Codex model query did the same. This is not limited to unavailable runtimes.

For a single-operation public tool, failure of its sole query should be a tool error. Keep the backend's per-entry behavior where internal callers need it; have the focused MCP adapter project the failure correctly. MCP treats an absent error flag as success and recommends flagging tool execution errors in the result. See [MCP CallToolResult](https://modelcontextprotocol.io/specification/2025-11-25/schema#calltoolresult).

Owners: [query error capture](../src/opencode.ts#L370), [focused query callback](../src/mcp.ts#L410).

### 3. Focused output contracts retain unnecessary family-wide freedom

All eighteen query tools publish the same batch result schema. A model-catalog output validator accepts `{results:[{index:7,type:"session",result:{unrelated:true}}]}`. It also allows arbitrary result counts. The split made input selection precise without establishing corresponding output ownership.

Keep native object payloads open where their native owner controls the shape. Narrow the connector-owned envelope to the one selected operation, with a fixed operation identity and singleton cardinality if retaining the existing wire shape. Returning the single result directly is a possible API change, but is unnecessary to correct the current validation gap.

`opencode.inspectActivity` and `opencode.inspectResult` likewise publish identical output schemas containing both OpenCode branches. Their purposes should remain separate; narrow each to its own OpenCode result while retaining the supported shared Codex inspection branch. Reuse existing owning schemas rather than introducing a second native object model.

Owners: [query output envelope](../src/results.ts#L103), [inspection output union](../src/results.ts#L81), [focused inspection registrations](../src/mcp.ts#L366).

## Granularity recommendations

### Consolidate two browser gesture pairs

- `browser.scroll` and `browser.scroll_xy`: one bounded element-scroll operation with optional horizontal displacement expresses the documented task. Both are programmatic DOM scrolling; neither is a trusted physical wheel event. Current implementation details differ (`scrollBy` with explicit instant behavior versus scroll-position assignments), so consolidation needs a deliberate scrolling contract and regression checks, including scrollable containers and relevant CSS behavior.
- `browser.keypress` and `browser.key_combo`: one bounded key operation with optional modifiers expresses both tasks. Preserve all currently supported keys, focus checks, modifier validation and the correct event sequences. Their different key allowlists are implementation constraints to preserve, rather than an independent caller objective.

These changes would replace four tools with two. They do not require a generic browser action executor. Owners: [gesture inputs](../src/browser/schemas.ts#L25), [keyboard dispatch](../src/browser/worker.py#L997), [scroll dispatch](../src/browser/worker.py#L964).

### Compare click variants before merging them

`browser.click`, `browser.right_click` and `browser.double_click` share exact input schemas, annotations, output shape, target checks and a native click routine parameterized by button/count. A click tool with bounded button/count parameters is plausible. Separate names may still improve routing for context menus and double-click activation. This review has no task-routing comparison establishing which surface is better.

Keep `browser.hover` separate despite its identical input schema: it moves the pointer without pressing a button and carries different destructive metadata. Identical argument shapes are not a sufficient merger criterion. Owner: [native click routine](../src/browser/worker.py#L559).

### Reconsider two combined boundaries

- `command.read` combines ordinary command replay with persistent-PTY observation that can remove an exited handle. Its conservative destructive/non-idempotent annotations are correct for that combined contract. A separate persistent observer would let ordinary replay carry a more accurate public contract. Do not relabel the existing combined tool as read-only or remove native cleanup to make its name fit. This is a design recommendation, not a demonstrated annotation defect. Owners: [registration](../src/mcp.ts#L286), [read implementation](../src/host.ts#L256).
- `opencode.usage` combines OpenCode cumulative token activity with Codex quota windows and reset times. These answer different operational questions and have different units and result contracts. Separate, clearly named reads would reduce the chance of using token totals as quota evidence. Keep each implementation with its native owner and retain read-only Codex quota collection without admitting a model turn. Owners: [query description](../src/mcp.ts#L393), [native token usage](../src/runtime/query.ts#L166), [Codex quota](../src/codex.ts#L176).

## Tool-by-tool decisions

Decisions concern the justification for each public boundary. **Retain** does not exempt a tool from the shared schema/error repairs above. **Consolidate** is a recommended design change; **Compare** needs routing evidence; **Rework** means the current combined boundary deserves a more precise contract. Across 96 tools: 87 retain, four consolidate, three compare and two rework.

### Status — 2 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `status.readiness` | Retain | Lightweight connector/native availability without worker inventory; distinct operational cost and evidence. |
| `status.recovery` | Retain | Recovers worker identities, pending actions and result evidence; substantially broader than availability. |

### Host — 15 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `host.list` | Retain | Directory enumeration has bounded inventory paging, rather than file-content semantics. |
| `host.read` | Retain | Fingerprinted byte reads and supported images have their own containment and continuation contract. |
| `host.find` | Retain | Native filename discovery differs from directory listing and shell-based content search. |
| `host.vcs` | Retain | Repository identity/base context; does not enumerate changes or patches. A clearer information-oriented name is optional. |
| `host.vcsStatus` | Retain | Working-tree change inventory, distinct from repository identity and patch contents. |
| `host.vcsBranch` | Retain | Native branch discovery/filtering; useful independently of status or diff. |
| `host.vcsDiff` | Retain | Location-based diff inventory or selected patch; mode/file/detail remain parameters. |
| `host.commands` | Retain | Discovers native command handles; does not start, control or replay them. |
| `host.terminalScreen` | Retain | Session-selected rendered terminal view, including an explicit unavailable result. |
| `host.terminalSnapshot` | Retain | Exact persistent-PTY handle snapshot with handle metadata and ownership verification; excludes checkpoint bytes. |
| `host.write` | Retain | Deliberate mutation with overwrite/fingerprint preflight and persisted byte readback. |
| `host.worktreeList` | Retain | Read-only project-owned inventory with fingerprint pagination. |
| `host.worktreeCreate` | Retain | Creates a new isolated location; authorization and uncertainty differ from inventory. |
| `host.worktreeRemove` | Retain | Destructive removal with inventory ownership, root protection and explicit force. |
| `host.worktreeRefresh` | Retain | Explicit native inventory-cache mutation; should not hide inside a read. |

### Command — 9 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `command.startShell` | Retain | Shell command-string execution with timeout and byte-output retention. |
| `command.startPty` | Retain | Executable/argument terminal admission with ordinary PTY replay and retention. |
| `command.startPersistentPty` | Retain | Experimental session-bound daemon with different ownership and exit-observer lifecycle. |
| `command.read` | Rework | Ordinary replay and potentially destructive persistent observation cross an annotation/lifecycle boundary. |
| `command.remove` | Retain | Terminates and forgets a handle; stronger effect than interrupting execution. |
| `command.resize` | Retain | Idempotent geometry update with native readback; different effect and inputs from terminal input. |
| `command.input` | Retain | Arbitrary bounded terminal input with no durable acknowledgement. |
| `command.interrupt` | Retain | Recognizable Ctrl-C recovery intent, distinct from removal; deliberately retains uncertainty. |
| `command.ctrlD` | Retain | Small explicit terminal control convenience; distinguishes a character send from pipe EOF or handle removal. |

Terminal Ctrl-C/Ctrl-D reuse the input transport, but their small public contracts make an operator's recovery intent explicit. That convenience is defensible; its value should still be revisited if routing evidence shows confusion. It does not justify cloning every possible terminal character into a tool.

### Worker lifecycle and inspection — 6 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `opencode.create` | Retain | Fresh admission requires cwd and may set initial configuration; creates an identity. |
| `opencode.continue` | Retain | Submits to an idle existing identity with inherited selection/location and narrower inputs. |
| `opencode.fork` | Retain | Creates a new OpenCode identity from history, optionally at an exact message boundary. |
| `opencode.wait` | Retain | Bounded synchronization at a dependency boundary; cancellation preserves the executing worker. |
| `opencode.inspectActivity` | Retain | Current activity/pending-action diagnosis; useful before deciding how to intervene. |
| `opencode.inspectResult` | Retain | Persisted outcome evidence with exact selection and text continuations. |

### Native queries — 18 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `opencode.sessionDiff` | Retain | Session-relative changes are different evidence from a location's current VCS diff. |
| `opencode.inbox` | Retain | Pending delivery inventory or an exact inbox entry; independent of completed history. |
| `opencode.skill` | Retain | Loads one canonical instruction body with text pagination; distinct from discovery. |
| `opencode.tools` | Retain | Bounded tool-call inventory for one canonical assistant message. |
| `opencode.tool` | Retain | Exact tool-call input, content part or error evidence; field selection remains a parameter. |
| `opencode.models` | Retain | Native model availability/pricing/capabilities; compact/full views remain parameters. |
| `opencode.agents` | Retain | Effective agent discovery with native hidden state and bounded views. |
| `opencode.agent` | Retain | Canonical agent detail and instruction/permission recovery. |
| `opencode.messages` | Retain | Bounded history inventory with runtime-appropriate pagination. |
| `opencode.message` | Retain | Exact message evidence or full compaction fields; independent from history discovery. |
| `opencode.permissions` | Retain | Reads native rules or pending requests; apply runtime-specific section constraints. |
| `opencode.savedApprovals` | Retain | Project-persisted grants are distinct from session rules and current pending requests. |
| `opencode.runtime` | Retain | Location-specific capability/plugin/MCP/command diagnostics form a useful runtime inspection task. |
| `opencode.skills` | Retain | Canonical skill discovery; does not load every instruction body. |
| `opencode.providers` | Retain | Provider identity/activation differs from model discovery and successful authentication evidence. |
| `opencode.usage` | Rework | Cumulative token activity and quota/reset windows answer different budget questions. |
| `opencode.sessions` | Retain | Native session discovery; supported runtime filters/cursors belong in its schema. |
| `opencode.session` | Retain | Exact canonical session state without result selection or broad recovery inventory. |

List/detail pairs are conventional bounded discovery/recovery boundaries. Their existence is justified even when an optional identifier could technically combine them. Do not split pagination, compact/full views or selected text fields into additional tools.

### Session mutations — 19 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `opencode.steer` | Retain | Submits to active execution and returns a canonical prompt identity. |
| `opencode.cancelInbox` | Retain | Cancels one exact pending delivery; distinct from interrupting the worker. |
| `opencode.updateInbox` | Retain | Changes delivery policy with pending-state readback; does not submit a new prompt. |
| `opencode.compact` | Retain | Admits native compaction with separate completion correlation. |
| `opencode.command` | Retain | Invokes a native catalogued command rather than a shell or generic worker prompt. |
| `opencode.invokeSkill` | Retain | Invokes a canonical skill in a native session; distinct from reading its instructions. |
| `opencode.interrupt` | Retain | Stops native worker execution while preserving the conversation. |
| `opencode.respondPermission` | Retain | Exact authority decision; native OpenCode decisions and Codex options retain distinct validation. |
| `opencode.respondForm` | Retain | Answers one pending native form; can authorize follow-on execution. |
| `opencode.cancelForm` | Retain | Cancels the form rather than answering it or interrupting execution. |
| `opencode.delete` | Retain | Destructive idle-session retirement with explicit runtime and safety reconciliation. |
| `opencode.revertStage` | Retain | Stages a previewable native revert without restoring files. |
| `opencode.revertClear` | Retain | Discards staged revert state without changing workspace files. |
| `opencode.revertCommit` | Retain | Applies the staged revert to workspace files; a distinct consequential boundary. |
| `opencode.switchModel` | Retain | Native model/variant selection with persisted readback; independent of agent selection. |
| `opencode.switchAgent` | Retain | Native executing-agent selection; combining with model switching would imply unsupported atomicity. |
| `opencode.setPermissions` | Retain | Replaces ordered session authority rules; separate from answering a pending request. |
| `opencode.removeSavedApproval` | Retain | Removes a persistent project grant with absence verification. |
| `opencode.synthetic` | Retain | Creates native synthetic inbox context with delivery/resume semantics; distinct from user-prompt admission. |

Advanced control-plane operations remain justified by configuration, recovery and authority management. Their native availability alone would not require universal exposure in a simpler product, but this connector's scope includes native operator control. Invocation frequency was not measured and is not a basis for removing them.

### Browser — 27 tools

| Tool | Decision | Justification |
| --- | --- | --- |
| `browser.status` | Retain | Passive endpoint/attachment diagnosis; does not request Windows consent. |
| `browser.connect` | Retain | Explicit Windows browser-native permission request with caller-bound connection identity. |
| `browser.tabs` | Retain | Sanitized target discovery without acquiring control. |
| `browser.launch` | Retain | Launches/reuses the dedicated Linux process; independent of tab attachment. |
| `browser.close` | Retain | Explicit ownership-verified process shutdown; different from ordinary cleanup. |
| `browser.attach` | Retain | Acquires one exact target lease in a selected observe/control mode. |
| `browser.snapshot` | Retain | Bounded accessibility evidence and fresh target references; different from screenshot pixels. |
| `browser.workflow` | Retain | Bounded known sequence with fresh resolution, mandatory postconditions and partial-progress evidence. |
| `browser.wait` | Retain | Observation-only condition checking; no mutation replay. Condition type remains a parameter. |
| `browser.media` | Retain | Audio/video readiness and bounded source metadata; independent of media retrieval. |
| `browser.media_download` | Retain | Authorized bounded host artifact creation with content hash and page CORS constraints. |
| `browser.screenshot` | Retain | Visual evidence without manufacturing element identities. Dimensions remain parameters. |
| `browser.detach` | Retain | Releases adapter control/connection while preserving Chrome, profiles and tabs. |
| `browser.click` | Compare | Activation is useful; compare one click tool with button/count parameters against explicit gesture names. |
| `browser.right_click` | Compare | Context-menu intent may help selection, but shares the click contract and routine. |
| `browser.double_click` | Compare | Double-click activation may help selection, but shares the click contract and routine. |
| `browser.hover` | Retain | Pointer movement without button press; different effect and destructive metadata from clicks. |
| `browser.drag` | Retain | Two-target gesture with distinct identity, dispatch and partial-effect risks. |
| `browser.type_text` | Retain | Inserts at the current selection and supports contenteditable; fast/sequential modes remain parameters. |
| `browser.key_combo` | Consolidate | Modified keypress belongs with the same key operation and optional validated modifiers. |
| `browser.scroll_xy` | Consolidate | Horizontal displacement is a parameter of the element-scroll operation. |
| `browser.fill` | Retain | Replaces a control's entire value using setter/events; different editing contract from insertion. |
| `browser.select` | Retain | Native option selection with option validation and change events. |
| `browser.upload` | Retain | File disclosure boundary with authorized roots, chooser handling and browser-host path constraints. |
| `browser.keypress` | Consolidate | Plain keys share the keyboard task with shortcuts; preserve current allowed keys and event behavior. |
| `browser.scroll` | Consolidate | Vertical-only displacement does not justify a separate operation from two-axis scrolling. |
| `browser.navigate` | Retain | Explicit destination change can discard page state; separate from observation and target attachment. |

The workflow tool overlaps primitives intentionally: its added contract is bounded find/act/verify execution with required per-step evidence and explicit stopping progress. It is not atomic, does not authorize blind replay and does not expose arbitrary script execution. Individual primitives remain necessary when the next action depends on new evidence.

## Verification and recommended sequence

- Enumerated all 96 current definitions and the 39-tool pre-split baseline through the real MCP SDK.
- Compared source names with all 96 currently exposed connector tool names; no name gaps.
- Reproduced six schema-valid unsupported Codex cases through actual MCP calls without native HTTP requests.
- Reproduced a failed native catalog read returning an unmarked query failure, and an unrelated query result passing a focused output validator.
- Confirmed all eighteen query output schemas are identical, as are both focused inspection output schemas.
- Ran `node --import tsx --test test/mcp.test.ts test/status.test.ts test/protocol.test.ts`: 32 passed, zero failed.

Repair runtime/field validation and MCP error signaling first. Narrow connector-owned output envelopes next. Implement browser scroll/keyboard consolidation only with behavior-preserving regression cases and caller/continuation updates. Evaluate click variants with representative target-selection tasks before merging them. Treat command observation and usage semantics as deliberate API design work rather than automatic flattening.

No live model turns, browser actions, service activation or plugin publication were performed. Existing passing tests do not cover the demonstrated schema/error gaps. Tool-routing accuracy, approval UI behavior and end-to-end latency remain unmeasured.
