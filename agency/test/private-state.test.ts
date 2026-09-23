import assert from "node:assert/strict"
import { chmod, lstat, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  assertPrivateDirectory,
  readHandlerRecord,
  readLaunchRecord,
  writeHandlerRecord,
  writeLaunchRecord,
} from "../src/platform/private-state.js"
import { RUNTIME_RECORD_VERSION, type HandlerGenerationRecord, type LaunchRecord, type ProcessIdentity } from "../src/platform/types.js"

const processIdentity = {
  bootId: "boot-1",
  pid: 101,
  birth: "birth-101",
  parentPid: 1,
  processGroupId: 101,
  sessionId: 101,
  uid: process.getuid!(),
  gid: process.getgid!(),
} satisfies ProcessIdentity

function launchRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    checkoutId: "checkout-1",
    leaseId: "lease-1",
    agentId: "agent-1",
    handlerGeneration: "generation-1",
    launchAttemptId: "attempt-1",
    launchBootId: "boot-1",
    launchAttempted: true,
    phase: "active",
    provider: {
      kind: "process-group",
      group: { leader: processIdentity, observed: [processIdentity] },
    },
    reason: null,
    ...overrides,
  }
}

function handlerRecord(overrides: Partial<HandlerGenerationRecord> = {}): HandlerGenerationRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    hostId: "host-1",
    launchBootId: "boot-1",
    generation: "generation-1",
    launchAttemptId: "attempt-1",
    launchAttempted: true,
    phase: "ready",
    process: processIdentity,
    socketPath: "/tmp/handler.sock",
    writer: "handler",
    reconciliation: { classified: 2, total: 2, quarantined: 0 },
    reason: null,
    ...overrides,
  }
}

