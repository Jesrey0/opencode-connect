import assert from "node:assert/strict";
import test from "node:test";
import * as facade from "../src/opencode.js";
import * as projection from "../src/runtime/projection.js";
import { latestResult } from "../src/runtime/result.js";
import { nativeFixture } from "./native-fixture.js";

test("the public backend facade retains the canonical projection and selection implementations", () => {
  for (const name of ["parseModelRef", "isZeroCostModel", "projectMessage", "projectAgent"] as const)
    assert.equal(facade[name], projection[name]);
  assert.equal(facade.latestResult, latestResult);
});

test("unknown native query types fail locally rather than falling through to a session read", async () => {
  const fixture = nativeFixture(() => { throw new Error("unexpected native access"); });
  const response = await new facade.OpenCodeBackend(fixture.connect).query([{ type: "futureQuery" } as unknown as facade.QueryInput]);
  assert.match(response.results[0].error!, /unsupported native query/);
  assert.deepEqual(fixture.requests, []);
});
