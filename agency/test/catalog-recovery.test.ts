import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { once } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { randomUUID } from "node:crypto"
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
import test, { type TestContext } from "node:test"
import { digest } from "../src/catalog/config.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { runControl } from "../src/cli/control.js"
import { writeHandlerRecord, writeLaunchRecord, readLaunchRecord } from "../src/platform/private-state.js"
import * as privateState from "../src/platform/private-state.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import * as singleton from "../src/platform/singleton.js"
import type { HandlerEnvironment } from "../src/handler/environment.js"
import type { HandlerGenerationRecord, ManagedLaunchRecord, ProcessIdentity } from "../src/platform/types.js"
import { privateRoot, unavailableControlDependencies } from "./control-support.js"
import { gate } from "./catalog-support.js"

type Request = { attemptId: string; handlerGeneration: string; sha256: string }
type FileSystem = { open: typeof open; rename: typeof rename; mkdir: typeof mkdir; rm: typeof rm }
type Dependencies = { filesystem?: FileSystem; boundary?: (name: string) => Promise<void> }
type Result = { state: "cleanup_verified"; attemptId: string; archivePath: string; sha256: string }
type Recover = (env: HandlerEnvironment, request: Request, dependencies?: Dependencies) => Promise<Result>
async function operation(): Promise<Recover> {
  const module = await import("../src/catalog/" + "recovery.js").catch(() => null)
  assert.equal(typeof module?.recoverCatalogProbe, "function", "offline recovery operation must exist")
  return module!.recoverCatalogProbe as Recover
}

async function fixture(t: TestContext) {
  const root = await privateRoot(t), base = join(root, "agency"), host = "a".repeat(64)
  const state = join(base, "hosts", host), runtime = join(root, "runtime")
  for (const path of [base, join(base, "hosts"), state, runtime]) await mkdir(path, { mode: 0o700 })
  const generation = randomUUID(), attemptId = randomUUID(), commandId = randomUUID(), handlerAttempt = randomUUID()
  const handlerIdentity: ProcessIdentity = { bootId: "boot", pid: 20001, birth: `100:agy-handler:${handlerAttempt}`, parentPid: 1, processGroupId: 20001, sessionId: 20001, uid: process.getuid!(), gid: process.getgid!() }
  const leader: ProcessIdentity = { ...handlerIdentity, pid: 20002, birth: `101:agy-provider:${attemptId}`, parentPid: 20001, processGroupId: 20002, sessionId: 20002 }
  const helper: ProcessIdentity = { ...leader, pid: 20003, birth: "102:unmarked:helper", parentPid: 20002 }
  const launch: ManagedLaunchRecord = { version: 2, owner: { kind: "catalog-probe", providerId: "codex-acp", commandId }, handlerGeneration: generation, launchAttemptId: attemptId, launchBootId: "boot", launchAttempted: true, phase: "quarantined", provider: { kind: "process-group", group: { leader, observed: [leader, helper] } }, reason: "process-group identity changed after SIGTERM" }
  const handler: HandlerGenerationRecord = { version: 1, hostId: host, launchBootId: "boot", generation, launchAttemptId: handlerAttempt, launchAttempted: true, phase: "ready", process: handlerIdentity, socketPath: join(runtime, "handler.sock"), writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null }
  const store = createCatalogStore(state)
  await store.writeAutomatic({ version: 1, commandId, hostId: host, handlerGeneration: generation, batchId: randomUUID(), fingerprints: [{ providerId: "codex-acp", fingerprint: "b".repeat(64) }], attempts: [{ providerId: "codex-acp", attemptId }], state: "pending", snapshotId: null }, null)
  const pending = (await store.readAutomatic(commandId))!
  await store.writeAutomatic({ ...pending, state: "interrupted" }, pending)
  await store.writeProbeMeta({ version: 3, receiptKind: "automatic", hostId: host, handlerGeneration: generation, commandId, providerId: "codex-acp", attemptId, fingerprint: "b".repeat(64), workPath: join(state, "catalog/work", attemptId) })
  await mkdir(join(state, "catalog/probe-launches"), { mode: 0o700 })
  const path = join(state, "catalog/probe-launches", attemptId + ".json")
  await writeLaunchRecord(path, launch)
  await writeHandlerRecord(join(runtime, "handler.json"), handler)
  const processes = new Map<number, ProcessIdentity>(), calls: number[] = [], groups: number[] = [], signals: string[] = []
  const env: HandlerEnvironment = { paths: { hostKey: host, persistentRoot: state, runtimeRoot: runtime, handlerSocketPath: handler.socketPath }, adapter: { platform: process.platform as "darwin" | "linux", bootId: async () => "boot", readProcess: async pid => { calls.push(pid); return processes.get(pid) ?? null }, readGroup: async pid => { groups.push(pid); return [] }, signalGroup: async (_pid, signal) => { signals.push(signal); throw new Error("recovery may not signal") } } }
  const bytes = await readFile(path), request = { attemptId, handlerGeneration: generation, sha256: digest(bytes) }
  const archive = join(base, "recovery", host, attemptId)
  return { root, state, runtime, path, env, request, archive, bytes, commandId, launch, handler, handlerIdentity, leader, helper, processes, calls, groups, signals }
}

