import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { createMcpHandler, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { BrowserBackend } from "../src/browser/backend.js";
import { browserInputs, browserActionInputs } from "../src/browser/schemas.js";
import { registerBrowserTools } from "../src/browser/tools.js";

const target = { role: "textbox", name: "Title", within: { role: "group", name: "Card" } };
const expected = { type: "element", target, value: "Saved" };
const workflow = (step: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
  ({ leaseId: "lease", authorized: true, steps: [{ target, expected, ...step }], ...fields });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });

test("workflow discovery shares constraints and keeps every action field visible", () => {
  const schema = json(browserInputs.workflow) as any;
  const item = schema.properties.steps.items;
  assert.equal(item.type, "object");
  assert.deepEqual(item.required, ["expected", "action", "target"]);
  assert.deepEqual(item.properties.action.enum, ["click", "typeText", "fill", "select", "upload", "keypress"]);
  assert.deepEqual(Object.keys(item.properties).sort(),
    ["action", "expected", "files", "inputMode", "key", "keyDelayMs", "modifiers", "target", "timeoutMs", "value"]);
  assert.deepEqual(item.properties.target.properties.within.required, ["role", "name"]);
  assert.equal(item.properties.timeoutMs.minimum, 100);
  assert.equal(item.properties.timeoutMs.maximum, 30000);
  assert.equal(item.properties.expected.oneOf.length, 6);
  assert.equal(item.properties.expected.properties, undefined, "Nested postconditions do not duplicate merged fields");
  for (const variant of item.oneOf) {
    assert.equal(variant.additionalProperties, false);
    for (const key of ["target", "expected", "timeoutMs"]) assert.deepEqual(variant.properties[key], {});
  }
  const keyboard = item.oneOf.find((variant: any) => variant.properties.action.const === "keypress");
  assert.deepEqual(keyboard.if, { required: ["modifiers"] });
  assert.ok(keyboard.then.properties.key.enum.includes("A"));
  assert.ok(!keyboard.else.properties.key.enum.includes("A"));
  assert.equal(keyboard.properties.modifiers.uniqueItems, true);
  assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 7000, "Workflow input stays below 7 KB; baseline was 25,878 bytes");
  for (const schema of Object.values(browserActionInputs)) {
    const expected = (json(schema) as any).properties.expected;
    assert.equal(expected.oneOf.length, 6);
    assert.equal(expected.properties, undefined);
  }
});

test("published workflow constraints agree with strict authorization and native variant parsing", () => {
  const validate = new AjvJsonSchemaValidator().getValidator(json(browserInputs.workflow) as JsonSchemaType);
  const cases: Array<[boolean, unknown]> = [
    [true, workflow({ action: "click" })],
    [true, workflow({ action: "fill", value: "" })],
    [true, workflow({ action: "typeText", value: "New", inputMode: "sequential", keyDelayMs: 1000, timeoutMs: 30000 })],
    [true, workflow({ action: "select", value: "x".repeat(1000) })],
    [true, workflow({ action: "upload", files: ["/authorized/file.txt"] })],
    [true, workflow({ action: "keypress", key: "A", modifiers: ["Control"] })],
    [true, workflow({ action: "keypress", key: "Space" })],
    [true, workflow({ action: "click", timeoutMs: 100 })],
    [true, workflow({ action: "click", expected: { type: "url", value: "https://example.test/" } })],
    [true, workflow({ action: "click", expected: { type: "elementAppears", selector: "button", frameId: "frame" } })],
    [false, workflow({ action: "click" }, { authorized: false })],
    [false, workflow({ action: "click" }, { authorized: undefined })],
    [false, workflow({ action: "click" }, { timeoutMs: 30001 })],
    [false, workflow({ action: "click", timeoutMs: 99 })],
    [false, workflow({ action: "click", expected: undefined })],
    [false, workflow({ action: "click", target: undefined })],
    [false, workflow({ action: "click", elementRef: "stale" })],
    [false, workflow({ action: "click", value: "Foreign action field" })],
    [false, workflow({ action: "fill", value: "ok", inputMode: "sequential" })],
    [false, workflow({ action: "fill", value: "x".repeat(64001) })],
    [false, workflow({ action: "typeText", value: "" })],
    [false, workflow({ action: "select", value: "x".repeat(1001) })],
    [false, workflow({ action: "upload", files: [] })],
    [false, workflow({ action: "keypress", key: "A" })],
    [false, workflow({ action: "keypress", key: "Space", modifiers: ["Control"] })],
    [false, workflow({ action: "keypress", key: "A", modifiers: ["Control", "Control"] })],
    [false, workflow({ action: "navigate", url: "https://example.test/" })],
    [false, workflow({ action: "click", expected: { type: "text", value: "done", selector: "body" } })],
    [false, workflow({ action: "click", target: { ...target, within: { ...target.within, selector: "body" } } })],
    [false, { leaseId: "lease", authorized: true, steps: [] }],
    [false, { leaseId: "lease", authorized: true, steps: Array(13).fill({ action: "click", target, expected }) }],
  ];
  for (const [valid, value] of cases) {
    assert.equal(browserInputs.workflow.safeParse(value).success, valid, JSON.stringify(value).slice(0,250));
    assert.equal(validate(value).valid, valid, JSON.stringify(value).slice(0,250));
  }
});

test("actual MCP discovery publishes compact browser inputs with readable workflow branches", async () => {
  const backend = new BrowserBackend({ enabled: true, env: {} });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "browser-catalog-test", version: "1" });
    registerBrowserTools(server, backend);
    return server;
  }, { legacy: "reject" });
  try {
    const version = "2026-07-28";
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": version, "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { name: "browser-catalog-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    }));
    const reply = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(reply));
    const tools = reply.result.tools as any[];
    assert.equal(tools.length, 25);
    const total = tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool.inputSchema)), 0);
    assert.ok(total < 49000, "Browser input discovery stays below 49 KB; baseline was 81,835 bytes: " + total);
    const workflow = tools.find(tool => tool.name === "browser.workflow").inputSchema;
    assert.equal(workflow.properties.authorized.const, true);
    assert.deepEqual(workflow.properties.steps.items, (json(browserInputs.workflow) as any).properties.steps.items);
    assert.equal(backend.snapshot().worker, "stopped", "Discovery does not start Chrome or the adapter");
  } finally {
    await handler.close();
    backend.close();
  }
});
