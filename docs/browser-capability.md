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
| `OPENCODE_CONNECT_BROWSER_WINDOWS_ENDPOINT` | Unset; optional exact loopback permission-mode browser WebSocket (`ws://`), never an HTTP endpoint. |
| `OPENCODE_CONNECT_BROWSER_WINDOWS_USER_DATA_DIR` | Unset; absolute mounted Windows Chrome user data directory. Reads only its bounded `DevToolsActivePort` metadata to discover the current loopback WebSocket; configure this or the Windows endpoint, not both. |
| `OPENCODE_CONNECT_BROWSER_CHROME` | Auto-detect Linux Chrome/Chromium executable; optional absolute executable path. |
| `OPENCODE_CONNECT_BROWSER_PYTHON` | Managed environment; optional preinstalled Python with the exact Nodriver version. |
| `OPENCODE_CONNECT_BROWSER_SETUP_PYTHON` | `python3`; interpreter used for explicit environment creation. |
| `OPENCODE_CONNECT_BROWSER_UPLOAD_ROOTS` | Empty (uploads denied); colon-separated absolute authorized directories. |
| `XDG_DATA_HOME` | `~/.local/share`; managed environment and dedicated Chrome profile parent. |

Debug endpoints require an explicit loopback IP and port without credentials,
query or fragment. Linux HTTP discovery accepts no path and rejects redirects or
a WebSocket outside the configured host/port. Windows accepts only `ws://`
browser endpoints with `/devtools/browser` paths (optionally followed by a browser
ID), either configured directly or read from `DevToolsActivePort`. A configured
Windows HTTP endpoint fails closed before any discovery request or consent
handshake. Neither HTTP nor WebSocket redirects are followed; no Windows HTTP
fallback exists. Never expose or proxy CDP publicly.

## Linux and optional Windows Chrome

Call `browser.status` first. It reports configured endpoint reachability, worker
state, version, attachment state, bounded Linux Chrome process IDs/debug-port
availability, `currentIssue`, and a timestamped `lastIncident`. Running Chrome without a debug port is
visible but cannot be converted into an attachable instance. A closed Linux
browser with no debugging process is reported as unreachable, not as an incident. Pipe-only automation
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
An explicit `browser.close` stops only the ownership-verified dedicated Linux
systemd unit and its profile. An absent browser is an ordinary already-closed
result; an unrelated endpoint or uncertain process identity is refused.
It never closes Windows Chrome or an independently launched Linux Chrome.
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
CDP discovery and attachment are not supported. See the historical
[Windows permission-mode acceptance evidence](windows-browser-investigation.md);
source tests do not establish current live-browser acceptance.

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
| `browser.status` | Optional `browser` (`linux` default); Windows optionally accepts its approved `connectionId`. Reports passive endpoint reachability, attachment socket state, `connectionState` and worker diagnostics. This does not verify the full MCP action path or an earlier action outcome. |
| `browser.connect` | Explicit `browser:"windows"`, `authorized:true`, optional `timeoutMs` (1000–120000, default 60000); request Chrome consent and return private `connectionId` plus version. |
| `browser.tabs` | Optional `browser`, `filter` and `maxTabs` (1–100, default 50); Windows requires its approved `connectionId`, Linux uses no connection handle. Returns exact target IDs, sanitized URLs/titles, lease flags and honest truncation. Narrow a truncated list with a title/URL filter. |
| `browser.launch` | Optional `headless` (default false); `reused`, reachability and new process ID when applicable. Linux only. |
| `browser.close` | No arguments; explicitly stop only verified connector-managed Linux Chrome. Reports `alreadyClosed` and `reachable:false`; refuses unrelated instances. |
| `browser.attach` | Exact `targetId`, `controlMode:observe|control`, optional `browser`; Windows requires its approved `connectionId`, Linux uses no connection handle. Returns opaque `leaseId`, generation and target summary. |
| `browser.snapshot` | `leaseId`, optional `maxNodes` (1–300, default 100), `frameId`, container `scopeRef`, name/role substring `filter`; compact AX roles, names, states, references, document generation, frame summaries, truncation and observation errors. |
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
document epoch, plus the observed role/name and named ancestors. Reordering the
same DOM nodes preserves identity; repurposing a node or named container rejects
the old reference. `scopeRef` restricts a snapshot to descendants of a current
container; that snapshot expires all previous references, including `scopeRef`.
Rejections require a new observation, never a guessed replacement.
`frameId` must belong to the selected tab. Same-origin iframes are supported;
unavailable out-of-process frame trees produce explicit observation errors.