test("recovery archives exact evidence and clears only one verified-absent probe", async t => {
  const f = await fixture(t), recover = await operation()
  const result = await recover(f.env, f.request)
  assert.deepEqual(result, { state: "cleanup_verified", attemptId: f.request.attemptId, archivePath: f.archive, sha256: f.request.sha256 })
  assert.deepEqual(await readLaunchRecord(f.path), { ...f.launch, phase: "cleanup_verified", reason: null })
  assert.deepEqual(await readFile(join(f.archive, "launch.json")), f.bytes)
  for (const [file, source] of [["metadata.json", join(f.state, "catalog/probe-meta", f.request.attemptId + ".json")], ["command.json", join(f.state, "catalog/automatic", f.commandId + ".json")], ["handler.json", join(f.runtime, "handler.json")]]) assert.deepEqual(await readFile(join(f.archive, file!)), await readFile(source!))
  const manifest = JSON.parse(await readFile(join(f.archive, "manifest.json"), "utf8"))
  assert.equal(manifest.files["launch.json"], f.request.sha256)
  assert.equal(manifest.hostId, f.env.paths.hostKey)
  assert.equal(manifest.handlerGeneration, f.request.handlerGeneration)
  assert.equal(f.calls.filter(pid => pid === f.leader.pid).length >= 2, true)
  assert.equal(f.calls.filter(pid => pid === f.helper.pid).length >= 2, true)
  assert.deepEqual(f.groups, [20002, 20002])
  assert.deepEqual(f.signals, [])
  assert.deepEqual((await createCatalogStore(f.state).inventory()).issues, [])
})

test("the next Handler reconciler must accept the recovered evidence", async t => {
  const f = await fixture(t), recover = await operation()
  await recover(f.env, f.request)
  assert.equal((await reconcileRecord(f.path, f.env.adapter, await readLaunchRecord(f.path))).record.phase, "cleanup_verified")
})

test("recovery rejects retained groups that omit the leader or contain duplicate PIDs", async t => {
  for (const fault of ["missing-leader", "duplicate-pid"]) await t.test(fault, async t => {
    const f = await fixture(t), recover = await operation()
    f.launch.provider!.group.observed = fault === "missing-leader" ? [f.helper] : [f.leader, f.helper, f.leader]
    await writeLaunchRecord(f.path, f.launch)
    const before = await readFile(f.path)
    f.request.sha256 = digest(before)
    await assert.rejects(recover(f.env, f.request))
    assert.deepEqual(await readFile(f.path), before)
  })
})

test("recovery refuses ownership evidence changed while replacement bytes are being fsynced", async t => {
  for (const fault of ["metadata", "command", "handler"]) await t.test(fault, async t => {
    const f = await fixture(t), recover = await operation()
    const target = fault === "metadata" ? join(f.state, "catalog/probe-meta", f.request.attemptId + ".json") : fault === "command" ? join(f.state, "catalog/automatic", f.commandId + ".json") : join(f.runtime, "handler.json")
    const filesystem: FileSystem = { mkdir, rename, rm, open: async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).startsWith(dirname(f.path)) && String(args[0]).endsWith(".tmp")) return new Proxy(handle, { get(targetHandle, key) { if (key === "sync") return async () => { await targetHandle.sync(); await writeFile(target, "{}") }; const value = Reflect.get(targetHandle, key); return typeof value === "function" ? value.bind(targetHandle) : value } }) as FileHandle
      return handle
    } }
    await assert.rejects(recover(f.env, f.request, { filesystem }))
    assert.deepEqual(await readFile(f.path), f.bytes)
  })
})

