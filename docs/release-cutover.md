# Coordinated release lifecycle

This is an operator runbook, **not** a shell script. The MCP connector and native
OpenCode plugin have separate lifecycles. Connector activation/rollback alone
never proves the plugin has changed.

## Release identity and rollback candidates

No immutable release is a permanent default baseline. Before every cutover,
re-inspect the deployed/current and previous connector builds, the exact configured
native plugin path/options, and the loaded OpenCode inventory. Record the
pre-cutover connector build plus exact loaded/configured plugin identity and path
as one rollback pair. The two build IDs may differ when unchanged plugin code
remains loaded during a connector-only activation. Historical
acceptance records are evidence about their date only; they do not replace current
runtime inspection.

- This repository owns both sources; `packages/codex-plugin` is an npm workspace,
  not a separate MCP server. Its stable package name remains `opencode-codex-subagent`.
- The default release store is `~/.local/lib/opencode-connect/builds/<buildId>/`.
  Inspect the installed unit and deployment configuration for the actual baseDir;
  pass it explicitly when it differs. Release identity covers connector/plugin source, manifests, and build scripts.
- `build.json` must have the complete current record, including full source and
  installed runtime checksums. Reuse, activation, rollback and runnable status
  rehash source, `dist` and pruned `node_modules`, rerun the installed integration
  verifier and check compiled package-relative identity. Missing or tampered files
  fail before service/link changes. Corrupt existing candidates are preserved,
  never automatically rebuilt. Keep release storage immutable; checksums are not
  signatures or protection against an owner replacing artifacts and the record.
- Supported source and runnable release trees must declare and contain the complete
  plugin workspace. Connector-only releases are not accepted by this source's
  deployment implementation. Validate the recorded rollback release itself rather
  than assuming an older accepted build remains suitable.
- Unsealed historical build records are unsupported, with no conversion or
  compatibility reader. Before cutover, independently prepare and accept a sealed
  rollback pair. Activation also validates the old current target for recovery;
  automatic recovery never restarts an invalid candidate.
- Configure the immutable `<builds>/<buildId>/packages/codex-plugin/src` directory,
  never a moving `current` path. The pinned OpenCode 2.0.24 loader resolves a local
  directory's `server` or `index`, not package `main`/`exports`. New releases omit
  the package-root wrapper; npm imports still resolve to `src/index.js`.

## Gate A — source validation and preparation

Prepare, activate and rollback serialize through `<baseDir>/deploy.lock.sqlite`.
An exclusive SQLite transaction holds ownership until the operation finishes or
the process exits, including crash recovery. Keep deployment state on a local
filesystem with SQLite locking; never unlink or replace this file. Lock I/O or
corruption fails closed. Use one accepted deployment-tool version for all
concurrent operations; different ownership protocols cannot coordinate.

Deployment helpers must run with the selected Node 24 binary directory on their
own `PATH`, including background and systemd helpers. An absolute Node executable
in the helper command is insufficient: deployment validators spawn `node` by
name. Verify Node resolution in that execution environment; an interactive shell's
version manager does not establish the user service manager's environment.

1. Confirm the independently reviewed commit and Git diff. Run `npm ci --include=dev`,
   `npm run check:all`, `npm run test:all`, `npm run build`, and
   `npm run verify:integration` in an isolated source copy if a console uses the checkout.
   `check:all` includes `verify:release`, which rejects package/lock/runtime/README
   release drift and a stale README native-client pin. This source check does not
   attest the deployed connector, loaded plugin or ChatGPT tool exposure.
2. Within the principal's authorization, use the newly compiled
   `dist/src/deploy.js prepare --source <source-directory>` to prepare an immutable
   release. Preparation does not activate or reload either runtime.
3. Inspect `build.json`, connector output, plugin source, installed workspace exports,
   native directory resolution, RPC/version parity, and production dependencies.
   Preparation must also import the compiled console quota observer through the
   plugin workspace export. Activation rechecks sealed integrity and connector
   identity while preserving the already accepted rollback build's contract.
   Record the immutable build ID/path and intended rollback target.
4. Preserve the prior connector identity and exact native plugin path/options in a
   protected rollback record. Never log secrets. Validate that the rollback target
   has its complete workspace and independently recoverable plugin configuration.

## Gate B — live activation

Use the principal's existing authorization for the intended cutover. Before a
disruptive reload, inspect native OpenCode's actual lifecycle controls and all
dependent consoles, active OpenCode sessions, supervised Codex children and pending
requests. Do not reload while dependent work remains active. Restarting the
connector does not restart OpenCode.

### Connector-only activation

A complete prepared release can update the connector while the existing native
plugin stays loaded. This path requires evidence before activation:

