# Native Chrome capability

OpenCode Connect exposes Nodriver-backed browser operations through its existing
MCP endpoint. Linux Chrome in WSL2 is the default. The connector can inspect a
configured debugging endpoint, reuse an existing browser, or explicitly launch a
dedicated Linux Chrome profile. Windows Chrome attachment is optional.

## Setup

Requirements: Node 24, Linux Python 3.11 or newer with `venv`/`pip`, and Chrome or
Chromium. The tested host uses Python 3.12 and Google Chrome 155. Run:

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
| `OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT` | Unset; optional loopback HTTP CDP endpoint or permission-mode browser WebSocket. |
| `OPENCODE_CONNECT_BROWSER_WINDOWS_USER_DATA_DIR` | Unset; absolute mounted Windows Chrome user data directory. Reads only its bounded `DevToolsActivePort` metadata to discover the current loopback WebSocket; configure this or the Windows endpoint, not both. |
| `OPENCODE_CONNECT_BROWSER_CHROME` | Auto-detect Linux Chrome/Chromium executable; optional absolute executable path. |
| `OPENCODE_CONNECT_BROWSER_PYTHON` | Managed environment; optional preinstalled Python with the exact Nodriver version. |
| `OPENCODE_CONNECT_BROWSER_SETUP_PYTHON` | `python3`; interpreter used for explicit environment creation. |
| `OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS` | Empty (uploads denied); colon-separated absolute authorized directories. |
| `XDG_DATA_HOME` | `~/.local/share`; managed environment and dedicated Chrome profile parent. |

Debug endpoints require an explicit loopback IP and port without credentials,
query or fragment. HTTP discovery accepts no path and rejects redirects or a
WebSocket outside the configured host/port. Windows permission-mode WebSockets
accept only `/devtools/browser` paths. Never expose or proxy CDP publicly.

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
`headless:true` is available for host tests. Launching never attaches a tab.
The launcher passes `--hide-crash-restore-bubble` to suppress the startup recovery
popup without rewriting profile state or disabling session recovery.
0xOperator operates the persistent Linux browser within the authorized objective.
Shutdown or restart is a deliberate lifecycle operation; detach, worker cleanup
and connector termination preserve the browser, tabs and profile. Launch is on
demand and does not explicitly request restoration of prior tabs.

For an independently launched Linux debugging session:

```sh
google-chrome-stable --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.local/share/chrome-operator"
```

Windows attachment explicitly selects the principal's existing daily Chrome.
Enable its browser-native remote debugging and configure the mounted user data
directory, or its exact loopback browser WebSocket. Mirrored networking provides
native WSL-to-Windows loopback reachability; no Windows helper, port proxy or WSL
networking change is needed. A separate Windows profile does not provide that
daily session. The connector never launches Windows Chrome or copies profile or
authentication state.

Permission mode intentionally omits `/json/*`. Status performs a passive TCP check
and reports `approval_required`; it never attempts a WebSocket handshake. Call
`browser.connect` with explicit authorization, then accept Chrome's own Allow
remote debugging dialog. Consent has a separate deadline of up to 120 seconds;
other browser requests return `busy` while it is pending. The returned private
`connectionId` binds the approved socket to its caller. Supply it to Windows tabs
and attach; discovery uses `Browser.getVersion` and `Target.getTargets`, then exact
target attachment reuses that socket. It does not request consent again.

Detach with `leaseId` after selecting a page, or `connectionId` before selection.
Both close only the transport and release control. Socket loss, metadata changes,
worker expiry or connector restart invalidate capabilities and require a new
explicit connect; an endpoint URL cannot revive an old lease. Legacy Windows HTTP
CDP remains supported. See [Windows compatibility evidence](windows-browser-investigation.md).



### Linux Chrome process ownership

When the connector runs as the managed `opencode-connect.service`, newly
launched Linux Chrome runs in its own transient `opencode-connect-chrome`
user systemd unit. A detached child **within** the connector's cgroup would
be terminated by systemd on connector restart, so process detachment alone
is insufficient. The independent Chrome unit keeps the persistent profile,
tabs and authenticated session alive across connector releases. It is started
on demand and not enabled at boot; `browser.launch` reuses an already healthy
debugging endpoint. Direct CLI and isolated tests retain their own detached
process-group lifecycle. Inspect `systemctl --user status
opencode-connect-chrome.service` and the Chrome endpoint after any cutover.

## Tools and workflow

Names below are the native MCP names; ChatGPT may project punctuation differently.

