/**
 * In-process fake Codex ACP agent.
 *
 * Uses the real @agentclientprotocol/sdk AgentApp so tests exercise the actual
 * ACP client/server protocol path without spawning codex-acp and without ever
 * contacting a model. No Codex quota is consumed.
 */

import { AgentApp, RequestError } from "@agentclientprotocol/sdk"

/** Protocol-valid params for the client methods this test exercises. */
function clientCallParams(method, sessionId) {
  switch (method) {
    case "session/request_permission":
      return {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "Write a file", kind: "edit", status: "pending" },
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      }
    case "fs/read_text_file":
      return { sessionId, path: "/etc/passwd" }
    case "fs/write_text_file":
      return { sessionId, path: "/tmp/secret", content: "x" }
    case "terminal/create":
      return { sessionId, command: "sh", args: ["-c", "echo hi"] }
    case "terminal/output":
      return { sessionId, terminalId: "term-1" }
    case "terminal/release":
      return { sessionId, terminalId: "term-1" }
    case "terminal/wait_for_exit":
      return { sessionId, terminalId: "term-1" }
    case "terminal/kill":
      return { sessionId, terminalId: "term-1" }
    case "elicitation/create":
      return { sessionId, mode: "form", message: "Approve?", requestedSchema: { type: "object", properties: {} } }
    default:
      return { sessionId }
  }
}

/**
 * @param {object} [behavior]
 * @param {string[]} [behavior.modes] Session modes the fake advertises.
 * @param {string} [behavior.currentModeId] Mode the session starts in.
 * @param {string[]} [behavior.clientCalls] Client methods the fake invokes during the prompt.
 * @param {string[]} [behavior.chunks] Assistant text chunks streamed back.
 * @param {boolean} [behavior.hang] Hold the prompt open until cancelled (cancellation tests).
 * @param {() => void} [behavior.onPrompt] Observe prompt admission before testing connection loss.
 * @param {string} [behavior.promptError] Reject the prompt with this message.
 * @param {string} [behavior.setModeError] Reject session/set_mode with this message.
 */
export function createFakeCodexAgent(behavior = {}) {
  const {
    modes = ["read-only", "workspace-write", "agent", "agent-full-access"],
    currentModeId,
    clientCalls = [],
    chunks = ["codex ", "done"],
    hang = false,
    promptError,
    setModeError,
  } = behavior

  const calls = { initialize: [], setMode: [], clientCalls: [], prompts: [], newSessions: [] }

  const agent = new AgentApp({ name: "fake-codex-acp" })
  let agentConnection
  agent.onConnect((connection) => {
    agentConnection = connection
  })

  agent.onRequest("initialize", ({ params }) => {
    calls.initialize.push(params)
    if (behavior.hangMethod === "initialize") return new Promise(() => {})
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
      authMethods: [],
    }
  })

  agent.onRequest("session/new", ({ params }) => {
    calls.newSessions.push(params)
    if (behavior.hangMethod === "session/new") return new Promise(() => {})
    return {
      sessionId: "codex-session-1",
      modes: {
        currentModeId: currentModeId ?? modes[0] ?? "read-only",
        availableModes: modes.map((id) => ({ id, name: id })),
      },
      _meta: { cwd: params.cwd },
    }
  })

  agent.onRequest("session/set_mode", ({ params }) => {
    calls.setMode.push(params)
    if (behavior.hangMethod === "session/set_mode") return new Promise(() => {})
    if (setModeError) throw new RequestError(-32000, setModeError)
    return null
  })

  agent.onRequest("session/prompt", async ({ params, client, signal }) => {
    calls.prompts.push(params)
    behavior.onPrompt?.()

    if (promptError) throw new RequestError(-32000, promptError)

    for (const method of clientCalls) {
      try {
        const result = await client.request(method, clientCallParams(method, params.sessionId))
        calls.clientCalls.push({ method, ok: true, result })
      } catch (error) {
        calls.clientCalls.push({ method, ok: false, error: error?.message ?? String(error) })
      }
    }

    if (hang) {
      // Only completes if the client cancels the request.
      await new Promise((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      return { stopReason: "cancelled" }
    }

    for (const text of chunks) {
      await client.notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      })
    }

    return { stopReason: "end_turn" }
  })

  return {
    agent,
    calls,
    /** Simulates the codex-acp process dying, severing the ACP connection. */
    kill: (reason = new Error("codex-acp exited")) => agentConnection?.close(reason),
  }
}
