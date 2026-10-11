import assert from "node:assert/strict"
import { test } from "node:test"
import { CodexStderr, spawnOwnedStdio } from "../src/stdio.js"

test("stderr retains a bounded tail, not the first full buffer forever", () => {
  const stderr = new CodexStderr(4)
  stderr.push("abcdef")
  stderr.push("gh")
  assert.equal(stderr.summary(), "efgh")
})

test("concurrent close calls share one owned-process cleanup", async () => {
  const owned = spawnOwnedStdio(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"])
  const first = owned.close()
  assert.equal(owned.close(), first)
  await first
  assert.equal(owned.isRunning(), false)
})

test("leader exit immediately terminates residual owned descendants", async t => {
  if (process.platform === "win32") return t.skip("POSIX process-group ownership")
  const script = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(c.pid),()=>process.exit(0));"
  const owned = spawnOwnedStdio(process.execPath, ["-e", script])
  let pidText = ""
  owned.child.stdout.on("data", data => { pidText += data.toString() })
  try {
    await owned.exited()
    const pid = Number(pidText)
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    const deadline = Date.now() + 5000
    let alive = true
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { alive = false; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(alive, false, "the leader cannot leave a live child behind")
  } finally { await owned.close() }
})
