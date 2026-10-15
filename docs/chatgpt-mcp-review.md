# ChatGPT MCP ergonomics and interface review — 2026-10-15

Scope: OpenCode Connect 0.10.0, pinned native/client OpenCode 2.0.24; existing
12 tools only. This is a source/interface review, not deployment, public plugin
submission certification, or proof of ChatGPT tool selection.

## Official OpenAI sources

Fetched and reviewed on **2026-10-15**:

- https://developers.openai.com/plugins/build/mcp-server — tool metadata,
  shared server instructions (important guidance in the first 512 characters),
  bounded useful results, Inspector and client evaluation.
- https://developers.openai.com/plugins/reference — explicit output schemas,
  structured/text results, annotations and optional metadata.
- https://developers.openai.com/plugins/plugin-guidelines — accurate descriptions,
  explicit safety hints, minimal inputs/results and individually reviewed operations.
- https://developers.openai.com/plugins/deploy/connect-chatgpt — representative
  selection tests and refreshing metadata after an authorized deployment.
- https://developers.openai.com/plugins/build/auth — OAuth discovery, challenges,
  per-tool security schemes and server-side authorization.

These documents govern the ChatGPT-facing interface; they do not authorize
changes to native OpenCode primitives, permissions or execution semantics.

## Findings and smallest changes

| Surface | Evidence and decision |
| --- | --- |
| Generic ChatGPT schema presentation | Real `tools/list` already exposes object properties, required `type`, enum values and strict `oneOf` variants. The reported generic frontend projection is not reproduced by this source test. Keep the schema; describe `type` (not `action`) and valid list/read examples explicitly. No aliases or permissive fallback. |
| Command ergonomics | Describe `kind` with a shell example and the existing separate `command.read` step. Publish shared selectors, canonical identity, continuation and uncertain-mutation rules in server instructions, under 512 characters. |
| Large validation errors | A real MCP call with arbitrary unknown argument keys reproduced an error that echoes those keys. Strict union object errors now omit key names, without accepting them. Discriminator, missing-field, bound and refinement errors retain SDK handling. This is not a blanket limit on every possible SDK/wire error. |
| Structured errors | Existing connector errors use `structuredContent` but previously fell outside success-only output schemas. Publish the existing safe error/recovery/deletion envelope alongside success shapes. No result fields or native calls change. SDK input errors remain text-only. |
| Large contracts | Flattened discovery properties help model projection; `oneOf` retains exact variant requirements. Removing either without client evidence risks ergonomics or validation. Keep both; do not replace explicit contracts with a generic executor or schema registry. |
| Broad results | Existing bounds already cover inventory pages (default 25, max 50, 96 KB entry budget), file bytes (default 12,000, max 65,536), text pages (12,000 UTF-16 units), message previews (512 units), and the 256 KiB structured-result ceiling. Diff inventories exclude patch text. Keep fingerprint/native-cursor continuations and returned `nextCall`; request a smaller page or specific detail instead of adding another shaping layer. Native APIs may still materialize complete files/lists before projection. |
| Text versus structured results | OpenAI reference makes both content fields optional and requires structured data to match `outputSchema`. Keep concise objects in `structuredContent`, `content: []`, and a separate bounded image block for images. No duplicate JSON text is required for these ordinary tools. The profile-tool-specific compatibility example is not a requirement to add a profile tool or duplicate all results. |
| Failure aggregate | Reported 732 calls / 13 failed / 0 unfinished across 11 sessions does not identify failed calls, causes, or the connector path. No current failure-level native evidence was supplied/discovered through available tools. Do not attribute those failures or fetch raw native context to explain them. |

### Safety annotations retained

All tools keep stable names/titles, explicit schemas, nonempty descriptions and
all four boolean hints. `test/mcp.test.ts` asserts the exact 12-tool inventory
and hint values; `test/protocol.test.ts` validates HTTP discovery and results.

- `status`, `host.inspect`, `opencode.wait`, `opencode.inspect`, `opencode.query`:
  read-only, non-destructive, bounded/private-world, idempotent observations.
- `host.write`, `host.worktree`: potentially destructive, non-idempotent,
  workspace-bound writes. Combined worktree metadata covers mutations too.
- `command.start`, `command.control`, `opencode.start`, `opencode.act`:
  state-changing, potentially destructive, non-idempotent and open-world because
  arbitrary commands/worker actions may reach arbitrary destinations.
- `command.read`: **not read-only or idempotent**, potentially destructive
  because native persistent-PTY observation can remove exited handles; bounded
  native handle access is not itself open-world.

