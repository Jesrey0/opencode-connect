import assert from "node:assert/strict";
import test from "node:test";
import { latestResult, OpenCodeBackend, projectAgent } from "../src/opencode.js";
import { fingerprint } from "../src/bounds.js";
import { nativeFixture, session, user, assistant } from "./native-fixture.js";
import type { AgentInfo, SessionMessageInfo } from "@opencode/client";

const reviewer = [
  { action: "*", resource: "*", effect: "deny" as const },
  ...["read", "glob", "grep"].map((action) => ({ action, resource: "*", effect: "allow" as const })),
  { action: "external_directory", resource: "*", effect: "deny" as const },
];
function messageFixture(messages: SessionMessageInfo[]) {
  const state = session();
  let pageCount = 0;
  let mutateOnPage = 0;
  const native = nativeFixture((r) => {
    if (r.path === "/api/session/s") return { data: state };
    if (r.path === "/api/session/active") return { data: {} };
    if (r.path.includes("/message/")) {
      const id = decodeURIComponent(r.path.split("/").at(-1)!);
      const message = messages.find((m) => m.id === id);
      if (!message) return new Response(JSON.stringify({ message: "missing message" }), { status: 404 });
      return { data: message };
    }
    if (r.path.endsWith("/message")) {
      pageCount++;
      if (pageCount === mutateOnPage) state.time.updated++;
      const cursor = r.query.get("cursor");
      assert.ok(!cursor || !r.query.has("order"), "native cursor cannot be combined with order");
      const order = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()).order : r.query.get("order") ?? "desc";
      const ordered = order === "desc" ? [...messages].reverse() : messages;
      const start = cursor ? JSON.parse(Buffer.from(cursor,"base64url").toString()).offset : 0;
      const limit = Number(r.query.get("limit"));
      const data = ordered.slice(start, start + limit);
      return { data, cursor: { next: data.length ? Buffer.from(JSON.stringify({ order, offset: start + limit })).toString("base64url") : null } };
    }
    throw new Error(`unexpected ${r.path}`);
  });
  return { ...native, state, mutateOn: (value: number) => { mutateOnPage = value; }, count: () => pageCount };
}

test("result recovery beyond 100 messages uses native pagination and excludes the next prompt", async () => {
  const text = "A😀".repeat(6000);
  const messages = [user("target"), ...Array.from({ length: 140 }, (_, i) => assistant(`a${i}`, i === 139 ? text : `step${i}`, i+2)), user("later", 150), assistant("other", "wrong result", 151)];
  const native = messageFixture(messages);
  const result = await latestResult(native.client, { sessionId: "s", messageId: "target" }, true);
  assert.equal(result.assistantMessageId, "a139");
  assert.equal(result.selectionComplete, true);
  assert.ok(native.count() >= 3);
  assert.equal(result.textPaging.cursorUnit, "utf16CodeUnits");
  const second = await latestResult(native.client, { sessionId: "s", messageId: "target", textOffset: result.textPaging.nextOffset!, textFingerprint: result.textPaging.fingerprint }, true);
  assert.equal(result.text + second.text, text);
});

test("bounded result scan continues past 500 with canonical cursor and candidate, and detects mutation", async () => {
  const messages = [user("target"), ...Array.from({ length: 630 }, (_, i) => assistant(`a${i}`, `step${i}`, i+2))];
  const native = messageFixture(messages);
  const first = await latestResult(native.client, { sessionId: "s", messageId: "target" }, true);
  assert.equal(first.selectionComplete, false); assert.equal(first.scannedMessages, 500); assert.ok(first.selectionCursor);
  assert.equal(first.text, "");
  assert.equal(first.outcome, "unknown");
  assert.equal(first.textNextCall, null);
  assert.equal(first.nextCall?.tool, "opencode.inspect");
  const input = { sessionId: "s", messageId: "target", selectionCursor: first.selectionCursor!, candidateAssistantMessageId: first.candidateAssistantMessageId!, selectionFingerprint: first.selectionFingerprint };
  const next = await latestResult(native.client, input, true);
  assert.equal(next.selectionComplete, true); assert.equal(next.assistantMessageId, "a629"); assert.equal(next.text, "step629");
  assert.deepEqual(first.nextCall?.arguments, { ...input, detail: "result" });
  native.state.time.updated++;
  await assert.rejects(latestResult(native.client, input, true), /changed/);
  await assert.rejects(latestResult(native.client, { ...input, selectionFingerprint: undefined }, true), /fingerprint/);
  const during = messageFixture(messages);
  during.mutateOn(2);
  await assert.rejects(latestResult(during.client, { sessionId: "s", messageId: "target" }, true), /changed during/);
});

