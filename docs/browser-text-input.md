# Browser text input release acceptance

OpenCode Connect 0.14.0, build `0ed346b5a473ccb1`, was activated on
October 19, 2026. Runtime source commit: `0e334d9f0406816fe70f4bd2a32272168c0ac311`.
The previous build `aead26457addd3be` remains available for rollback.

## Findings and implementation

The previous fill primitive used a native control value setter and input/change
events. Text insertion used CDP `Input.insertText`; it provided no sequential
keyboard mode. Both the public schema and Python worker imposed the text ceiling.
Zod measures Unicode code points, while the old worker counted UTF-16 units;
the updated bounds agree on Unicode code points.

| Contract | Behavior |
| --- | --- |
| Fill, type_text, workflow text steps, exact expected values | Up to 64,000 Unicode characters. Fill replaces; type_text inserts at the current selection. |
| `type_text.inputMode:"fast"` or omitted | Native CDP insertion. Inputs above 12,000 characters use ordered 8,000-character parts, each sent once. Control progress and selection are checked before continuing. |
| `type_text.inputMode:"sequential"` | Native rawKeyDown, char and keyUp per Unicode code point, up to 2,000 characters. Keyboard cancellation remains effective. |
| `keyDelayMs` | Sequential only, deterministic 0–1,000 ms between characters. Impossible delay budgets reject before typing. |
| `textVerification` | Separate from application postcondition verification; exact text is `confirmed` or explicitly `unverified`. Workflows retain the aggregate result. |

Controls with observable selections receive exact automatic read-back. Editors
without an observable selection, including contenteditable, need a same-element
expected value for exact verification. Submitted text is not echoed in results.
Native maxlength is respected; transformed or incomplete control text reports
`partial_input`. Focus, editability and full reference identity are checked
between sequential events and large insertion parts. Uncertain mutations are
never retried, replayed or switched to another mode.

Large multiline editors also exposed the private CDP message bound. That bound
is now 16 MiB; public IPC and result limits remain 2 MiB and 256 KiB. Exact target
checks use native AX queries and ancestor inspection rather than transferring
entire editor layout subtrees. AX subscriptions are scoped to observation.

## Verification

- Source checks, full build and source/install integration contract passed.
- Full suite: 349 connector tests passed with three explicit opt-in skips;
  145 native plugin tests passed.
- Browser opt-in suite: all 79 tests passed, including 13 text acceptance checks.
  Python boundary/media suite: all 24 passed.
- The prepared immutable build independently passed the same 13 text checks in
  disposable Chrome: exact 64k Unicode fill, selection insertion and
  contenteditable; trusted event ordering and autocomplete listeners; delays;
  maxlength; numeric fill and email insertion; focus/identity/editability
  changes; cancellation, transformation, workflow reporting and mutation timeout
  without late replay.
- Live health identifies the exact build. Live MCP discovery serves 38 tools,
  including 26 browser tools, with the 64k limit, input modes, delay bound and
  text-verification outputs exposed.
- Authenticated MCP `browser.status` passed. Native Codex runtime discovery and
  read-only quota retrieval passed through authenticated MCP without model turns.
  Browser mutations were tested against the installed backend in disposable
  fixtures, rather than production application data.
- Native configuration, plugin source and the original Chrome tab IDs are
  preserved. Protected rollback and acceptance records reside under
  `~/.local/state/opencode-connect/browser-text-20261019/`.

## Limits and connector refresh

Refresh/reconnect OpenCode Connect to load the changed tool schema. The native
plugin source is unchanged; no plugin configuration migration is required.

Operation deadlines remain bounded to 30 seconds, with a 10-second default.
Allow `timeoutMs:30000` for substantial documents. Dense line breaks, expensive
page handlers and rich-editor normalization can still cause timeout or failed
verification. There is no guarantee for arbitrary framework editors or hidden
server persistence. Exact automatic insertion read-back bounds the existing
control value to 128,000 UTF-16 units. A whole workflow must fit the IPC cap.

Sequential input supports printable Unicode and LF, including spaces and common
punctuation. Tab and other control characters reject before dispatch; fast mode
supports literal tabs. LF sends Enter and may invoke application handlers.
Physical keyboard layout, IME composition and randomized typing are outside this
contract. Fill remains fast replacement. Full details are in
[the browser capability contract](browser-capability.md).
