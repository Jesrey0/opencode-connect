import { resolveBaseDir, prepareBuild, activateBuild, rollbackBuild, deploymentStatus, ActivationFailedError } from "./deployment.js";

function usage(): string {
  return [
    "opencode-connect deploy",
    "",
    "  prepare [--source <dir>] [--base <dir>]   build an immutable release from source",
    "  activate <buildId> [--base <dir>]         switch current, restart, verify (auto-rollback on failure)",
    "  rollback [--base <dir>]                   switch to previous, restart, verify (reversible)",
    "  status [--base <dir>] [--json]            show current/previous, service, live health, source",
    "",
    "Release identity is the 16-hex content hash of package.json,",
    "package-lock.json, tsconfig.json and src/**/*.ts. Dirty work is allowed;",
    "commit/dirty metadata stays observability-only in build.json.",
  ].join("\n");
}

function flag(args: string[], ...names: string[]): string | null {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
  }
  return null;
}

function has(args: string[], ...names: string[]): boolean {
  return names.some((name) => args.includes(name));
}

function printStatus(status: Awaited<ReturnType<typeof deploymentStatus>>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const line = (label: string, value: string) => console.log(`${label.padEnd(10)} ${value}`);
  line("current:", status.current ? `${status.current.buildId} ${status.current.path} runnable=${status.current.runnable}` : "(none)");
  line("previous:", status.previous ? `${status.previous.buildId} ${status.previous.path} runnable=${status.previous.runnable}` : "(none)");
  line("service:", status.service.state);
  line("live:", status.live.reachable
    ? `build=${status.live.buildId ?? "(missing)"} version=${status.live.version ?? "(missing)"} ok=${status.live.ok}`
    : `unreachable${status.live.error ? `: ${status.live.error}` : ""}`);
  line("drift:", status.drift === null ? "unknown" : String(status.drift));
  if (status.source) {
    line("source:", status.source.available
      ? `${status.source.commitShort ?? "?"}${status.source.dirty ? " (dirty)" : ""} branch=${status.source.branch ?? "?"} ${status.source.dir}`
      : `(no git metadata) ${status.source.dir}`);
  }
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const baseDir = flag(rest, "--base") ?? resolveBaseDir();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (command === "prepare") {
    const source = flag(rest, "--source") ?? process.cwd();
    const result = await prepareBuild({ sourceDir: source, baseDir });
    console.log(result.reused ? `reused ${result.buildId}` : `prepared ${result.buildId}`);
    console.log(result.path);
    return 0;
  }
  if (command === "activate") {
    const buildId = rest.find((arg) => !arg.startsWith("--"));
    if (!buildId) {
      console.error("activate requires <buildId>");
      return 2;
    }
    try {
      const result = await activateBuild(buildId, { baseDir });
      console.log(`activated ${result.buildId}`);
      console.log(result.path);
      if (result.previousBuildId) console.log(`previous ${result.previousBuildId}`);
      return 0;
    } catch (error) {
      if (error instanceof ActivationFailedError) {
        console.error(`activation failed (${error.rollback}): ${error.message}`);
        if (error.rollbackError) console.error(`rollback: ${error.rollbackError}`);
        return 1;
      }
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (command === "rollback") {
    try {
      const result = await rollbackBuild({ baseDir });
      console.log(`rolled back to ${result.buildId}`);
      console.log(result.path);
      if (result.previousBuildId) console.log(`previous ${result.previousBuildId}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (command === "status") {
    const status = await deploymentStatus({ baseDir });
    printStatus(status, has(rest, "--json"));
    return 0;
  }
  console.error(`unknown command: ${command}\n\n${usage()}`);
  return 2;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