test("recovery rejects live, stopped, or reused Handler PIDs without trusting stale classification", async t => {
  for (const birth of ["live", "stopped", "reused"]) await t.test(birth, async t => {
    const f = await fixture(t), recover = await operation()
    f.processes.set(f.handlerIdentity.pid, birth === "reused" ? { ...f.handlerIdentity, birth: "999:unmarked:other" } : f.handlerIdentity)
    await assert.rejects(recover(f.env, f.request))
    assert.deepEqual(await readFile(f.path), f.bytes)
    assert.deepEqual(f.signals, [])
  })
})

test("recovery rejects live or reused providers, detached helpers, nonempty groups, and observation failures in either pass", async t => {
  for (const fault of ["leader", "reused", "detached", "group", "process-error", "group-error", "boot-error", "boot-changed"]) for (const pass of [1, 2]) await t.test(`${fault} pass ${pass}`, async t => {
    const f = await fixture(t), recover = await operation(), read = f.env.adapter.readProcess, group = f.env.adapter.readGroup
    let leaderReads = 0, groupReads = 0, bootReads = 0
    f.env.adapter.bootId = async () => { bootReads++; if (bootReads >= pass && fault === "boot-error") throw new Error("boot observation failed"); return bootReads >= pass && fault === "boot-changed" ? "other" : "boot" }
    f.env.adapter.readProcess = async pid => {
      if (pid === f.leader.pid) leaderReads++
      if (leaderReads === pass) {
        if (pid === f.leader.pid && fault === "leader") return f.leader
        if (pid === f.leader.pid && fault === "reused") return { ...f.leader, birth: "999:unmarked:other" }
        if (pid === f.helper.pid && fault === "detached") return { ...f.helper, processGroupId: 99999 }
        if (pid === f.helper.pid && fault === "process-error") throw new Error("process observation failed")
      }
      return read(pid)
    }
    f.env.adapter.readGroup = async pid => { groupReads++; if (groupReads === pass && fault === "group") return [f.helper]; if (groupReads === pass && fault === "group-error") throw new Error("group observation failed"); return group(pid) }
    await assert.rejects(recover(f.env, f.request))
    assert.deepEqual(await readFile(f.path), f.bytes)
    assert.deepEqual(f.signals, [])
  })
})

test("recovery rejects invalid associations and incomplete ownership", async t => {
  for (const fault of ["host", "generation", "boot", "metadata", "command", "pending-command", "no-handler", "no-provider", "unattempted", "owner", "marker", "uid", "group", "conflicting-pid", "legacy"]) await t.test(fault, async t => {
    const f = await fixture(t), recover = await operation()
    if (fault === "host") f.env.paths.hostKey = "c".repeat(64)
    if (fault === "generation") f.request.handlerGeneration = randomUUID()
    if (fault === "boot") f.env.adapter.bootId = async () => "new-boot"
    if (fault === "metadata") await writeFile(join(f.state, "catalog/probe-meta", f.request.attemptId + ".json"), "{}")
    if (fault === "command") await rm(join(f.state, "catalog/automatic", f.commandId + ".json"))
    if (fault === "pending-command") { const path = join(f.state, "catalog/automatic", f.commandId + ".json"), value = JSON.parse(await readFile(path, "utf8")); value.state = "pending"; await writeFile(path, JSON.stringify(value)) }
    if (fault === "no-handler") await writeHandlerRecord(join(f.runtime, "handler.json"), { ...f.handler, phase: "launch_pending", writer: "launcher", process: null, reconciliation: null })
    const mutated = JSON.parse(f.bytes.toString())
    if (fault === "no-provider") mutated.provider = null
    if (fault === "unattempted") mutated.launchAttempted = false
    if (fault === "owner") mutated.owner.commandId = randomUUID()
    if (fault === "marker") mutated.provider.group.leader.birth = "101:unmarked:foreign"
    if (fault === "uid") mutated.provider.group.observed[0].uid++
    if (fault === "group") mutated.provider.group.leader.processGroupId++
    if (fault === "conflicting-pid") mutated.provider.group.observed.push({ ...mutated.provider.group.leader, birth: "333:unmarked:other" })
    if (fault === "legacy") { delete mutated.owner; mutated.version = 1; mutated.checkoutId = "legacy"; mutated.leaseId = randomUUID(); mutated.agentId = randomUUID() }
    await writeFile(f.path, JSON.stringify(mutated))
    f.request.sha256 = digest(await readFile(f.path))
    const before = await readFile(f.path)
    await assert.rejects(recover(f.env, f.request))
    assert.deepEqual(await readFile(f.path), before)
  })
})

