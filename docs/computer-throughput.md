# Computer Use Throughput — OpenCode Connect 0.7.0

`computer.sequence` is the canonical benchmark surface for bounded desktop workflows through Windows Computer Use 0.4.0 on Windows loopback `127.0.0.1:17842`. It batches MCP admission while retaining WCU's explicit action contracts, persistent bridge and DPAPI security model. The existing observe/interact/screenshot response shapes remain compatible; timing is added to sequence results only.

## Input and execution

Input is a strict object `{steps:[...]}` with **1..32 steps**. Every step must be either an existing `computer.interact` action object or a `waitFor` object below. All steps are validated before the first action. Actions are `activate`, `focus`, `setValue`, `invoke`, `keySequence`, `move`, `click`, `scroll`, `drag`, and `close`; their fields, bounds and activation/readback behavior are identical to [computer.interact](computer-use.md#computerinteract).

Actions run sequentially and stop on the first error, malformed native result, or action response with `success=false`. `continueOnError` is unsupported and rejected. There are no screenshots, shell commands, scripts, arbitrary code, loops, branches, parallel actions, or raw button-down/up steps. The backend serializes a complete sequence, including waits, with its other computer tool calls. At most 64 backend tool calls are admitted at once, retaining the bridge admission bound while calls queue in HostPlane. This does not lock out a human or another process interacting with Windows.

Activation is explicit. `focus`, `setValue` and `invoke` accept `activate` (default false) and `readback` (default true). `keySequence` with `activate=true` requires a handle. Each action uses the same internal executor as standalone interact: activation/action/readback remains one 1..3-request Windows transaction. A sequence is not a rollback transaction; previously performed effects persist if a later step fails.

## Drag

Standalone interact and sequence both accept:

```json
{"action":"drag","points":[{"x":10,"y":20},{"x":140,"y":80}],"durationMs":250,"stepsPerSegment":16}
```

This maps exactly to `POST /v1/input/drag`, omitting only the adapter's `action` discriminator. Points are 2..128 signed 32-bit integer coordinate pairs. `durationMs` is optional, integer 0..5000. `stepsPerSegment` is optional and positive; an explicit value must satisfy `1 + (points.length - 1) * stepsPerSegment <= 512` emitted move positions. Omitted optional fields remain omitted, using WCU defaults. WCU returns `{success:true,metadata:{elapsedMs,emittedInputCount,steps}}`; the adapter preserves these fields inside `result`. `steps` is the number of moves after the initial position; input count also includes button press and release.

## Exact waits

Waits belong only to `computer.sequence`, run in HostPlane, and use existing WCU observation endpoints. Each wait accepts `timeoutMs` (integer 0..10000, default 3000) and `pollIntervalMs` (integer 50..1000, default 100). Poll immediately, then sleep at most the interval or remaining time. The deadline includes observation time; a stalled observation races the remaining deadline and cannot trigger another sequence action. Timeout zero allows one immediate check. An already submitted read-only bridge request may finish after the wait deadline; it is not replayed or used to resume the failed sequence.

Window presence requires **exactly one** exact title or handle, and a boolean `expected`:

```json
{"action":"waitFor","condition":{"type":"windowPresent","title":"Untitled - Notepad","expected":true},"timeoutMs":3000,"pollIntervalMs":100}
```

```json
{"action":"waitFor","condition":{"type":"windowPresent","handle":"0x1234","expected":false}}
```

Each poll calls `GET /v1/windows`. Titles compare case-sensitively with no trimming, substrings or fuzzy matching. Handles compare exact hexadecimal numeric identity, accepting the same prefix, case and leading-zero representations as other computer inputs. A matching title means at least one window has that exact title; absence means none do.

Element state requires a handle, the same exact locator as interact, and one typed predicate:

```json
{"action":"waitFor","condition":{"type":"elementState","handle":"0x1234","locator":{"automationId":"Editor"},"predicate":{"type":"valueEquals","expected":"ready"}},"timeoutMs":5000}
```

| Predicate `type` | Required `expected` | Match |
| --- | --- | --- |
| `exists` | boolean | Inspect succeeds, or exact absence is observed |
| `focused` | boolean | Element's `focused` equals expected |
| `enabled` | boolean | Element's `enabled` equals expected |
| `valueEquals` | string up to 4096 UTF-16 units or null | Element's value equals expected exactly |
| `nameEquals` | string up to 4096 UTF-16 units or null | Element's name equals expected exactly |

Each poll calls `POST /v1/elements/inspect` with the same handle and locator. For `exists=false`, `element_not_found` satisfies the condition. The inspected WCU 0.4 source emits `locator_not_found` for an exact locator with no matches, so that fixed code also satisfies absence. For `exists=true`, these codes keep polling. Missing windows/ancestors, ambiguous locators, provider errors, transport errors, malformed observations and all other failures surface immediately; they never become proof of absence. Missing elements for predicates other than `exists` also fail immediately. No mutation is retried during polling.

## Results and telemetry

Success:

```json
{
  "success":true,
  "results":[
    {"index":0,"success":true,"elapsedMs":4.2,"result":{"action":"activate","result":{"handle":"0x1234","isForeground":true}}},
    {"index":1,"success":true,"elapsedMs":102.8,"result":{"action":"waitFor","satisfied":true,"polls":2}}
  ],
  "totalElapsedMs":107.4,
  "completedSteps":2,
  "stoppedAt":null
}
```

Failure retains the prior successful results and includes the failed step:

```json
{
  "success":false,
  "results":[
    {"index":0,"success":false,"action":"waitFor","elapsedMs":3000,"error":{"code":"wait_timeout","message":"Computer wait condition was not satisfied before its deadline","polls":31}}
  ],
  "totalElapsedMs":3000.4,
  "completedSteps":0,
  "stoppedAt":0
}
```

Indices are zero-based. `completedSteps` counts fully successful sequence steps, including satisfied waits; it excludes the failing step even if its mutation already took effect. `stoppedAt` is the failing index or null. Later steps are omitted. Failure also sets MCP `isError=true`, retaining the sequence's structured result.

Bridge failures include a fixed `code`, a safe `message`, and, when known, `status` and `completedSteps` inside the failed step's `error`. That nested count refers to acknowledged HTTP requests inside one activation/action/readback composition, not successful sequence steps or proof that the failed action never ran. Unknown native errors and invalid output use `operation_failed` without raw error bodies. Wait timeout uses `wait_timeout` and `polls`. Reconcile observed state before deciding to retry a failed mutation; the adapter never automatically replays it.

HostPlane uses a monotonic clock. Per-step `elapsedMs` includes action composition/validation or wait observation/sleep time. `totalElapsedMs` starts after input validation and includes backend queue delay and sequence overhead. It excludes MCP admission, transport and final serialization outside the backend. WCU drag `result.result.metadata.elapsedMs` measures Windows gesture execution separately; subtract it from that step's adapter time to estimate bridge/adapter overhead, and measure client round-trip time separately for MCP overhead. No images or base64 are returned in sequences. The existing 256 KiB structured-result ceiling applies; very large element states can exceed it, so bound workflows and use `readback=false` when immediate state is unnecessary. An envelope failure can occur after mutations took effect.

Annotations are `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=false`, `openWorldHint=false`.

## Verification

The fake transport/process suite runs without Windows, PowerShell, desktop access or token decryption. It covers batching bounds, validation before mutation, composition parity, exact ordering, concurrent-call serialization, stop-on-error/no replay, drag metadata, waits and deadlines, absence/error distinction, telemetry, capability limits and real MCP discovery/schema validation. Live Windows desktop/DPAPI behavior and measured end-to-end throughput require separate validation before deployment.
