import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { browserInputs } from "../src/browser/schemas.js";
// The same real-browser acceptance can inspect a prepared immutable build.
const { BrowserBackend, BrowserError, browserPython } = await import(process.env.OPENCODE_CONNECT_BROWSER_TEST_BUILD
  ? pathToFileURL(join(process.env.OPENCODE_CONNECT_BROWSER_TEST_BUILD, "dist/src/browser/backend.js")).href
  : "../src/browser/backend.js") as typeof import("../src/browser/backend.js");

const unit = "Maayong adlaw! ñ ü — “Cebuano” 😀 ".repeat(16) + "\n  Ikaduhang linya\t!\n";
const repeated = unit.repeat(Math.floor(64000 / [...unit].length));
const large = repeated + " ".repeat(64000 - [...repeated].length);
const target = { role: "textbox", name: "Text" };
const base = { leaseId: "lease", authorized: true, elementRef: "ref" };

test("text schemas share the 64,000 Unicode character bound and expose sequential workflow fields", () => {
  assert.equal([...large].length, 64000);
  for (const action of ["fill", "typeText"]) {
    const input = { ...base, action, value: large, expected: { type: "element", target, value: large } };
    assert.equal(browserInputs.action.safeParse(input).success, true);
    assert.equal(browserInputs.action.safeParse({ ...input, value: large + "x" }).success, false);
    const { elementRef: _, leaseId: _lease, authorized: _auth, ...step } = input;
    assert.equal(browserInputs.workflow.safeParse({ leaseId: "lease", authorized: true, steps: [{ ...step, target }] }).success, true);
  }
  assert.equal(browserInputs.action.safeParse({ ...base, action: "typeText", value: "ok", inputMode: "sequential", keyDelayMs: 1001 }).success, false);
  assert.equal(browserInputs.action.safeParse({ ...base, action: "fill", value: "ok", inputMode: "sequential" }).success, false);
});

