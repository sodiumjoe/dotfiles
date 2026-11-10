import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { patchCodexAcp } from "../patch-codex-acp.mjs";

const installed = await readFile(new URL("../node_modules/@agentclientprotocol/codex-acp/dist/index.js", import.meta.url), "utf8");
const installer = await readFile(new URL("../patch-codex-acp.mjs", import.meta.url), "utf8");
const replacements = runInNewContext(installer.slice(installer.indexOf("const originalHash"), installer.indexOf("export async function")) + "; replacements");
let bundle = installed;
if (createHash("sha256").update(bundle).digest("hex") === "45a79a25de7579e188fbd1c018e92bc209a0cebba1668b2e0df0224c14ace691") {
  for (const [before, after] of [...replacements].reverse()) {
    assert.equal(bundle.split(after).length, 2);
    bundle = bundle.replace(after, before);
  }
}
assert.equal(createHash("sha256").update(bundle).digest("hex"), "733b7521c2a437a34ed016d45a6f46bebff2bac123a172467574ee827db98b99");
const fixture = async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acp-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  return root;
};
const digest = text => createHash("sha256").update(text).digest("hex");

test("installer qualifies exact 2.6 bytes atomically and preserves executable mode", async t => {
  const root = await fixture(t), entry = path.join(root, "dist/index.js");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "2.6.0" }));
  await writeFile(entry, bundle); await chmod(entry, 0o755);
  await patchCodexAcp(root);
  const patched = await readFile(entry, "utf8");
  assert.equal(digest(patched), "45a79a25de7579e188fbd1c018e92bc209a0cebba1668b2e0df0224c14ace691");
  assert.equal((await stat(entry)).mode & 0o777, 0o755);
  await patchCodexAcp(root); assert.equal(await readFile(entry, "utf8"), patched);
});

test("installer refuses unknown versions and changed bundle bytes before writing", async t => {
  const root = await fixture(t), entry = path.join(root, "dist/index.js");
  for (const [version, input] of [["2.6.1", bundle], ["2.6.0", bundle + "x"]]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version }));
    await writeFile(entry, input); await chmod(entry, 0o755);
    await assert.rejects(patchCodexAcp(root), /Unsupported codex-acp/);
    assert.equal(await readFile(entry, "utf8"), input);
    assert.equal((await stat(entry)).mode & 0o777, 0o755);
  }
});