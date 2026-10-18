import { createHash } from "node:crypto";
import { readFile, mkdir, access, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = join(root, "src/browser/requirements.lock");
const key = createHash("sha256").update(await readFile(lockfile)).digest("hex").slice(0, 16);
const target = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode-connect/browser", key);
const python = join(target, "bin/python");
const run = (command, args) => {
  const child = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (child.error || child.status !== 0) throw new Error("Browser dependency setup failed");
};
// Installation is explicit, isolated, hash checked and never runs in a tool call.
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
const setupLock = target + ".setup-lock";
try { await mkdir(setupLock); } catch { throw new Error("Browser setup already running; inspect " + setupLock); }
try {
  try { await access(python); } catch { run(process.env.OPENCODE_CONNECT_BROWSER_SETUP_PYTHON ?? "python3", ["-m", "venv", target]); }
  run(python, ["-m", "pip", "install", "--require-hashes", "--no-deps", "-r", lockfile]);
  run(python, ["-B", "-c", "import nodriver; assert nodriver.__version__ == '0.50.6'"]);
  console.log("Browser Python: " + python);
} finally { await rm(setupLock, { recursive: true, force: true }); }