Model-visible tools use distinct, explicitly described operations. The action
union is the **internal** backend contract, not a generic MCP executor or a
compatibility route.

Native input support: `click`, `right_click`, `double_click`, `hover` and
`drag` use Chrome's CDP mouse events instead of JavaScript `element.click()`.
`key_combo` and `type_text` use CDP keyboard/text events. Normal `keypress`
supports Enter, Tab, Escape, Backspace, Delete, arrows, Home, End and Space.
`scroll` and `scroll_xy` use bounded DOM scrolling. They report dispatch rather than verified scroll position; native wheel-event injection is not yet accepted by the Chrome fixture and is not advertised.

`fill` and `select` remain programmatic DOM operations that raise input/change
events, but may not satisfy sites demanding trusted user activation. Fields must
be visible and enabled; fill rejects read-only and password controls.
Typing, keyboard actions and filling verify that focus handlers did not replace,
repurpose or redirect the intended editor before dispatching input.
After fill has dispatched input/change, a site may legitimately move focus or
disable the accepted control. Exact fill read-back checks the same identity and
value without requiring continued focus or editability. A requested focus/state
postcondition is still verified separately.

`fill` replaces an input/textarea value using the native value setter and
input/change events. `type_text` inserts at the current selection in a text
control or contenteditable. Both accept up to 64,000 Unicode code points, as do
workflow text steps and exact element-value conditions. Astral characters count
once. The 2 MiB IPC request cap still applies to an entire workflow; oversized
requests reject before dispatch. Submitted values are not returned in results.

`type_text.inputMode` defaults to `"fast"` (CDP `Input.insertText`). Large values
use ordered parts without retries; control progress is checked between parts.
`inputMode:"sequential"` sends native rawKeyDown, char and keyUp events for each
Unicode code point, up to 2,000 characters. Chrome preserves cancelled keyboard
events. Optional `keyDelayMs` is a deterministic 0–1,000 ms delay between
characters, default 0, accepted only in sequential mode. The total delay must fit
the request/step deadline (100–30,000 ms, default 10,000), with time for actual
processing. An admissible delay does not guarantee completion before timeout.
Identity, editability and focus are checked between keys; focus is never restored
mid-sequence. There is no key retry, mode fallback, or replay after uncertainty.
Sequential text supports printable Unicode and LF. LF sends Enter
and can trigger application keyboard handlers. Tab would navigate focus, so
sequential tab and other control characters reject before dispatch; use fast
insertion for literal tabs.
These events do not model a platform keyboard layout or IME composition.

Both operations respect a native control's `maxlength` (measured by HTML in
UTF-16 units), including the current selection for insertion. Single-line
controls reject line breaks. Automatic insertion read-back needs an observable native selection; controls
such as email/number/date need a same-element expected value to verify insertion.
Fill retains replacement semantics for these controls. Inserting into a control
whose existing value exceeds 128,000 UTF-16 units rejects before editing because
exact automatic read-back is bounded. Unpaired surrogates reject before text dispatch.

Successful text actions include `textVerification:"confirmed"` when exact control
read-back matches, independently of application `verification`. Contenteditable and controls without an observable selection
require a same-element `expected:{type:"element",target,value}` to confirm exact
control value or rendered `innerText`; otherwise `textVerification:"unverified"` states the
limitation. Workflows aggregate that field across attempted text edits; a
non-value postcondition cannot prove exact editor content. Rich editors can
normalize text or move selection; no generic normalization is assumed.

