# Native Chrome capability

OpenCode Connect exposes Nodriver-backed browser operations through its existing
MCP endpoint. Linux Chrome in WSL2 is the default. The connector can inspect a
configured debugging endpoint, reuse an existing browser, or explicitly launch a
dedicated Linux Chrome profile. Windows Chrome attachment is optional.

## Setup

Requirements: Node 24, Linux Python 3.11 or newer with `venv`/`pip`, and Chrome or
Chromium. The tested host uses Python 3.12 and Google Chrome 149. Run:

```sh
npm ci --include=dev
npm run browser:setup
```

Setup installs unmodified Nodriver **0.50.6**, deprecated **3.0.0**, mss **10.2.0**,
websockets **17.2**, and wrapt **2.5.1** using a complete hash-checked dependency
lock. The environment lives under
`$XDG_DATA_HOME/opencode-connect/browser/<lock-sha256-prefix>/`, defaulting to
`~/.local/share/opencode-connect/browser/`. Neither tools nor connector startup
install packages. Python bytecode and environments are kept outside release inputs.

The feature is disabled unless `OPENCODE_CONNECT_BROWSER=1`. After passing the
acceptance gates, set that variable for `opencode-connect.service` and activate a
verified immutable connector release through the existing deployment mechanism.
Dependency setup and service configuration are separate from release activation.
Native Codex plugin configuration does not change for browser activation.

| Variable | Default / purpose |
| --- | --- |
| `OPENCODE_CONNECT_BROWSER` | Disabled; `1` exposes browser tools. |
| `OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT` | `http://127.0.0.1:9222`; configured Linux CDP endpoint. |
| `OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT` | Unset; optional Windows CDP endpoint reachable through WSL loopback. |
| `OPENCODE_CONNECT_BROWSER_CHROME` | Auto-detect Linux Chrome/Chromium executable; optional absolute executable path. |
| `OPENCODE_CONNECT_BROWSER_PYTHON` | Managed environment; optional preinstalled Python with the exact Nodriver version. |
| `OPENCODE_CONNECT_BROWSER_SETUP_PYTHON` | `python3`; interpreter used for explicit environment creation. |
| `OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS` | Empty (uploads denied); colon-separated absolute authorized directories. |
| `XDG_DATA_HOME` | `~/.local/share`; managed environment and dedicated Chrome profile parent. |

Debug endpoints must use an explicit loopback IP and port, HTTP, and no credentials,
path, query or fragment. Discovery rejects redirects and a websocket outside the
configured host/port. Never expose or proxy CDP publicly.

## Linux and optional Windows Chrome

Call `browser.status` first. It reports configured endpoint reachability, worker
state, version, attachment state, bounded Linux Chrome process IDs/debug-port
availability, and a recoverable diagnostic. Running Chrome without a debug port is
visible but cannot be converted into an attachable instance. Pipe-only automation
instances are not CDP endpoint candidates.

`browser.launch` checks the Linux endpoint before launching. It reuses a supported
reachable instance; otherwise it starts Linux Chrome with a dedicated persistent
`opencode-connect/chrome-linux` profile under the data directory. It leaves the
browser sandbox enabled, uses loopback CDP, and opens `about:blank`. The default is
headed Chrome on the configured display (`DISPLAY=:0` fallback for WSLg);
`headless:true` is available for host tests. Launching never attaches a tab. Browser
shutdown remains the principal's responsibility, including browsers launched here.
Detach and connector termination preserve them.

For an independently launched Linux debugging session:

```sh
google-chrome-stable --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.local/share/chrome-operator"
```

Windows attachment uses `browser:"windows"` explicitly on status, tabs and attach.
Launch Windows Chrome yourself with a dedicated debugging profile and a distinct
port, then configure its loopback endpoint. It requires Windows-to-WSL localhost
reachability, such as mirrored networking. Non-loopback Windows host addresses and
new tunnels are unsupported. A normal Windows browser session without CDP remains
unavailable. The connector never launches Windows Chrome or copies profiles or
authentication state. Actual Windows attachment needs host-specific acceptance.

## Tools and workflow

Names below are the native MCP names; ChatGPT may project punctuation differently.

| Tool | Arguments / result |
| --- | --- |
| `browser.status` | Optional `browser` (`linux` default); reachability and worker diagnostics. |
| `browser.tabs` | Optional `browser`, `filter` and `maxTabs` (1–100, default 50); exact target IDs, sanitized URLs/titles, lease flags and honest truncation. Narrow a truncated list with a title/URL filter. |
| `browser.launch` | Optional `headless` (default false); `reused`, reachability and new process ID when applicable. Linux only. |
| `browser.attach` | Exact `targetId`, `controlMode:observe|control`, optional `browser`; opaque `leaseId`, generation and target summary. |
| `browser.snapshot` | `leaseId`, optional `maxNodes` (1–300, default 100), `frameId`, name/role substring `filter`; compact AX roles, names, states, references, document generation, frame summaries, truncation and observation errors. |
| `browser.action` | `leaseId`, `authorized:true`, action-specific arguments, optional `expected`, `timeoutMs` (100–30000); dispatch/completion, verification, URL and evidence. |
| `browser.wait` | `leaseId`, structured `condition`, optional `timeoutMs`; deadline-bounded observed condition. |
| `browser.screenshot` | `leaseId`, optional `width`/`height` (default 1280×720; maximum 1920×1080); JPEG image content, maximum 1 MiB, no file persistence. |
| `browser.detach` | Exact `leaseId`; release the connection while preserving Chrome and its tabs. |

