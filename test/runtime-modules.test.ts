import assert from "node:assert/strict";
import test from "node:test";
import * as facade from "../src/opencode.js";
import * as codex from "../src/codex.js";
import { nativeFixture } from "./native-fixture.js";

test("backend facades expose no relocated-helper aliases", () => {
  for (const name of ["OPENCODE_RELEASE", "parseModelRef", "projectMessage", "projectAgent", "latestResult"])
    assert.equal(Object.hasOwn(facade, name), false, name);
  assert.equal(Object.hasOwn(codex, "CodexSessionsDefinition"), false);
});

test("unknown native query types fail locally rather than falling through to a session read", async () => {
  const fixture = nativeFixture(() => { throw new Error("unexpected native access"); });
  const response = await new facade.OpenCodeBackend(fixture.connect).query([{ type: "futureQuery" } as unknown as facade.QueryInput]);
  assert.match(response.results[0].error!, /unsupported native query/);
  assert.deepEqual(fixture.requests, []);
});