test("latest user without an assistant never inherits a prior prompt's result", async () => {
  const native = messageFixture([user("previous"), assistant("old", "previous answer"), user("new")]);
  for (const messageId of [undefined, "new"]) {
    const result = await latestResult(native.client, { sessionId: "s", messageId }, true);
    assert.equal(result.selectionComplete, true);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.assistantMessageId, null);
    assert.equal(result.text, "");
    assert.equal(result.textNextCall, null);
  }
});

test("result selection and full-text continuations are independent reusable canonical calls", async () => {
  const native = messageFixture([user("target"), ...Array.from({ length: 630 }, (_, i) => assistant(`a${i}`, i === 629 ? "😀".repeat(8000) : "step"))]);
  const backend = new OpenCodeBackend(native.connect);
  const initial = await latestResult(native.client, { sessionId: "s", messageId: "target", textLimit: 1000 }, true);
  assert.equal(initial.nextCall?.tool, "opencode.inspect");
  const selected = await backend.inspect(initial.nextCall!.arguments as Parameters<typeof backend.inspect>[0]);
  assert.ok("result" in selected);
  assert.equal(selected.result.selectionComplete, true);
  assert.equal(selected.result.outcome, "completed");
  assert.equal(selected.result.nextCall, null);
  assert.equal(selected.result.textNextCall?.tool, "opencode.query");
  let call = selected.result.textNextCall;
  let text = selected.result.text;
  const scanned = native.count();
  while (call) {
    const response = await backend.query(call.arguments.queries as Parameters<typeof backend.query>[0]);
    const result = response.results[0].result as { text: string; nextCall: typeof call };
    text += result.text;
    call = result.nextCall;
  }
  assert.equal(text, "😀".repeat(8000));
  assert.equal(native.count(), scanned, "text recovery does not rescan result history");
  assert.equal(native.requests.some((request) => request.method !== "GET"), false);
});

test("assistant finish evidence stays separate from native execution outcome across result, semantic, wait and status", async () => {
  const state = session();
  const failed = { ...assistant("error", "", 3), finish: "error", error: { type: "provider.quota", message: "SECRET", response: { body: "SECRET" } } } as SessionMessageInfo;
  const messages = [user("target"), assistant("prior", "intermediate", 2), failed,
    { id: "idle-failed", type: "idle", outcome: "failed", time: { created: 4 } },
    { id: "idle-succeeded", type: "idle", outcome: "succeeded", time: { created: 5 } }] as SessionMessageInfo[];
  const native = nativeFixture((request) => {
    if (request.path === "/api/session/s") return { data: state };
    if (request.path === "/api/session/active") return { data: {} };
    if (request.path === "/api/session") return { data: [state], cursor: {} };
    if (request.path.endsWith("/message/target")) return { data: messages[0] };
    if (request.path.endsWith("/message")) return { data: [...messages].reverse(), cursor: {} };
    if (request.path.endsWith("/permission") || request.path.endsWith("/form")) return { data: [] };
    throw new Error(`unexpected ${request.path}`);
  });
  const backend = new OpenCodeBackend(native.connect);
  const inspected = await backend.inspect({ sessionId: "s", messageId: "target", detail: "result" });
  assert.ok("result" in inspected);
  assert.equal(inspected.session.executionOutcome, "succeeded");
  assert.equal(inspected.session.status, "completed");
  assert.equal(inspected.session.outcome, "failed");
  assert.equal(inspected.result.assistantMessageId, "error");
  assert.equal(inspected.result.error?.type, "provider.quota");
  const semantic = await backend.inspect({ sessionId: "s", messageId: "target" });
  assert.ok("outcomeEvidence" in semantic);
  assert.equal(semantic.outcomeEvidence.assistantMessageId, "error");
  assert.equal(semantic.session.outcome, "failed");
  const waited = await backend.wait("s", "target");
  assert.equal(waited.state, "terminal");
  assert.equal(waited.session.executionOutcome, "succeeded");
  assert.equal(waited.session.outcome, "failed");
  const status = await backend.status();
  assert.equal(status.workers[0].executionOutcome, "succeeded");
  assert.equal(status.workers[0].outcome, "failed");
  assert.equal(status.workers[0].outcomeEvidence.completedAtMs, 3);
  assert.equal(JSON.stringify([inspected, semantic, waited, status]).includes("SECRET"), false);
  const unscanned = await backend.query([{ type: "session", sessionId: "s" }]);
  assert.equal((unscanned.results[0].result as { outcome: string }).outcome, "unknown");
});

