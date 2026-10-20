import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBackend, BrowserError } from "../src/browser/backend.js";
import { createHttpHandler } from "../src/http.js";

const fixture = `import json,os,sys,time
lease=None
for line in sys.stdin:
 request=json.loads(line)
 if request['method']=='hello':
  print(json.dumps({'id':request['id'],'ok':True,'result':{'protocol':1,'nodriver':'0.50.6'}}),flush=True)
  continue
 with open(os.environ['BROWSER_RESULT_TRACE'],'a') as trace:
  trace.write(request['method']+'\\n')
 mode=os.environ['BROWSER_RESULT_MODE']
 if mode in ('idle-expiry','slow-wait'):
  if request['method']=='attach':
   lease='lease-'+str(os.getpid())
   result={'leaseId':lease,'browser':'linux','generation':'fixture','controlMode':'control','ownership':'external','target':{'targetId':'fixture','title':'Fixture','url':'https://example.test/','type':'page','leased':True}}
  elif request['method']=='status':
   result={'browser':'linux','reachable':True,'attached':lease is not None,'version':'Chrome/fixture','connectionState':'ready','linuxProcesses':[],'lastError':None}
  elif request['method']=='wait':
   time.sleep(.2)
   result={'verification':'timed_out','url':'https://example.test/','evidence':'Condition not met'}
  elif request['params'].get('leaseId')==lease:
   result={'dispatched':True,'completed':True,'verification':'inconclusive','url':'https://example.test/','evidence':'Executed once','mutationMayHaveOccurred':True}
  else:
   print(json.dumps({'id':request['id'],'ok':False,'error':{'code':'invalid_lease','message':'Attach explicitly','dispatched':False,'verification':'rejected'}}),flush=True)
   continue
  print(json.dumps({'id':request['id'],'ok':True,'result':result}),flush=True)
  continue
 reply={'id':request['id'],'ok':True,'result':{'dispatched':False}}
 if mode=='oversized-result': reply['result']['evidence']='x'*262144
 elif mode=='malformed-frame':
  print('{private malformed payload',flush=True)
  continue
 elif mode=='oversized-frame':
  print('x'*2200000,flush=True)
  continue
 elif mode=='missing-error-evidence': reply={'id':request['id'],'ok':False,'error':{'code':'browser_error','message':'Sanitized worker failure'}}
 elif mode=='missing-error-dispatched': reply={'id':request['id'],'ok':False,'error':{'code':'browser_error','message':'Sanitized worker failure','verification':'rejected'}}
 elif mode=='malformed-error-evidence': reply={'id':request['id'],'ok':False,'error':{'code':'browser_error','message':'Sanitized worker failure','dispatched':'false'}}
 elif mode=='rejected-before-dispatch': reply={'id':request['id'],'ok':False,'error':{'code':'stale_reference','message':'Element removed','dispatched':False,'verification':'rejected'}}
 print(json.dumps(reply),flush=True)
`;

async function backendFixture(t: TestContext, mode: string, idleMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "browser-result-"));
  const workerPath = join(directory, "fixture.py"), trace = join(directory, "requests.txt");
  await writeFile(workerPath, fixture);
  const backend = new BrowserBackend({ enabled: true, workerPath, idleMs, env: {
    ...process.env, OPENCODE_CONNECT_BROWSER_PYTHON: "/usr/bin/python3",
    BROWSER_RESULT_MODE: mode, BROWSER_RESULT_TRACE: trace,
  } });
  t.after(async () => { backend.close(); await rm(directory, { recursive: true, force: true }); });
  return { backend, requests: async () => (await readFile(trace, "utf8")).trim().split("\n") };
}

const inputs = {
  action: { leaseId: "lease", action: "click", elementRef: "observed", authorized: true },
  workflow: { leaseId: "lease", authorized: true, steps: [
    { action: "click", target: { role: "button", name: "Save" }, expected: { type: "text", value: "Saved" } },
  ] },
};

test("overlapping requests reject before dispatch without cancelling a wait or its lease", async t => {
  const { backend, requests } = await backendFixture(t, "slow-wait");
  const attached = await backend.call("attach", { targetId: "fixture", controlMode: "control" });
  const waiting = backend.call("wait", { leaseId: attached.leaseId, timeoutMs: 1000, condition: { type: "text", value: "pending" } });
  await assert.rejects(backend.call("status", {}), (error: unknown) => error instanceof BrowserError && error.code === "busy" && !error.dispatched);
  assert.equal((await waiting).verification, "timed_out");
  assert.equal((await backend.call("status", {})).attached, true);
  assert.deepEqual(await requests(), ["attach", "wait", "status"]);
});