| Tool | Arguments / result |
| --- | --- |
| `browser.status` | Optional `browser` (`linux` default) and `connectionId`; passive reachability, `connectionState` and worker diagnostics. |
| `browser.connect` | Explicit `browser:"windows"`, `authorized:true`, optional `timeoutMs` (1000–120000, default 60000); request Chrome consent and return private `connectionId` plus version. |
| `browser.tabs` | Optional `browser`, `connectionId`, `filter` and `maxTabs` (1–100, default 50); exact target IDs, sanitized URLs/titles, lease flags and honest truncation. Narrow a truncated list with a title/URL filter. |
| `browser.launch` | Optional `headless` (default false); `reused`, reachability and new process ID when applicable. Linux only. |
| `browser.attach` | Exact `targetId`, `controlMode:observe|control`, optional `browser` and `connectionId`; opaque `leaseId`, generation and target summary. |
| `browser.snapshot` | `leaseId`, optional `maxNodes` (1–300, default 100), `frameId`, name/role substring `filter`; compact AX roles, names, states, references, document generation, frame summaries, truncation and observation errors. |
| `browser.click`, `browser.right_click`, `browser.double_click`, `browser.hover` | `leaseId`, `elementRef`, `authorized:true`; native Chrome mouse input on the observed element. |
| `browser.drag` | Drag between observed `sourceRef` and `targetRef` using Chrome mouse events. |
| `browser.key_combo`, `browser.type_text`, `browser.keypress` | Focus observed field and send a bounded shortcut, Unicode text, or single key via Chrome input. |
| `browser.scroll`, `browser.scroll_xy` | Scroll a selected element programmatically, using safe bounded vertical or XY deltas. These do not produce a trusted mouse-wheel event. |
| `browser.fill`, `browser.select`, `browser.upload` | Programmatic form fill, selection, or files supplied to an observed input/chooser button; may trigger autosave/uploads. |
| `browser.navigate` | Navigate the attached tab to HTTP/HTTPS, potentially discarding unsaved form state. |
| `browser.workflow` | `leaseId`, `authorized:true`, 1–12 `steps`, optional total `timeoutMs` (100–30000, default 10000); fresh exact role/name targets, required postconditions, partial progress on failure. |
| `browser.wait` | `leaseId`, structured `condition`, optional `timeoutMs`; normal condition timeout preserves the lease. |
| `browser.media` | `leaseId`, optional `maxItems` (1–20, default 10); audio/video references, sanitized source URLs, duration, readiness and errors, including hidden players. |
| `browser.media_download` | `leaseId`, observed media `elementRef`, `authorized:true`, optional `maxBytes` (1024–33554432), `timeoutMs`; private host artifact path, MIME type, byte count and SHA-256. |
| `browser.screenshot` | `leaseId`, optional `width`/`height` (default 1280×720; maximum 1920×1080); JPEG image content, maximum 1 MiB, no file persistence. |
| `browser.detach` | Exactly one `leaseId` or `connectionId`; release control and transport while preserving Chrome and its tabs. |

Select an exact target from `browser.tabs`, attach, then take a snapshot. Use the
returned opaque `elementRef` for actions. Each snapshot replaces prior references;
navigation, frame reload, element removal, worker loss and detach invalidate them.
References bind to the leased target, frame loader, DOM backend identity and
document epoch. Rejections require a new observation, never a guessed replacement.
`frameId` must belong to the selected tab. Same-origin iframes are supported;
unavailable out-of-process frame trees produce explicit observation errors.

Model-visible tools use distinct, explicitly described operations. The legacy
action union remains an **internal** backend contract, not a generic MCP executor.

Native input support: `click`, `right_click`, `double_click`, `hover` and
`drag` use Chrome's CDP mouse events instead of JavaScript `element.click()`.
`key_combo` and `type_text` use CDP keyboard/text events. Normal `keypress`
supports Enter, Tab, Escape, Backspace, Delete, arrows, Home, End and Space.
`scroll` and `scroll_xy` use bounded DOM scrolling. They report dispatch rather than verified scroll position; native wheel-event injection is not yet accepted by the Chrome fixture and is not advertised.

`fill` and `select` remain programmatic DOM operations that raise input/change
events, but may not satisfy sites demanding trusted user activation. Fields must
be visible and enabled; fill rejects read-only and password controls.
Uploads accept a visible file input or an observed visible button that opens one.
All files must be explicitly selected absolute regular files under configured
roots; protected paths and key/certificate files are rejected before clicking.
The button path temporarily intercepts Chrome's file chooser, validates its frame,
document, backend input and single/multiple selection mode, then sets those files.
Interception is removed after success or failure. A chooser without an input
backend ID (such as a File System Access picker) fails explicitly. Directory
pickers are unsupported. No-chooser failure can follow a dispatched click;
inspect the page before retrying.