Length/mode violations reject before dispatch. `site_limit` identifies native
maxlength rejection and reports the exact bound in UTF-16 code units; the
connector's 64,000-character ceiling does not override a smaller site limit.
`partial_input` identifies mismatched control text after
input, and `input_budget_exceeded` identifies an impossible delay budget. A
mutation-time timeout, focus/identity interruption, or failed postcondition keeps
mutation uncertainty. Inspect current content and selection before continuing;
never resend an uncertain part. An application's custom limit can appear as
`partial_input` or a failed expected-value condition rather than `site_limit`.

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
`navigation(fromUrl)`, and `element(target,value?,state?)`. Element conditions
require one exact role/name match, optionally within one named ancestor in the
same frame. They can compare an exact field value or contenteditable rendered
text, or assert enabled, disabled, focused, checked, unchecked, expanded,
collapsed, selected or editable. Actual field values are not returned. Missing
targets continue observation; ambiguous targets reject immediately.
Navigation uses the main document's loader change or a changed sanitized
URL plus interactive-or-complete readiness. This confirms a parsed main document,
not full subresource loading; explicitly request readyState(complete) when full load
matters. An unrelated iframe reload cannot confirm it. Same-URL navigation must
be observed from before the change; a standalone wait cannot prove a reload that
already finished. CSS selectors are used only for read-only conditions, never
guessed action targets.

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
`upload`), `target:{role,name,frameId?,within?:{role,name}}`, the action's values, a required `expected`
condition and optional `timeoutMs`. Roles and names match exactly against a fresh
accessibility observation immediately before that step. Missing elements are
observed until the step deadline; ambiguous or incomplete observations stop the
workflow. Document/element identity is checked by the ordinary action path.
Fresh snapshots rotate prior references, including references held by callers.

The total deadline caps all steps; it does not multiply by the step count.
Results report `completedSteps` (confirmed postconditions), zero-based `failedStep`
or null, `errorCode`, `errorLayer`, verification and whether any mutation may have
occurred. `dispatched` is cumulative across the workflow; `stepDispatched` reports
input dispatch for the failing step and is false when every step confirmed.
No action is retried. A failed step can already have changed the page, so reconcile
its current state before constructing a continuation. This batches known UI
interactions without an embedded script or another model turn.

Errors distinguish validation, lease, target, input, observation, browser, worker,
transport and result layers without exposing native exception contents. A lost
Chrome socket is not reported as a stale element. Invalid or oversized replies
after an action retain mutation uncertainty, even when completion cannot be
decoded. An upstream `UNAVAILABLE` may precede the server or follow dispatch;
endpoint readiness alone cannot establish which occurred. Reconcile before retry.
See [browser reliability acceptance](browser-reliability.md) for fixtures,
incident findings, usage examples and rollout requirements.

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
default, and raw worker/CDP errors and stderr are withheld. Tool errors include
the same safe diagnostics in standard MCP text content and structured content.
The service journal records tool name, error code/layer and dispatch state;
it omits arguments, error messages and page content.

The lazy Python worker uses versioned, correlated JSON lines over private pipes,
2 MiB frames, at most 16 pending private frames, and per-request deadlines.
Public requests are admitted one at a time; an overlapping request returns
`busy` without dispatch or interruption of the active request. A private request
whose deadline expires while queued rejects without invalidating the attachment.
The worker closes
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
Tab listings reconcile dead sockets and changed browser identity before reporting
lease ownership. Explicit attachment can discard a dead lease; healthy leases
still require their owner's release. Detach authenticates the owner and handle
without requiring a healthy socket or page. Windows recovery still requires
explicit Chrome approval when its approved connection has been lost.

`browser.status.currentIssue` describes the selected browser's current probe
issue. It is null for a healthy endpoint with no selected attachment.
`lastIncident: { at, message }` retains the latest sanitized connector-wide incident
with an ISO UTC timestamp, including idle release or worker stderr, after recovery.
Historical incidents alone do not indicate a current fault. The lightweight
`status` readiness view describes only the local supervisor and does not probe the
browser endpoint or lease. For long
application-side generation, detach after submission and explicitly rediscover,
reattach and inspect when verifying the result. Lease expiry does not close the
page or prove generation failed; never submit generation again merely to recover
an attachment.

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