test("unknown, incomplete, completed and failed assistant results require exact finalized evidence", async () => {
  for (const [finish, completed, error, outcome] of [
    ["stop", true, false, "completed"], ["stop", false, false, "incomplete"],
    ["length", true, false, "incomplete"], ["tool-calls", true, false, "incomplete"],
    ["unknown", true, false, "incomplete"], [undefined, true, false, "incomplete"],
    ["content-filter", true, false, "incomplete"], ["error", true, false, "failed"],
    ["stop", true, true, "failed"],
  ] as const) {
    const message = { ...assistant("answer", "text"), finish, time: { created: 2, ...(completed ? { completed: 3 } : {}) }, ...(error ? { error: { type: "provider.quota", message: "omitted" } } : {}) } as SessionMessageInfo;
    const native = messageFixture([user("target"), message]);
    const result = await latestResult(native.client, { sessionId: "s", messageId: "target" }, true);
    assert.equal(result.outcome, outcome);
    assert.equal(result.outcomeBasis, "selectedAssistantMessage");
    assert.equal((await latestResult(native.client, { sessionId: "s", messageId: "target" }, false)).outcome, "unknown");
  }
});

test("status and untargeted semantic retain inventory with sanitized unavailable extra-result evidence", async () => {
  const state = session();
  let semantic = false;
  let gets = 0;
  const native = nativeFixture((request) => {
    if (request.path === "/api/session/active") return { data: {} };
    if (request.path === "/api/session") return { data: [state, { ...state, id: "removed" }], cursor: {} };
    if (request.path === "/api/session/removed") return Response.json({ message: "SECRET" }, { status: 404 });
    if (request.path === "/api/session/s") {
      gets++;
      if (semantic && gets > 1) return Response.json({ message: "SECRET" }, { status: 500 });
      return { data: state };
    }
    if (request.path.endsWith("/message")) return { data: [assistant("answer", "text"), user("target")], cursor: {} };
    if (request.path.endsWith("/message/missing")) return Response.json({ message: "SECRET" }, { status: 404 });
    if (request.path.endsWith("/permission") || request.path.endsWith("/form")) return { data: [] };
    throw new Error(`unexpected ${request.path}`);
  });
  const backend = new OpenCodeBackend(native.connect);
  const status = await backend.status();
  assert.equal(status.ready, true);
  assert.equal(status.workers.length, 2);
  assert.equal(status.workers.find((worker) => worker.sessionId === "s")!.outcome, "completed");
  const removed = status.workers.find((worker) => worker.sessionId === "removed")!;
  assert.equal(removed.outcome, "unknown");
  assert.equal(removed.outcomeEvidence.unavailable, true);
  assert.ok(removed.outcomeEvidence.readError);
  semantic = true; gets = 0;
  const inspected = await backend.inspect({ sessionId: "s" });
  assert.ok("outcomeEvidence" in inspected);
  assert.equal(inspected.session.outcome, "unknown");
  assert.equal(inspected.outcomeEvidence.unavailable, true);
  assert.ok(inspected.currentActivity);
  assert.equal(JSON.stringify([status, inspected]).includes("SECRET"), false);
  semantic = false;
  await assert.rejects(backend.inspect({ sessionId: "s", messageId: "missing", detail: "result" }));
  await assert.rejects(backend.inspect({ sessionId: "s", messageId: "missing", detail: "semantic" }));
});

test("missing or synthetic target never fabricates a user result", async () => {
  const native = messageFixture([user("u"), assistant("a", "answer")]);
  await assert.rejects(latestResult(native.client, { sessionId: "s", messageId: "missing" }, true));
  await assert.rejects(latestResult(native.client, { sessionId: "s", messageId: "a" }, true), /user prompt/);
  assert.equal((await latestResult(native.client, { sessionId: "s", messageId: "u" }, false)).selectionComplete, false);
});

