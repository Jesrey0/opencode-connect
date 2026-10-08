import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireStoreLock } from "../src/storeLock.js";
import { Events } from "../src/events.js";

const lockModule = new URL("../src/storeLock.ts", import.meta.url).href;

test("kernel lock excludes other processes and recovers after SIGKILL without deleting its inode", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lock-crash-"));
  const path = join(root, "store.lock.sqlite");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { acquireStoreLock } from ${JSON.stringify(lockModule)};
     acquireStoreLock(${JSON.stringify(path)});
     process.stdout.write('ready'); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => { throw new Error("lock holder exited before ready"); }),
    ]);
    const inode = (await stat(path)).ino;
    assert.throws(() => acquireStoreLock(path), /already owned/u);
    child.kill("SIGKILL");
    assert.equal((await exited)[1], "SIGKILL");
    const release = acquireStoreLock(path);
    try {
      assert.equal((await stat(path)).ino, inode);
      assert.throws(() => acquireStoreLock(path), /already owned/u);
    } finally { release(); }
    const next = acquireStoreLock(path);
    release(); // A repeated release must not unlock the new owner's connection.
    try { assert.throws(() => acquireStoreLock(path), /already owned/u); }
    finally { next(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("stale legacy PID locks (including a live reused PID) never block startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lock-legacy-"));
  try {
    for (const legacy of [String(process.pid), "999999999", "", "malformed"]) {
      await writeFile(join(root, "store.lock"), legacy);
      const events = await Events.open(join(root, "store.json"));
      try { assert.deepEqual(events.targets(), []); }
      finally { await events.close(); }
      assert.equal(await readFile(join(root, "store.lock"), "utf8"), legacy);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent startup admits exactly one owner; old close cannot release a successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lock-race-"));
  try {
    const path = join(root, "store.json");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => Events.open(path)));
    const owners = results.filter((result) => result.status === "fulfilled");
    assert.equal(owners.length, 1);
    for (const result of results) if (result.status === "rejected") assert.match(result.reason.message, /already owned/u);
    const first = owners[0]!.value;
    await first.close();
    const next = await Events.open(path);
    try {
      await first.close();
      await assert.rejects(Events.open(path), /already owned/u);
    } finally { await next.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all startup failures release the lock, including recovery and persist failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lock-failure-"));
  try {
    const path = join(root, "store.json");
    for (const data of ["not json", JSON.stringify({ subscriptions: null })]) {
      await writeFile(path, data);
      await assert.rejects(Events.open(path));
      const release = acquireStoreLock(join(root, "store.lock.sqlite"));
      release();
    }
    await rm(path);
    await assert.rejects(Events.open(path, { now: () => { throw new Error("recovery failed"); } }), /recovery failed/u);
    await assert.rejects(Events.open(path, { now: () => { mkdirSync(path); return Date.now(); } }));
    const release = acquireStoreLock(join(root, "store.lock.sqlite"));
    release();
    await rm(path, { recursive: true });
    const events = await Events.open(path);
    await events.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lock I/O errors fail closed rather than being mistaken for stale ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lock-io-"));
  try { assert.throws(() => acquireStoreLock(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
});
