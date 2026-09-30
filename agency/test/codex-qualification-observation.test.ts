import assert from "node:assert/strict"
import { test } from "node:test"
import { verifyQualificationAbsence } from "../scripts/qualification-observation.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const handler: ProcessIdentity = { bootId: "boot", pid: 100, birth: "1:handler", parentPid: 90, processGroupId: 100, sessionId: 100, uid: 501, gid: 20 }
const leader: ProcessIdentity = { ...handler, pid: 200, birth: "2:provider", parentPid: 100, processGroupId: 200, sessionId: 200 }
const child: ProcessIdentity = { ...leader, pid: 201, birth: "3:child", parentPid: 200 }
const group = { leader, observed: [leader] }
const processes = [handler, leader, child]
const live: PlatformAdapter = { platform: "darwin", async bootId() { return "boot" }, async readProcess(pid) { return processes.find(p => p.pid === pid) ?? null }, async readGroup(pid) { return processes.filter(p => p.processGroupId === pid) }, async signalGroup() { throw new Error("no signals authorized") } }

const absent = { ...live, async readProcess(_pid: number) { return null }, async readGroup(_pid: number) { return [] } }

test("parent absence verifies all exact identities in two passes under one budget", async () => {
  const calls: string[] = []
  const adapter = { ...absent, async readProcess(pid: number) { calls.push(`process:${pid}`); return null }, async readGroup(pid: number) { calls.push(`group:${pid}`); return [] } }
  const result = await verifyQualificationAbsence(adapter, [handler], { leader, observed: [leader, child] }, 80)
  assert.equal(result.outcome, "completed"); assert.equal(result.passes, 2)
  assert.equal(result.handler, "absent"); assert.equal(result.provider, "absent")
  for (const key of ["group:100", "group:200", "process:100", "process:200", "process:201"]) assert.equal(calls.filter(c => c === key).length, 2)
  assert.ok(result.durationMs < result.limitMs)
})

test("delayed parent absence reads cannot reset the budget between passes", async () => {
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 55))
  const adapter = { ...absent, async readProcess(_pid: number) { await pause(); return null }, async readGroup(_pid: number) { await pause(); return [] } }
  const result = await verifyQualificationAbsence(adapter, [handler], { leader, observed: [leader, child] }, 80)
  assert.equal(result.outcome, "timed_out"); assert.equal(result.passes, 1)
  assert.equal(result.handler, "unknown"); assert.equal(result.provider, "unknown")
  assert.ok(result.durationMs < 300)
})

test("never-settling parent absence reads remain unknown and bounded", async () => {
  const result = await verifyQualificationAbsence({ ...absent, readProcess: () => new Promise(() => undefined) }, [handler], group, 40)
  assert.equal(result.outcome, "timed_out"); assert.equal(result.passes, 0)
  assert.equal(result.handler, "unknown"); assert.equal(result.provider, "unknown")
  assert.ok(result.durationMs < 300)
})

test("unavailable parent absence reads do not become process absence", async () => {
  const result = await verifyQualificationAbsence({ ...absent, async readGroup() { throw new Error("unavailable") } }, [handler], group, 80)
  assert.equal(result.outcome, "failed")
  assert.equal(result.handler, "unknown"); assert.equal(result.provider, "unknown")
})

test("parent absence bounds concurrent process observations for large groups", async () => {
  let active = 0, peak = 0
  const members = Array.from({ length: 24 }, (_, index) => ({ ...leader, pid: 200 + index, birth: `${index + 2}:member` }))
  const adapter = { ...absent, async readProcess(_pid: number) { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return null } }
  const result = await verifyQualificationAbsence(adapter, [handler], { leader: members[0]!, observed: members }, 500)
  assert.equal(result.outcome, "completed")
  assert.ok(peak <= 8, `peak concurrent reads: ${peak}`)
})

test("a surviving provider does not erase independently verified Handler absence", async () => {
  const adapter = { ...absent, async readGroup(pid: number) { return pid === 200 ? [leader] : [] }, async readProcess(pid: number) { return pid === 200 ? leader : null } }
  const result = await verifyQualificationAbsence(adapter, [handler], group, 80)
  assert.equal(result.outcome, "failed"); assert.equal(result.passes, 2)
  assert.equal(result.handler, "absent"); assert.equal(result.provider, "present")
})