Select an exact target from `browser.tabs`, attach, then take a snapshot. Use the
returned opaque `elementRef` for actions. Each snapshot replaces prior references;
navigation, frame reload, element removal, worker loss and detach invalidate them.
References bind to the leased target, frame loader, DOM backend identity and
document epoch. Rejections require a new observation, never a guessed replacement.
`frameId` must belong to the selected tab. Same-origin iframes are supported;
unavailable out-of-process frame trees produce explicit observation errors.

Actions: `click(elementRef)`, `fill(elementRef,value)`,
`select(elementRef,value)`, `keypress(elementRef,key)`,
`scroll(elementRef,deltaY)`, `navigate(url)`, and
`upload(elementRef,files[])`. Keypress supports Enter, Tab, Escape, Backspace,
Delete, arrows, Home, End and Space. Fill rejects disabled, hidden, read-only and
password controls. Uploads require a visible file input, explicitly selected
absolute regular files within configured roots, and reject protected dot paths and
key/certificate files. Navigation allows HTTP/HTTPS without embedded credentials;
navigating to the exact current URL reloads the document.

Example sequence, after selecting an exact target:

```json
{"leaseId":"<lease>","action":"fill","elementRef":"<name-ref>","value":"Example","authorized":true}
```

```json
{"leaseId":"<lease>","action":"click","elementRef":"<save-ref>","authorized":true,"expected":{"type":"text","value":"Saved Example"}}
```

Expected/wait conditions: `text(value)` for visible main-document text,
`url(value)` for an exact URL, `elementAppears(selector,frameId?)`,
`elementDisappears(selector,frameId?)`, `readyState(interactive|complete)`, and
`navigation(fromUrl)`. Navigation uses the main document's loader change or a
changed sanitized URL plus complete readiness. An unrelated iframe reload cannot
confirm it. Same-URL navigation must be observed from before the change; a standalone
wait cannot prove a reload that already finished. CSS selectors are used only for
read-only conditions, never guessed action targets.

`confirmed` means the supplied observable condition was met. Without an expected
condition, a completed command returns `inconclusive`. Browser/app errors,
preflight rejection and deadline expiry remain distinct. A timeout, cancellation
or broken transport can leave an action outcome uncertain. Never automatically
retry a submission or other mutation; reattach and inspect first. Programmatic DOM
click/fill/select operations may be rejected by sites requiring trusted user gestures;
they do not grant user activation. Browser tools expose no arbitrary JavaScript API.

## Ownership, privacy and lifecycle

One controller lease exists per connector, including observe leases. A second
attachment is rejected until detach or worker expiry. The lease is bound to the
browser websocket identity, exact target, control mode and verified ingress
principal/client/grant hash. A shared OAuth grant does not identify individual
chats: the unguessable lease token supplies additional capability ownership.
Status and tabs never reveal another lease. Without the ingress verifier, local
embeddings use an explicit bearer lease and the same conservative single-controller
policy. OpenCode worker permission rules do not govern direct HostPlane tools.

The principal must authorize consequential external effects. `authorized:true`
records the caller's authorization assertion; it is not an independent human
approval system. Page content is untrusted observation data. Browser access is a
privileged capability of the host account, not an OS sandbox.

The adapter omits AX values (including password values), removes URL credentials,
query values and fragments from observations, masks common token patterns, bounds
names and output, and does not expose cookie, storage, profile or raw CDP APIs.
Page-visible text and screenshots can still contain sensitive application data;
redaction is not a general secret detector. No snapshots/screenshots persist by
default, and raw worker/CDP errors and stderr are withheld.

The lazy Python worker uses versioned, correlated JSON lines over private pipes,
2 MiB frames, at most 16 pending requests, and per-request deadlines. It closes
only Nodriver `Connection` sockets; no Nodriver `Browser` owner, destructor or
process cleanup object is created. Linux Chrome is launched separately with an
independent process group and ignored stdio. Chrome never belongs to the worker's
process lifetime.

The worker exits after five idle minutes. A request cancellation or IPC failure
terminates only Python and invalidates its leases. Process-exit recovery has a
one-second backoff and at most three starts per minute. The next authorized call
can start a worker, but recovery requires explicit attachment and never replays an
action. Connector SIGTERM/SIGINT reaps Python; pipe EOF closes connections after
forced connector termination. Chrome identity changes and closed targets reject
old leases. An old debugging port does not establish browser identity.

## Acceptance and licensing

Run `OPENCODE_CONNECT_BROWSER_TEST=1 npm run test:browser` after explicit setup.
The suite launches fixture-owned Chrome with a disposable dedicated profile,
tests exact targets, ownership, protected values, uploads, same-origin iframes,
stale references, navigation verification, images, HTTP request lifetime, worker
death, timeout recovery, normal/forced connector exits, and browser replacement at
the same port. Test cleanup closes only its own fixture browser.

Run `npm run browser:benchmark` with the installed `playwright-cli` for a controlled
20-trial comparison. See [acceptance evidence](browser-acceptance.md) for measured
results and deployment evidence. General Chat discovery, source tests and live
deployment are separate checks; refresh the connector catalog if stale.

Nodriver is an unmodified **AGPL-3.0** dependency. Its installed distribution
contains the license, and its source is available from
[the upstream project](https://github.com/ultrafunkamsterdam/nodriver) and
[the exact pinned PyPI release](https://pypi.org/project/nodriver/0.50.6/).
Separate-process use is not a claimed licensing exemption. Review applicable AGPL
obligations before redistribution or changes to network-served integrated code.
Other dependencies retain their installed license notices. No Nodriver source is
vendored or forked.
