# Native OpenCode API coverage audit — 2026-10-10

Scope: pinned OpenCode client/server **2.0.24**, OpenCode Connect **0.8.0**
baseline, no additional MCP tool families. This evaluation intentionally
excludes session-scoped instruction-entry APIs and all mutations thereof.

## Findings and decisions

| Native client API | Existing adapter capability | Observed result | Decision |
| --- | --- | --- | --- |
| `session.log({ after, follow:false })` | `opencode.inspect`, `opencode.query messages`, session status | Replayed only `log.synced` (no durable events) for an existing completed session and a newly created+updated disposable session | **Do not expose** until durable replay is demonstrably available. Re-test after a pinned upstream update |
| `session.context` | Bounded selected result and message paging | 19 entries / 268,086 JSON bytes for an existing completed session | **Do not expose raw**; could leak sensitive context and increases response size |
| `model.default` | Canonical compact `query models` and explicit model at worker admission | Returned no default for tested project (173 ms) | **Defer**; cannot replace explicit cost-aware model selection |
| `reference.list` | Native skills/catalogs and host file lookup | Available upstream but no proven operator workflow reducing calls | **Defer** pending a concrete use case |

## Reproducible observation

Benchmarked against the running native OpenCode server using pinned client
2.0.24. The disposable session was removed after the tests. Only aggregate
counts/timings were printed; event bodies, prompts, context and credentials
were never emitted.

- Existing 19-message session: finite `session.log({after:0,follow:false})`
  yielded one `log.synced` marker, taking 41 ms then 14 ms. Native message
  inventory returned 19 entries, taking 99 ms then 57 ms.
- Fresh disposable session after create and update: finite log queries with
  omitted `after`, `after:0`, and `after:1` each yielded just one
  `log.synced` marker (13–18 ms). These observations do not establish why
  replay is absent or whether other sessions/releases behave differently.
- Existing session: `session.context` returned 19 entries, about 268 KB in
  55 ms; selected `OpenCodeBackend.inspect(detail:"result")` returned about
  6.3 KB in 87–101 ms on warm trials. Bounded messages query returned about
  16 KB in 54–63 ms. These are local observations, not generalized latency
  benchmarks.
- Empty disposable session: `session.context` returned 0 entries.

## Release guard

The source lockfile and production release pinned 2.0.24, but the repository's
working `node_modules` still had 2.0.22. `npm ci --ignore-scripts` aligned the
installed client and `npm run check` passed. A precheck/pretest/prebuild
client-version guard now detects local drift before relying on test results.

## Future acceptance gate

Reconsider a **single paged read-only `opencode.query` variant**, not a new
first-class tool, only after a disposable session exhibits replayable events
with monotonic canonical sequences, safe bounded projections, and useful
recovery evidence beyond existing selected-result/message inspection. Require
tests for cursor continuation, sequence gaps, missing/expired history, output
redaction and exact session scoping. Do not implement event polling or claim
MCP event-triggered ChatGPT task support from this API alone.

The 12 native-backed MCP tools remain unchanged.
