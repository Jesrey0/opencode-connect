# Browser acceptance — October 18, 2026

## Source verification

Node 24.16.0, Python 3.12.3, Nodriver 0.50.6, Google Chrome 149.0.7827.196,
OpenCode client/plugin 2.0.24. Browser capability release: OpenCode Connect 0.11.0.

| Gate | Result |
| --- | --- |
| `npm ci --include=dev` | Passed in isolated worktree; active checkout console preserved. |
| `npm run check:all` | Passed connector/plugin checks and exact RPC/version parity. |
| `OPENCODE_CONNECT_BROWSER_TEST=1 npm run test:all` | 334 connector tests and 145 plugin tests passed; zero failed or skipped. |
| Python boundary tests (within browser suite) | 3 passed: validation/authority, redaction, large tab-list bounds and narrowing. |
| Browser coverage (within connector suite) | 26 tests including all 17 real-Chrome acceptance scenarios passed. |
| Final pipe-race regression | 2 focused supervisor tests passed after the last callback ownership guard. |
| `npm run build` | Passed. |
| `npm run verify:integration` | Passed: 11 Codex RPC methods; pinned native loader/client/plugin contract. |

Independent read-only review covered request lifetime, verified ingress identity,
lease/reference ownership, browser process independence, bounded output and IPC
cleanup. Its material findings were resolved and covered by regressions.

## Browser and recovery evidence

The deterministic fixture used multiple page targets, text/select/file controls,
disabled/read-only/password inputs and a same-origin iframe. All core actions,
bounded JPEG capture, exact target selection, competing owner rejection, sanitized
URLs, AX states, snapshot ID rotation, removed nodes, frame reload and top-document
navigation passed.

Chrome remained reachable and its original page target IDs remained intact after
detach, Python SIGTERM/SIGKILL, normal connector exit, forced connector SIGKILL,
and forced connector exit during a blocked navigation. The orphaned Python worker
exited after pipe EOF during the blocked action. Timeout recovery required a new
lease. Closing the selected target and restarting Chrome at the same debugging
port rejected the old leases. No tab was guessed or silently substituted.

A query-bearing unchanged URL and an unrelated iframe reload both failed to
confirm top-document navigation. Exact-current-URL navigation reloaded the main
document and confirmed its new loader. Separate MCP HTTP requests retained the
same lease; a different verified ingress grant could not use it. Native image
content carried screenshots without placing base64 in structured metadata.

## Controlled comparison

`npm run browser:benchmark`, 20 sequential trials per route against the same
script-heavy local HTML fixture and isolated Chrome. Each trial obtained an
accessibility snapshot, filled a textbox, clicked Save and observed the exact
result text. Both routes used five-second action deadlines.

| Metric | Integrated Nodriver | Installed Playwright CLI 0.1.22 |
| --- | ---: | ---: |
| Confirmed trials | 20/20 | 20/20 |
| Median warm task | 370.73 ms | 135 ms |
| p95 warm task | 792.23 ms | 181 ms |
| Attachment | 303.87 ms | 2973.21 ms |
| Observation characters | 1303 (structured JSON) | 93 (YAML text) |

The full fixture HTML was 140,259 characters. The Nodriver observation was 99.1%
smaller than that HTML, while larger than Playwright's terse text snapshot. No
tokenizer was run; these are character counts, not measured token totals.
Playwright warm timings exclude CLI process startup; its attachment includes CLI
startup. Warm timings compare the operation sequences, not equivalent transport
stacks or model turns. This fixture does not establish a general speed advantage:
Playwright was faster for the measured warm task. The browser capability's result
is native connector integration, stable references and supervised reuse.

## Supported limits

- Actual Windows Chrome attachment has not been exercised; it requires a reachable
  explicitly configured loopback endpoint. Linux remains the default.
- Same-origin iframe control is exercised. Out-of-process iframe AX availability
  is reported explicitly; comprehensive cross-origin frame control is unsupported.
- Upload roots default to empty in production; enable only directories the
  principal authorizes. Upload behavior was exercised using fixture files.
- Authorization is verified at ingress grant scope plus an opaque lease; a grant
  is not a per-chat identity. `authorized:true` is the operator's consent assertion.
- DOM click/fill/select do not grant trusted user activation. Applications requiring
  that gesture can reject them; dispatch alone never confirms application success.
- Runtime source, tests, immutable installation and General Chat's cached tool
  catalog are separate evidence. A stale ChatGPT catalog needs a connector refresh.
