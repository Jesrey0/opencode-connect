# Coordinated OpenCode Connect + Codex plugin cutover

This is an operator runbook, **not** a shell script. The MCP connector and the native OpenCode plugin have separate ownership and lifecycles. Connector activation/rollback alone never proves the plugin has changed.

## Release identity and responsibilities

- Root source: `/home/jesrey0/projects/opencode-connect`; plugin workspace: `packages/codex-plugin/`.
- Connector installed releases: `~/.local/lib/opencode-connect/builds/<buildId>/`.
- The plugin configuration is an independently managed native OpenCode setting; it currently points to the retained standalone `opencode-codex-subagent` checkout.
- The existing standalone plugin checkout is the **rollback artifact**, not a second source of truth for new work. Do not modify or remove it during this cutover.
- Release ID covers plugin runtime source, root manifests, scripts, and connector source. Release preparation does not activate or reload either runtime.

## Gate A — safe preparation (no live changes)

1. Confirm the reviewed source commit and clean Git worktree. Run `npm ci --include=dev`, `npm run check:all`, `npm run test:all`, `npm run build`, and `npm run verify:integration` in an isolated checkout if an interactive console is using the source checkout.
2. Use the **newly compiled** `dist/src/deploy.js prepare --source <source-directory>` implementation to stage an immutable release. Do not use the old deployed CLI implementation for workspace-aware staging.
3. Inspect the prepared release: check `build.json`, `dist/src/server.js`, `packages/codex-plugin/src/index.js`, installed workspace exports, RPC method/version parity, and production-only dependencies. Record immutable build ID and path.
4. Read (do not change) current/previous connector build IDs, connector health, native OpenCode process identity, current plugin configuration path and options. Store a rollback-safe record in an appropriately protected host location; never log secrets.
5. Verify the plugin will load from the immutable path `<builds>/<newBuildId>/packages/codex-plugin/src`, not from a moving `current` symlink. Preserve current config options/agent permissions when changing only the package path.

## Gate B — separate live cutover approval

Do **not** do this while `npm run console` or active native agent sessions depend on the current service. Obtain the principal's go-ahead for the disruptive native reload and verify the console has exited. Preflight the installed native OpenCode service's actual lifecycle controls; do not assume restarting `opencode-connect.service` restarts OpenCode.

1. Preserve the exact original config and old connector release, including their independently recoverable locations.
2. Point native OpenCode's plugin configuration to the immutable plugin path, preserving all other configuration. Use the native OpenCode owner's supported reload/restart mechanism, verify a new loaded plugin inventory/endpoint, and explicitly test its `codex-sessions` RPC capabilities; **config file presence does not prove runtime loading**.
3. Activate the matching prepared connector build via the repository's deploy implementation, which switches the connector and health-checks it. Do not count `/health` as evidence that the plugin loaded.
4. Check native OpenCode agent discovery, ordinary non-Codex session operations, Codex direct read-only/write-mode capabilities and approvals (use harmless tasks), Codex quota read, and ChatGPT-to-MCP `status` and `opencode.query` calls. Confirm source/release IDs and the native process owning RPC.
5. Mark production accepted only when both services, the MCP link and representative end-to-end operations pass. Refresh the ChatGPT connector only if the connection or catalog is actually stale.

## Recovery on failure

- Abort further steps at any failed gate. Do not delete the standalone plugin or prepared release.
- Restore the **old native plugin configuration and options** and reload/restart the **native OpenCode** owner using its verified lifecycle command. Verify the old plugin's runtime RPCs are restored.
- Roll back the connector with its `rollback` command **only if its current release was activated**; verify that the previous build is active and healthy. If activation never occurred, leave the connector untouched.
- Re-test MCP health, OpenCode-native session discovery, Codex RPC and quota separately; report partial rollback if any of those checks cannot be completed.
- Do not rely on the automatic connector rollback to restore OpenCode's plugin; it cannot.

## Non-goals until live acceptance

No publication or deletion of the retained standalone repository, no modifications to a loaded legacy plugin checkout, no blind native service kill/reload, and no assumption that source tests or a healthy connector are equivalent to live plugin acceptance.
