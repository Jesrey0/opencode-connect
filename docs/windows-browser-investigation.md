# Everyday Windows Chrome compatibility

OpenCode Connect 0.12.0 supports Chrome's permission-based WebSocket connection to
the principal's existing Windows browser. Linux remains the default. Windows uses
native mirrored-network loopback from WSL; no Windows helper, port proxy, extra
profile or networking change is required.

## Protocol and lifecycle

Chrome approval mode deliberately returns HTTP 404 for JSON discovery and uses
ordinary CDP over a browser WebSocket. It accepts the socket only after browser
approval. See the [Chromium handler](https://github.com/chromium/chromium/blob/155.0.8059.82/content/browser/devtools/devtools_http_handler.cc#L585).
The relevant handler and consent source was compared between 155.0.8059.82 and
155.0.8059.85 and was identical.

The connector reads bounded `DevToolsActivePort` metadata from the explicitly
configured mounted user data directory, matching [Puppeteer's discovery](https://github.com/puppeteer/puppeteer/blob/ff3103c8e46f1b97e00a6a4a72f8e2509cbc796f/packages/puppeteer-core/src/common/BrowserConnector.ts#L119).
An exact configured loopback WebSocket is also supported. Passive status uses TCP
readiness and never requests consent. Explicit `browser.connect` acquires approval,
then a private caller-bound connection handle permits target discovery and exact
tab attachment. Both use the same socket and existing Nodriver CDP machinery.

The socket's generation is part of capability ownership: a browser URL alone does
not revive a connection. Loss or replacement of the socket or discovery metadata
invalidates leases and references. Recovery requires a fresh explicit connection,
new tab selection and a new snapshot. Uncertain mutations are never replayed.
Detach, cancellation and worker/connector cleanup close transport resources while
preserving Chrome and its profile. Legacy HTTP discovery remains supported.

## Verified environment

The initial 2026-10-18 investigation observed WSL NAT, where Windows loopback was
unreachable. The environment subsequently changed to mirrored networking.
Readback confirmed `wslinfo --networking-mode` returned `mirrored`, TCP to
`127.0.0.1:56005` succeeded from WSL, and `/json/version` returned the expected 404.
The remaining defect was application compatibility. See [Microsoft's networking
contract](https://learn.microsoft.com/en-us/windows/wsl/networking).

A Windows-local diagnostic established a browser WebSocket and read
`Browser.getVersion` as Chrome 155.0.8059.85, CDP 1.3. An earlier 403 without a
visible prompt remains unexplained; subsequent connection success does not
establish its cause. No private targets were enumerated by that diagnostic.

## Acceptance

The updated source adapter was exercised over the actual mirrored connection
against an explicitly created test tab in the existing Windows profile. It passed
passive readiness, approval, CDP target discovery, exact attachment, accessibility
snapshot, fill/click with an observed application result, selection, bounded
screenshot, navigation, stale-reference rejection and transport-only detach.
Only the owned fixture tab was selected and closed. No profile was created or
copied, and no networking configuration changed.

Automated permission-mode fixtures use the pinned Nodriver dependency and a local
WebSocket server that returns HTTP 404 for discovery. Cases distinguish passive
status from consent, enforce owner/token and lease identity, verify socket reuse,
preserve legacy HTTP behavior, exercise approval denial and delays longer than
ten seconds, bound consent deadlines and competing operations, invalidate closed
sockets and changed metadata, and verify cleanup sends no browser-close command.

Source, automated fixtures, live adapter checks, release deployment and live MCP
acceptance are separate evidence. Deployment and MCP results are recorded after
their own checks; the source adapter result alone does not establish them.
