# Operator workflow acceptance

Measure the operator's complete path from a task prompt to a verified answer in
ChatGPT. Backend regression tests and local MCP probes remain separate evidence.
Use a disposable repository/browser fixture for mutations and fault injection;
preserve the operator's persistent browser and unrelated sessions. No external
account writes, production outage or model turn is implied by this matrix.

## Representative tasks

| Task prompt | Setup and decisive evidence | Plausible failure to reject |
| --- | --- | --- |
| Locate the document that owns coordinated connector/plugin rollback and explain the rule. | Given the repository cwd, locate and read the owning document. Return its path and the actual connector/plugin lifecycle distinction. | Filename-only answer, guessing from worker output, or treating connector rollback as a native plugin reload. |
| In a disposable repository, make the specified bounded edit and verify it. | Record the initial diff and exact target. Make one authorized change; run a check that fails on the original defect, inspect the final diff and read the persisted result. Preserve unrelated fixture changes. | Passing a mirrored implementation test, editing another matching object, or reporting completion without persisted readback. |
| Recover the result of an existing worker after its start response was lost. | Retain canonical runtime/session/prompt identity in a fixture record; hide the start response. Use recovery inventory and exact result evidence. Verify the artifact at its owning source and account for an interrupted or failed assistant result. | Creating another worker, selecting the newest unrelated answer, or accepting native termination as success. |
| Change and save the named browser form field; preserve its neighboring value. | Use a disposable page with repeated labels in distinct named containers and an unchanged neighboring field. Select the exact tab, resolve the intended scoped object from fresh evidence, then verify the saved value and neighbor from application state. Release control. | Generic readiness or click dispatch as save evidence, wrong-container action, or an uncertain workflow automatically replayed. |
| Distinguish an unavailable OpenCode service from a browser lease that expired while Chrome stayed available. | Use separately controlled fixtures. Read readiness for native connectivity; use the browser endpoint/attachment probe and timestamped incident history. For expiry, explicitly reselect/attach and reconcile the page before continuing. | Calling a historical idle incident a current outage, inferring browser lease health from supervisor readiness, or reconnecting/replaying an uncertain write silently. |

For a denied action, distinguish platform safety denial from transport failure.
Stop that denied action; another backend, browser or worker must not bypass it.

## Measurement rules

Record one row per run with the prompt, date, host/client, source/deployed build,
tool exposure, fixture, result and evidence paths. Verify the required tools are
actually callable before attributing an exposure gap to the server. Keep private
handles and page/user content out of published records.

- **Tool calls:** every operator tool invocation from prompt to final answer,
  including discovery, retries, reads, writes and recovery. Record backend native
  requests separately; batching is one operator call, not zero underlying work.
- **Elapsed time:** wall time from prompt admission to the verified answer,
  including reasoning, waits and required recovery. Label narrower probe timings.
- **Unnecessary actions:** independently reviewed calls that do not advance
  discovery, authorized execution, verification or recovery; include duplicate
  delegation and avoidable retries. Identify the specific call and reason.
- **Incomplete verification:** count required postconditions not established at
  their owning layer. Any material missing condition makes the run INCONCLUSIVE.
- **Recoverability:** PASS only if an interrupted/lost result is reconciled using
  retained native identities without duplicate writes. Otherwise record FAIL,
  INCONCLUSIVE or not exercised with a reason.

Run before/after with the same prompts, fixture state, runtime, exposure and cost
constraints. Use repeated paired runs before claiming a latency improvement;
report tool counts, median/p95, unnecessary actions, missing verification and
recovery outcomes. Accept a reduction only with preserved behavior/evidence. Do
not rationalize the tool catalog from one observation or simulated latency.

## Recorded baseline — 20 October 2026

[Machine-readable observations](operator-baseline.json) preserve the measured
values and scope. The callable tools were the existing deployment; the new
readiness selector was not exposed or deployed. Read-only probes ran from a Codex
subagent through the connected tools, without AI worker turns or application writes.
They exclude setup, discovery and operator reasoning and are not complete ChatGPT
acceptance runs.
The probes did not measure deployed connector version/build identity; the returned
OpenCode version identifies only that native runtime. The local fixture used
modified source at Git HEAD `eabd0527766e55a8311f0104f74a8f318f716bdd`, with
source version 0.14.2 and non-release build identity `source`, inspected after the
run. Neither identity establishes the deployed connector build.

| Connected read-only probe | Calls | Elapsed | Result |
| --- | ---: | ---: | --- |
| Locate and read rollback owner | 2 | 9.566 s | Found `docs/release-cutover.md`; readback established the separate plugin rollback requirement. No unnecessary calls or missing task readback observed; recovery not exercised. |
| Existing recovery `status` | 1 | 3.354 s | Ready, OpenCode 2.0.24, 4 workers; 3,721 JSON response characters. Single observation. |

The source-checkout benchmark uses the real MCP SDK/client with in-memory
transport and a deterministic native fetch fixture. It includes the native
`/api/info` connection read, honors the recent-session limit of 8 from a population
of 20, and verifies all returned recovery outcomes. It injects no delay, performs
two warmups per detail and 20 measured trials per detail, alternating order.
Timing is local processing/serialization, without service/network or ChatGPT cost.

```bash
npm run operator:benchmark
```

| Same-fixture status detail | Calls/run | Native requests/run | Median | p95 | Serialized response bytes | Verified trials |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Readiness | 1 | 1 | 4.274 ms | 12.121 ms | 288 | 20/20 |
| Recovery | 1 | 35 | 18.515 ms | 32.758 ms | 5,186 | 20/20 |

The fixture establishes less native traversal and smaller output for a readiness
question while preserving recovery evidence. It does not establish deployed or
ChatGPT latency improvement. It does not test service discovery, browser readiness,
leases, loaded Codex plugin identity or quota.

| Full ChatGPT workflow | Acceptance |
| --- | --- |
| Repository locate | INCONCLUSIVE — connected read-only probe only; no full ChatGPT run. |
| Bounded edit and verify | INCONCLUSIVE — disposable live mutation run not performed. |
| Worker recovery | INCONCLUSIVE — no live worker turn or fault injection performed. |
| Browser form postconditions | INCONCLUSIVE — browser regression fixtures are separate evidence. |
| Outage versus expired lease | INCONCLUSIVE — live faults were not injected. |

Repeat the matrix after separately authorized deployment and verified ChatGPT
exposure. The baseline does not justify a tool-catalog redesign or broader release
attestation layer.
