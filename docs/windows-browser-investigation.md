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

## Release verification

Connector 0.12.0 build `fddd92c4615a79f7` was activated on 2026-10-18 from commit
`bb6c03f3478398070fcf04afbc07ca77f154053b`. All 349 connector tests and 145 native
plugin tests passed, with no failures or skips. Type checks, build and source/install
integration verification passed. The immutable preparation independently built,
pruned and verified the installation. Native plugin source and configuration were
unchanged.

The live service reports that exact healthy build and exposes 22 tools, including
all ten browser tools. Its Windows configuration names the existing mounted Chrome
user data directory. An unauthenticated production `browser.connect` call was
rejected before dispatch. Linux Chrome remained reachable on its existing profile.
The Linux launcher now supplies `--hide-crash-restore-bubble`; its process argument
was verified in the real Chrome acceptance test. The dedicated Linux workspace,
containing only a blank tab, was then gracefully closed and relaunched through the
live connector. The active process includes the flag, the persistent profile's
directory identity is unchanged, and Chrome recorded a normal prior exit. Routine
launch calls continue to reuse the reachable browser.

After an initial consent deadline expired without creating a tab, a fresh explicit
attempt with a two-minute approval window completed all nine immutable release MCP
checks against actual Windows Chrome 155.0.8059.85: passive readiness, approved
connection, filtered discovery, exact target and caller ownership, verified
fill/click, native screenshot content, verified navigation, transport-only detach
and Linux readiness. Only the owned fixture tab was selected and closed. This test
used the immutable release's MCP HTTP handler and a test ingress verifier; it did
not claim to run from General Chat.

The actual connected App independently verified production Linux status, discovery,
observation attachment, accessibility snapshot and detach, and passive Windows
`approval_required` status. After refreshing the connector and starting a branched
conversation, all ten browser tools, including `browser.connect` and connection-aware
arguments, were visible in the connected App. This verifies platform catalog
exposure; the Windows interaction evidence above remains scoped to its actual MCP
handler test.

## Main integration and release retirement

The complete browser branch was fast-forwarded into `main` and pushed to
`origin/main`. The active connector remains 0.12.0 build `fddd92c4615a79f7`, and
`6f98ddf8aba904fe` is the retained rollback release. Both immutable releases contain
the complete plugin workspace and pass the installed integration verifier.

Native plugin configuration was migrated from the legacy `1ee740f1b0945db7` build
to the current immutable `fddd92c4615a79f7/packages/codex-plugin/src` path, preserving
all other configuration and options. Plugin workspace source is byte-identical
across the old, current and rollback releases. The idle development console was
closed gracefully, the native location was reloaded and initialized through its
supported API, and the owning inventory confirmed the current plugin active.
Native agent discovery, Codex RPC capabilities, read-only quota and a read-only
direct Codex smoke turn passed. The smoke session and completed browser
investigation session were deleted through their native APIs. The primary
checkout's generated build was refreshed.

With no live references remaining, 32 obsolete immutable builds and one abandoned
staging directory were removed, reclaiming 11.07 GiB. The current and rollback
releases, persistent browser profile, browser dependencies and compact recovery
evidence were retained. The coordinated rollback configuration points to the
retained rollback plugin workspace. Protected operational evidence is under
`~/.local/state/opencode-connect/cleanup-20261018T153707Z/`.
