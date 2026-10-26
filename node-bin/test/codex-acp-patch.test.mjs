import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { patchCodexAcp } from "../patch-codex-acp.mjs";

const installed = await readFile(new URL("../node_modules/@agentclientprotocol/codex-acp/dist/index.js", import.meta.url), "utf8");
const original = installed
  .replace(/      const resolvers = threadResolvers\.get\(turnId\) \?\? new Set\(\);\n      resolvers\.add\(resolve\);\n      threadResolvers\.set\(turnId, resolvers\);/, "      threadResolvers.set(turnId, resolve);")
  .replace("    const resolvers = threadResolvers?.get(event.turn.id);\n    if (resolvers)", "    const resolve = threadResolvers?.get(event.turn.id);\n    if (resolve)")
  .replace("      for (const resolve of resolvers) resolve(event);", "      resolve(event);\n      return;");
assert.equal(createHash("sha256").update(original).digest("hex"), "afffcfeb6ae3a82f2b359a7d3d6a1a3ceee43898b59c34335eb1760974cc4ff8");

async function fixture(t, { version = "1.7.0", name = "@agentclientprotocol/codex-acp", source = original } = {}) {
  const project = await mkdtemp(path.join(tmpdir(), "acp-patch-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const root = path.join(project, "node_modules/@agentclientprotocol/codex-acp");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name, version }));
  const bundle = path.join(root, "dist/index.js");
  await writeFile(bundle, source); await chmod(bundle, 0o751);
  return { root, bundle, project };
}

test("patch changes pinned bundle once and preserves executable mode", async t => {
  const { root, bundle } = await fixture(t);
  await patchCodexAcp(root);
  const patched = await readFile(bundle);
  assert.notDeepEqual(patched, Buffer.from(original));
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  await patchCodexAcp(root);
  assert.deepEqual(await readFile(bundle), patched);
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(root, "dist")), ["index.js"]);
});

for (const [label, options] of [
  ["version", { version: "2.3.0" }],
  ["package name", { name: "unrelated" }],
  ["unknown source", { source: original.replace("threadResolvers.set(turnId, resolve);", "threadResolvers.set(turnId, () => {});") }],
  ["mixed patch state", { source: original.replace("      resolve(event);\n      return;", "      for (const resolve of resolvers) resolve(event);") }],
]) test("patch rejects " + label + " without modifying bundle", async t => {
  const { root, bundle } = await fixture(t, options);
  const before = await readFile(bundle);
  await assert.rejects(patchCodexAcp(root), /Unsupported codex-acp/);
  assert.deepEqual(await readFile(bundle), before);
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(root, "dist")), ["index.js"]);
});

test("postinstall executable resolves its own package directory", async t => {
  const { project, bundle } = await fixture(t);
  const script = path.join(project, "patch-codex-acp.mjs");
  await writeFile(script, await readFile(new URL("../patch-codex-acp.mjs", import.meta.url)));
  const result = spawnSync(process.execPath, [script], { cwd: tmpdir(), env: {}, timeout: 3000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.notDeepEqual(await readFile(bundle), Buffer.from(original));
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
});

test("manifest and lock retain the exact supported provider graph", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(await readFile(new URL("../node_modules/@agentclientprotocol/codex-acp/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies[metadata.name], "1.7.0");
  assert.equal(lock.packages[""].dependencies[metadata.name], "1.7.0");
  assert.equal(lock.packages["node_modules/" + metadata.name].version, "1.7.0");
  assert.equal(metadata.version, "1.7.0");
  assert.equal(manifest.scripts.postinstall, "node patch-codex-acp.mjs");
});