async function createFixture(): Promise<{ directory: string; launchPath: string; handlerPath: string }> {
  const directory = join(await realpath(tmpdir()), `agency-private-${crypto.randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  return { directory, launchPath: join(directory, "launch.json"), handlerPath: join(directory, "handler.json") }
}

test("accepts a private directory owned by the current uid", async t => {
  const { directory } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  await assertPrivateDirectory(directory)
})

test("rejects group or world permissions and symlink roots", async t => {
  const { directory } = await createFixture()
  const link = `${directory}-link`
  t.after(async () => {
    const fs = await import("node:fs/promises")
    await fs.rm(link, { force: true })
    await fs.rm(directory, { recursive: true, force: true })
  })
  await chmod(directory, 0o770)
  await assert.rejects(assertPrivateDirectory(directory), /0700|private|permission/i)
  await chmod(directory, 0o700)
  await symlink(directory, link)
  await assert.rejects(assertPrivateDirectory(link), /symlink|canonical/i)
})

test("rejects unsafe record storage and malformed records", async t => {
  const { directory, launchPath } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  await mkdir(launchPath)
  await assert.rejects(readLaunchRecord(launchPath), /file/i)
  await (await import("node:fs/promises")).rm(launchPath, { recursive: true })
  await writeFile(launchPath, "x".repeat(1024 * 1024 + 1), { mode: 0o600 })
  await assert.rejects(readLaunchRecord(launchPath), /1 MiB|size/i)
  await writeFile(launchPath, "{", { mode: 0o600 })
  await assert.rejects(readLaunchRecord(launchPath), /JSON|parse/i)
  await writeFile(launchPath, JSON.stringify({ ...launchRecord(), version: 2 }), { mode: 0o600 })
  await assert.rejects(readLaunchRecord(launchPath), /version/i)
})

test("publishes complete launch records atomically with private file mode", async t => {
  const { directory, launchPath } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  const oldRecord = launchRecord({ checkoutId: "old" })
  const newRecord = launchRecord({ checkoutId: "new" })
  await writeLaunchRecord(launchPath, oldRecord)
  const observations: string[] = []
  let replacing = true
  const reader = (async () => {
    while (replacing) {
      try {
        observations.push((await readLaunchRecord(launchPath)).checkoutId)
      } catch (error) {
        assert.fail(`reader observed invalid replacement: ${String(error)}`)
      }
    }
  })()
  await writeLaunchRecord(launchPath, newRecord)
  replacing = false
  await reader
  assert.equal((await readLaunchRecord(launchPath)).checkoutId, "new")
  assert.ok(observations.every(value => value === "old" || value === "new"))
  assert.equal((await lstat(launchPath)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(directory), ["launch.json"])
})

test("rejects oversized serialized records without replacing the previous record", async t => {
  const { directory, launchPath } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  const previous = launchRecord({ checkoutId: "previous" })
  await writeLaunchRecord(launchPath, previous)
  await assert.rejects(writeLaunchRecord(launchPath, launchRecord({ checkoutId: "x".repeat(1024 * 1024) })), /1 MiB|size/i)
  assert.deepEqual(await readLaunchRecord(launchPath), previous)
  assert.deepEqual(await readdir(directory), ["launch.json"])
})

test("validates LaunchRecord phase invariants and launch boot identity", async t => {
  const { directory, launchPath } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  const invalid = [
    launchRecord({ launchBootId: "" }),
    launchRecord({ launchAttempted: false, provider: launchRecord().provider }),
    launchRecord({ launchAttempted: false, phase: "cleanup_verified" }),
    launchRecord({ phase: "active", provider: null }),
    launchRecord({ phase: "readiness", provider: null }),
    launchRecord({ phase: "exited_unverified", reason: null }),
    launchRecord({ phase: "exited_unverified", launchAttempted: false, provider: null, reason: "not attempted" }),
    launchRecord({ phase: "cleanup_pending", launchAttempted: false, provider: null }),
    launchRecord({ phase: "cleanup_pending", provider: null }),
    launchRecord({ phase: "quarantined", reason: "" }),
  ]
  for (const record of invalid) await assert.rejects(writeLaunchRecord(launchPath, record), /record|launch|phase|reason|provider/i)
  await writeLaunchRecord(launchPath, launchRecord({ phase: "exited_unverified", provider: null, reason: "handler died" }))
  const exited = await readLaunchRecord(launchPath)
  assert.equal(exited.provider, null)
  assert.equal(exited.reason, "handler died")
  assert.notEqual(exited.phase, "active")
})

test("validates HandlerGenerationRecord ownership and phase invariants", async t => {
  const { directory, handlerPath } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  const valid = [
    handlerRecord({ phase: "launch_pending", launchAttempted: false, process: null, writer: "launcher", reconciliation: null }),
    handlerRecord({ phase: "identity_published", process: processIdentity, writer: "launcher", reconciliation: null }),
    handlerRecord({ phase: "socket_bound", process: processIdentity, writer: "handler", reconciliation: null }),
    handlerRecord({ phase: "reconciling", process: processIdentity, writer: "handler", reconciliation: { classified: 1, total: 2, quarantined: 0 } }),
    handlerRecord(),
  ]
  for (const record of valid) {
    await writeHandlerRecord(handlerPath, record)
    assert.deepEqual(await readHandlerRecord(handlerPath), record)
  }
  const invalid = [
    handlerRecord({ phase: "launch_pending", process: processIdentity, writer: "launcher", reconciliation: null }),
    handlerRecord({ phase: "launch_pending", process: null, writer: "handler", reconciliation: null }),
    handlerRecord({ phase: "identity_published", writer: "handler", reconciliation: null }),
    handlerRecord({ phase: "socket_bound", writer: "launcher", reconciliation: null }),
    handlerRecord({ phase: "socket_bound", reconciliation: { classified: 0, total: 1, quarantined: 0 } }),
    handlerRecord({ phase: "ready", process: null }),
    handlerRecord({ phase: "ready", reconciliation: { classified: 1, total: 2, quarantined: 0 } }),
    handlerRecord({ phase: "ready", reason: "not ready" }),
    handlerRecord({ phase: "identity_published", process: { ...processIdentity, bootId: "boot-2" }, writer: "launcher", reconciliation: null }),
    handlerRecord({ phase: "exited_unverified", writer: "handler", reason: "handler exited" }),
    handlerRecord({ phase: "exited_unverified", writer: "reconciler", reason: "" }),
  ]
  for (const record of invalid) await assert.rejects(writeHandlerRecord(handlerPath, record), /record|handler|phase|writer|reason|process|reconciliation/i)
})

test("exited_unverified preserves exact prior process and reconciliation evidence", async t => {
  const { directory, handlerPath } = await createFixture()
  t.after(async () => (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }))
  const firstWrite = handlerRecord({ phase: "exited_unverified", writer: "reconciler", reason: "handler exited" })
  await assert.rejects(writeHandlerRecord(handlerPath, firstWrite), /prior|existing|evidence/i)
  const previous = handlerRecord()
  await writeHandlerRecord(handlerPath, previous)
  await assert.rejects(writeHandlerRecord(handlerPath, handlerRecord({ phase: "exited_unverified", process: null, writer: "reconciler", reason: "handler exited" })), /process|evidence/i)
  await assert.rejects(writeHandlerRecord(handlerPath, handlerRecord({ phase: "exited_unverified", writer: "reconciler", reconciliation: null, reason: "handler exited" })), /reconciliation|evidence/i)
  await assert.rejects(writeHandlerRecord(handlerPath, handlerRecord({ phase: "exited_unverified", process: { ...processIdentity, parentPid: 999 }, writer: "reconciler", reason: "handler exited" })), /process|evidence/i)
  const preserved = handlerRecord({ phase: "exited_unverified", writer: "reconciler", reason: "handler exited" })
  await writeHandlerRecord(handlerPath, preserved)
  assert.deepEqual(await readHandlerRecord(handlerPath), preserved)
  const previousNull = handlerRecord({ phase: "launch_pending", process: null, writer: "launcher", reconciliation: null })
  await writeHandlerRecord(handlerPath, previousNull)
  const preservedNull = handlerRecord({ phase: "exited_unverified", process: null, writer: "reconciler", reconciliation: null, reason: "handler exited" })
  await writeHandlerRecord(handlerPath, preservedNull)
  assert.deepEqual(await readHandlerRecord(handlerPath), preservedNull)
})