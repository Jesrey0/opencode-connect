import assert from "node:assert/strict";
import test from "node:test";
import { isZeroCostModel, parseModelRef } from "../src/opencode.js";
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

test("zero-cost classification relies only on canonical pricing metadata", () => {
  const paid = [{ input: 1, output: 2, cache: { read: 0.1, write: 0.1 } }];
  const free = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
  assert.equal(isZeroCostModel({ cost: free }), true);
  assert.equal(isZeroCostModel({ cost: paid }), false);
  assert.equal(isZeroCostModel({ cost: [] }), false);
});

test("zero-cost classification requires every pricing field in every tier to be exactly zero", () => {
  const free = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  for (const field of ["input", "output", "read", "write"] as const) {
    const paid = structuredClone(free);
    if (field === "input" || field === "output") paid[field] = 1;
    else paid.cache[field] = 1;
    assert.equal(isZeroCostModel({ cost: [free, paid] }), false, field);
  }
  assert.equal(isZeroCostModel({ cost: [free, free] }), true);
});

test("zero-cost classification excludes unknown or malformed pricing", () => {
  type Cost = Parameters<typeof isZeroCostModel>[0]["cost"];
  const free = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  const unknownCosts: unknown[] = [undefined, null, {}, [], [null], [{ input: 0, output: 0 }]];
  for (const value of [undefined, null, "0", "", false, NaN]) {
    for (const field of ["input", "output", "read", "write"] as const) {
      const tier = { ...free, cache: { ...free.cache } };
      if (field === "input" || field === "output") Object.assign(tier, { [field]: value });
      else Object.assign(tier.cache, { [field]: value });
      unknownCosts.push([tier]);
    }
  }
  for (const cost of unknownCosts) {
    assert.equal(isZeroCostModel({ cost: cost as Cost }), false);
  }
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
