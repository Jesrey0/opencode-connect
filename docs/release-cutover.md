# Coordinated release lifecycle

This is an operator runbook, **not** a shell script. The MCP connector and native
OpenCode plugin have separate lifecycles. Connector activation/rollback alone
never proves the plugin has changed.

## Release identity and rollback candidates

No immutable release is a permanent default baseline. Before every cutover,
re-inspect the deployed/current and previous connector builds, the exact configured
native plugin path/options, and the loaded OpenCode inventory. Record the
pre-cutover connector build plus plugin path as one rollback pair. Historical
acceptance records are evidence about their date only; they do not replace current
runtime inspection.

- This repository owns both sources; `packages/codex-plugin` is an npm workspace,
  not a separate MCP server. Its stable package name remains `opencode-codex-subagent`.
- Installed releases live under `~/.local/lib/opencode-connect/builds/<buildId>/`.
  Release identity covers connector/plugin source, manifests, and build scripts.
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

1. Confirm the independently reviewed commit and Git diff. Run `npm ci --include=dev`,
   `npm run check:all`, `npm run test:all`, `npm run build`, and
   `npm run verify:integration` in an isolated source copy if a console uses the checkout.
   `check:all` includes `verify:release`, which rejects package/lock/runtime/README
   release drift and a stale README native-client pin. This source check does not
   attest the deployed connector, loaded plugin or ChatGPT tool exposure.
2. With separate operator authorization, use the newly compiled
   `dist/src/deploy.js prepare --source <source-directory>` to prepare an immutable
   release. Preparation does not activate or reload either runtime.
3. Inspect `build.json`, connector output, plugin source, installed workspace exports,
   native directory resolution, RPC/version parity, and production dependencies.
   Record the immutable build ID/path and intended rollback target.
4. Preserve the prior connector identity and exact native plugin path/options in a
   protected rollback record. Never log secrets. Validate that the rollback target
   has its complete workspace and independently recoverable plugin configuration.

## Gate B — separately authorized live activation

Do not reload while a console or active native sessions depend on the service.
Obtain the principal's authorization for disruptive changes and inspect the native
OpenCode owner's actual lifecycle controls; restarting the connector does not
restart OpenCode.

1. Load the immutable plugin `src` path, preserving unrelated configuration,
   options, and permissions. Use the native owner's supported reload mechanism.
   Verify loaded inventory and `codex-sessions` capabilities; configuration presence
   alone is not loading evidence.
2. Activate the matching prepared connector through the repository's deployment
   implementation. `/health` establishes connector identity/connectivity, not plugin identity.
3. Independently verify native agent discovery, non-Codex session operations,
   Codex direct mode/approval behavior with harmless tasks, read-only quota, and
   ChatGPT-to-MCP `status.readiness`, `opencode.runtime` and representative focused tools. Record release and native process identities.
4. Accept only after both runtimes and representative end-to-end operations pass.
   Refresh the ChatGPT connector only if its connection/catalog is actually stale.

## Recovery

- Stop at a failed gate; do not delete the prior or prepared release.
- Restore the recorded immutable plugin path/options and reload its native owner;
  verify native RPC and quota independently.
- Roll back the connector only if activation occurred. Rollback swaps current/previous
  and remains reversible to the recorded pre-cutover connector build. Restore the
  matching plugin path separately, then verify health and MCP behavior; report partial
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
