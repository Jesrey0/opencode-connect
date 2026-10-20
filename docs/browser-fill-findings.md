# Browser fill and lease findings — October 20, 2026

OpenCode Connect 0.14.1 is deployed as `36f2d1ed78cd7973`, from runtime
commit `001a60ecfcb01296738b4403deea213e2461cdc0`. Rollback build:
`0ed346b5a473ccb1`.

## Fill failure

The operator reported successful entry of a 15,945-character source, two failed
fills of an audio-focus field, and successful native text insertion afterward.
The original error outputs are unavailable. Live inspection was read-only; the
audio customization dialog was closed. Its historical failure cause remains
unconfirmed.

A local Chrome fixture reproduced a connector defect: fill writes the correct
value and emits input/change, but a legitimate change handler moves focus or
disables the accepted field. The former final editable/focus check then reports
`focus_changed` with `dispatched:true`, despite the correct value remaining.

The patch verifies the same reference identity and exact value after fill has
finished dispatching. It permits legitimate final focus/editability changes.
Pre-dispatch focus protection, target identity, exact read-back, explicit state
postconditions, and guards between continued typing operations remain enforced.
No input fallback or replay was added. A failed dispatched edit still requires
inspection before another write.

Fill remains a programmatic replacement for native input/textarea controls.
Contenteditable requires native text insertion; applications may also distinguish
synthetic events from native input. Those possibilities cannot be attributed to
the reported NotebookLM incident without its error outputs.

## Lease expiry

The existing worker releases resources after five idle minutes. Chrome and its
page remain alive, while attachment handles expire. Cancellation, connection loss
or caller changes can also invalidate a handle; the reported incident's exact
trigger requires its timing and error evidence.

Idle cleanup now retains its cause in `browser.status.lastError`. The default
timeout and explicit reattachment requirement are unchanged. For long generation,
detach after submission and rediscover, attach and inspect during verification.
An expired lease alone does not establish that generation failed.

## Acceptance

Source checks, build and integration verification passed. The full suite passed
350 connector tests with three explicit opt-in skips, plus 145 plugin tests.
All 82 browser tests and 24 Python tests passed. The immutable build independently
passed all 15 text tests and a real-worker idle-release diagnostic check.

Live health identifies the exact build. Authenticated MCP browser readiness,
native runtime discovery and read-only quota retrieval passed. Native
configuration and original Chrome tab IDs are preserved. Protected evidence is
under `~/.local/state/opencode-connect/browser-fill-20261020/`.

Tool schemas are unchanged; no connector catalog refresh is required. Existing
leases require fresh attachment after the deployment restart.