test("MCP tool errors retain native diagnostics in standard text and structured content", async t => {
  const backend = new BrowserBackend({ enabled: true });
  const logs: string[] = [];
  t.mock.method(console, "warn", (line: string) => { logs.push(line); });
  let failure: Error = new BrowserError("site_limit", "Control maxlength is 5000 UTF-16 code units; no text dispatched");
  t.mock.method(backend, "call", async () => { throw failure; });
  const handler = createHttpHandler(undefined, undefined, undefined, backend);
  t.after(() => handler.close());
  const request = async (args: unknown) => {
    const version = "2026-07-28";
    const response = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json", "mcp-protocol-version": version, "mcp-method": "tools/call", "mcp-name": "browser.fill",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser.fill", arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "browser-error-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
    } } }) }));
    return (await response.json() as any).result;
  };
  const args = { leaseId: "private-lease", elementRef: "private-ref", authorized: true, value: "private-prompt" };
  for (const error of [failure, new BrowserError("invalid_lease", "Attach explicitly"), new BrowserError("partial_input", "Inspect without replay", true, "inconclusive"), new Error("private-exception")]) {
    failure = error;
    const result = await request(args);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    if (error instanceof BrowserError) assert.deepEqual(result.structuredContent, error.result());
    else assert.equal(result.structuredContent.errorCode, "browser_unavailable");
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
  const invalid = await request({ ...args, authorized: false });
  assert.equal(invalid.isError, true);
  assert.ok(invalid.content[0].text.length > 0, "SDK schema rejection also has standard error text");
  assert.equal(logs.length, 4);
  assert.doesNotMatch(logs.join("\n"), /private-|maxlength|Inspect without replay/);
  assert.deepEqual(JSON.parse(logs[0]), { event: "browser_tool_error", tool: "browser.fill", errorCode: "site_limit", errorLayer: "input", dispatched: false });
});

test("idle expiry reports why the attachment was lost and never revives or replays it", async t => {
  const { backend, requests } = await backendFixture(t, "idle-expiry", 60000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const attached = await backend.call("attach", { targetId: "fixture", controlMode: "control" });
  t.mock.timers.tick(60001);
  await assert.rejects(backend.call("action", { ...inputs.action, action: "fill", leaseId: attached.leaseId, value: "Do not replay" }), (error: unknown) => error instanceof BrowserError && error.code === "invalid_lease" && !error.dispatched);
  const status = await backend.call("status", {});
  assert.equal(status.reachable, true); assert.equal(status.attached, false);
  assert.match(String(status.lastError), /inactivity.*expired.*attach explicitly/);
  const fresh = await backend.call("attach", { targetId: "fixture", controlMode: "control" });
  assert.notEqual(fresh.leaseId, attached.leaseId);
  assert.deepEqual(await requests(), ["attach", "action", "status", "attach"]);
});

for (const method of ["action", "workflow"] as const) {
  for (const [mode, code] of [
    ["invalid-contract", "invalid_response"],
    ["oversized-result", "too_large"],
    ["malformed-frame", "invalid_response"],
    ["oversized-frame", "worker_unavailable"],
    ["missing-error-evidence", "browser_error"],
    ["missing-error-dispatched", "browser_error"],
    ["malformed-error-evidence", "invalid_response"],
  ]) {
    test(`${method} ${mode} preserves uncertainty without replay`, async t => {
      const { backend, requests } = await backendFixture(t, mode);
      await assert.rejects(backend.call(method, inputs[method]), (error: unknown) => {
        assert.ok(error instanceof BrowserError);
        assert.equal(error.code, code);
        assert.equal(error.verification, "inconclusive");
        assert.equal(error.dispatched, true);
        assert.equal(error.result().mutationMayHaveOccurred, true);
        assert.doesNotMatch(error.message, /private malformed payload/);
        return true;
      });
      assert.deepEqual(await requests(), [method]);
    });
  }
}

test("explicit worker rejection retains evidence that no action was dispatched", async t => {
  const { backend } = await backendFixture(t, "rejected-before-dispatch");
  await assert.rejects(backend.call("action", inputs.action), (error: unknown) => {
    assert.ok(error instanceof BrowserError);
    assert.equal(error.result().errorLayer, "target");
    assert.equal(error.result().mutationMayHaveOccurred, false);
    assert.equal(error.verification, "rejected");
    return true;
  });
});

test("read-only malformed results do not claim a possible mutation", async t => {
  const { backend } = await backendFixture(t, "invalid-contract");
  await assert.rejects(backend.call("tabs", {}), (error: unknown) => {
    assert.ok(error instanceof BrowserError);
    assert.equal(error.result().errorLayer, "result");
    assert.equal(error.result().mutationMayHaveOccurred, false);
    return true;
  });
});

test("argument errors identify field bounds without exposing input values", async () => {
  const backend = new BrowserBackend({ enabled: true, env: { OPENCODE_CONNECT_BROWSER_PYTHON: "/not-started" } });
  try {
    for (const [method, input, path, bound] of [
      ["action", { ...inputs.action, action: "fill", value: "private-value".repeat(5000) }, "value", "64000 characters"],
      ["workflow", { ...inputs.workflow, steps: [{ ...inputs.workflow.steps[0], action: "fill", value: "private-value".repeat(5000) }] }, "steps[0].value", "64000 characters"],
      ["snapshot", { leaseId: "lease", maxNodes: 301 }, "maxNodes", "300"],
    ] as const) {
      await assert.rejects(backend.call(method, input), (error: unknown) => {
        assert.ok(error instanceof BrowserError);
        assert.equal(error.code, "invalid_arguments");
        assert.equal(error.result().errorLayer, "validation");
        assert.ok(error.message.includes(path));
        assert.ok(error.message.includes(bound));
        assert.doesNotMatch(error.message, /private-value/);
        assert.equal(error.dispatched, false);
        return true;
      });
    }
    await assert.rejects(backend.call("action", { ...inputs.action, "private-unknown-key": "secret" }), (error: unknown) => {
      assert.ok(error instanceof BrowserError);
      assert.doesNotMatch(error.message, /private-unknown-key|secret/);
      return true;
    });
  } finally { backend.close(); }
});
