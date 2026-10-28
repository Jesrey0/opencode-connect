import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createServer } from "../src/mcp.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { HostBackend } from "../src/host.js";
import { BrowserBackend } from "../src/browser/backend.js";
import { browserActionInputs, browserInputs } from "../src/browser/schemas.js";
import { nativeFixture } from "./native-fixture.js";

async function fixture(handler: Parameters<typeof nativeFixture>[0] = () => { throw new Error("unexpected native request"); }, browser?: BrowserBackend) {
  const native = nativeFixture(handler);
  let connections = 0;
  const connect = async () => { connections++; return native.connection; };
  const server = createServer(new OpenCodeBackend(connect), new HostBackend(connect), undefined, browser);
  const client = new Client({ name: "focused-contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const { tools } = await client.listTools();
  const validator = new AjvJsonSchemaValidator();
  return {
    client, native, connections: () => connections,
    validate: (name: string, value: unknown, field: "inputSchema" | "outputSchema" = "inputSchema") => {
      const schema = tools.find(tool => tool.name === name)?.[field];
      assert.ok(schema, `${name}.${field}`);
      return validator.getValidator(schema as JsonSchemaType)(value).valid;
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

test("unsupported runtime and Codex field combinations reject in discovery and before connection", async () => {
  const f = await fixture();
  const nativeOnly: [string, Record<string, unknown>][] = [
    ["sessionDiff", { sessionId: "s" }], ["inbox", { sessionId: "s" }],
    ["skill", { skillId: "skill" }], ["toolCalls", { sessionId: "s", messageId: "m" }],
    ["toolCall", { sessionId: "s", messageId: "m", toolId: "t", field: "input" }],
    ["models", {}], ["agents", {}], ["agent", { agentId: "a" }],
    ["savedApprovals", { sessionId: "s" }], ["skills", {}], ["providers", {}], ["usage", {}],
    ["steer", { sessionId: "s", instruction: "task" }],
    ["cancelInbox", { sessionId: "s", inboxId: "i" }], ["updateInbox", { sessionId: "s", inboxId: "i", delivery: "queue" }],
    ["compact", { sessionId: "s" }], ["invokeCommand", { sessionId: "s", name: "test", text: "" }],
    ["invokeSkill", { sessionId: "s", skillId: "skill" }], ["respondForm", { sessionId: "s", formId: "f", answer: {} }],
    ["cancelForm", { sessionId: "s", formId: "f" }], ["revertStage", { sessionId: "s", messageId: "m" }],
    ["revertClear", { sessionId: "s" }], ["revertCommit", { sessionId: "s" }],
    ["switchModel", { sessionId: "s", model: "p/m" }], ["switchAgent", { sessionId: "s", agent: "a" }],
    ["setPermissions", { sessionId: "s", permissions: [] }], ["removeSavedApproval", { sessionId: "s", approvalId: "a" }],
    ["synthetic", { sessionId: "s", text: "context" }],
  ];
  const conditional: [string, Record<string, unknown>][] = [
    ["opencode.wait", { sessionId: "s", messageId: "m" }],
    ["opencode.permissions", { sessionId: "s" }], ["opencode.permissions", { sessionId: "s", section: "rules" }],
    ["opencode.sessions", { limit: 25 }], ["opencode.sessions", { searchTerm: "search" }],
    ["opencode.messages", { sessionId: "s", cursor: "native" }],
    ["opencode.message", { sessionId: "s", messageId: "m", field: "summary" }],
  ];
  try {
    for (const [type, args] of nativeOnly) {
      const name = `opencode.${type}`;
      assert.equal(f.validate(name, args), true, `${name} retains native default`);
      assert.equal(f.validate(name, { ...args, runtime: "opencode" }), true, `${name} retains explicit native runtime`);
    }
    for (const [name, args] of [...nativeOnly.map(([type, args]) => [`opencode.${type}`, args] as const), ...conditional]) {
      const input = { ...args, runtime: "codex" };
      assert.equal(f.validate(name, input), false, `${name} ${JSON.stringify(args)}`);
      assert.equal((await f.client.callTool({ name, arguments: input })).isError, true, name);
    }
    for (const [name, args] of [
      ["opencode.wait", { sessionId: "s" }], ["opencode.permissions", { sessionId: "s", section: "pending" }],
      ["opencode.sessions", { cursor: "native" }], ["opencode.messages", { sessionId: "s", order: "asc", limit: 2 }],
      ["opencode.message", { sessionId: "s", messageId: "m", textLimit: 2 }],
    ] as const) assert.equal(f.validate(name, { ...args, runtime: "codex" }), true, `${name} retains supported Codex inputs`);
    assert.equal(f.connections(), 0);
    assert.equal(f.native.requests.length, 0);
  } finally { await f.close(); }
});

test("a failed focused query signals MCP failure and preserves its sanitized typed evidence", async () => {
  const f = await fixture(() => Response.json({ _tag: "ServiceUnavailableError", message: "PRIVATE-UPSTREAM" }, { status: 503 }));
  try {
    for (const name of ["opencode.models", "opencode.codexQuota"]) {
      const response = await f.client.callTool({ name, arguments: {} });
      assert.equal(response.isError, true);
      const content = response.structuredContent as any;
      assert.equal("results" in content, false);
      assert.equal(typeof content.error, "string");
      assert.equal(JSON.stringify(response).includes("PRIVATE-UPSTREAM"), false);
      assert.equal(f.validate(name, content, "outputSchema"), true);
    }
    assert.deepEqual(f.native.requests.map(request => request.path), ["/api/model", "/api/rpc/codex-sessions/usage"]);
  } finally { await f.close(); }
});

test("focused query outputs validate direct fields, owning continuations and native extensions", async () => {
  const f = await fixture();
  try {
    const model = { id: "provider/model", enabled: true, cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 }, context: { min: 0, max: 1000 } }], modalities: ["text"], variants: ["high"], arbitraryNativeField: { retained: true } };
    const page = { location: { directory: "/tmp" }, view: "compact", data: [model], offset: 0, nextOffset: null, total: 1, fingerprint: "native-fingerprint", nextCall: null, arbitraryNativePageField: { retained: true } };
    assert.equal(f.validate("opencode.models", page, "outputSchema"), true);
    assert.equal(f.validate("opencode.models", { ...page, nextOffset: 1, nextCall: { tool: "opencode.models", arguments: { offset: 1, fingerprint: "native-fingerprint" } } }, "outputSchema"), true);
    for (const malformed of [
      { results: [{ index: 0, type: "models", result: page }] },
      { results: [] },
      { ...page, view: "other" },
      { ...page, data: {} },
      { ...page, data: [{ ...model, id: undefined }] },
      { ...page, data: [{ ...model, enabled: "yes" }] },
      { ...page, data: [{ ...model, cost: { input: 1, output: 2, cache: { read: 0, write: 0 } } }] },
      { ...page, data: [{ ...model, cost: [{ ...model.cost[0], input: "free" }] }] },
      { ...page, total: -1 },
      { ...page, nextCall: { tool: "opencode.session", arguments: { sessionId: "s" } } },
    ]) assert.equal(f.validate("opencode.models", malformed, "outputSchema"), false);
    assert.equal(f.validate("opencode.models", { error: "native operation failed", errorCode: "NATIVE_OPERATION_FAILED" }, "outputSchema"), true);
    const activity = {
      session: { sessionId: "s", cwd: "/tmp", status: "idle", executionOutcome: null, outcome: "unknown", outcomeBasis: "selectedAssistantMessage", model: null, modelVariant: null, agent: null },
      retry: null, outcomeEvidence: {}, nextCall: null, textNextCall: null,
      currentActivity: null, recentMessages: [], pendingActions: [],
    };
    assert.equal(f.validate("opencode.activity", activity, "outputSchema"), true);
    assert.equal(f.validate("opencode.result", activity, "outputSchema"), false);
    const result = { session: activity.session, result: {
      outcomeBasis: "selectedAssistantMessage", outcome: "unknown", messageId: null, assistantMessageId: null,
      selectionComplete: true, selectionCursor: null, selectionFingerprint: "f", candidateAssistantMessageId: null,
      scannedMessages: 0, targetFound: false, exhausted: true, terminal: false, retry: null,
      text: "", textPaging: { offset: 0, nextOffset: null, size: 0, cursorUnit: "utf16CodeUnits", fingerprint: "f" },
      truncated: false, nextCall: null, textNextCall: null, completedAtMs: null, finish: null, error: null,
    } };
    assert.equal(f.validate("opencode.result", result, "outputSchema"), true);
    assert.equal(f.validate("opencode.activity", result, "outputSchema"), false);
  } finally { await f.close(); }
});

test("shell and terminal reads have disjoint identities, cursors and lifecycle annotations", async () => {
  const f = await fixture();
  const handle = { cwd: "/tmp", id: "p" };
  try {
    for (const name of ["command.read", "terminal.read", "terminal.observePersistent"]) {
      assert.equal(f.validate(name, handle), true, name);
      for (const kind of ["shell", "pty", "persistentPty"]) {
        const input = { ...handle, kind };
        assert.equal(f.validate(name, input), false, name + " rejects kind");
        assert.equal((await f.client.callTool({ name, arguments: input })).isError, true);
      }
    }
    assert.equal(f.validate("opencode.codexQuota", { runtime: "codex" }), false);
    assert.equal((await f.client.callTool({ name: "opencode.codexQuota", arguments: { runtime: "codex" } })).isError, true);
    const base = { ...handle, location: { directory: "/tmp" }, status: "exited", pid: 1, exitCode: 0, retention: "fixture", cursor: 0, output: "", drained: false };
    const outputs = [
      ["command.read", { ...base, kind: "shell", cursorUnit: "bytes", nextCall: null }],
      ["terminal.read", { ...base, kind: "pty", cursorUnit: "utf16CodeUnits" }],
      ["terminal.observePersistent", { ...base, kind: "persistentPty", cursorUnit: "bytes" }],
    ] as const;
    for (const [name, output] of outputs) {
      for (const [other] of outputs) assert.equal(f.validate(other, output, "outputSchema"), name === other, other + " vs " + output.kind);
      assert.equal(f.validate(name, { ...output, cursorUnit: output.cursorUnit === "bytes" ? "utf16CodeUnits" : "bytes" }, "outputSchema"), false, name + " rejects wrong cursor unit");
    }
    const { tools } = await f.client.listTools();
    for (const name of ["command.read", "terminal.read"]) {
      assert.equal(tools.find(tool => tool.name === name)!.annotations!.readOnlyHint, true);
      assert.equal(tools.find(tool => tool.name === name)!.annotations!.destructiveHint, false);
      assert.equal(tools.find(tool => tool.name === name)!.annotations!.idempotentHint, true);
    }
    const persistent = tools.find(tool => tool.name === "terminal.observePersistent")!;
    assert.equal(persistent.annotations!.readOnlyHint, false);
    assert.equal(persistent.annotations!.destructiveHint, true);
    assert.equal(persistent.annotations!.idempotentHint, false);
    assert.equal(f.validate("opencode.codexQuota", {}), true);
    assert.equal(f.connections(), 0);
  } finally { await f.close(); }
});

test("consolidated browser gestures preserve key constraints, bounded axes and exact MCP dispatch", async () => {
  class CapturedBrowser extends BrowserBackend {
    calls: { method: string; args: unknown }[] = [];
    override async call(...[method, args]: Parameters<BrowserBackend["call"]>) {
      this.calls.push({ method, args });
      return { dispatched: true, completed: false, verification: "inconclusive", url: "https://fixture.test", evidence: "fixture dispatch", mutationMayHaveOccurred: true };
    }
  }
  const browser = new CapturedBrowser({ enabled: true });
  const f = await fixture(undefined, browser);
  const base = { leaseId: "lease", authorized: true, elementRef: "e" };
  try {
    for (const key of ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Space"]) {
      assert.equal(f.validate("browser.keypress", { ...base, key }), true, key);
      assert.equal(browserActionInputs.keypress.safeParse({ ...base, key }).success, true, key);
    }
    const valid = [
      ["browser.keypress", { ...base, key: "A", modifiers: ["Control"] }, "keypress"],
      ["browser.keypress", { ...base, key: "Enter", modifiers: ["Control", "Shift"] }, "keypress"],
      ["browser.keypress", { ...base, key: "Home" }, "keypress"],
      ["browser.scroll", { ...base, deltaY: 120 }, "scroll"],
      ["browser.scroll", { ...base, deltaX: -10000, deltaY: 10000 }, "scroll"],
    ] as const;
    for (const [name, args, action] of valid) {
      assert.equal(f.validate(name, args), true, name);
      assert.notEqual((await f.client.callTool({ name, arguments: args })).isError, true);
      assert.deepEqual(browser.calls.at(-1), { method: "action", args: { ...args, action } });
    }
    const invalid = [
      ["browser.keypress", { ...base, key: "A" }], ["browser.keypress", { ...base, key: "Home", modifiers: ["Control"] }],
      ["browser.keypress", { ...base, key: "A", modifiers: [] }], ["browser.keypress", { ...base, key: "A", modifiers: ["Control", "Control"] }],
      ["browser.scroll", { ...base, deltaX: 10001, deltaY: 0 }], ["browser.scroll", { ...base, deltaX: 0.5, deltaY: 0 }],
    ] as const;
    for (const [name, args] of invalid) {
      assert.equal(f.validate(name, args), false, name);
      assert.equal(browserActionInputs[name.split(".")[1]].safeParse(args).success, false, name);
      assert.equal((await f.client.callTool({ name, arguments: args })).isError, true, name);
    }
    assert.equal(browser.calls.length, valid.length);
    const step = { action: "keypress", target: { role: "textbox", name: "Editor" }, key: "A", modifiers: ["Control"], expected: { type: "text", value: "Selected" } };
    assert.equal(browserInputs.workflow.safeParse({ leaseId: "lease", authorized: true, steps: [step] }).success, true);
    assert.equal(f.validate("browser.workflow", { leaseId: "lease", authorized: true, steps: [step] }), true);
    const invalidStep = { ...step, key: "Home" };
    assert.equal(browserInputs.workflow.safeParse({ leaseId: "lease", authorized: true, steps: [invalidStep] }).success, false);
    assert.equal(f.validate("browser.workflow", { leaseId: "lease", authorized: true, steps: [invalidStep] }), false);
    const { tools } = await f.client.listTools();
    assert.equal(tools.length, 99, "74 core tools and 25 optional browser tools");
    assert.equal(tools.some(tool => ["browser.key_combo", "browser.scroll_xy"].includes(tool.name)), false);
  } finally { await f.close(); }
});
