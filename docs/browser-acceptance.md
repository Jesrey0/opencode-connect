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
startup. The Nodriver worker was initialized by tab discovery before its attachment
timer; attachment numbers are not comparable complete cold-start measurements.
Warm timings compare the operation sequences, not equivalent transport
stacks or model turns. This fixture does not establish a general speed advantage:
Playwright was faster for the measured warm task. The browser capability's result
is native connector integration, stable references and supervised reuse.

## Immutable installation and live state

Implementation commits: `6aeca725943094a82ec0de4092ac5b37f5277854` and
`1831e133862e1111c7faf3d70f163aa66cbdc808` on `codex/native-browser`.
Source was clean when the final immutable release was prepared.

Final build: **`6f98ddf8aba904fe`**, version **0.11.0**, installed at
`~/.local/lib/opencode-connect/builds/6f98ddf8aba904fe/` and activated through the
repository's `deploy.js` lifecycle. `/health` confirmed that exact build and native
connectivity. The build source hash was independently recomputed after preparation.
The managed Python environment is
`~/.local/share/opencode-connect/browser/05c00324197c5495/`.

The service is enabled for browser tools by
`~/.config/systemd/user/opencode-connect.service.d/browser.conf`, containing only
`OPENCODE_CONNECT_BROWSER=1`. Upload roots and the optional Windows endpoint remain
unset. No host-ingress configuration or ordinary user Chrome profiles were changed.

The live `/mcp` tool catalog advertises all nine `browser.*` tools. A production
browser call without verified ingress authorization was rejected. Existing
ChatGPT-connected `status`, Codex runtime capability discovery and read-only Codex
quota calls passed after the final activation.

The final installed adapter was exercised directly on the host against headed
Linux Chrome PID **304741**, using exact target
`7904611D3C15C86DDF143E313C5C8199`. It detected the process after Chrome rewrote its
process title, reused its loopback debugging endpoint without another launch,
navigated to a deterministic local page, confirmed a click through resulting
visible text, restored the prior page, recovered from controlled Python SIGKILL
with an explicitly reacquired lease, and detached. Chrome remained reachable with
its target intact and no active lease. The browser is left open for principal use.

Native Codex plugin configuration still names
`~/.local/lib/opencode-connect/builds/1ee740f1b0945db7/packages/codex-plugin/src`.
Its source matches the new release; no plugin configuration edit was needed.
The rollback record is
`~/.local/state/opencode-connect/browser-cutover-20261018.json` (mode 0600).
The pre-feature build is `1ee740f1b0945db7`; the final activation's immediate
previous build is `fd9f39c6a54185ed`. Connector rollback and removal of the added
browser environment drop-in remain distinct operations.

Git publication has not been performed. After the principal reported completing
the ChatGPT connection refresh, this existing conversation still exposed the
original 12 tools. A fresh live `/mcp` check returned 21 tools, including all nine
browser operations. [OpenAI's documented refresh procedure](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)
includes starting a new conversation after refreshing and checking the metadata.
The pending platform acceptance therefore requires a new General Chat conversation
with OpenCode Connect enabled. That final platform browser invocation is **not yet
verified**; direct installed adapter acceptance and live MCP catalog availability
do not substitute for it.

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