test("real Chrome text capacity, keyboard semantics and interrupted mutation", { skip: process.env.OPENCODE_CONNECT_BROWSER_TEST !== "1", timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "browser-text-"));
  const host = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8"><title>Text fixture</title>
      <textarea aria-label="Text" id="text"></textarea><input aria-label="Other" id="other">
      <div contenteditable="true" role="textbox" aria-label="Editor" id="editor" style="white-space:pre-wrap"></div>
      <input aria-label="Limited" id="limited" maxlength="4" value="abcd">
      <input aria-label="Single line" id="single"><input aria-label="Number" id="number" type="number"><input aria-label="Email" id="email" type="email">
      <script>
      window.record=false;window.events=[];window.stopAt='';window.behavior='';window.suggestions=[];
      text.addEventListener('input',()=>{if(record)suggestions.push(text.value);if(behavior==='transform')text.value=text.value.toUpperCase()});
      for(const kind of ['keydown','keypress','beforeinput','input','keyup'])text.addEventListener(kind,e=>{
        if(record)events.push({type:e.type,key:e.key,data:e.data,trusted:e.isTrusted,time:performance.now()});
        if(kind==='keydown'&&e.key===stopAt){
          if(behavior==='focus')other.focus();
          if(behavior==='replace'){const next=text.cloneNode();text.replaceWith(next);next.focus()}
          if(behavior==='rename')text.setAttribute('aria-label','Repurposed');
          if(behavior==='prevent')e.preventDefault();
        }
      });
      editor.addEventListener('keydown',e=>{if(behavior==='lock'&&e.key==='b')editor.contentEditable='false'});
      </script>`);
  });
  host.listen(0, "127.0.0.1"); await once(host, "listening");
  const address = host.address(); assert.ok(address && typeof address !== "string");
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const debug = reserve.address(); assert.ok(debug && typeof debug !== "string");
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const cdpUrl = `http://127.0.0.1:${debug.port}`;
  const backend = new BrowserBackend({ enabled: true, env: { ...process.env, XDG_DATA_HOME: temp, OPENCODE_CONNECT_BROWSER_PYTHON: await browserPython(), OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT: cdpUrl }, chromeLaunchMode: "direct" });
  let pid: number | undefined;
  let socket: WebSocket | undefined;
  t.after(async () => {
    socket?.close(); backend.close();
    if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
    await new Promise<void>(resolve => host.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 300)); await rm(temp, { recursive: true, force: true });
  });
  pid = (await backend.call("launch", { headless: true })).pid as number;
  const page = await (await fetch(cdpUrl + "/json/new?" + encodeURIComponent(`http://127.0.0.1:${address.port}`), { method: "PUT" })).json() as { id: string; webSocketDebuggerUrl: string };
  await fetch(cdpUrl + "/json/activate/" + page.id);
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, "open");
  let id = 0;
  const evaluate = async (expression: string): Promise<any> => {
    const request = ++id;
    const response = new Promise<any>((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== request) return;
        socket!.removeEventListener("message", handler);
        if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else resolve(message.result.result.value);
      };
      socket!.addEventListener("message", handler);
    });
    socket!.send(JSON.stringify({ id: request, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    return response;
  };
  const { leaseId } = await backend.call("attach", { targetId: page.id, controlMode: "control" }, "text-fixture");
  const ref = async (name = "Text") => {
    const snap = await backend.call("snapshot", { leaseId, maxNodes: 100 }, "text-fixture");
    const node = (snap.nodes as any[]).find(n => n.name === name && n.ref); assert.ok(node, name); return node.ref;
  };
  const act = async (input: Record<string, unknown>, name = "Text") => backend.call("action", { leaseId, authorized: true, elementRef: await ref(name), ...input }, "text-fixture");
  const code = (wanted: string, dispatched: boolean) => (error: unknown) => error instanceof BrowserError && error.code === wanted && error.dispatched === dispatched;
  const reset = () => evaluate("text.value='';other.value='';record=true;events=[];suggestions=[];behavior='';stopAt=''");

  await t.test("64k fill and selection insertion preserve Unicode, whitespace and exact ordering", async () => {
    const filled = await act({ action: "fill", value: large, expected: { type: "element", target, value: large }, timeoutMs: 30000 });
    assert.equal(filled.textVerification, "confirmed"); assert.equal(filled.verification, "confirmed");
    assert.equal(await evaluate("text.value"), large);
    assert.ok(JSON.stringify(filled).length < 1000);
    await evaluate("text.value='😀before AFTER';text.setSelectionRange(9,14)");
    const inserted = await act({ action: "typeText", value: large, inputMode: "fast", timeoutMs: 30000 });
    assert.equal(inserted.textVerification, "confirmed"); assert.equal(inserted.verification, "inconclusive");
    assert.equal(await evaluate("text.value"), "😀before " + large);
    await evaluate("text.value=''");
  });
  await t.test("64k contenteditable has explicit exact verification, otherwise reports unverified", async () => {
    const result = await act({ action: "typeText", value: large, timeoutMs: 30000, expected: { type: "element", target: { role: "textbox", name: "Editor" }, value: large } }, "Editor");
    assert.equal(result.verification, "confirmed"); assert.equal(result.textVerification, "confirmed");
    assert.equal(await evaluate("editor.innerText"), large);
    const unverified = await act({ action: "typeText", value: "end" }, "Editor");
    assert.equal(unverified.textVerification, "unverified"); assert.match(String(unverified.evidence), /unverified/);
    await evaluate("editor.textContent=''");
  });
  await t.test("sequential trusted events preserve Unicode, LF, spaces and punctuation", async () => {
    await reset();
    const value = "Ab ñé😀\n  !?";
    const result = await act({ action: "typeText", value, inputMode: "sequential", keyDelayMs: 40, timeoutMs: 10000, expected: { type: "element", target, value } });
    assert.equal(result.textVerification, "confirmed"); assert.equal(result.verification, "confirmed");
    assert.equal(await evaluate("text.value"), value);
    const events = await evaluate("events") as any[];
    const keys = events.filter(e => e.type === "keydown");
    assert.deepEqual(keys.map(e => e.key), [...value].map(c => c === "\n" ? "Enter" : c));
    assert.ok(events.every(e => e.trusted));
    for (let i = 0; i < [...value].length; i++) assert.deepEqual(events.slice(i * 5, i * 5 + 5).map(e => e.type), ["keydown", "keypress", "beforeinput", "input", "keyup"]);
    assert.ok(keys.slice(1).every((key, i) => key.time - keys[i].time >= 35));
    assert.deepEqual(await evaluate("suggestions"), [...value].map((_, i, chars) => chars.slice(0, i + 1).join("")));
  });
  await t.test("maxlength respects selected replacement and rejects excess without editing", async () => {
    for (const action of ["fill", "typeText"]) await assert.rejects(act({ action, value: "12345" }, "Limited"), code("site_limit", false));
    await evaluate("limited.focus();limited.setSelectionRange(1,3)");
    assert.equal((await act({ action: "typeText", value: "12" }, "Limited")).textVerification, "confirmed");
    assert.equal(await evaluate("limited.value"), "a12d");
    assert.equal((await act({ action: "fill", value: "42" }, "Number")).textVerification, "confirmed");
    const email = await act({ action: "typeText", value: "demo@example.test", expected: { type: "element", target: { role: "textbox", name: "Email" }, value: "demo@example.test" } }, "Email");
    assert.equal(email.textVerification, "confirmed");
    await assert.rejects(act({ action: "fill", value: "two\nlines" }, "Single line"), code("unsupported_input", false));
  });
  await t.test("sequential bounds and delay budget reject before dispatch", async () => {
    await reset();
    for (const [input, expected] of [
      [{ value: "x".repeat(2001), inputMode: "sequential" }, "sequential_limit"],
      [{ value: "xyz", inputMode: "sequential", keyDelayMs: 1000, timeoutMs: 1000 }, "input_budget_exceeded"],
      [{ value: "abc", keyDelayMs: 1 }, "invalid_arguments"],
      [{ value: "a\rb", inputMode: "sequential" }, "unsupported_input"],
      [{ value: "a\tb", inputMode: "sequential" }, "unsupported_input"],
    ] as const) await assert.rejects(act({ action: "typeText", ...input }), code(expected, false));
    assert.equal(await evaluate("text.value"), ""); assert.deepEqual(await evaluate("events"), []);
  });
  await t.test("focus interruption stops after the completed prefix without typing in another field", async () => {
    await reset(); await evaluate("behavior='focus';stopAt='c'");
    await assert.rejects(act({ action: "typeText", value: "abcd", inputMode: "sequential" }), code("focus_changed", true));
    assert.equal(await evaluate("text.value"), "ab"); assert.equal(await evaluate("other.value"), "");
    assert.deepEqual(await evaluate("events.filter(e=>e.type==='keydown').map(e=>e.key)"), ["a", "b", "c"]);
  });
  await t.test("handler transformation and cancelled key are partial input, with no replay", async () => {
    await reset(); await evaluate("behavior='transform'");
    await assert.rejects(act({ action: "typeText", value: "abc" }), code("partial_input", true));
    assert.equal(await evaluate("text.value"), "ABC");
    await reset(); await evaluate("behavior='prevent';stopAt='b'");
    await assert.rejects(act({ action: "typeText", value: "abc", inputMode: "sequential" }), code("partial_input", true));
    assert.equal(await evaluate("text.value"), "ac");
    assert.deepEqual(await evaluate("events.filter(e=>e.type==='keydown').map(e=>e.key)"), ["a", "b", "c"]);
  });
  await t.test("workflow carries text mode and exact value postcondition", async () => {
    await reset();
    const result = await backend.call("workflow", { leaseId, authorized: true, steps: [{ action: "typeText", target, inputMode: "sequential", keyDelayMs: 5, value: "Maayo 😀", expected: { type: "element", target, value: "Maayo 😀" } }] }, "text-fixture");
    assert.equal(result.verification, "confirmed"); assert.equal(result.completedSteps, 1);
    assert.equal(result.textVerification, "confirmed");
    await evaluate("editor.textContent=''");
    const unverified = await backend.call("workflow", { leaseId, authorized: true, steps: [{ action: "typeText", target: { role: "textbox", name: "Editor" }, value: "x", expected: { type: "element", target: { role: "textbox", name: "Editor" }, state: "focused" } }] }, "text-fixture");
    assert.equal(unverified.verification, "confirmed"); assert.equal(unverified.textVerification, "unverified");
    assert.match(String(unverified.evidence), /exact text remains unverified/);
  });
  await t.test("contenteditable becoming noneditable stops sequential input", async () => {
    await reset(); await evaluate("editor.textContent='';behavior='lock'");
    await assert.rejects(act({ action: "typeText", value: "abc", inputMode: "sequential" }, "Editor"), code("focus_changed", true));
    assert.equal(await evaluate("editor.innerText"), "a");
    await evaluate("editor.contentEditable='true'");
  });
  await t.test("identity changes stop before the next character", async () => {
    await reset(); await evaluate("behavior='rename';stopAt='b'");
    await assert.rejects(act({ action: "typeText", value: "abc", inputMode: "sequential" }), code("stale_reference", true));
    assert.equal(await evaluate("text.value"), "a");
  });
  await t.test("mutation deadline stops the sequence without replaying a late key", async () => {
    await evaluate("text.setAttribute('aria-label','Text')"); await reset();
    await evaluate("text.addEventListener('keydown',()=>{const until=performance.now()+1000;while(performance.now()<until){}},{once:true})");
    await assert.rejects(act({ action: "typeText", value: "abc", inputMode: "sequential", timeoutMs: 400 }), (error: unknown) => error instanceof BrowserError && error.code === "timed_out" && error.dispatched);
    assert.equal(await evaluate("text.value"), "");
    assert.deepEqual(await evaluate("events.filter(e=>e.type==='keydown').map(e=>e.key)"), ["a"]);
  });
});
