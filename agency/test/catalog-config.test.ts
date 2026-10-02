import assert from "node:assert/strict"
import test from "node:test"
import { chmod, link, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { adapterEntry, observeConfig, readProfiles } from "../src/catalog/config.js"
import { profileFixture } from "./catalog-support.js"
import { privateRoot } from "./control-support.js"

test("absent profiles are read-only and do not create catalog directories", async t => {
  const root = await privateRoot(t)
  assert.deepEqual(await readProfiles(root), [])
  assert.deepEqual(await readdir(root), [])
})

test("declared fingerprints track presence, content, and physical executable identity without SDK import", async t => {
  const f = await profileFixture(t)
  await f.save()
  assert.deepEqual(await readProfiles(f.root), [f.profile])
  const first = await observeConfig(f.profile)
  assert.equal(first.sdkVersion, "0.3.232")
  assert.equal(first.adapterVersion, "0.70.0")
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(await observeConfig(f.profile), first)
  assert.equal(await adapterEntry(f.profile), join(f.adapter, "index.mjs"))
  await writeFile(join(f.adapter, "index.mjs"), "changed adapter bytes", { mode: 0o600 })
  const adapterChanged = await observeConfig(f.profile)
  assert.notEqual(adapterChanged.fingerprint, first.fingerprint)
  await rename(join(f.adapter, "index.mjs"), join(f.adapter, "index-old.mjs"))
  await writeFile(join(f.adapter, "index.mjs"), "changed adapter bytes", { mode: 0o600 })
  assert.notEqual((await observeConfig(f.profile)).fingerprint, adapterChanged.fingerprint)
  await writeFile(f.config, "")
  const empty = await observeConfig(f.profile)
  assert.notEqual(empty.fingerprint, first.fingerprint)
  await writeFile(f.config, "changed")
  const changed = await observeConfig(f.profile)
  assert.notEqual(changed.fingerprint, empty.fingerprint)
  await rename(f.executable, f.executable + "-old")
  await writeFile(f.executable, "fixture executable", { mode: 0o700 })
  assert.notEqual((await observeConfig(f.profile)).fingerprint, changed.fingerprint)
  const before = await observeConfig(f.profile)
  await writeFile(join(f.root, "unlisted-secret"), "not fingerprinted")
  assert.deepEqual(await observeConfig(f.profile), before)
  for (const path of [f.config, f.profile.adapterPackageJson, f.profile.sdkPackageJson!]) {
    const prior = await observeConfig(f.profile), bytes = await readFile(path)
    await rename(path, path + "-old")
    await writeFile(path, bytes, { mode: 0o600 })
    assert.notEqual((await observeConfig(f.profile)).fingerprint, prior.fingerprint)
  }
})

test("adapter entries reject escape, missing, symlink, and nonregular targets", async t => {
  const f = await profileFixture(t), packageJson = f.profile.adapterPackageJson
  for (const main of ["/absolute.mjs", "../escape.mjs", "missing.mjs", "./index.mjs", "dist//index.mjs"]) {
    await writeFile(packageJson, JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.70.0", main }), { mode: 0o600 })
    await assert.rejects(adapterEntry(f.profile), { code: "INVALID_CATALOG" })
  }
  await writeFile(packageJson, JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.70.0", main: "linked.mjs" }), { mode: 0o600 })
  await symlink(join(f.adapter, "index.mjs"), join(f.adapter, "linked.mjs"))
  await assert.rejects(adapterEntry(f.profile), { code: "INVALID_CATALOG" })
  await writeFile(packageJson, JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.70.0", main: "directory" }), { mode: 0o600 })
  await mkdir(join(f.adapter, "directory"))
  await assert.rejects(adapterEntry(f.profile), { code: "INVALID_CATALOG" })
})

test("unsafe manifests fail without changing evidence", async t => {
  const f = await profileFixture(t)
  for (const providers of [[f.profile, f.profile], [{ ...f.profile, id: "unknown" }], [{ ...f.profile, extra: true }], [{ ...f.profile, executable: "relative" }], [{ ...f.profile, configurationFiles: [f.config, f.config] }]]) {
    await f.save(providers)
    const before = await readFile(f.manifest)
    await assert.rejects(readProfiles(f.root), { code: "INVALID_CATALOG" })
    assert.deepEqual(await readFile(f.manifest), before)
  }
  await f.save()
  await chmod(f.manifest, 0o644)
  await assert.rejects(readProfiles(f.root), { code: "INVALID_CATALOG" })
  await chmod(f.manifest, 0o600)
  await link(f.manifest, f.manifest + "-link")
  await assert.rejects(readProfiles(f.root), { code: "INVALID_CATALOG" })
  await unlink(f.manifest + "-link")
  await rename(f.manifest, f.manifest + "-original")
  await symlink(f.manifest + "-original", f.manifest)
  await assert.rejects(readProfiles(f.root), { code: "INVALID_CATALOG" })
})

test("configuration readers reject bad packages, oversized or invalid data, and nonregular targets", async t => {
  const f = await profileFixture(t)
  await writeFile(f.profile.sdkPackageJson!, JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0", main: "sdk.mjs" }))
  await assert.rejects(observeConfig(f.profile), { code: "UNSUPPORTED_PROVIDER_VERSION" })
  await writeFile(f.profile.sdkPackageJson!, JSON.stringify({ name: "other", version: "0.3.232" }))
  await assert.rejects(observeConfig(f.profile), { code: "INVALID_CATALOG" })
  await writeFile(f.manifest, Buffer.from([0xff]), { mode: 0o600 })
  await assert.rejects(readProfiles(f.root), { code: "INVALID_CATALOG" })
  await writeFile(f.manifest, " ".repeat(65537))
  await assert.rejects(readProfiles(f.root), { code: "INVALID_CATALOG" })
  await unlink(f.executable)
  await mkdir(f.executable)
  await assert.rejects(observeConfig(f.profile), { code: "INVALID_CATALOG" })
})