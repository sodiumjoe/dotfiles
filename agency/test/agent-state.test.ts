import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, readdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { prepareProviderState, providerStatePath, removeProviderState, resolvedLaunchEnvironment } from "../src/agent/state.js"
import type { LaunchEnvironmentPolicy } from "../src/agent/qualification.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import type { LaunchRecord } from "../src/platform/types.js"
import { sampleSpec } from "./agent-support.js"
import { privateRoot } from "./control-support.js"

const policy: LaunchEnvironmentPolicy = {
  fixed: { CODEX_CONFIG: "{}", CODEX_PATH: "/managed/codex", GIT_CONFIG_NOSYSTEM: "1", INITIAL_AGENT_MODE: "read-only", MODEL_PROVIDER: "litellm", PATH: "/usr/bin:/bin" },
  private: { HOME: "home", CODEX_HOME: "home/codex", XDG_CONFIG_HOME: "xdg/config", XDG_CACHE_HOME: "xdg/cache", XDG_STATE_HOME: "xdg/state", TMPDIR: "tmp" },
}

async function stateFixture(t: TestContext) {
  const root = await privateRoot(t), spec = sampleSpec(), launchAttemptId = spec.launchAttemptId
  const launch: LaunchRecord = { version: 1, checkoutId: spec.checkout.checkoutId, agentId: spec.agentId, leaseId: spec.leaseId, handlerGeneration: spec.handlerGeneration, launchAttemptId, launchBootId: "boot-a", launchAttempted: false, provider: null, phase: "launch_pending", reason: null }
  await mkdir(join(root, "launches"), { mode: 0o700 })
  await writeLaunchRecord(join(root, "launches", launchAttemptId + ".json"), launch)
  const unrelated = join(root, "unrelated")
  await mkdir(unrelated, { mode: 0o700 }); await writeFile(join(unrelated, "sentinel"), "retain", { mode: 0o600 })
  const verified = async () => writeLaunchRecord(join(root, "launches", launchAttemptId + ".json"), { ...launch, phase: "cleanup_verified" })
  return { root, launchAttemptId, policy, unrelated, verified }
}

test("private launch environment contains only qualified keys", async t => {
  const f = await stateFixture(t)
  const prepared = await prepareProviderState(f.root, f.launchAttemptId, f.policy)
  assert.equal(prepared.root, providerStatePath(f.root, f.launchAttemptId))
  assert.deepEqual(Object.keys(prepared.environment).sort(), [
    "CODEX_CONFIG", "CODEX_HOME", "CODEX_PATH", "GIT_CONFIG_NOSYSTEM", "HOME", "INITIAL_AGENT_MODE",
    "MODEL_PROVIDER", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
  ])
  assert.equal(prepared.environment.HOME, join(prepared.root, "home"))
  assert.equal(prepared.environment.CODEX_HOME, join(prepared.root, "home/codex"))
  assert.equal(prepared.environment.GIT_CONFIG_NOSYSTEM, "1")
  for (const relative of ["", "home", "home/codex", "xdg", "xdg/config", "xdg/cache", "xdg/state", "tmp"]) {
    const stat = await lstat(join(prepared.root, relative))
    assert.equal(stat.mode & 0o777, 0o700)
    assert.equal(stat.uid, process.getuid!())
  }
  await f.verified(); await removeProviderState(f.root, f.launchAttemptId)
  await assert.rejects(lstat(prepared.root), { code: "ENOENT" })
})

test("launch environment preserves only the exact fixed Git system-config exclusion", () => {
  const fixed = { ...policy.fixed, GIT_DIR: "/unrelated", GIT_WORK_TREE: "/unrelated", GIT_CONFIG_SYSTEM: "/unrelated", GIT_CONFIG_GLOBAL: "/unrelated", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG: "/unrelated", GIT_EXEC_PATH: "/unrelated", NODE_OPTIONS: "--inspect", NODE_PATH: "/unrelated", AGENCY_TEST: "1" }
  const environment = resolvedLaunchEnvironment("/private/attempt", { ...policy, fixed })
  assert.deepEqual(Object.keys(environment).filter(key => key.startsWith("GIT_")), ["GIT_CONFIG_NOSYSTEM"])
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1")
  assert.equal(environment.HOME, "/private/attempt/home")
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "AGENCY_TEST"]) assert.equal(Object.hasOwn(environment, key), false)
  for (const value of ["", "0", "true", "01", "1 "]) {
    assert.throws(() => resolvedLaunchEnvironment("/private/attempt", { ...policy, fixed: { ...policy.fixed, GIT_CONFIG_NOSYSTEM: value } }), { code: "CLEANUP_UNVERIFIED" })
  }
})

