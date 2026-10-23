# OpenCode Connect modernization merge review

Review date: 23 October 2026.

## Decision and scope

Accept the modernization for source merge and publication after the validation below. The finishing changes remove stale public-tool callers and narrow discovery contracts without adding operations, compatibility aliases, alternate execution paths, or new dependencies.

OpenCode 2.0.24 remains the native authority for sessions, models, agents and permissions. The native Codex plugin retains its 11-method RPC boundary. Connector activation, native plugin loading, Git publication and live acceptance remain separate operations.

## Findings resolved

| Finding | Resolution and evidence |
| --- | --- |
| The operator benchmark still called the removed `status` tool. | It now calls `status.readiness` and `status.recovery`. The original command failed with an unknown-tool error; the corrected benchmark completes both 20-trial fixture evaluations. |
| Focused tools advertised unrelated family-wide success results. | Public status, host inspection, worktree, command and session-action outputs now derive the matching variant from their authoritative backend schemas. A regression rejects another operation's success result while retaining typed safe errors. It failed before the correction and passes afterward. |
| A closed-browser fixture inspected the operator's real Chrome profile. | The fixture now uses its own data directory and a reserved ephemeral endpoint. Ownership refusal remains enforced; the test does not stop the operator browser. |
| Readiness tests validated against the recovery tool's broad output schema. | Each test now validates against its owning tool's discovered schema. Healthy and unavailable native-service cases both pass. |
| Diagnostics and the cutover runbook named retired public tools. | Guidance now uses the focused lifecycle, readiness and runtime operations. Internal native backend dispatch remains intentional and is not a public compatibility API. |

## Catalog measurement

Measured through actual MCP SDK `tools/list` responses, including the optional browser definitions. The comparison baseline is the live-accepted build `6cb7050b70993d47` at source commit `64fc34e`.

| Measurement | Accepted build | Finishing source |
| --- | ---: | ---: |
| Tools | 96 | 96 |
| Input-schema bytes | 134,853 | 134,853 |
| Output-schema bytes | 410,085 | 177,782 |
| Complete serialized catalog bytes | 578,413 | 346,110 |

The complete catalog is 40.16% smaller. All tool names, ordering, input schemas and safety annotations compare equal. The 69-tool core fixture separately measures 203,105 total bytes, down from 435,408.

These are serialized JSON byte counts, not model token measurements or evidence of improved General Chat latency. Native query projections remain native data rather than a duplicated connector-owned model.

## Browser acceptance incident and remaining risk

An initial durable full run reported 87 passing tests and four failures, counting the parent suite. The first failure was a timeout during query-only navigation with a redacted public URL. The old test ignored the preceding complete-readiness result and left its lease attached after failure, causing two later lease conflicts.

The regression now asserts the initial load, repeats five unchanged-public-URL document transitions, checks that a stationary document cannot confirm navigation, and releases both navigation tests' leases through test cleanup. An isolated repeated run and a full traced run passed. The final normal, uninstrumented browser suite passed all 91 tests. Diagnostic hooks were removed from source.

The original timeout's cause was not established. Passing reruns do not prove it fixed; this remains a recorded intermittent acceptance risk. No production browser condition, timeout, or ownership check was weakened. Source merge is supported by the strengthened final acceptance and the prior independent live acceptance; activation of the finishing source remains a separate release decision.

## Validation

| Gate | Final result |
| --- | --- |
| Locked installation | `npm ci --include=dev` completed |
| TypeScript and release checks | `npm run check:all` passed |
| Core tests | 403 passed, 3 opt-in browser tests skipped, 0 failures |
| Native Codex plugin tests | 145 passed, 0 failures |
| Build | `npm run build` passed |
| Native integration | `npm run verify:integration` passed |
| Operator benchmark | Both 20-trial fixture evaluations verified |
| Real Chrome | `OPENCODE_CONNECT_BROWSER_TEST=1 npm run test:browser`: 91 passed, 0 skipped or failed |
| Dependency audit | Immediate full and production `npm audit` reports: zero reported vulnerabilities |
| Patch review | `git diff --check` passed; unpublished baseline changes reviewed |

The locked installation retains existing transitive deprecation and install-script notices. The existing native directory-loader experimental warning remains independently established. No warnings were suppressed, dependencies upgraded, or approval settings changed in this finishing pass.

The repository's GitHub Actions workflow independently runs installation, source checks, tests, build and the production audit. Verify its result for the published commit; local results do not establish remote CI status.

## Deployment boundary

The prior coordinated live cutover accepted build `6cb7050b70993d47`, including the exact immutable native plugin path, read-only quota, OpenCode and Codex session smoke tests, Linux and Windows browser workflows, and sealed rollback readiness.

The finishing source changes are not a new live deployment. Git merge and push do not update the running connector, plugin configuration or ChatGPT catalog. A subsequent activation must prepare and verify a new immutable release and retain a matching connector/plugin rollback pair.

## Nonblocking follow-ups

- Evaluate end-to-end tool selection, invalid arguments, round trips and completion time in General Chat.
- Measure coherent full accessibility-tree resolution on large pages.
- Retain the explicit non-atomic host-write contract until the native owner provides an appropriate atomic operation.
- Account for native command-handle and PTY replay retention; preserve long-running verification logs and exit evidence at their owning host layer.
- Preserve mutation uncertainty and recovery controls. Remove supported protocol behavior only when its owning current contract establishes that it is obsolete.
