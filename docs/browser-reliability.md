# Native browser reliability acceptance

## Scope and runtime state

This sprint extends the existing native browser tools. Nodriver/CDP, explicit
authorization, standalone actions, lease ownership, and independent Chrome
lifetime remain the execution contract. No scheduling or monitoring was added.

Baseline commit: `2f8c4d9` (browser workflows, chooser uploads and media retrieval).
Reliability implementation: `689732de877e2539474e07df316d167c07d64de2`.
Connector 0.13.0, immutable build `aead26457addd3be`, was activated on
October 19, 2026. Live health reports that exact build; the live catalog serves
38 tools, including 26 browser tools, with ancestor scope, scopeRef and element
read-back exposed. The previous build `d2f38de5ecdf6ccc` is retained for rollback.
External MCP client acceptance remains separate from the successful local and
installed-handler checks below. No NotebookLM validation is claimed.

## Incident findings

| Incident | Finding and evidence | Result |
| --- | --- | --- |
| A: wrong title edited | Historical cause remains unknown. Backend node IDs already prevent index-based redirection on reorder. Code inspection found that reuse of the same DOM node/named container was not detected, and focus handlers could redirect native text insertion. Local fixtures exercise repeated Rename/Title controls, node/container reuse and focus redirection. | Named ancestor scope, full role/name/ancestor identity checks, focus checks and targeted value assertions make these paths reject or verify explicitly. No Nodriver defect is inferred. |
| B: INVALID_ARGUMENT/internal error | The original click failure was not reproduced. MCP SDK validation can reject input or output; broad worker handlers also mislabeled socket loss as stale-reference/closed-target. Injected connection and protocol failures reproduce the classification weakness. | Sanitized error codes identify target, input/CDP, browser, worker, result and other owning layers. Clicking never falls back to keyboard activation. |
| C: UNAVAILABLE workflow | Exact historical failure was not reproduced; available service journals did not identify its layer. The message is not emitted by browser adapter code. A reachable Chrome endpoint does not prove MCP transport or prior action completion. Successful worker replies followed by malformed/oversized output were confirmed to lose mutation evidence. | Result/IPC failures preserve uncertainty and do not resend. Socket loss clears a dead attachment while endpoint reachability remains a separate fact. Outer workflow cancellation also preserves earlier dispatch evidence. |
| D: repeated inspection | Global role/name matching could not scope repeated controls. Existing batching was retained. | One four-step workflow resolves a card, opens its editor, fills it and saves it with a postcondition at every step. It verifies the intended card and independently checks the notebook title. |
| E: oversized fill | The reliability release retained the 12,000 limit. The subsequent text-input extension raises it; see browser-capability.md. | Errors include the applicable bound without input values. Explicit ordered type_text parts are verified against a dynamically created contenteditable; replacement rejects the old reference. |

## Contract changes

- `browser.snapshot.scopeRef` observes descendants of a current container. The
  new snapshot expires all old references, including the supplied scope.
- Workflow targets and element postconditions accept
  `within:{role,name}` plus optional `frameId`. The named ancestor must be unique;
  repeated targets or containers reject with match counts and narrowing guidance.
- `expected` and `browser.wait.condition` accept
  `type:"element",target,value?,state?`. Value comparison uses an exact control
  value or contenteditable rendered text. States cover enabled/disabled, focus,
  checked/unchecked, expanded/collapsed, selection and editability. Protected
  values are never returned. Ambiguity rejects rather than waiting or choosing.
- References bind to backend node, document/frame, role/name and the complete
  ordered named ancestor chain. Reorder preserves the same identity; changed,
  added or replaced named containers require a new observation.
- Errors include `errorLayer`. Workflow results additionally include
  `stepDispatched` for the failing step; existing `dispatched` is cumulative.
  `completedSteps` counts confirmed postconditions and `failedStep` is zero-based.
- A completed action without `expected` remains `inconclusive`. `completed:true`
  means the command returned, not that the application outcome was verified.
  Postcondition expiry returns `timed_out`; malformed or missing results retain
  mutation uncertainty. No completed, failed or uncertain action is replayed.

