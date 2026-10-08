import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { createHostInventory, parseHostEnrollment } from "../src/bureau/hosts.js"
import { inspectReadiness } from "../src/bureau/readiness.js"
import { connectHost } from "../src/bridge/ssh.js"
import { bridgeFixture } from "./bridge-support.js"

test("enrollment persists trusted identities without silently adopting hostname replacements", async t => {
  const root = await mkdtemp(join(realpathSync("/tmp"), "agy-host-")); t.after(() => rm(root, { recursive: true, force: true }))
  const f = bridgeFixture(t), inventory = createHostInventory(root)
  await inventory.enroll(f.enrollment); assert.deepEqual(await createHostInventory(root).list(), [f.enrollment])
  await assert.rejects(inventory.enroll({ ...f.enrollment, hostId: f.second.hostId }), /HOST_IDENTITY_CHANGED/)
  await assert.rejects(inventory.enroll({ ...f.second, hostname: f.enrollment.hostname }), /HOSTNAME_CONFLICT/)
  assert.deepEqual(await inventory.list(), [f.enrollment]); assert.throws(() => parseHostEnrollment({ ...f.enrollment, environment: { TOKEN: "secret" } }))
})

test("identical local agent IDs remain distinct across enrolled hosts", async t => {
  const f = bridgeFixture(t), first = await connectHost(f.enrollment, f.spawn)
  t.after(() => first.close()); f.setHost(f.second.hostId)
  const second = await connectHost(f.second, f.spawn); t.after(() => second.close())
  const agents = [...first.snapshot.agents, ...second.snapshot.agents]
  assert.equal(agents[0]?.agent.agentId, agents[1]?.agent.agentId); assert.notEqual(agents[0]?.agent.hostId, agents[1]?.agent.hostId)
})

test("readiness retains independent unavailable and unknown observations with source time", async () => {
  const result = await inspectReadiness({ observedAt: 123, cwd: async () => "ready", model: async () => "unavailable", tools: async () => "ready", git: async () => { throw new Error("offline") } })
  assert.deepEqual(result, { observedAt: 123, ready: false, checks: { cwd: "ready", model: "unavailable", tools: "ready", git: "unknown" } })
})