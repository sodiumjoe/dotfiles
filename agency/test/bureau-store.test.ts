import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { coreFixture } from "./orchestration-support.js"

const record = (f: Awaited<ReturnType<typeof coreFixture>>) => ({ version: 1 as const, runId: f.input.runId, createCommandId: randomUUID(), root: f.input.agent, objective: "Inspect local work", state: "active" as const, bindingEpoch: randomUUID(), journal: null })

test("Bureau run CAS persists versions and rejects stale replacement", async t => {
  const f = await coreFixture(t), first = record(f)
  await f.store.writeRun(first, null)
  assert.deepEqual(await f.store.readRun(first.runId), first)
  const next = { ...first, state: "cancelled" as const }
  await f.store.writeRun(next, first)
  await assert.rejects(f.store.writeRun(first, first), /CONFLICT/)
  assert.deepEqual(await f.store.readRun(first.runId), next)
})

test("lineage remains immutable across reopen and is absent for roots", async t => {
  const f = await coreFixture(t), value = { runId: f.input.runId, assignmentId: f.input.assignmentId, parent: f.input.agent }
  const child = { ...f.input.agent, agentId: randomUUID() }
  assert.equal(await f.lineage.read(f.input.agent), null)
  await f.lineage.publish(child, value, null)
  await f.lineage.publish(child, value, value)
  await assert.rejects(f.lineage.publish(child, { ...value, assignmentId: randomUUID() }, value), /CONFLICT/)
  f.restart()
  assert.deepEqual(await f.lineage.read(child), value)
  await assert.rejects(f.lineage.publish(f.input.agent, value, null), /CYCLE|INVALID/)
})

test("failed Bureau CAS publication retains the prior readable snapshot", async t => {
  const f = await coreFixture(t), first = record(f)
  await f.store.writeRun(first, null)
  f.failAt("write")
  await assert.rejects(f.store.writeRun({ ...first, objective: "changed" }, first), /ENOSPC/)
  assert.deepEqual(await f.store.readRun(first.runId), first)
})

test("Bureau and lineage schemas reject credentials and forged host identities", async t => {
  const f = await coreFixture(t), first = record(f)
  await assert.rejects(f.store.writeRun({ ...first, environment: { TOKEN: "secret" } } as typeof first, null))
  await assert.rejects(f.store.writeRun({ ...first, root: { ...first.root, hostId: "host" } }, null))
  await assert.rejects(f.lineage.publish(f.input.agent, { runId: f.input.runId, assignmentId: f.input.assignmentId, parent: { hostId: "host", agentId: randomUUID() } }, null))
})