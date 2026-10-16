# Native OpenCode API coverage audit — 2026-10-10

Scope: pinned OpenCode client/server **2.0.24**, OpenCode Connect **0.8.0**
baseline, no additional MCP tool families. This evaluation intentionally
excludes session-scoped instruction-entry APIs and all mutations thereof.

## Findings and decisions

| Native client API | Existing adapter capability | Observed result | Decision |
| --- | --- | --- | --- |
| `session.log({ after, follow:false })` | `opencode.inspect`, `opencode.query messages`, session status | Replayed only `log.synced` (no durable events) for an existing completed session and a newly created+updated disposable session | **Do not expose** until durable replay is demonstrably available. Re-test after a pinned upstream update |
| `session.context` | Bounded selected result and message paging | 19 entries / 268,086 JSON bytes for an existing completed session | **Do not expose raw**; could leak sensitive context and increases response size |
| `model.default` | Canonical compact `query models`; native session creation owns omitted selection | Returned no default for tested project (173 ms) | **Do not project separately**; fresh admission omits an unspecified model and reads native selected state back |
| `reference.list` | Native skills/catalogs and host file lookup | Available upstream but no proven operator workflow reducing calls | **Defer** pending a concrete use case |

## Catalog identity validation (source and test review, 2026-10-16)

Session command names, skill IDs, and structured prompt attachments (`files`,
`agents`, `skills`) are **delegated to native OpenCode 2.0.24**. The connector
does not shadow the native command or skill catalogs: it forwards the caller's
identifier verbatim, bounds only the request shape (at most 20 entries per
attachment kind, bounded text and attachment JSON), and reports
`identitySupplied: false`, because native admission returns no message identity
for these routes.

Decision: **do not shadow native catalogs.** Pre-resolving a name or ID against a
cached command/skill list would duplicate catalog state the native server owns,
and would reject identities that native accepts after a live reload.

| Claim | Evidence |
| --- | --- |
| Unknown or malformed command/skill identity is refused by native admission, not by the connector | Source-verified: `opencode.act` forwards `name`/`id` straight to `client.session.command`/`client.session.skill` with no local catalog lookup |
| The connector issues no extra catalog read for command admission | Test-verified: an unlisted command name is still forwarded, and no `/api/command` request is made |
| A forwarded identity the native server rejects surfaces as a sanitized native error | Test-verified against the native fixture; the underlying error text is not surfaced verbatim |
| Native behavior for an unknown command/skill ID on a live 2.0.24 server, and any structured attachment rejection, is unchanged by this delegation | **Not live-verified.** No live observation of an unknown command or skill identity was made for this audit; only the fixture-backed tests above |

This section records source and test review only. It adds no live observation to
the reproducible measurements below, and no timing or catalog-size claim is made
for command, skill, or attachment identity handling.

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
