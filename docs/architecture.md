# Architecture and operator navigation

## Repository topology (Node 24 and npm workspaces)
- Root package: opencode-connect, the MCP adapter, HostPlane and OpenCode session facade (src/).
- Workspace package: packages/codex-plugin, the native OpenCode V2 plugin, direct Codex ACP backend and read-only App Server quota reader. It is not another MCP server.
- Independent tests: test/ and packages/codex-plugin/test/.
- Docs, scripts, CI and the root package-lock.json are shared governance. The workspace owns its manifest but not an independent lock file.

There are two runtime components and one source/install lock. This repository is the sole source owner. PlatformPlane `$0xOperator` guidance is separately managed by ChatGPT, while runtime-specific operator knowledge lives in native OpenCode global skills under `~/.config/opencode/skills/` and is discovered at runtime; neither is mirrored into this repository. A legacy standalone plugin checkout, if one still exists, is superseded rather than a parallel source owner and may be retired only after independent acceptance and rollback verification.

## Module ownership
- src/opencode.ts is the public WorkerPlane facade: admission, wait/act orchestration, runtime routing and query envelopes.
- src/runtime/query.ts owns the native query union and exhaustive resolution, reading native catalogs directly.
- src/runtime/result.ts owns the inspection contract and bounded, fingerprint-pinned assistant selection. It imports only projections/bounds/continuations, never the facade.
- src/runtime/projection.ts owns pure native projections and outcome-evidence shapes. Callers import helpers from their owning modules; the facade does not re-export them.
- src/codex.ts validates the connector-facing RPC boundary; src/codexRpc.ts owns the importable connector declaration. It never executes plugin code or Codex turns directly.
- packages/codex-plugin/src/index.js registers the plugin; direct.js owns native sessions/RPC; codex.js owns the ACP backend; app-server.js owns the read-only App Server JSON-RPC transport; usage.js owns quota read authorization and projection; stdio.js owns shared child-process lifetime and bounded stderr handling. The two protocol transports depend on stdio.js, not on each other.
- Local plugin configuration names packages/codex-plugin/src, whose index.js is resolved by the pinned native directory loader. npm package exports also resolve to src/index.js; there is no package-root directory wrapper.

## Call path
External ChatGPT -> opencode-connect HTTP/MCP -> OpenCode 2.0.24 native client -> OpenCode private service.
For Codex: the connector calls the codex-sessions RPC, registered by the workspace plugin in the OpenCode service. Direct Codex uses ACP sessions. The plugin does not intercept OpenCode's native subagent tool. Quota reads call the installed Codex App Server with a short-lived read-only client.

For optional browser operations: the existing MCP handler shares one connector-owned
`src/browser/backend.ts` across requests. It supervises `src/browser/worker.py` over
private pipes. The worker uses pinned Nodriver connection/CDP APIs to an explicitly
selected Chrome target. `src/browser/schemas.ts` and `tools.ts` own validation and
projection. Linux Chrome is launched independently when explicitly requested and
survives worker/connector cleanup. Python source and lock are hashed release assets;
the explicit setup environment lives outside immutable builds. See
[browser capability](browser-capability.md) for configuration and ownership.

## Dependency rules
- The root package pins @opencode/client and the plugin pins @opencode/plugin to exactly the same 2.0.24 release; scripts/verify-integration.mjs enforces this.
- The connector must not import the plugin's implementation to run a Codex turn; RPC remains the sole runtime interface. The source verifier imports the real connector declaration using Node 24's native type stripping and the installed workspace's authoritative direct.js definition without running setup, checks installed/locked versions and exact method sets. test/codex.test.ts crosses the real native client/MCP boundary into injected plugin handlers, without a model turn. Plugin helper imports also go directly to their owners, not through index.js or direct.js aliases.
- The root package-lock.json owns both package dependency trees. Avoid reintroducing a nested lockfile.
- Hashing and copying share one inventory: root manifests/tsconfig, all regular files under src/ and scripts/, and the plugin manifest and src/. Tests/docs/node_modules/dist are not staged. Runtime assets cannot be shipped unhashed; symlinked source inputs fail explicitly. Plugin code changes require a new release ID.
- Every source/release must declare the complete plugin workspace; connector-only trees are rejected. Prepare checks snapshot identity before building and after pruning, verifies the pruned workspace import/RPC and native directory-entry contracts, and refuses mismatched inputs. This is build/install validation, not verification of the plugin loaded by the live service.
- Generated artifacts are not sources of truth. Changes to config and service are separate from test results.

## Local development
Install development dependencies with: npm ci --include=dev (even when NODE_ENV=production)
Check with: npm run check:all
Test with: npm run test:all
Build the connector with: npm run build
Verify plugin contract with: npm run verify:integration
Verify source release identity with: npm run verify:release (also in check:all)

The root npm commands preserve existing connector entrypoints. To run plugin-only tests: npm test --workspace opencode-codex-subagent

Focused tests: node --import tsx --test test/runtime-modules.test.ts test/codex.test.ts test/deployment.test.ts; node --test packages/codex-plugin/test/codex-usage.test.js packages/codex-plugin/test/stdio.test.js. Existing catalog/message/result/wait suites continue to protect moved behavior. Tests inject services and spawn fixtures only; verify:integration does not contact a running OpenCode service.

Do not replace checkout node_modules or rebuild its dist beneath an active console. Use a temporary source validation copy when the checkout toolchain is pruned. Source tests, a staged installation, and live acceptance are distinct evidence.

## Deployment boundary and acceptance
Only an authorized operator may prepare/activate/rollback a release or change/reload OpenCode plugin configuration.

Connector deployment stages the workspace but manages only opencode-connect.service. It does not update global plugin configuration or reload the independent OpenCode service. /health proves connector identity/native connectivity, not loaded plugin identity or quota functionality. Switching current alone must not be treated as a plugin reload.

For each coordinated deployment, record the old plugin configuration and connector build, validate the source gates, then separately authorize preparation, plugin loading and connector activation. Use the explicit immutable builds/<buildId>/packages/codex-plugin/src path to make the loaded version auditable. Preserve existing plugin options. Verify the native plugin inventory, RPC capabilities, direct-session behavior and read-only quota at their owning runtime after the authorized load.

Rollback automation swaps connector current/previous only. Restore the corresponding immutable plugin path/configuration and verify its native reload separately. Treat the recorded pre-cutover connector build and plugin path as the rollback pair for that deployment; no historical release is a permanent default baseline. A rollback candidate is valid only if it contains the complete workspace and still passes the required integration/layout checks. Connector-only releases are outside the supported release invariant. See [release lifecycle](release-cutover.md) for the coordinated acceptance and recovery gates; re-inspect runtime identity before acting.
