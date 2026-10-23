# OpenCode Connect modernization merge review

Review date: 23 October 2026.

## Decision and scope

Accept the modernization for source merge and publication with the intermittent browser-acceptance risk recorded below. The finishing changes remove stale public-tool callers and narrow discovery contracts without adding operations, compatibility aliases, alternate execution paths, or new dependencies.

OpenCode 2.0.24 remains the native authority for sessions, models, agents and permissions. The native Codex plugin retains its 11-method RPC boundary. Connector activation, native plugin loading, Git publication and live acceptance remain separate operations.

## Findings resolved

| Finding | Resolution and evidence |
| --- | --- |
| The operator benchmark still called the removed `status` tool. | It now calls `status.readiness` and `status.recovery`. The original command failed with an unknown-tool error; the corrected benchmark completes both 20-trial fixture evaluations. |
| Focused tools advertised unrelated family-wide success results. | Public status, host inspection, worktree, command and session-action outputs now derive the matching variant from their authoritative backend schemas. A regression rejects another operation's success result while retaining typed safe errors. It failed before the correction and passes afterward. |
| A closed-browser fixture inspected the operator's real Chrome profile. | The fixture now uses its own data directory and a reserved ephemeral endpoint. Ownership refusal remains enforced; the test does not stop the operator browser. |
| Startup shutdown could lose to a missing Python preflight result on a clean CI runner. | Closing during startup now consistently reports `closed` and preserves closed supervisor state. A deterministic regression covers executable and missing executable paths, and separately retains `setup_required` for an open backend. The missing-executable case reproduced the CI failure before the correction. |
| A refreshed full audit identified the development MCP client redirect advisory [GHSA-6prh-2h8m-c8cw](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw). | Pin the development client to patched 2.3.1, matching the existing server SDK version. The production audit remained clear. Locked installation and the final full/production audits validate the dependency update. |
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

The regression now asserts the initial load, repeats five unchanged-public-URL document transitions, checks that a stationary document cannot confirm navigation, identifies the failing stage, and releases both navigation tests' leases through test cleanup. A later full run still failed this navigation case with a deadline before dispatch was reported, while the improved cleanup prevented the earlier cascade (89 passed, two failures counting the parent).

The cause remains unestablished. Five consecutive isolated acceptance runs passed all 25 tests each. Full-suite runs with failure-only telemetry and with the normal worker also passed all 91 tests. The normal-worker diagnostic performed extra fixture observation only after an error; that branch was not reached in its passing run. All temporary diagnostic hooks and probes were then removed. The final source retains only assertion context and lease cleanup.

These passing runs do not establish a navigation fix. This is an explicit remaining release risk. No production navigation condition, timeout, or ownership check was weakened. Source publication includes independently verified schema, startup-shutdown and development dependency fixes; future live activation must assess this retained risk separately.

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
| Real Chrome | Final normal-worker run: 91 passed, 0 skipped or failed; intermittent earlier failures and diagnostic removal are qualified above |
| Dependency audit | Immediate full and production `npm audit` reports: zero reported vulnerabilities |
| Patch review | `git diff --check` passed; unpublished baseline changes reviewed |

The locked installation retains existing transitive deprecation and install-script notices. The existing native directory-loader experimental warning remains independently established. Warnings and approval settings were preserved. The sole dependency update in this finishing pass pins the development MCP client from 2.2.0 to patched 2.3.1; runtime dependency versions are unchanged. Earlier audit reports returned zero findings, while a later full report identified the advisory above; only the final post-update reports support the final audit result.

The first publication's GitHub Actions run exposed the missing-interpreter shutdown race above after installation and source checks passed. It was reproduced locally with an explicit missing executable, fixed at the startup lifecycle owner, and revalidated. The repository's GitHub Actions workflow independently runs installation, source checks, tests, build and the production audit. Verify its result for the published commit; local results do not establish remote CI status.

## Deployment boundary

The prior coordinated live cutover accepted build `6cb7050b70993d47`, including the exact immutable native plugin path, read-only quota, OpenCode and Codex session smoke tests, Linux and Windows browser workflows, and sealed rollback readiness.