The catalog still contains 26 browser tools. Description, limit, independent
primitive and safety-annotation review follows OpenAI's
[tool planning guidance](https://developers.openai.com/plugins/plan/tools) and
[plugin tool requirements](https://developers.openai.com/plugins/plugin-guidelines).

## Validation

- `npm ci --include=dev` and `npm run check:all` passed.
- `npm run test:all` passed: 348 connector tests, with two explicit browser
  opt-ins skipped, and 145 plugin tests.
- `OPENCODE_CONNECT_BROWSER_TEST=1 npm run test:browser` passed all 66 tests.
  The final Chrome fixture rerun passed all 34 tests after adding the menu
  transition. This includes real Chrome execution, HTTP/MCP contract/catalog
  checks, lease ownership, frame changes, protected inputs, dispatch/verification,
  scoped editing, node reuse, focus movement, multipart text and worker recovery.
- The pinned Python environment passed all 23 worker/media boundary tests.
- Seventeen supervisor regressions verify invalid/missing/oversized result
  evidence, one request per mutation, safe size diagnostics and pre-dispatch
  rejection. An outer-timeout regression preserves earlier workflow dispatch.
- `npm run build` and `npm run verify:integration` passed. The independent source
  integration check confirms 11 Codex RPC methods and pinned OpenCode 2.0.24.
- The documented four-step workflow validates against the actual input schema.
  Read-only live catalog/health inspection independently confirms the earlier
  deployed schema and build, rather than treating source tests as deployment.

The local fixture is UTF-8 and explicitly foregrounded so Chrome background-media
preloading does not invalidate unrelated assertions. Attachment itself does not
activate production tabs. No authenticated NotebookLM content was changed.

## Deployment acceptance

- The immutable installation passes its integration contract check. Its build
  record identifies the clean implementation commit above.
- Activation reports build `aead26457addd3be`; service state is active, live health
  matches, and deployment drift is false. The live HTTP/MCP catalog contains the
  new scoped-target, scoped-snapshot and element-condition fields.
- The installed production MCP handler passes an isolated real-Chrome smoke
  test: four verified menu/dialog/edit/save steps, preserved notebook title,
  scoped snapshot, ambiguity rejection, focus-redirect rejection, stale identity
  rejection and an unverified step that stops subsequent actions.
- The configured native plugin source matches this release's plugin source.
  Configuration is byte-for-byte unchanged. Native runtime capabilities and
  read-only Codex quota succeeded after activation. The original persistent
  Chrome tab remains present; the smoke test uses its own disposable browser.
- Public ingress responds with the expected unauthenticated 401 challenge.
  Authenticated external MCP tool calls from this client returned transport or
  internal errors before and after activation. Their cause is unproven; local
  catalog and installed-handler success do not establish client acceptance.

The protected rollback/configuration record and acceptance results are under
`~/.local/state/opencode-connect/browser-reliability-20261019/`. Git publication
and external client reconnection are not established by this deployment.

## Operator example

After selecting and attaching to the intended tab with a control lease, call
`browser.workflow` with the following arguments. Names must match the observed
page. An application must expose the named containers used here.

```json
{
  "leaseId": "<current lease>",
  "authorized": true,
  "steps": [
    {
      "action": "click",
      "target": {"role": "button", "name": "Actions", "within": {"role": "group", "name": "Recording Beta"}},
      "expected": {"type": "element", "target": {"role": "menuitem", "name": "Rename", "within": {"role": "menu", "name": "Actions Recording Beta"}}}
    },
    {
      "action": "click",
      "target": {"role": "menuitem", "name": "Rename", "within": {"role": "menu", "name": "Actions Recording Beta"}},
      "expected": {"type": "element", "target": {"role": "textbox", "name": "Title", "within": {"role": "dialog", "name": "Rename Recording Beta"}}, "state": "editable"}
    },
    {
      "action": "fill",
      "target": {"role": "textbox", "name": "Title", "within": {"role": "dialog", "name": "Rename Recording Beta"}},
      "value": "Renamed recording",
      "expected": {"type": "element", "target": {"role": "textbox", "name": "Title", "within": {"role": "dialog", "name": "Rename Recording Beta"}}, "value": "Renamed recording"}
    },
    {
      "action": "click",
      "target": {"role": "button", "name": "Save recording", "within": {"role": "dialog", "name": "Rename Recording Beta"}},
      "expected": {"type": "element", "target": {"role": "group", "name": "Renamed recording"}}
    }
  ]
}
```

This uses one interaction call after attachment, instead of separate snapshots,
actions and waits for each of four steps. For granular operation, observe the
card's current reference, call `browser.snapshot` with that `scopeRef`, then use
the returned child reference in a standalone action with `expected`.

For long text, use explicit ordered `browser.type_text` calls with parts within
the current catalog limit each. Verify the intended field and selection before
each part, and the final application content afterward. Do not fill repeatedly:
fill replaces the entire value. If the editor is replaced, inspect its content
and selection before continuing; never resend an uncertain part automatically.

## Limits and rollout

Named scope depends on the page's accessibility semantics. Unnamed containers
may need granular inspection; out-of-process frame observation remains bounded
and can fail explicitly. Identity checks are conservative: changing a name can
expire a reference even when the DOM node remains. Native CDP input and page
JavaScript do not form an atomic transaction; a page can change after a check.
Postconditions establish only the selected observable state, not hidden server
durability. Choose specific values and object names instead of incidental text.

Contenteditable can normalize line breaks, rich content and selection. The
fixture verifies 14,001 UTF-16 code units with emoji, combining characters and a
line break, in two explicit insertions. An input handler can observe an
intermediate edit state; final read-back must observe the completed document.
No generic guarantee is made for arbitrary framework editors.

Prepare and activate a new immutable connector release through the established
release lifecycle, then refresh the client's MCP catalog and inspect the live
new fields before using them. Browser leases will require explicit attachment
after the connector restart; persistent Chrome/profile lifetime is separate.
This browser-only change requires no native Codex plugin source/configuration
change. Git publication and service activation are separate operator decisions.

## Before and after

| Before | After |
| --- | --- |
| Repeated names need manual disambiguation across global snapshots. | Workflow ancestor scope and scoped snapshots identify one container; ambiguity stops. |
| Same node can be repurposed under an existing reference. | Role/name and full named ancestor identity changes reject before action. |
| Focus redirect can send typing to another editor. | Focus and identity are checked before typing/filling. |
| Mostly page-wide text/selector verification. | Exact scoped field value/state read-back without returning private values. |
| Result validation can discard evidence of an earlier mutation. | Result/IPC failures and outer cancellation retain mutation uncertainty. |
| Separate find/action/inspection calls for known sequences. | Four verified actions in one bounded workflow, with exact partial progress. |
| Generic size rejection. | Bounded diagnostics and verified explicit multipart Unicode entry. |
