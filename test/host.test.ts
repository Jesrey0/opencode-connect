import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBackend, imageMime } from "../src/host.js";
import { fingerprint, page } from "../src/bounds.js";
import { nativeFixture, session } from "./native-fixture.js";

test("shell native admission, byte cursors, exit/drain, timeout, remove and missing handle", async () => {
  let status: "running" | "exited" | "timeout" = "running";
  let removed = false;
  const bytes = Buffer.from("Aé😀Z");
  const info = () => ({ id: "sh", status, cwd: "/tmp", command: "never expose command metadata", shell: "sh", file: "/secret/output", metadata: { env: "SECRET" }, time: { started: 1 }, exit: status === "exited" ? 0 : undefined });
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/location") return { directory: "/tmp", project: { id: "p", directory: "/tmp", canonical: "/tmp" } };
    if (removed) return new Response(JSON.stringify({ message: "shell not found" }), { status: 404 });
    if (r.method === "DELETE") { removed = true; return; }
    if (r.path.endsWith("/output")) {
      const start = Number(r.query.get("cursor") ?? 0); const end = Math.min(bytes.length, start + Number(r.query.get("limit")));
      return { location: { directory: "/tmp" }, data: { output: bytes.subarray(start, end).toString("utf8"), cursor: end, size: bytes.length, truncated: false } };
    }
    return { location: { directory: "/tmp" }, data: info() };
  });
  const host = new HostBackend(fixture.connect);
  const admitted = await host.start({ kind: "shell", cwd: "/tmp", command: "printf native", timeoutMs: 10 });
  assert.equal(admitted.id, "sh");
  assert.equal(admitted.cursorUnit, "bytes");
  const post = fixture.requests.find((r) => r.method === "POST")!;
  assert.equal(post.body.timeout, 10);
  assert.equal(post.body.cwd, "/tmp");
  assert.equal(JSON.stringify(admitted).includes("SECRET"), false);
  const handle = { kind: "shell" as const, cwd: "/tmp", id: "sh" };
  const running = await host.read({ ...handle, cursor: bytes.length });
  assert.equal(running.drained, false);
  status = "exited";
  const partial = await host.read({ ...handle, cursor: 1, limit: 1 });
  assert.equal(partial.output, "�"); // Upstream itself decodes a split byte page with replacement.
  assert.equal(partial.cursor, 2);
  assert.equal(partial.drained, false);
  assert.ok("decodingLimit" in partial);
  assert.match(String(partial.decodingLimit), /split multibyte/);
  assert.equal((await host.read({ ...handle, cursor: bytes.length })).drained, true);
  status = "timeout";
  assert.equal((await host.read({ ...handle, cursor: bytes.length })).drained, true);
  await assert.rejects(host.control({ ...handle, action: "interrupt" }), /removal only/);
  await host.control({ ...handle, action: "remove" });
  await assert.rejects(host.read(handle));
});