The finishing source changes are not a new live deployment. Git merge and push do not update the running connector, plugin configuration or ChatGPT catalog. A subsequent activation must prepare and verify a new immutable release and retain a matching connector/plugin rollback pair.

## Nonblocking follow-ups

- Evaluate end-to-end tool selection, invalid arguments, round trips and completion time in General Chat.
- Measure coherent full accessibility-tree resolution on large pages.
- Retain the explicit non-atomic host-write contract until the native owner provides an appropriate atomic operation.
- Account for native command-handle and PTY replay retention; preserve long-running verification logs and exit evidence at their owning host layer.
- Preserve mutation uncertainty and recovery controls. Remove supported protocol behavior only when its owning current contract establishes that it is obsolete.

## Post-cutover browser follow-up — 23 October 2026

After live connector activation, five consecutive query-only navigation cycles
through General Chat's native MCP path succeeded: stationary-document waits
timed out as expected, and changed-query main-document transitions were
confirmed. This is bounded live evidence, not proof of intermittent reliability.

The opt-in real-Chrome suite subsequently reproduced readyState=complete
postcondition timeouts after Chrome accepted navigation. In one diagnostic full
run, the HTTP fixture observed one main-document request, one iframe request
and two audio requests; a subsequent read-only readyState=interactive wait
was confirmed and a snapshot showed the new public URL. This predicate also
accepts complete, so it does not prove which exact state was observed. Removing
media/iframe dependencies and using a disposable navigation target **did not**
eliminate the full-suite timeout. Both unproven fixture changes were reverted.
Independent full runs had 89/91 and 91/91 outcomes; the intermittent
navigation-completion risk remains open. Do not weaken the production deadline
or replay an uncertain navigation without further evidence.

Separately, the forced-connector-exit acceptance fixture could wait indefinitely
for a blocked request while suppressing child-navigation failures, or register
child/worker exit listeners after signalling termination. Its test-only patch
bounds the fixture handshake, retains child error evidence, and registers exit
observers before kill signals. A focused real-Chrome file run passed 37/37; full
runs confirmed forced-exit recovery even when the separate navigation check
failed. No browser adapter, deployed service or native plugin behavior was
changed. Final source checks and publication remain separate gates.

Final post-follow-up verification on a detached checkout with locked
dependencies: check:all and native integration passed, 403 core tests passed
(3 browser opt-ins skipped), 145 Codex plugin tests passed, and build passed.
The full opt-in real-Chrome gate passed once (91/91) but also failed at the
intermittent navigation readiness check in separate runs (89/91). One earlier
combined core run independently failed an Events delivery-capacity test; the
focused Events file and a subsequent complete core rerun passed. These
intermittent outcomes are recorded, not reclassified as resolved.


### Subsequent navigation lifecycle resolution — 23 October 2026

An isolated CDP trace reproduced the reported timeout: Chrome acknowledged
Page.navigate, emitted a main-frame navigation event, and document.readyState
remained interactive throughout the ten-second verification window, with no
Page.loadEventFired. The connector correctly refused to claim full-load
completion; the pending resource state, not a fabricated navigation result,
explained the reported timeout.

The prior supposedly lightweight fixture accidentally appended a slash before
its query string, making the handler serve the heavy media/iframe page again.
The corrected identity fixture matches the exact request pathname independent
of query/fragment, uses its own disposable Chrome tab, and still requires a
main-document identity change across five query-only navigation cycles.

The native navigation(fromUrl) condition now accepts a changed top-document
loader or changed sanitized public URL once the main DOM has parsed
(interactive or complete). This matches a navigation postcondition without
requiring unrelated image/media/iframe resources to finish. An explicitly
requested readyState(complete) remains stricter and is not implicitly granted.
A new real-Chrome test holds a resource response open and independently confirms
navigation succeeds at the parsed document, full load times out while held,
then confirms after release. No mutation replay or additional browser privilege
was introduced. Cross-frame and unchanged-document rejection tests still pass.

Source acceptance on the isolated lockfile-matched checkout: check:all,
test:all (403 core passed, three opt-in browser tests skipped by default,
145 native Codex plugin tests passed), build, verify:integration, and the
separate real-Chrome opt-in suite (92 of 92 passed) with temporary CDP
instrumentation removed. Source/Git publication and the disruptive live
release/plugin activation are separate gates.
