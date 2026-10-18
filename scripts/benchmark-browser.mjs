// Explicit local acceptance benchmark. Requires browser:setup and playwright-cli.
import { BrowserBackend } from "../src/browser/backend.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), "browser-benchmark-"));
const html = '<!doctype html><title>Benchmark</title><label>Name <input aria-label="Name" id="name"></label><button onclick="document.getElementById(\'status\').textContent=\'Saved \'+document.getElementById(\'name\').value">Save</button><p id="status">Ready</p><script>' + "/* fixture script padding */".repeat(5000) + '</script>';
const host = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
host.listen(0, "127.0.0.1"); await once(host, "listening");
const pageUrl = `http://127.0.0.1:${host.address().port}/`;
const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
const debugUrl = `http://127.0.0.1:${reserve.address().port}`;
await new Promise(resolve => reserve.close(resolve));
const backend = new BrowserBackend({ enabled: true, env: { ...process.env, XDG_DATA_HOME: temp, OPENCODE_CONNECT_BROWSER_PYTHON: await (await import("../src/browser/backend.ts")).browserPython(), OPENCODE_CONNECT_BROWSER_LINUX_ENDPOINT: debugUrl } });
let pid;
const session = "browser-benchmark-" + process.pid;
const cli = args => exec("playwright-cli", [`-s=${session}`, ...args], { cwd: temp, maxBuffer: 2 * 1024 * 1024, timeout: 60000 });
const summary = values => { const sorted = [...values].sort((a,b) => a-b); return { trials: values.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2) }; };
try {
  pid = (await backend.call("launch", { headless: true })).pid;
  const tabs = await backend.call("tabs", {});
  let start = performance.now();
  const attached = await backend.call("attach", { targetId: tabs.targets[0].targetId, controlMode: "control" });
  const coldAttachMs = performance.now() - start;
  const leaseId = attached.leaseId;
  await backend.call("action", { leaseId, action: "navigate", url: pageUrl, authorized: true, expected: { type: "readyState", value: "complete" }, timeoutMs: 5000 });
  const samples = []; let snapshotCharacters;
  for (let i = 0; i < 20; i++) {
    start = performance.now();
    const snapshot = await backend.call("snapshot", { leaseId }); snapshotCharacters = JSON.stringify(snapshot).length;
    const input = snapshot.nodes.find(node => node.name === "Name" && node.ref);
    const button = snapshot.nodes.find(node => node.name === "Save" && node.ref);
    await backend.call("action", { leaseId, action: "fill", elementRef: input.ref, value: "Nodriver " + i, authorized: true, timeoutMs: 5000 });
    const result = await backend.call("action", { leaseId, action: "click", elementRef: button.ref, authorized: true, expected: { type: "text", value: "Saved Nodriver " + i }, timeoutMs: 5000 });
    if (result.verification !== "confirmed") throw new Error("Nodriver verification failed");
    samples.push(performance.now() - start);
  }
  await backend.call("detach", { leaseId });
  start = performance.now(); await cli(["attach", `--cdp=${debugUrl}`]);
  const playwrightAttachMs = performance.now() - start;
  const code = `async page => {const p=page.context().pages().find(p=>p.url()===${JSON.stringify(pageUrl)});if(!p)throw Error('Exact benchmark page unavailable');p.setDefaultTimeout(5000);const times=[];let chars=0;for(let i=0;i<20;i++){const start=Date.now();const snapshot=await p.locator('body').ariaSnapshot();chars=snapshot.length;await p.getByRole('textbox',{name:'Name',exact:true}).fill('Playwright '+i);await p.getByRole('button',{name:'Save',exact:true}).click();await p.getByText('Saved Playwright '+i,{exact:true}).waitFor({state:'visible'});times.push(Date.now()-start);}return {times,snapshotCharacters:chars};}`;
  const filename = join(temp, "benchmark.js"); await writeFile(filename, code);
  const { stdout } = await cli(["--raw", "run-code", `--filename=${filename}`]);
  const match = stdout.match(/\{[\s\S]*"times"[\s\S]*\}/);
  if (!match) throw new Error("Playwright benchmark returned no metrics: " + stdout.slice(0, 500));
  const compared = JSON.parse(match[0]);
  const version = await backend.call("status", {});
  console.log(JSON.stringify({ date: new Date().toISOString(), chrome: version.version, nodriver: "0.50.6", playwrightCli: (await exec("playwright-cli", ["--version"])).stdout.trim(), fixtureHtmlCharacters: html.length, nodriverResult: { ...summary(samples), confirmed: 20, coldAttachMs: +coldAttachMs.toFixed(2), snapshotCharacters }, playwrightResult: { ...summary(compared.times), confirmed: 20, coldAttachMs: +playwrightAttachMs.toFixed(2), snapshotCharacters: compared.snapshotCharacters }, methodology: "Sequential 20-trial snapshot + fill + click + visible-text verification against the same page and Chrome. Warm timings exclude CLI command startup; cold Playwright attach includes CLI startup. Both use 5-second action deadlines. Nodriver snapshot is structured JSON; Playwright snapshot is YAML text. Characters are measured, tokens are not." }, null, 2));
} finally {
  await cli(["detach"]).catch(() => {});
  backend.close();
  if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
  await new Promise(resolve => host.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 300)); await rm(temp, { recursive: true, force: true });
}
