import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises"
import { join } from "node:path"
import { privateRoot } from "./control-support.js"
import { runLinuxAcceptance, parseLinuxAcceptanceArgs, linuxStackDependencies, type LinuxStackDependencies } from "../scripts/accept-linux-stack.js"
import { captureBuildManifest, publishBuildManifest, verifyBuildManifest } from "../scripts/build-manifest.js"
import { coreFixture } from "./orchestration-support.js"
import type { TestContext } from "node:test"
import type { ProcessIdentity } from "../src/platform/types.js"

const revision = "a".repeat(40)
const owned: ProcessIdentity = { bootId: "boot", pid: 101, birth: "17:agy-handler:fixture", parentPid: 1, processGroupId: 101, sessionId: 101, uid: 501, gid: 20 }
const cases = ["root-tools-report-wait", "notification-admission", "headless-permission", "shared-observers-detach-cancel", "handler-reconcile-restore", "editor-replacement"]
async function fixture(t: Parameters<typeof privateRoot>[0]) {
  const root = await privateRoot(t), fixtureRoot = await privateRoot(t), evidenceRoot = join(root, "evidence")
  await mkdir(evidenceRoot, { mode: 0o700 })
  const state = { executed: 0, reads: 0, fail: false, skipped: false, missing: false, survivor: false, unreadable: false, groupSurvivor: false, mixed: false, dirty: false }
  const deps: LinuxStackDependencies = {
    platform: "linux",
    async runtime() { return "v24.13.0" },
    async provenance() { return { revision, dirty: state.dirty, sourceDigest: "1".repeat(64), distDigest: "2".repeat(64), verified: !state.mixed } },
    async execute() { state.executed++; return { exitCode: state.fail ? 1 : 0, cases: cases.slice(state.missing ? 1 : 0).map(name => ({ name, passed: !state.fail, skipped: state.skipped })), owned: [owned], cleanupVerified: true } },
    async observe() { state.reads++; if (state.unreadable) throw new Error("procfs unavailable"); return state.survivor ? owned : null },
    async group() { return state.groupSurvivor ? [{ ...owned, pid: 102 }] : [] }
  }
  const input = { revision, nodePath: "/usr/local/bin/node", fixtureRoot, evidenceRoot, scenario: "deterministic" as const }
  return { input, state, deps }
}

test("Linux acceptance rejects Darwin before invoking a process", async t => {
  const f = await fixture(t)
  await assert.rejects(runLinuxAcceptance(f.input, { ...f.deps, platform: "darwin" }), /LINUX_REQUIRED/)
  assert.equal(f.state.executed, 0)
})

test("Linux acceptance refuses a runtime other than the pinned Node version", async t => {
  const f = await fixture(t)
  await assert.rejects(runLinuxAcceptance(f.input, { ...f.deps, runtime: async () => "v24.14.0" }), /NODE_VERSION/)
  assert.equal(f.state.executed, 0)
})

test("Linux acceptance verifies source and build before executing cases", async t => {
  const f = await fixture(t); f.state.mixed = true
  await assert.rejects(runLinuxAcceptance(f.input, f.deps), /MIXED_BUILD/)
  assert.equal(f.state.executed, 0)
})

test("Linux acceptance verifies the supplied revision independently", async t => {
  const f = await fixture(t)
  await assert.rejects(runLinuxAcceptance({ ...f.input, revision: "b".repeat(40) }, f.deps), /REVISION_MISMATCH/)
  assert.equal(f.state.executed, 0)
})

test("Linux acceptance retains content provenance for dirty deterministic source", async t => {
  const f = await fixture(t); f.state.dirty = true
  const result = await runLinuxAcceptance(f.input, f.deps)
  assert.equal(result.success, true)
  assert.equal(result.provenance.dirty, true)
  assert.equal(result.provenance.sourceDigest, "1".repeat(64))
  assert.equal(result.scope, "deterministic")
  assert.deepEqual(result.survivors, [])
  assert.ok(f.state.reads >= 2)
  assert.equal(result.cases.every(value => value.passed && !value.skipped), true)
})

for (const fault of ["fail", "skipped", "missing", "survivor", "unreadable", "groupSurvivor"] as const) test(`Linux acceptance preserves failure evidence for ${fault}`, async t => {
  const f = await fixture(t); f.state[fault] = true
  const result = await runLinuxAcceptance(f.input, f.deps)
  assert.equal(result.success, false)
  const files = await readdir(f.input.evidenceRoot)
  assert.equal(files.length, 1)
  const retained = JSON.parse(await readFile(join(f.input.evidenceRoot, files[0]!, "report.json"), "utf8"))
  assert.equal(retained.success, false)
  assert.notEqual(retained.failure, null)
  if (["survivor", "unreadable", "groupSurvivor"].includes(fault)) assert.equal(retained.survivors.length, 1)
})

test("Linux acceptance refuses live mode without reviewed provider inputs", async t => {
  const f = await fixture(t)
  await assert.rejects(runLinuxAcceptance({ ...f.input, scenario: "live" }, f.deps), /LIVE_CONFIG_REQUIRED/)
  assert.equal(f.state.executed, 0)
})

test("Linux acceptance parser requires explicit canonical paths and revision", () => {
  const args = ["--revision", revision, "--node", "/usr/local/bin/node", "--fixtures", "/tmp/fixtures", "--evidence", "/tmp/evidence", "--scenario", "deterministic"]
  assert.equal(parseLinuxAcceptanceArgs(args).revision, revision)
  for (const invalid of [[], [...args, "--target", "historical"], args.map(v => v === "/tmp/fixtures" ? "relative" : v), args.map(v => v === "/tmp/evidence" ? "/tmp/../evidence" : v), [...args, "--revision", revision]]) assert.throws(() => parseLinuxAcceptanceArgs(invalid), /INVALID_ACCEPTANCE/)
})

