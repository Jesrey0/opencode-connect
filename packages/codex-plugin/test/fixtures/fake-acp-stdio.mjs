/**
 * A minimal ACP agent that speaks newline-delimited ACP over stdio.
 *
 * Used by the transport test to exercise the real spawn + stdio path without
 * spawning codex-acp and without contacting a model.
 */

import { Readable, Writable } from "node:stream"

import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk"

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
const agent = new AgentApp({ name: "fake-acp-stdio" })

agent.onRequest("initialize", ({ params }) => ({
  protocolVersion: params.protocolVersion,
  agentInfo: { name: "fake-acp-stdio", version: "1.0.0" },
  agentCapabilities: { loadSession: false, promptCapabilities: {} },
  authMethods: [],
}))

agent.onRequest("session/new", () => ({
  sessionId: "stdio-session",
  modes: {
    currentModeId: "agent-full-access",
    availableModes: [
      { id: "read-only", name: "read-only" },
      { id: "workspace-write", name: "workspace-write" },
      { id: "agent", name: "agent" },
      { id: "agent-full-access", name: "agent-full-access" },
    ],
  },
}))

agent.onRequest("session/set_mode", () => null)

agent.onRequest("session/prompt", async ({ params, client }) => {
  // Ask for approval, then try to use the client's fs/terminal methods.
  try {
    await client.request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "call-1", title: "Edit file", kind: "edit", status: "pending" },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
    })
  } catch {}

  for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create"]) {
    try {
      await client.request(method, { sessionId: params.sessionId, path: "/etc/passwd", command: "sh", args: [] })
    } catch {}
  }

  await client.notify("session/update", {
    sessionId: params.sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stdio ok" } },
  })

  return { stopReason: "end_turn" }
})

const connection = agent.connect(stream)
// A well-behaved stdio agent treats stdin EOF as "the client is gone" and
// shuts itself down, which is the path the transport tries first.
process.stdin.on("end", () => {
  try {
    connection.close()
  } catch {}
  process.exit(0)
})
process.on("SIGTERM", () => {
  try {
    connection.close()
  } catch {}
  process.exit(0)
})