test("recovery rejects unsafe paths, changed digests, and conflicting archives", async t => {
  for (const fault of ["symlink", "hardlink", "public-file", "public-directory", "wrong-digest", "archive-conflict", "archive-symlink", "changed-record", "changed-metadata", "changed-handler"]) await t.test(fault, async t => {
    const f = await fixture(t), recover = await operation()
    if (fault === "symlink") { await rename(f.path, f.path + ".original"); await symlink(f.path + ".original", f.path) }
    if (fault === "hardlink") await link(f.path, join(f.root, "hardlink"))
    if (fault === "public-file") await chmod(f.path, 0o644)
    if (fault === "public-directory") await chmod(dirname(f.path), 0o755)
    if (fault === "wrong-digest") f.request.sha256 = "d".repeat(64)
    if (fault.startsWith("archive-")) { await mkdir(dirname(f.archive), { recursive: true, mode: 0o700 }); if (fault === "archive-symlink") await symlink(f.root, f.archive); else { await mkdir(f.archive, { mode: 0o700 }); await writeFile(join(f.archive, "launch.json"), "conflict", { mode: 0o600 }) } }
    const before = await readFile(f.path)
    await assert.rejects(recover(f.env, f.request, { boundary: async name => {
      if (name !== "before_publish") return
      if (fault === "changed-record") await writeFile(f.path, f.bytes.toString() + " ")
      if (fault === "changed-metadata") await writeFile(join(f.state, "catalog/probe-meta", f.request.attemptId + ".json"), "{}")
      if (fault === "changed-handler") await writeHandlerRecord(join(f.runtime, "handler.json"), { ...f.handler, generation: randomUUID() })
    } }))
    if (fault !== "changed-record") assert.deepEqual(await readFile(f.path), before)
    else assert.equal((await readLaunchRecord(f.path)).phase, "quarantined")
  })
})

test("recovery survives archive-only and post-replacement crashes with evidence-checked retries", async t => {
  for (const boundary of ["archive_durable", "record_published"]) await t.test(boundary, async t => {
    const f = await fixture(t), recover = await operation()
    await assert.rejects(recover(f.env, f.request, { boundary: async name => { if (name === boundary) throw new Error("simulated crash") } }), /simulated crash/)
    assert.deepEqual(await readFile(join(f.archive, "launch.json")), f.bytes)
    assert.equal((await readLaunchRecord(f.path)).phase, boundary === "archive_durable" ? "quarantined" : "cleanup_verified")
    f.calls.length = 0
    assert.equal((await recover(f.env, f.request)).state, "cleanup_verified")
    assert.equal(f.calls.filter(pid => pid === f.helper.pid).length >= 2, true)
    const archived = await readFile(join(f.archive, "launch.json"))
    await writeFile(join(f.archive, "launch.json"), archived.toString() + " ")
    await assert.rejects(recover(f.env, f.request))
  })
})

test("recovery cannot clear quarantine when an evidence fsync fails", async t => {
  const f = await fixture(t), recover = await operation()
  const filesystem: FileSystem = { open: async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).endsWith("metadata.json")) return new Proxy(handle, { get(target, key) { if (key === "sync") return async () => { throw new Error("evidence fsync failed") }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value } }) as FileHandle
    return handle
  }, rename, rm, mkdir }
  await assert.rejects(recover(f.env, f.request, { filesystem }), /fsync/)
  assert.deepEqual(await readFile(f.path), f.bytes)
})

test("recovery refuses an archive changed after durable verification", async t => {
  const f = await fixture(t), recover = await operation()
  await assert.rejects(recover(f.env, f.request, { boundary: async name => {
    if (name === "before_publish") await writeFile(join(f.archive, "launch.json"), f.bytes.toString() + " ")
  } }))
  assert.deepEqual(await readFile(f.path), f.bytes)
})

test("publication failures before and after each rename preserve an evidence-checked retry path", async t => {
  for (const target of ["archive", "record"]) for (const moment of ["before", "after"]) await t.test(`${target} ${moment}`, async t => {
    const f = await fixture(t), recover = await operation()
    const filesystem: FileSystem = { open, mkdir, rm, rename: async (source, destination) => {
      if (destination === (target === "archive" ? f.archive : f.path)) {
        if (moment === "after") await rename(source, destination)
        throw new Error("rename boundary failure")
      }
      await rename(source, destination)
    } }
    await assert.rejects(recover(f.env, f.request, { filesystem }), /rename boundary/)
    assert.equal((await readLaunchRecord(f.path)).phase, target === "record" && moment === "after" ? "cleanup_verified" : "quarantined")
    assert.equal((await recover(f.env, f.request)).state, "cleanup_verified")
    assert.deepEqual(await readFile(join(f.archive, "launch.json")), f.bytes)
  })
})

