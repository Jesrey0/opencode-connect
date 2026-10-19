# Browser workflow acceptance — October 19, 2026

Connector **0.13.0**, build **`d2f38de5ecdf6ccc`**, is active and healthy.
The preceding connector build is `b20513ec328dee51`.

## Verified behavior

- An observed upload button opens a hidden file input through Chrome chooser
  interception. Multiple file selection is confirmed. Unauthorized,
  unavailable, protected and directory paths fail before file assignment;
  interception is restored after failure.
- A six-step workflow inserts two sources while replacing the editor between
  insertions. Ambiguous targets stop before dispatch. An unconfirmed step stops
  subsequent actions and reports confirmed progress and mutation uncertainty.
- Normal condition timeouts preserve the lease. Worker loss, target loss and
  broken transport retain explicit recovery requirements.
- Hidden HTTP and Blob audio can be observed and retrieved byte-for-byte with a
  checksum. Byte overflow and cross-origin retrieval without CORS permission are
  rejected. Partial artifacts are removed.

## Evidence

- `npm ci --include=dev`, `npm run check:all`, `npm run test:all`,
  `npm run build` and `npm run verify:integration` passed. The connector suite
  passed 331 tests with its two explicit browser opt-ins skipped; the plugin
  suite passed 145 tests.
- The browser opt-in run passed all 46 tests against real Chrome, including
  permission-mode protocol fixtures. The pinned Python environment passed all
  18 worker/media boundary tests.
- The immutable installation passed its MCP handler smoke test: chooser upload,
  two-step workflow, wait continuation and retrieval of a 16,044-byte WAV with
  matching SHA-256.
- The live MCP catalog contains 38 tools, including 26 browser tools and the
  added workflow/media operations. Connector health, browser readiness, native
  Codex capabilities and read-only quota passed after activation.
- The native configuration matches its protected pre-activation backup. The
  configured plugin source matches the release's plugin source. Connector
  activation restarted the native service through its existing lifecycle;
  capabilities and quota were checked on the resulting process. Persistent
  Chrome remained running and detached.

The rollback record is
`~/.local/state/opencode-connect/browser-workflow-20261019/rollback.json`.
Baseline source is committed as `2f8c4d9`; Git publication remains separate.
Follow-on source changes and rollout requirements are recorded in
[native browser reliability acceptance](browser-reliability.md). ChatGPT catalog
refresh and an actual Gemini Notebook workflow remain separate acceptance surfaces.

## Limits

Upload roots remain explicitly configured and default to empty. Windows path
translation is boundary-tested; this release's upload/media behavior was exercised
against Linux Chrome. Choosers without a backend file input and directory pickers
are unsupported. Media retrieval preserves normal site/CORS restrictions and does
not verify spoken language or content quality. Background Chrome tabs may limit
preloading, so media readiness reflects available data rather than job completion.