1. Resolve the loaded plugin implementation from native inventory and
   `opencode.runtime {cwd,runtime:"codex"}`, including its immutable package/build
   identity. Record the actual configured path and options. A configured path or
   expected version alone does not prove which implementation is loaded.
2. Compare every plugin runtime input under `packages/codex-plugin/src/`, the
   plugin package manifest and the pinned native client/plugin versions between
   that implementation and the prepared candidate. Verify byte identity, complete
   inventories and installed RPC compatibility; the source integration check
   remains required. Missing loaded identity, unavailable inputs or any changed
   runtime input disqualifies this path.
3. Preserve the configured immutable plugin path and loaded OpenCode process.
   Activate only the prepared connector through the deployment implementation.
   Verify connector health/readiness and the unchanged loaded plugin identity,
   native process identity and `codex-sessions` capabilities.
4. Record both identities separately. The new connector's build ID does not
   relabel the already loaded plugin. No plugin reload is implied by acceptance.

### Coordinated plugin activation

When plugin equivalence is unproved or runtime inputs change, use this path:

1. Within the principal's authorization, resolve dependent work before loading
   the new immutable plugin `src` path. Preserve unrelated configuration, plugin
   options and permissions. Use the native owner's supported reload mechanism.
   Verify loaded inventory and `codex-sessions` capabilities; configuration presence
   alone is not loading evidence.
2. Activate the prepared connector through the repository's deployment
   implementation. `/health` establishes connector identity/connectivity, not
   plugin identity.
3. Verify native agent discovery, non-Codex session operations, Codex direct
   mode/approval behavior with harmless tasks and read-only quota at their owning
   runtime. Record release and native process identities.

### Native guidance refresh

Connector-only activation does not necessarily update native cached guidance.
After writing operator guidance, verify persisted file readback and then read its
canonical native skill content through `opencode.skill`. Follow the live schema's
page bounds and returned continuations; disk readback alone does not prove that
workers will receive the new content.

If canonical content remains stale, first look for an exposed scoped refresh
primitive. The pinned native SDK skill API exposes inventory listing, not a skill
cache invalidation operation. When no scoped refresh is available, coordinate one
supported `client.location.reload` after checking active workers, pending actions
and dependent consoles. Resolve dependent work before reloading: location reload
disposes plugins, can stop supervised Codex children and may invalidate host
command handles.

For unchanged plugin inputs, preserve configuration, the immutable plugin path
and its options. Reloading the same implementation does not relabel its loaded
build as the connector's newer build. If the reload response is lost or uncertain,
reconcile through read-only runtime identity and canonical skill-content probes;
do not issue repeated reloads. After any reload, reverify canonical guidance,
native plugin identity/RPC compatibility and representative live MCP operations.

### Catalog and PlatformPlane acceptance

After either path, inspect deployed MCP discovery and representative focused
operations. For 0.17.0, verify resource namespaces, unified `opencode.*` worker
control, direct typed reads, compact model discovery and shell/terminal routing.
Use [Catalog migration](catalog-migration.md) to update callers and saved
continuation names.

Refresh the ChatGPT connector after the server cutover when the client still
exposes the previous catalog. Then verify actual PlatformPlane tool names,
arguments and representative calls. A successful host-side tools/list or local
HTTP probe proves the server catalog; it does not prove that an existing ChatGPT
conversation has refreshed. Record server deployment and client acceptance
separately. Accept completion only for the layers actually verified.

## Recovery

- Stop at a failed gate; do not delete the prior or prepared release.
- For connector-only activation, retain the unchanged plugin path/options and
  loaded identity. No native reload is needed to restore the recorded pair.
- If plugin configuration/loading changed, restore the recorded immutable plugin
  path/options and reload its native owner after resolving dependent work;
  verify native identity, RPC and quota independently.
- Roll back the connector only if activation occurred. Rollback swaps current/previous
  and remains reversible to the recorded pre-cutover connector build. Restore the
  recorded plugin state separately when it changed, then verify health and MCP behavior; report partial
  recovery if any check cannot complete.
- Automatic connector rollback cannot restore native plugin configuration.

## Legacy standalone-checkout cleanup

If a legacy standalone plugin checkout still exists, it is superseded and is not
part of release preparation. Deletion is a separate operator-owned action **after
independent cleanup acceptance**:

1. Verify that all applicable configurations and live processes are independent of it.
2. Confirm the accepted connector and rollback target both have complete immutable
   plugin workspaces, with recorded paths/options and a viable coordinated recovery plan.
3. Independently accept the cleaned source/release and obtain explicit deletion authorization.

Source workers do not deploy, change global configuration, reload services, or
remove the standalone checkout. Git publication is also a separate decision.
