// Shared ownership/lifetime for the plugin's two stdio protocols. Protocol
// decoding and authority remain with ACP and the read-only quota reader.
import { spawn } from "node:child_process"

const EOF_GRACE_MS = 5_000
const TERMINATE_GRACE_MS = 2_000
const OWNS_PROCESS_GROUP = process.platform !== "win32"

export class CodexStderr {
  constructor(limit = 64 * 1024) { this.limit = limit; this.text = "" }
  push(chunk) { this.text = (this.text + chunk.toString("utf8")).slice(-this.limit) }
  summary() { return this.text.trim().slice(-2000) }
}

export function spawnOwnedStdio(command, args, { cwd, env } = {}) {
  const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: OWNS_PROCESS_GROUP })
  const stderr = new CodexStderr()
  const ignorePipeError = error => {
    if (!["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_CLOSED"].includes(error?.code))
      stderr.push("stdio transport error")
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", ignorePipeError)
  child.stderr.on("data", chunk => stderr.push(chunk))
  child.stderr.resume()

  let exited = false, closing, shutdownFailed = false
  const signalOwned = signal => {
    if (OWNS_PROCESS_GROUP && typeof child.pid === "number") {
      try { process.kill(-child.pid, signal); return }
      catch (error) { if (error.code !== "ESRCH") shutdownFailed = true }
    }
    if (!exited) {
      try { child.kill(signal) } catch { shutdownFailed = true }
    }
  }
  const exitedPromise = new Promise(resolve => {
    child.once("exit", (code, signal) => {
      exited = true
      // Reap residual descendants *now*, not on a later close that could target
      // a reused PID. The leader's exit alone does not prove group termination.
      signalOwned("SIGKILL")
      resolve({ code, signal })
    })
    child.once("error", () => { exited = true; resolve({ code: null, signal: null, error: true }) })
  })
  const withinExit = ms => new Promise(resolve => {
    if (exited) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    void exitedPromise.then(() => { clearTimeout(timer); resolve(true) })
  })
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      try {
        if (!exited) {
          child.stdin.end()
          if (!await withinExit(EOF_GRACE_MS)) {
            signalOwned("SIGTERM")
            if (!await withinExit(TERMINATE_GRACE_MS)) {
              signalOwned("SIGKILL")
              if (!await withinExit(TERMINATE_GRACE_MS)) shutdownFailed = true
            }
          }
        }
        if (shutdownFailed) throw new Error("Codex stdio process did not complete bounded shutdown; details omitted.")
      } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
    })()
    return closing
  }
  return { child, stderr, exited: () => exitedPromise, isRunning: () => !exited, close }
}