test("a directory fsync failure after replacement is not reported as success", async t => {
  const f = await fixture(t), recover = await operation()
  const filesystem: FileSystem = { mkdir, rename, rm, open: async (...args) => {
    const handle = await open(...args)
    if (args[0] === dirname(f.path)) return new Proxy(handle, { get(target, key) { if (key === "sync") return async () => { throw new Error("record directory fsync failed") }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value } }) as FileHandle
    return handle
  } }
  await assert.rejects(recover(f.env, f.request, { filesystem }), /fsync/)
  assert.deepEqual(await readFile(join(f.archive, "launch.json")), f.bytes)
  assert.equal((await readLaunchRecord(f.path)).phase, "cleanup_verified")
  assert.equal((await recover(f.env, f.request)).state, "cleanup_verified")
})

test("checked launch publication rejects changes made while its replacement is being fsynced", async t => {
  const f = await fixture(t)
  const replace = Reflect.get(privateState, "writeLaunchRecordExpected") as ((path: string, record: ManagedLaunchRecord, expected: Buffer, filesystem: Pick<FileSystem, "open" | "rename" | "rm">) => Promise<void>) | undefined
  assert.equal(typeof replace, "function", "maintenance publication must compare expected raw bytes")
  const changed = Buffer.from(f.bytes.toString() + " ")
  await assert.rejects(replace!(f.path, { ...f.launch, phase: "cleanup_verified", reason: null }, f.bytes, {
    open: async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith(".tmp")) return new Proxy(handle, { get(target, key) { if (key === "sync") return async () => { await target.sync(); await writeFile(f.path, changed) }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value } }) as FileHandle
      return handle
    }, rename, rm,
  }))
  assert.deepEqual(await readFile(f.path), changed)
})

test("offline maintenance holds the startup lock and releases it on failure", async t => {
  const f = await fixture(t), acquired = gate(), release = gate()
  const withLock = Reflect.get(singleton, "withStartupLock") as ((options: { root: string; adapter: HandlerEnvironment["adapter"]; lockTimeoutSeconds?: number }, work: () => Promise<void>) => Promise<void>) | undefined
  assert.equal(typeof withLock, "function", "offline maintenance requires a startup-lock scope")
  const held = withLock!({ root: f.runtime, adapter: f.env.adapter }, async () => { acquired.resolve(); await release.promise; throw new Error("callback failure") })
  const failed = assert.rejects(held, /callback failure/)
  await acquired.promise
  const recover = await operation()
  await assert.rejects(recover(f.env, f.request, { boundary: async () => undefined }), /lock/)
  release.resolve()
  await failed
  assert.equal((await recover(f.env, f.request)).state, "cleanup_verified")
})

test("recovery cannot publish after its startup-lock holder dies", async t => {
  const f = await fixture(t), recover = await operation(), spawn = childProcess.spawn
  let holder: ReturnType<typeof spawn> | undefined
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => { holder = spawn(...args); return holder }) as typeof spawn
  syncBuiltinESMExports()
  t.after(() => { childProcess.spawn = spawn; syncBuiltinESMExports() })
  await assert.rejects(recover(f.env, f.request, { boundary: async name => {
    if (name !== "archive_durable") return
    assert.ok(holder)
    const exited = once(holder, "exit")
    holder.kill("SIGKILL")
    await exited
  } }), /lock/)
  assert.deepEqual(await readFile(f.path), f.bytes)
})

test("the recovery CLI remains offline and rejects missing or duplicate targeting flags", async t => {
  const f = await fixture(t), out: string[] = []
  const deps = { ...unavailableControlDependencies(), environment: async () => f.env, stdout: (text: string) => { out.push(text) } }
  assert.equal(await runControl(["model", "recover-probe", "--attempt-id", f.request.attemptId, "--handler-generation", f.request.handlerGeneration, "--sha256", f.request.sha256, "--json"], deps), 0)
  assert.equal(JSON.parse(out.join("")).result.state, "cleanup_verified")
  for (const args of [[], ["--attempt-id", "../escape"], ["--attempt-id", f.request.attemptId, "--attempt-id", f.request.attemptId]]) {
    let resolved = false
    assert.equal(await runControl(["model", "recover-probe", ...args, "--json"], { ...deps, environment: async () => { resolved = true; return f.env } }), 64)
    assert.equal(resolved, false)
  }
})