Annotations are not authorization. Native worker permissions do not constrain
the separate direct-host authority.

### Source verification

An active source console was detected, so dependencies/build artifacts were
installed and checked only in an ignored `.worktrees/` validation copy.

- **PASS:** `npm run check:all`, including exact OpenCode 2.0.24 and unchanged
  11-method Codex RPC integration verification; `npm run build`.
- **PASS:** focused MCP/host/HTTP tests (27); `npm run test:all` (314 connector
  tests and 170 plugin tests, zero failures).
- **PASS:** actual MCP unknown-field probe with 100 long keys returns a
  **193-byte** error result, without fixture key/value echoes; discovery still
  lists exactly 12 tools. Initial regression tests failed before the fix.
- **PASS:** validated changed files match the working source; native host,
  connection, HTTP/server auth boundary and package pins are unchanged.
- Existing environment warnings remain: locked transitive `node-domexception`
  and `glob` deprecations during `npm ci` (audit: zero vulnerabilities), and a
  Node experimental-loader warning, independently reproduced by the unchanged
  plugin entrypoint test. They were not suppressed or addressed by dependency
  or native-runtime changes in this sprint.

## Ownership boundaries and unresolved acceptance

- Public OAuth discovery, token validation, challenges and resource metadata
  belong to shared host-ingress, not this repository's loopback MCP server.
  Public authorization/cookies are stripped before forwarding. No ingress,
  native configuration, token handling or permission controls changed here.
  The source HTTP tests retain metadata/header/version/Origin rejection and
  authenticated Events discovery checks; they do **not** verify live OAuth.
- OpenAI recommends per-tool `securitySchemes` and documents a `_meta` mirror
  plus tool-level authentication challenges. This backend currently inherits
  ingress authentication rather than declaring per-tool schemes. End-to-end
  scheme/challenge advertisement requires operator inspection of the public
  boundary. Do not label private tools `noauth`, invent scopes, or add a second
  OAuth implementation to work around missing public evidence.
- OpenAI recommends focused tools and the directory guidelines say to expose
  model-callable operations separately rather than hide them behind a generic
  executor. These 12 accepted families explicitly enumerate their strict
  variants in discovery; there is no dynamic operation/schema lookup. Whether
  this grouping is acceptable for a future Directory submission remains an
  operator/product review question. Splitting it would conflict with this
  sprint's fixed tool count; no runtime or catalog redesign is authorized.
- The build/connect docs use initialization-era examples; the accepted endpoint
  serves per-request MCP `2026-07-28` discovery and rejects legacy initialization.
  Instructions are tested on its real `server/discover` response. Do not enable
  legacy protocol behavior just to match an example. Inspector/client version
  compatibility needs a separate live check.

## Operator acceptance after separately authorized activation

Source checks are not MCP Inspector or ChatGPT acceptance. No deployment,
plugin reload, account linking or connection refresh was performed here.

1. Use a protocol-compatible MCP Inspector against the authorized endpoint;
   inspect instructions, all 12 tools, schemas, hints and representative errors.
   Verify unauthenticated requests fail with the correct resource-metadata
   challenge; verify authorized calls and expired/revoked grants separately.
2. Refresh the custom MCP server connection and start a new ChatGPT conversation.
   Record selected tool, arguments, result/error, confirmation and unnecessary
   calls for the scenarios below. Redact credentials, prompts and file contents.
3. Compare source discovery with the actual model-visible projection before
   assigning any remaining generic-schema issue to the connector.

| Evaluation request | Expected contract |
| --- | --- |
| Direct: list the authorized project directory | `host.inspect` with `type:"list"`, absolute `cwd`, not `action` |
| Indirect: show the first small portion of its README | `type:"read"`, explicit path and a small `limit` |
| Follow-up: continue that read | Returned read-only `nextCall` with fingerprint; no guessed cursor |
| Authorized content search | Native shell through `command.start` then `command.read`; no synchronous exec/search alias |
| Boundary: wrong selector, extra field, oversized limit | Clear `isError`, strict rejection before native access; no arbitrary key dump |
| Authorized write or worker start | Correct confirmation/annotations; persisted readback or native admission identity; no automatic uncertain retry |
| Unsupported: raw native context or live LSP request | No invented operation or sensitive context exposure |

Until these checks run, the source improvements are verified locally only;
actual ChatGPT selection, Inspector compatibility and public OAuth remain
**INCONCLUSIVE**, not evidence of a connector defect or full compliance.
