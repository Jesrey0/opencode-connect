/**
 * Test harness: an in-memory stand-in for the OpenCode V2 tool editor and the
 * subset of the plugin Context this plugin uses. The built-in subagent is kept
 * in the editor to prove plugin setup does not transform native tools.
 *
 * The editor mirrors the semantics of the real `ToolEditor` from
 * @opencode/plugin@2.0.24: `get` returns the registered tool plus its id,
 * `add` registers/replaces by effective name, and `update` mutates in place.
 *
 * `ctx.rpc.register` mirrors the real registration: handlers are keyed by the
 * definition id and method names, and `context.error` produces the same typed
 * error envelope the runtime would.
 */

import { installCodexSessions } from "../src/index.js"

export function createToolEditor(tools) {
  const registry = new Map(tools.map((tool) => [tool.id ?? tool.name, tool]))
  return {
    registry,
    list: () => [...registry.values()],
    get(id) {
      return registry.get(id)
    },
    add(tool) {
      registry.set(tool.name, tool)
    },
    update(id, mutate) {
      const tool = registry.get(id)
      if (!tool) return
      mutate(tool)
    },
    remove(id) {
      registry.delete(id)
    },
  }
}

/**
 * Builds a plugin Context with direct RPC registration and an untouched native
 * `subagent` tool that records calls.
 *
 * @param {object} options
 * @param {object} [options.pluginOptions] Plugin options (`enableCodex`, ...).
 * @param {object} [options.internals] Injection seam forwarded to the plugin.
 * @param {AbortSignal} [options.signal] Tool-call signal.
 */
export async function createHarness({
  pluginOptions = { enableCodex: true },
  internals,
  signal,
  cwd = "/tmp/opencode-project",
} = {}) {
  const nativeCalls = []
  const rpcCalls = []

  /** Handlers registered by the plugin, keyed `id.method`. */
  const rpcRegistry = new Map()

  const builtInSubagent = {
    id: "subagent",
    name: "subagent",
    description: "Launch a subagent.",
    input: { any: true },
    output: { any: true },
    execute: async (input, context) => {
      nativeCalls.push({ input, context })
      return { output: { sessionID: "ses_native", status: "completed", output: `native:${input.prompt}` }, metadata: { native: true } }
    },
  }

  const editor = createToolEditor([builtInSubagent])

  const ctx = {
    options: pluginOptions,
    location: { directory: cwd },
    tool: {
      transform: async (callback) => {
        callback(editor)
        return { dispose: async () => {} }
      },
    },
    rpc: {
      register: async (definition, handlers) => {
        const namespace = {}
        for (const [name, handler] of Object.entries(handlers)) {
          const key = `${definition.id}.${name}`
          namespace[name] = async (input, options = {}) => {
            rpcCalls.push({ method: key, input })
            // The runtime's typed handler-error factory, reduced to the same
            // `{ type, message, data }` envelope it produces.
            const error = (type, message, data) => ({
              __handlerError: true,
              type,
              message,
              ...(data === undefined ? {} : { data }),
            })
            const result = await handler(input, {
              signal: options.signal ?? new AbortController().signal,
              error,
            })
            if (result?.__handlerError) {
              const { __handlerError: _ignored, ...envelope } = result
              throw Object.assign(new Error(envelope.message), envelope)
            }
            return result
          }
        }
        rpcRegistry.set(definition.id, { definition, namespace })
        return { dispose: async () => rpcRegistry.delete(definition.id), events: { emit: async () => {} } }
      },
    },
  }

  const dispose = await installCodexSessions(ctx, internals)

  const subagent = editor.get("subagent")
  const callContext = {
    sessionID: "ses_parent",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    signal: signal ?? new AbortController().signal,
    progress: async () => {},
  }

  return {
    editor,
    ctx,
    dispose,
    nativeCalls,
    rpcCalls,
    builtInSubagent,
    subagent,
    call: (input, context) => subagent.execute(input, { ...callContext, ...context }),
    /** Handlers registered under an RPC id, or undefined when nothing registered. */
    rpc: (id) => rpcRegistry.get(id),
    /** Invokes an RPC method exactly as a client would. */
    rpcCall: (id, method, input, options) => {
      const registered = rpcRegistry.get(id)
      if (!registered) throw new Error(`no RPC registered under "${id}"`)
      const handler = registered.namespace[method]
      if (!handler) throw new Error(`no RPC method "${id}.${method}"`)
      return handler(input, options)
    },
  }
}
