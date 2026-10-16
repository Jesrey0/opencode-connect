import assert from "node:assert/strict";
import test from "node:test";
import { parseModelRef } from "../src/runtime/projection.js";
import { OpenCodeBackend } from "../src/opencode.js";
import { nativeFixture } from "./native-fixture.js";

test("parseModelRef preserves provider and model IDs", () => {
  assert.deepEqual(parseModelRef("opencode/muse-spark-1.3-contributor-free"), {
    providerID: "opencode",
    id: "muse-spark-1.3-contributor-free",
  });
});

test("parseModelRef rejects non-canonical IDs", () => {
  assert.throws(() => parseModelRef("muse-spark-1.3-contributor-free"), /provider\/model/);
});

test("saved approval removal requires the exact project target and verifies absence", async () => {
  let saved = [
    { id: "a1", projectID: "p", action: "edit", resource: "src/**", time: { created: 1, updated: 1 } },
    { id: "other", projectID: "q", action: "edit", resource: "src/**", time: { created: 1, updated: 1 } },
  ];
  const native = nativeFixture((request) => {
    if (request.path === "/api/session/s") return { data: { id: "s", projectID: "p", location: { directory: "/tmp" }, time: { created: 1, updated: 2 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } };
    if (request.path === "/api/permission/saved") return { data: saved };
    if (request.path === "/api/permission/saved/a1" && request.method === "DELETE") { saved = saved.filter((entry) => entry.id !== "a1"); return undefined; }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const backend = new OpenCodeBackend(native.connect);
  await assert.rejects(backend.act({ action: "removeSavedApproval", sessionId: "s", approvalId: "missing" }), /absent/);
  await assert.rejects(backend.act({ action: "removeSavedApproval", sessionId: "s", approvalId: "other" }), /absent/, "another project's approval is not an exact target");
  const removed = await backend.act({ action: "removeSavedApproval", sessionId: "s", approvalId: "a1" });
  assert.deepEqual(removed, { action: "removeSavedApproval", sessionId: "s", projectId: "p", approvalId: "a1", removed: true, persisted: true });
  assert.deepEqual(native.requests.filter((request) => request.path.startsWith("/api/permission/saved")).map((request) => [request.method, request.path]), [["GET", "/api/permission/saved"], ["GET", "/api/permission/saved"], ["GET", "/api/permission/saved"], ["DELETE", "/api/permission/saved/a1"], ["GET", "/api/permission/saved"]]);
  await assert.rejects(backend.act({ action: "removeSavedApproval", sessionId: "s", approvalId: "a1" }), /absent/);
});

test("session revert actions preserve native stage, clear, and commit boundaries", async () => {
  const native = nativeFixture((request) => {
    if (request.path === "/api/session/s") return { data: { id: "s", projectID: "p", location: { directory: "/tmp" }, time: { created: 1, updated: 2 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } };
    if (request.path.endsWith("/revert/stage")) return { data: { messageID: "m", files: [{ file: "secret", additions: 1, deletions: 0, status: "modified", patch: "private patch" }] } };
    return undefined;
  });
  const backend = new OpenCodeBackend(native.connect);
  const staged = await backend.act({ action: "revertStage", sessionId: "s", messageId: "m", files: true });
  await backend.act({ action: "revertClear", sessionId: "s" });
  await backend.act({ action: "revertCommit", sessionId: "s" });
  assert.equal(JSON.stringify(staged).includes("private patch"), false);
  assert.deepEqual(native.requests.filter((request) => request.path.includes("/revert")).map((request) => [request.method, request.path]), [["POST", "/api/session/s/revert/stage"], ["DELETE", "/api/session/s/revert"], ["POST", "/api/session/s/revert/commit"]]);
  assert.equal(native.requests.find((request) => request.path.endsWith("/revert/stage"))?.body.messageID, "m");
});
