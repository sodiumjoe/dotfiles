import assert from "node:assert/strict"
import test from "node:test"
import { verifyQualificationAbsence } from "../scripts/qualification-observation.js"
import type { ProcessIdentity } from "../src/platform/types.js"

const leader: ProcessIdentity = { bootId: "boot", pid: 200, birth: "2:provider", parentPid: 100, processGroupId: 200, sessionId: 200, uid: 501, gid: 20 }
const child = { ...leader, pid: 201, birth: "3:child", parentPid: 200 }
const group = { leader, observed: [leader, child] }
const absent = { async readProcess(_pid: number) { return null }, async readGroup(_pid: number): Promise<ProcessIdentity[]> { return [] } }

test("two separated observations retain every exact owned identity", async () => {
  const calls: number[] = []
  const result = await verifyQualificationAbsence({ ...absent, async readProcess(pid) { calls.push(pid); return null } }, group, 1000)
  assert.equal(result.first!.outcome, "absent"); assert.equal(result.second!.outcome, "absent")
  assert.deepEqual(result.first!.identity, group); assert.deepEqual(result.second!.identity, group)
  assert.deepEqual(calls, [200, 201, 200, 201]); assert.ok(result.second!.startedAt >= result.first!.endedAt + 25)
})

for (const pass of [1, 2]) for (const observation of ["group", "process", "unavailable"]) test(`${observation} in pass ${pass} cannot qualify as absence`, async () => {
  let reads = 0
  const result = await verifyQualificationAbsence({
    async readGroup() { reads++; if (reads === pass && observation === "unavailable") throw new Error("missing"); return reads === pass && observation === "group" ? [child] : [] },
    async readProcess(pid) { return reads === pass && observation === "process" && pid === child.pid ? { ...child, processGroupId: 900, sessionId: 900 } : null },
  }, group, 1000)
  assert.notEqual(result[pass === 1 ? "first" : "second"]?.outcome, "absent")
})

test("never settling observations remain bounded and retain missing proof", async () => {
  const started = performance.now()
  const result = await verifyQualificationAbsence({ ...absent, readProcess: () => new Promise(() => undefined) }, group, 60)
  assert.notEqual(result.first?.outcome, "absent"); assert.equal(result.second, null); assert.ok(performance.now() - started < 500)
})