function workerFixture() {
  const state = session();
  const agent = { id: "build", name: "Build", mode: "primary", hidden: false, request: { headers: { auth: "SECRET" } }, system: "instructions", description: "builder", steps: 7, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
  let persist = true;
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/session/active") return { data: {} };
    if (r.path === "/api/model") return { location: state.location, data: ["a", "b"].map((id) => ({ id, modelID: id, name: id, providerID: "openai", family: "test", capabilities: { tools: true, input: ["text"], output: ["text"] }, time: { released: 123 }, status: "active", enabled: true, variants: [{ id: "high" }], limit: { context: 100, output: 10 }, cost: [] })) };
    if (r.path === "/api/agent") return { location: state.location, data: [agent, { ...agent, id: "explore" }] };
    if (r.path === "/api/session" && r.method === "POST") {
      if (r.body.permissions) state.permissions = r.body.permissions as typeof state.permissions;
      else delete state.permissions;
      return { data: state };
    }
    if (r.path === "/api/session/s" && r.method === "GET") return { data: state };
    if (r.path.endsWith("/model")) { if (persist) state.model = { ...(r.body.model as NonNullable<typeof state.model>), variant: (r.body.model as NonNullable<typeof state.model>).variant ?? "default" }; return; }
    if (r.path.endsWith("/agent")) { if (persist) state.agent = String(r.body.agent); return; }
    if (r.path === "/api/session/s" && r.method === "PATCH") { if (persist) state.permissions = r.body.permissions as typeof state.permissions; return; }
    if (r.path.endsWith("/prompt")) return { data: { id: "user-admission", sessionID: "s", type: "user" } };
    if (r.path.endsWith("/synthetic")) return { data: { id: "inbox-native", sessionID: "s", type: "synthetic", time: { created: 5 }, delivery: "queue", payload: { text: r.body.text } } };
    if (r.path.endsWith("/permission")) return { data: [] };
    if (r.path === "/api/permission/saved") return { data: [{ id: "approval", projectID: "p", action: "shell", resource: "*", time: { created: 1, updated: 1 } }] };
    throw new Error(`unexpected ${r.method} ${r.path}`);
  });
  return { ...fixture, state, agent, persist: (value: boolean) => { persist = value; } };
}

test("scalar agent selects execution while plural context forwards unchanged; fresh defaults and resume/fork inherit", async () => {
  const state = session();
  let forked = { ...state, id: "fork" };
  const fixture = nativeFixture((request) => {
    if (request.path === "/api/session/active") return { data: {} };
    if (request.path === "/api/model") return { data: [{ id: "a", providerID: "openai", enabled: true, variants: [] }] };
    if (request.path === "/api/agent") return { data: [{ id: "build", mode: "primary" }, { id: "explore", mode: "subagent" }] };
    if (request.path === "/api/session" && request.method === "POST") {
      state.agent = String(request.body.agent);
      return { data: state };
    }
    if (request.path === "/api/session/s") return { data: state };
    if (request.path === "/api/session/fork") return { data: forked };
    if (request.path === "/api/session/s/fork") {
      forked = { ...state, id: "fork" };
      return { data: forked };
    }
    if (request.path.endsWith("/prompt")) return { data: { id: "user-native", type: "user", sessionID: request.path.split("/")[3] } };
    throw new Error(`unexpected ${request.path}`);
  });
  const backend = new OpenCodeBackend(fixture.connect);
  const first = await backend.start({ task: "task", model: "openai/a", cwd: "/tmp", agents: [{ name: "explore" }] });
  assert.equal(first.agent, "build");
  const second = await backend.start({ task: "task", model: "openai/a", cwd: "/tmp", agent: "explore", agents: [{ name: "build" }] });
  assert.equal(second.agent, "explore");
  const resumed = await backend.start({ task: "task", model: "openai/a", sessionId: "s", agents: [{ name: "build" }] });
  assert.equal(resumed.agent, "explore");
  const fork = await backend.start({ task: "task", model: "openai/a", forkFromSessionId: "s", agents: [{ name: "build" }] });
  assert.equal(fork.sessionId, "fork");
  assert.equal(fork.agent, "explore");
  const before = fixture.requests.filter((request) => request.method !== "GET").length;
  await assert.rejects(backend.start({ task: "task", model: "openai/a", sessionId: "s", agent: "build" }), /match canonical/);
  await assert.rejects(backend.start({ task: "task", model: "openai/a", forkFromSessionId: "s", agent: "build" }), /match canonical/);
  assert.equal(fixture.requests.filter((request) => request.method !== "GET").length, before);
  const creates = fixture.requests.filter((request) => request.path === "/api/session" && request.method === "POST");
  assert.deepEqual(creates.map((request) => request.body.agent), ["build", "explore"]);
  assert.equal(creates.some((request) => "agents" in request.body), false);
  const prompts = fixture.requests.filter((request) => request.path.endsWith("/prompt"));
  assert.deepEqual(prompts.map((request) => request.body.agents), [[{ name: "explore" }], [{ name: "build" }], [{ name: "build" }], [{ name: "build" }]]);
  assert.equal(prompts.some((request) => "agent" in request.body), false);
  assert.equal(fixture.requests.filter((request) => request.path.startsWith("/api/agent")).every((request) => request.method === "GET"), true);
});