Paths belong to Chrome's operating system. Linux Chrome uses validated Linux
paths. Windows Chrome accepts validated mounted-drive paths such as
`/mnt/c/Users/.../paper.pdf`, translated to `C:\Users\...\paper.pdf` after
authorization; Linux-only paths cannot be uploaded to Windows Chrome.
Upload roots remain an operator-configured allowlist and default to empty.
Navigation allows HTTP/HTTPS without embedded credentials; navigating to the
exact current URL reloads the document. All action outputs distinguish dispatch
from a confirmed application result. The model must supply authorization and
an appropriate observable expected condition for consequential operations.

Expected/wait conditions: `text(value)` for visible main-document text,
`url(value)` for an exact URL, `elementAppears(selector,frameId?)`,
`elementDisappears(selector,frameId?)`, `mediaReady(selector,frameId?)`, `readyState(interactive|complete)`, and
`navigation(fromUrl)`. Navigation uses the main document's loader change or a
changed sanitized URL plus complete readiness. An unrelated iframe reload cannot
confirm it. Same-URL navigation must be observed from before the change; a standalone
wait cannot prove a reload that already finished. CSS selectors are used only for
read-only conditions, never guessed action targets.

`mediaReady` requires an audio/video element with current data (`readyState >= 2`)
and no media error; the player may be hidden. It does not establish that an
application's generation job finished or that spoken content is correct. Choose
an application-specific text/element condition when generation has another signal.
A normal wait or action-postcondition timeout returns `verification:"timed_out"`
and retains the lease. Continue observation with another wait or snapshot; do not
replay a mutation merely because its postcondition timed out. Cancellation,
transport failure and the outer request deadline still invalidate leases.

### Bounded workflows

Each step uses `action` (`click`, `fill`, `typeText`, `select`, `keypress`, or
`upload`), `target:{role,name,frameId?}`, the action's values, a required `expected`
condition and optional `timeoutMs`. Roles and names match exactly against a fresh
accessibility observation immediately before that step. Missing elements are
observed until the step deadline; ambiguous or incomplete observations stop the
workflow. Document/element identity is checked by the ordinary action path.
Fresh snapshots rotate prior references, including references held by callers.

The total deadline caps all steps; it does not multiply by the step count.
Results report `completedSteps` (confirmed postconditions), zero-based `failedStep`
or null, `errorCode`, verification and whether any mutation may have occurred.
No action is retried. A failed step can already have changed the page, so reconcile
its current state before constructing a continuation. This batches known UI
interactions without an embedded script or another model turn.

### Generated media

Inspect media after the application reports completion, then retrieve the chosen
reference. Media observations rotate only media references; snapshots and document
changes expire them. Downloads stream the player's current HTTP(S) or Blob source
through an isolated frame world using normal browser CORS permissions. No cookie
export, arbitrary caller URL, browser-global download policy, DRM bypass or
MediaSource extraction is provided. Source changes and byte overflow abort the
transfer and remove partial artifacts.

Artifacts use random filenames under
`$XDG_DATA_HOME/opencode-connect/browser-media/` (default `~/.local/share/`),
directory mode 0700 and file mode 0600. Successful artifacts remain available for
authorized host playback, decoding or transcription; remove them when finished.
Duration/readiness and successful download establish media availability, not
language, intelligibility or content quality. Those require examining the audio.

The pinned Nodriver 0.50.6 bindings already expose
[`Page.setInterceptFileChooserDialog` and `fileChooserOpened`](https://ultrafunkamsterdam.github.io/nodriver/nodriver/cdp/page.html),
plus [`DOM.setFileInputFiles`](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles).
These operations use the existing selected-target connection and lease.

`confirmed` means the supplied observable condition was met. Without an expected
condition, a completed command returns `inconclusive`. Browser/app errors,
preflight rejection and deadline expiry remain distinct. A timeout, cancellation
or broken transport can leave an action outcome uncertain. Never automatically
retry a submission or other mutation; inspect first, reattaching if the lease was
invalidated. Programmatic fill/select operations may be rejected by sites requiring trusted user gestures;
they do not grant user activation. Browser tools expose no arbitrary JavaScript API.

## Ownership, privacy and lifecycle

One controller lease or approved browser connection exists per connector, including observe leases. A second
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
deployment are separate checks. After refreshing a changed connector catalog,
start a new General Chat conversation with OpenCode Connect enabled, as described
in [OpenAI's connection testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
An existing conversation can still expose its earlier tool set.

Nodriver is an unmodified **AGPL-3.0** dependency. Its installed distribution
contains the license, and its source is available from
[the upstream project](https://github.com/ultrafunkamsterdam/nodriver) and
[the exact pinned PyPI release](https://pypi.org/project/nodriver/0.50.6/).
Separate-process use is not a claimed licensing exemption. Review applicable AGPL
obligations before redistribution or changes to network-served integrated code.
Other dependencies retain their installed license notices. No Nodriver source is
vendored or forked.