test("build provenance rejects changed source and changed compiled bytes", async t => {
  const root = await privateRoot(t)
  for (const dir of ["src", "test", "scripts", "dist/src"]) await mkdir(join(root, dir), { recursive: true, mode: 0o700 })
  await writeFile(join(root, "src/main.ts"), "const n = 1")
  await writeFile(join(root, "dist/src/main.js"), "const n = 1")
  const initial = await captureBuildManifest(root)
  await publishBuildManifest(root, initial)
  assert.equal(await verifyBuildManifest(root), true)
  await writeFile(join(root, "src/main.ts"), "const n = 2")
  assert.equal(await verifyBuildManifest(root), false)
  await writeFile(join(root, "src/main.ts"), "const n = 1")
  await writeFile(join(root, "dist/src/main.js"), "const n = 2")
  assert.equal(await verifyBuildManifest(root), false)
})

test("Linux acceptance does not require ownership of an inherited process group", async t => {
  const f = await fixture(t), endpoint = { ...owned, pid: 102, processGroupId: 900 }
  const result = await runLinuxAcceptance(f.input, { ...f.deps, execute: async () => ({ exitCode: 0, cases: cases.map(name => ({ name, passed: true, skipped: false })), owned: [endpoint], cleanupVerified: true }), group: async () => { throw new Error("unowned group") } })
  assert.equal(result.success, true)
})

test("Linux acceptance fails when execution omits cleanup evidence", async t => {
  const f = await fixture(t), execute = f.deps.execute
  const result = await runLinuxAcceptance(f.input, { ...f.deps, execute: async input => ({ ...await execute(input), cleanupVerified: false }) })
  assert.equal(result.success, false)
  assert.match(result.failure!, /MISSING_CLEANUP_EVIDENCE/)
})

test("Linux acceptance detects a build changed during execution", async t => {
  const f = await fixture(t), execute = f.deps.execute
  const result = await runLinuxAcceptance(f.input, { ...f.deps, execute: async input => { const result = await execute(input); f.state.mixed = true; return result } })
  assert.equal(result.success, false)
  assert.match(result.failure!, /BUILD_CHANGED_DURING_RUN/)
})

test("native acceptance executor retains every actor before fixture deletion", { timeout: 180000 }, async t => {
  const f = await fixture(t), result = await linuxStackDependencies().execute({ ...f.input, nodePath: process.execPath, runDirectory: f.input.evidenceRoot })
  assert.equal(result.exitCode, 0, await readFile(join(f.input.evidenceRoot, "tests.tap"), "utf8"))
  assert.equal(result.cleanupVerified, true, JSON.stringify(result) + "\n" + await readFile(join(f.input.evidenceRoot, "tests.tap"), "utf8"))
  assert.equal(result.cases.length, cases.length)
  assert.ok(result.cases.every(value => value.passed && !value.skipped))
  const events = (await readFile(join(f.input.evidenceRoot, "ownership.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  for (const role of ["handler", "provider", "mcp-helper", "editor", "acp-endpoint"]) {
    const intent = events.find(value => value.type === "intent" && value.role === role)
    assert.ok(intent, role)
    const observed = events.find(value => value.type === "identity" && value.launchId === intent.launchId)
    assert.ok(observed, role)
    assert.ok(events.indexOf(intent) < events.indexOf(observed), role)
    assert.ok(result.owned.some(value => value.pid === observed.identity.pid), role)
  }
  assert.deepEqual(await readdir(f.input.fixtureRoot), [])
})

for (const truncated of [false, true]) test(`Linux acceptance observes retained ownership after executor failure (truncated=${truncated})`, async t => {
  const f = await fixture(t)
  const result = await runLinuxAcceptance(f.input, { ...f.deps, execute: async input => {
    await writeFile(join(input.runDirectory, "ownership.jsonl"), [
      JSON.stringify({ type: "intent", launchId: "handler-1", role: "handler" }),
      JSON.stringify({ type: "spawn", launchId: "handler-1", role: "handler", pid: owned.pid }),
      JSON.stringify({ type: "identity", launchId: "handler-1", role: "handler", identity: owned }),
      truncated ? '{"type":' : ""
    ].join("\n"))
    throw new Error("executor storage failure")
  } })
  assert.equal(result.success, false)
  assert.equal(result.cleanupVerified, false)
  assert.deepEqual(result.owned, [owned])
  assert.ok(f.state.reads >= 2)
  assert.match(result.failure!, /executor storage failure/)
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")).owned, [owned])
})

test("Linux acceptance rejects truncated ownership despite passing cases", async t => {
  const f = await fixture(t), execute = f.deps.execute
  const result = await runLinuxAcceptance(f.input, { ...f.deps, execute: async input => {
    await writeFile(join(input.runDirectory, "ownership.jsonl"), JSON.stringify({ type: "observed", role: "provider-group", identity: owned }) + '\n{"type":')
    return execute(input)
  } })
  assert.equal(result.success, false)
  assert.equal(result.cleanupVerified, false)
  assert.deepEqual(result.owned, [owned])
  assert.ok(f.state.reads >= 2)
  assert.match(result.failure!, /MISSING_CLEANUP_EVIDENCE/)
})

test("orchestration fixture drains registered services before deleting their state", async () => {
  let cleanup: (() => Promise<void>) | undefined, drained = false
  const f = await coreFixture({ after(callback: () => Promise<void>) { cleanup = callback } } as unknown as TestContext)
  f.beforeCleanup(async () => {
    await access(f.root)
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeFile(join(f.root, "last-receipt"), "durable")
    drained = true
  })
  await cleanup!()
  assert.equal(drained, true)
  await assert.rejects(access(f.root), { code: "ENOENT" })
})