test("fresh permission omission preserves native policy; explicit rules are persisted verbatim", async () => {
  const fixture = workerFixture(); const backend = new OpenCodeBackend(fixture.connect);
  await backend.start({ task: "task", model: "openai/a", cwd: "/tmp" });
  assert.equal("permissions" in fixture.requests.find((r) => r.path === "/api/session" && r.method === "POST")!.body, false);
  const started = await backend.start({ task: "task", model: "openai/a", cwd: "/tmp", permissions: reviewer });
  assert.equal(started.messageId, "user-admission"); assert.deepEqual(fixture.state.permissions, reviewer);
  await assert.rejects(backend.start({ task: "task", model: "openai/a", sessionId: "s", permissions: reviewer }), /fresh sessions/);
  await backend.act({ action: "setPermissions", sessionId: "s", permissions: [] });
  assert.deepEqual(fixture.state.permissions, []);
  fixture.persist(false);
  await assert.rejects(backend.act({ action: "setPermissions", sessionId: "s", permissions: reviewer }), /readback mismatch/);
});

test("model and agent switches validate catalogs separately, read persisted state, and synthetic returns inbox identity", async () => {
  const fixture = workerFixture(); const backend = new OpenCodeBackend(fixture.connect);
  await assert.rejects(backend.act({ action: "switchModel", sessionId: "s", model: "other/missing" }), /not available/);
  await assert.rejects(backend.act({ action: "switchAgent", sessionId: "s", agent: "Build" }), /not available/);
  await backend.act({ action: "switchModel", sessionId: "s", model: "openai/b", variant: "high" });
  assert.deepEqual(fixture.state.model, { providerID: "openai", id: "b", variant: "high" });
  assert.equal(fixture.state.agent, "build");
  await backend.act({ action: "switchAgent", sessionId: "s", agent: "explore" });
  assert.equal(fixture.state.agent, "explore");
  assert.equal(fixture.state.model?.id, "b");
  fixture.persist(false);
  await assert.rejects(backend.act({ action: "switchAgent", sessionId: "s", agent: "build" }), /readback/);
  const synthetic = await backend.act({ action: "synthetic", sessionId: "s", text: "CI finished", delivery: "queue", resume: false });
  assert.equal(synthetic.inboxId, "inbox-native"); assert.equal("messageId" in synthetic, false);
});

test("model switch permits native default variant resolution and still checks explicit variant and model readback", async () => {
  const fixture = workerFixture(); const backend = new OpenCodeBackend(fixture.connect);
  const result = await backend.act({ action: "switchModel", sessionId: "s", model: "openai/b" });
  assert.ok(result.session);
  assert.equal(result.session.model, "openai/b");
  assert.equal(result.session.modelVariant, "default");
  fixture.persist(false);
  await assert.rejects(backend.act({ action: "switchModel", sessionId: "s", model: "openai/a" }), /readback mismatch/);
  await assert.rejects(backend.act({ action: "switchModel", sessionId: "s", model: "openai/b", variant: "high" }), /readback mismatch/);
});

test("safe complete agent fields omit request; permission/saved approval queries use native session/project scope", async () => {
  const fixture = workerFixture();
  const agent = projectAgent(fixture.agent as unknown as AgentInfo);
  assert.equal(agent.steps, 7); assert.equal(agent.system.text, "instructions"); assert.equal(agent.description.text, "builder");
  assert.deepEqual(agent.permissions.data, fixture.agent.permissions); assert.equal(JSON.stringify(agent).includes("SECRET"), false);
  const backend = new OpenCodeBackend(fixture.connect);
  const query = await backend.query([{ type: "permissions", sessionId: "s" }, { type: "savedApprovals", sessionId: "s" }]);
  assert.equal(query.results.some((entry) => "error" in entry), false);
  assert.equal(fixture.requests.find((r) => r.path === "/api/permission/saved")?.query.get("projectID"), "p");
});

