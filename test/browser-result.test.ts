import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBackend, BrowserError } from "../src/browser/backend.js";

const fixture = `import json,os,sys
for line in sys.stdin:
 request=json.loads(line)
 if request['method']=='hello':
  print(json.dumps({'id':request['id'],'ok':True,'result':{'protocol':1,'nodriver':'0.50.6'}}),flush=True)
  continue
 with open(os.environ['BROWSER_RESULT_TRACE'],'a') as trace:
  trace.write(request['method']+'\\n')
 mode=os.environ['BROWSER_RESULT_MODE']
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

async function backendFixture(t: TestContext, mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "browser-result-"));
  const workerPath = join(directory, "fixture.py"), trace = join(directory, "requests.txt");
  await writeFile(workerPath, fixture);
  const backend = new BrowserBackend({ enabled: true, workerPath, env: {
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