test("file pages are fingerprinted, byte bounded, lossless for split UTF-8, and reject escaping symlinks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-host-"));
  try {
    await writeFile(`${cwd}/file`, "Aé😀Z");
    await symlink("/etc/hosts", `${cwd}/escape`);
    let bytes = Buffer.from("Aé😀Z");
    const fixture = nativeFixture((r) => {
      if (r.path === "/api/location") return { directory: cwd, project: { id: "p", directory: cwd, canonical: cwd } };
      if (r.path.startsWith("/api/fs/read/")) return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      if (r.path.endsWith("/list")) return { location: { directory: cwd }, data: [{ path: "a", type: "file" }, { path: "b", type: "file" }] };
      throw new Error(`unexpected ${r.path}`);
    });
    const host = new HostBackend(fixture.connect);
    const first = await host.inspect({ type: "read", cwd, path: "file", limit: 2 });
    assert.equal(first.encoding, "base64");
    assert.equal(Buffer.from(String(first.data), "base64").toString("hex"), bytes.subarray(0,2).toString("hex"));
    const hash = String(first.fingerprint);
    assert.equal(first.nextCall?.tool, "host.inspect");
    assert.deepEqual(first.nextCall?.arguments, { type: "read", cwd, path: `${cwd}/file`, limit: 2, offset: 2, fingerprint: hash });
    const next = await host.inspect(first.nextCall!.arguments as Parameters<typeof host.inspect>[0]);
    assert.equal(next.offset, 2);
    await assert.rejects(host.inspect({ type: "read", cwd, path: "file", offset: 2 }), /fingerprint/);
    bytes = Buffer.from("changed");
    await assert.rejects(host.inspect({ type: "read", cwd, path: "file", offset: 2, fingerprint: hash }), /changed/);
    await assert.rejects(host.inspect({ type: "read", cwd, path: "escape" }), /leaves/);
    await assert.rejects(host.inspect({ type: "list", cwd, path: ".." }), /leaves/);
    const list = await host.inspect({ type: "list", cwd, limit: 1 });
    assert.equal(list.nextOffset, 1);
    const last = await host.inspect(list.nextCall!.arguments as Parameters<typeof host.inspect>[0]);
    assert.equal(last.nextOffset, null);
    assert.equal(last.nextCall, null);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("native VCS diffs page metadata separately from complete patch text; changed patches invalidate pages", async () => {
  let patch = "x".repeat(20000);
  const fixture = nativeFixture((r) => r.path === "/api/location" ? { directory: "/tmp" } : { location: { directory: "/tmp" }, data: [{ file: "a", additions: 1, deletions: 0, status: "modified", patch }] });
  const host = new HostBackend(fixture.connect);
  const inventory = await host.inspect({ type: "vcsDiff", cwd: "/tmp" });
  assert.equal("patch" in (inventory.data as object[])[0], false);
  const first = await host.inspect({ type: "vcsDiff", cwd: "/tmp", file: "a" });
  assert.equal(first.text?.length, 12000);
  assert.equal(first.nextCall?.tool, "host.inspect");
  const second = await host.inspect(first.nextCall!.arguments as Parameters<typeof host.inspect>[0]);
  assert.equal(second.text?.length, 8000);
  patch = "changed";
  await assert.rejects(host.inspect({ type: "vcsDiff", cwd: "/tmp", file: "a", textOffset: 12000, textFingerprint: fingerprint("x".repeat(20000)) }), /changed/);
});

test("native VCS branches page fingerprinted names with native search", async () => {
  const branches = ["main", "feature-a", "feature-b"];
  const fixture = nativeFixture((r) => {
    if (r.path === "/api/location") return { directory: "/tmp", project: { id: "p", directory: "/tmp", canonical: "/tmp" } };
    if (r.path === "/api/vcs/branch") {
      const search = r.query.get("search");
      return { location: { directory: "/tmp" }, data: search ? branches.filter((branch) => branch.includes(search)) : branches };
    }
    throw new Error(`unexpected ${r.path}`);
  });
  const host = new HostBackend(fixture.connect);
  const first = await host.inspect({ type: "vcsBranch", cwd: "/tmp", limit: 2 });
  assert.deepEqual(first.data, ["main", "feature-a"]);
  assert.equal(first.nextOffset, 2);
  const second = await host.inspect(first.nextCall!.arguments as Parameters<typeof host.inspect>[0]);
  assert.deepEqual(second.data, ["feature-b"]);
  assert.equal(second.nextOffset, null);
  await assert.rejects(host.inspect({ type: "vcsBranch", cwd: "/tmp", offset: 2 }), /fingerprint/);
  const filtered = await host.inspect({ type: "vcsBranch", cwd: "/tmp", search: "feature" });
  assert.deepEqual(filtered.data, ["feature-a", "feature-b"]);
  assert.equal(filtered.search, "feature");
  assert.ok(fixture.requests.some((request) => request.path === "/api/vcs/branch" && request.query.get("search") === "feature"));
});

test("safe images enforce byte limit and signature, excluding SVG/HTML", async () => {
  assert.equal(imageMime(Buffer.from([137,80,78,71,13,10,26,10])), "image/png");
  assert.throws(() => imageMime(Buffer.from("<svg/>")), /signature/);
  const cwd = await mkdtemp(join(tmpdir(), "opencode-image-"));
  try {
    await writeFile(`${cwd}/image`, "fixture");
    const fixture = nativeFixture((r) => r.path === "/api/location" ? { directory: cwd } : new Response(Buffer.alloc(1_048_577)));
    await assert.rejects(new HostBackend(fixture.connect).inspect({ type: "read", cwd, path: "image", image: true }), /1 MiB/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("array pages bound serialized bytes and invalidate mutation between pages", () => {
  const data = Array.from({ length: 50 }, (_, id) => ({ id, text: "x".repeat(20000) }));
  const first = page(data, { limit: 50 });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 100000);
  assert.ok(first.nextOffset !== null);
  const second = page(data, { offset: first.nextOffset!, fingerprint: first.fingerprint, limit: 50 });
  assert.equal(second.data[0].id, first.nextOffset);
  data[0].text = "changed";
  assert.throws(() => page(data, { offset: first.nextOffset!, fingerprint: first.fingerprint }), /changed/);
});

test("file UTF-8 pages preserve BOM bytes at the beginning and at continuation boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-bom-"));
  const bytes = Buffer.from("\uFEFFAB\uFEFFC");
  try {
    await writeFile(`${cwd}/file`, bytes);
    const native = nativeFixture((r) => r.path === "/api/location" ? { directory: cwd } : new Response(bytes));
    const host = new HostBackend(native.connect);
    const first = await host.inspect({ type: "read", cwd, path: "file", limit: 5 });
    const second = await host.inspect({ type: "read", cwd, path: "file", offset: 5, fingerprint: String(first.fingerprint) });
    assert.equal(first.encoding, "utf8"); assert.equal(second.encoding, "utf8");
    assert.deepEqual(Buffer.from(String(first.text) + String(second.text), "utf8"), bytes);
    assert.equal(first.nextOffset, 5); assert.equal(second.nextOffset, null);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