test("message query carries native cursors without order and direct message text pages recover full text", async () => {
  const text = "é😀".repeat(5000);
  const fixture = messageFixture([user("u"), assistant("a",text)]);
  const backend = new OpenCodeBackend(fixture.connect);
  const result = await backend.query([{ type: "messages", sessionId: "s", limit: 1, order: "asc" }]);
  const page = result.results[0].result as { cursor: { next: string } };
  await backend.query([{ type: "messages", sessionId: "s", cursor: page.cursor.next }]);
  const direct = await backend.query([{ type: "message", sessionId: "s", messageId: "a", textOffset: 12000, textFingerprint: fingerprint(text) }]);
  assert.equal(direct.results.some((r) => "error" in r), false);
});

test("large canonical permission rules recover through independent pages, with changed-rule detection", async () => {
  const state = session();
  state.permissions = Array.from({ length: 130 }, (_, i) => ({ action: "read", resource: `file-${i}`, effect: "allow" }));
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/session/s") return { data: state };
    if (r.path.endsWith("/permission")) return { data: [{ id: "pending", sessionID: "s", action: "edit", resources: ["a"] }] };
    throw new Error(`unexpected ${r.path}`);
  });
  const backend = new OpenCodeBackend(fixture.connect);
  type RulesPage = { rules: { data: unknown[]; nextOffset: number | null; fingerprint: string } };
  let offset = 0; let fingerprint: string | undefined; const recovered: unknown[] = [];
  do {
    const query = await backend.query([{ type: "permissions", sessionId: "s", section: "rules", offset, fingerprint, limit: 50 }]);
    assert.equal(query.results.some((r) => "error" in r), false);
    const rules = (query.results[0].result as RulesPage).rules;
    recovered.push(...rules.data); fingerprint = rules.fingerprint;
    if (rules.nextOffset === null) break;
    offset = rules.nextOffset;
  } while (true);
  assert.deepEqual(recovered, state.permissions);
  assert.equal(fixture.requests.some((r) => r.path.endsWith("/permission")), false);
  const pending = await backend.query([{ type: "permissions", sessionId: "s", section: "pending", limit: 1 }]);
  assert.ok("pending" in (pending.results[0].result as object));
  state.permissions[0].effect = "deny";
  const changed = await backend.query([{ type: "permissions", sessionId: "s", section: "rules", offset: 50, fingerprint }]);
  assert.match(String(changed.results[0].error), /changed/);
});

test("complete agent instructions and permissions recover through independent fields without provider request", async () => {
  const rules = Array.from({length:60}, (_,i)=>({action:"read",resource:`f-${i}`,effect:"allow"}));
  const system = "instructions\n".repeat(1300);
  const agent = {id:"reviewer",name:"Reviewer",mode:"primary",hidden:false,system,description:"review",steps:5,permissions:rules,request:{headers:{authorization:"PRIVATE"}}};
  const fixture = nativeFixture(() => ({location:{directory:"/tmp"},data:agent}));
  const backend = new OpenCodeBackend(fixture.connect);
  const first = await backend.query([{type:"agent",cwd:"/tmp",agentId:"reviewer",field:"system"}]);
  const part = first.results[0].result as {text:string;textPaging:{nextOffset:number;fingerprint:string}};
  const second = await backend.query([{type:"agent",cwd:"/tmp",agentId:"reviewer",field:"system",textOffset:part.textPaging.nextOffset,textFingerprint:part.textPaging.fingerprint}]);
  assert.equal(part.text+(second.results[0].result as {text:string}).text,system);
  const permissions = await backend.query([{type:"agent",cwd:"/tmp",agentId:"reviewer",field:"permissions",offset:50,limit:50,fingerprint:fingerprint(rules)}]);
  assert.deepEqual((permissions.results[0].result as {permissions:{data:unknown[]}}).permissions.data,rules.slice(50));
  assert.equal(JSON.stringify([first,second,permissions]).includes("PRIVATE"),false);
});
