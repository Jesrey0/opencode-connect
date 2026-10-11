/**
 * A shutdown-behaviour ACP agent over stdio.
 *
 * Two modes, both used by the transport shutdown tests:
 *
 * Mode and target come from SHUTDOWN_MODE and SHUTDOWN_TARGET.
 *
 *   `exit-on-eof`  answers stdin EOF by writing the target file and exiting
 *                  cleanly, the way a cooperative agent does.
 *   `ignore`       ignores stdin EOF and SIGTERM, and spawns a long-lived
 *                  grandchild whose PID is written to the target file. Only
 *                  owned-group termination can reap both, which is what
 *                  codex-acp's own Codex child needs.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import { Readable, Writable } from "node:stream"

import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk"

const mode = process.env.SHUTDOWN_MODE
const target = process.env.SHUTDOWN_TARGET
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
const agent = new AgentApp({ name: "shutdown-acp-stdio" })

agent.onRequest("initialize", ({ params }) => ({
  protocolVersion: params.protocolVersion,
  agentInfo: { name: "shutdown-acp-stdio", version: "1.0.0" },
  agentCapabilities: { loadSession: false, promptCapabilities: {} },
  authMethods: [],
}))

if (mode === "exit-on-eof") {
  process.stdin.on("end", () => {
    fs.writeFileSync(target, "eof")
    process.exit(0)
  })
} else {
  // Deliberately uncooperative, standing in for an agent still shutting down.
  process.on("SIGTERM", () => {})
  process.stdin.on("end", () => {})
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  fs.writeFileSync(target, String(grandchild.pid))
  // Held referenced so the agent is still alive when close() escalates, which is
  // the only situation in which owned-group termination is exercised.
  setInterval(() => {}, 1000)
}

agent.connect(stream)