test("cleanup refuses a substituted state root", async t => {
  const f = await stateFixture(t)
  const prepared = await prepareProviderState(f.root, f.launchAttemptId, f.policy)
  await f.verified(); await rename(prepared.root, prepared.root + "-old")
  await symlink(f.unrelated, prepared.root)
  await assert.rejects(removeProviderState(f.root, f.launchAttemptId), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(await readFile(join(f.unrelated, "sentinel"), "utf8"), "retain")
})

test("cleanup never removes a root substituted between verification and quarantine", async t => {
  const f = await stateFixture(t)
  const prepared = await prepareProviderState(f.root, f.launchAttemptId, f.policy)
  await f.verified()
  let entered!: () => void, release!: () => void
  const quarantineEntered = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const removing = removeProviderState(f.root, f.launchAttemptId, { beforeQuarantineRename: async () => { entered(); await released } })
  await quarantineEntered
  await rename(prepared.root, prepared.root + "-old")
  await rename(f.unrelated, prepared.root)
  release()
  await assert.rejects(removing, { code: "CLEANUP_UNVERIFIED" })
  const quarantined = (await readdir(join(f.root, "agents/provider-state"))).find(name => name.startsWith(".cleanup-"))
  assert.ok(quarantined)
  assert.equal(await readFile(join(f.root, "agents/provider-state", quarantined, "sentinel"), "utf8"), "retain")
})

test("failed parent sync after removal retains pending evidence instead of completed evidence", async t => {
  const f = await stateFixture(t)
  const prepared = await prepareProviderState(f.root, f.launchAttemptId, f.policy)
  await f.verified()
  await assert.rejects(removeProviderState(f.root, f.launchAttemptId, { afterQuarantineRemoval: async () => { throw new Error("parent sync failed") } }), { code: "CLEANUP_UNVERIFIED" })
  await assert.rejects(lstat(prepared.root), { code: "ENOENT" })
  assert.deepEqual((await readdir(join(f.root, "agents/provider-state"))).sort(), [`.cleanup-${f.launchAttemptId}.pending.json`])
})

for (const defect of ["missing-marker", "symlink-child", "public-child", "unexpected-root"] as const) {
  test(`cleanup retains unsafe provider state: ${defect}`, async t => {
    const f = await stateFixture(t)
    const prepared = await prepareProviderState(f.root, f.launchAttemptId, f.policy)
    await f.verified()
    if (defect === "missing-marker") await rename(join(prepared.root, ".agency-state.json"), join(prepared.root, "marker-old"))
    if (defect === "symlink-child") await symlink(f.unrelated, join(prepared.root, "linked"))
    if (defect === "public-child") { await writeFile(join(prepared.root, "public"), "x"); await chmod(join(prepared.root, "public"), 0o644) }
    if (defect === "unexpected-root") { await rename(prepared.root, prepared.root + "-old"); await mkdir(prepared.root, { mode: 0o700 }) }
    await assert.rejects(removeProviderState(f.root, f.launchAttemptId), { code: "CLEANUP_UNVERIFIED" })
    assert.equal(await readFile(join(f.unrelated, "sentinel"), "utf8"), "retain")
  })
}

test("state path rejects noncanonical attempt IDs", async t => {
  const f = await stateFixture(t)
  for (const attempt of ["../unrelated", randomUUID().toUpperCase(), "not-an-id"]) assert.throws(() => providerStatePath(f.root, attempt))
})

test("private mappings cannot reintroduce blocked process-control keys", async t => {
  const f = await stateFixture(t)
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "AGENCY_TEST", "GIT_DIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT"]) {
    await assert.rejects(prepareProviderState(f.root, f.launchAttemptId, { fixed: {}, private: { [key]: "tmp" } }), { code: "CLEANUP_UNVERIFIED" })
  }
})