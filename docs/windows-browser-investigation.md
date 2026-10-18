# Everyday Windows Chrome connection

Investigated on 2026-10-18. The current Windows selector supports a traditional HTTP
CDP endpoint already reachable through WSL loopback. It does not implement Chrome's
permission-based connection to the principal's everyday profile or a transport
across WSL NAT. Both are required for the intended Windows workflow.

## Verified observations

| Surface | Evidence |
| --- | --- |
| Windows listener | Chrome PID 6292 listening on `127.0.0.1:56005` during initial inspection. |
| HTTP discovery | Both `/json/version` and `/json/list` returned 404 from Windows. |
| Native discovery | The existing profile's `DevToolsActivePort` contained a port and browser WebSocket path. |
| WSL network | `wslinfo --networking-mode` returned `nat`; WSL loopback refused port 56005 and the Windows gateway connection timed out. |
| Connector configuration | Browser support enabled; Windows endpoint unset. |
| Windows-local connection | A Windows child process launched from WSL connected using the published WebSocket path and received `Browser.getVersion`: `Chrome/155.0.8059.85`, CDP 1.3. |
| Diagnostic boundary | Only `Browser.getVersion` was sent. No targets were enumerated or attached. The socket closed normally without a browser-close command. |
| Existing Linux runtime | Linux Chrome remained reachable at version 155.0.8059.84; connector build `6f98ddf8aba904fe` returned HTTP 200 health. |

An earlier Windows-local attempt returned 403 without a visible prompt. Its exact
cause remains inconclusive; the subsequent successful connection establishes that
the Windows WebSocket path can work. Windows PowerShell's .NET client also rejected
an optional custom User-Agent locally before an initial connection attempt. The
successful request used default headers and no proxy. A private fixture confirmed
that this client sends no Origin header by default.

The diagnostic did not launch or close Chrome, edit browser or service configuration,
or create or copy a profile. Windows-local connection success is
distinct from connector attachment and page-action acceptance, which remain unverified.

## Protocol and implementation gaps

Chrome's approval mode deliberately returns HTTP 404 for JSON discovery. It uses
ordinary CDP over a browser WebSocket and accepts the connection after browser
approval. Its approval branch does not enforce a GUID suffix as browser identity.
See the [Chromium handler](https://github.com/chromium/chromium/blob/155.0.8059.82/content/browser/devtools/devtools_http_handler.cc#L585).
The relevant handler and consent implementations were compared between 155.0.8059.82
and 155.0.8059.85 and were identical.

Official Puppeteer discovers this socket by reading the port and path from
`DevToolsActivePort`, then connects directly. See
[Puppeteer discovery](https://github.com/puppeteer/puppeteer/blob/ff3103c8e46f1b97e00a6a4a72f8e2509cbc796f/packages/puppeteer-core/src/common/BrowserConnector.ts#L119).
WSL NAT and mirrored networking expose different localhost behavior; see
[Microsoft's networking contract](https://learn.microsoft.com/en-us/windows/wsl/networking).

The current adapter has these gaps:

- `src/browser/worker.py` accepts only an HTTP loopback base, requires
  `/json/version` in `discover`, and requires `/json/list` in `targets`. Each guarded
  page operation repeats HTTP discovery. A WebSocket-only endpoint cannot pass.
- No Windows-local transport exists. Changing the configured port cannot make the
  Windows loopback listener reachable from this NAT environment.
- Approval precedes tab discovery, but the public attachment tool requires an
  already-discovered exact target. There is no explicit browser-connection phase
  with a bounded human-consent deadline. Passive status must remain non-activating.
- Endpoint-URL equality is insufficient identity in approval mode. An approved
  socket/session needs its own generation; disconnect must invalidate leases and
  references without automatically reconnecting an old lease.
- Current acceptance exercises Linux's traditional debugging server. It does not
  cover Windows approval, HTTP-404 discovery, NAT transport, consent denial or
  Windows socket replacement. The generic unreachable diagnostic also incorrectly
  suggests launching Linux Chrome for a Windows discovery failure.

The discovery failure was reproduced against the actual worker using a private
HTTP-404 fixture: status reported unreachable, tab discovery rejected with
`unreachable`, and a directly configured WebSocket URL rejected as `invalid_endpoint`.
With no Windows endpoint configured, status reports that limitation and tab
discovery rejects with `not_configured` before attempting a connection.

## Required implementation and acceptance

Keep Linux as the default and retain the existing Nodriver page-action layer,
exact-target leases, authorization, bounded observations and mutation verification.
The page-action layer's compatibility with an approved Windows target still needs
live acceptance.

Add a Windows-local connection helper over private, owned process pipes. It should
discover the selected existing Chrome instance locally and connect to its loopback
WebSocket. WSL can launch such a Windows process and receive CDP output, as the
diagnostic demonstrated. This avoids changing WSL networking, exposing a debugger
to the LAN or substituting another profile.

Provide explicit consent acquisition before tab enumeration. Reuse the approved
connection for `Browser.getVersion`, `Target.getTargets` and exact
`Target.attachToTarget`; preserve observation/control modes and the single-lease
contract. Detach, cancellation and worker cleanup close owned transport resources
while preserving Chrome. Report missing discovery, transport failure, pending or
denied approval, and lost connection distinctly.

Acceptance must cover approval and denial; passive status; changed port and
browser identity; socket loss and helper/connector termination; lease conflicts;
stale references; uncertain mutations; actual Windows tab selection and page
verification; and preservation of the default Linux workflow. Windows page tests
require a deliberately selected target and their own authorized scope.
