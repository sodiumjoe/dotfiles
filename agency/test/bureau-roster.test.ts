import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createBureauRoster } from "../src/bureau/roster.js"
import type { OrchestrationHost, HostSnapshot } from "../src/bureau/host.js"
import type { BureauStore } from "../src/bureau/store.js"

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-roster-")))
  t.after(() => rm(root, { force: true, recursive: true }))
  const generation = randomUUID(), agentId = randomUUID(), runId = randomUUID(), inventoryId = randomUUID(), providerGeneration = randomUUID()
  const parent = { hostId: "a".repeat(64), agentId }, child = { hostId: "b".repeat(64), agentId }
  const snapshots: HostSnapshot[] = [parent, child].map(agent => ({ hostId: agent.hostId, handlerGeneration: generation, backendChoices: ["codex-acp"], receipts: [], replayFences: [],
    agents: [{ agent, execution: { ...agent, handlerGeneration: generation, providerGeneration }, phase: "ready", toolsEnabled: true, lineage: null, membership: { runId, bindingEpoch: randomUUID() }, cwd: "/work", settings: { configValues: { model: "model-a" } } }] }))
  let offline = false, enabled = true, now = 1000
  const hosts = snapshots.map((snapshot, index) => ({ hostId: snapshot.hostId, async snapshot() { if (index === 1 && offline) throw new Error("disconnected"); return structuredClone(snapshot) } })) as OrchestrationHost[]
  const assignmentId = randomUUID(), attemptId = randomUUID(), lineage = { runId, parent, assignmentId }
  snapshots[1]!.agents[0]!.lineage = lineage
  const attempts: any[] = [{ version: 1, ref: { runId, assignmentId, attemptId }, child, lineage, state: "completed", execution: snapshots[1]!.agents[0]!.execution }]
  const assignments: any[] = [{ assignmentId, runId, spec: { description: "Worker task", parent }, activeAttemptId: attemptId }]
  const store = { listAssignments: async () => assignments, listAttempts: async () => attempts, readReport: async () => null } as unknown as BureauStore
  const enrollment = { inventoryId, hostId: child.hostId, hostname: "devbox-b", agyPath: "/opt/agency/agy", loginShell: "/bin/bash" }
  const create = () => createBureauRoster({ root, bureauId: parent.hostId, hosts, store, enabled: () => enabled, enrollments: async () => [enrollment], now: () => now })
  const roster = create()
  return { root, runId, assignments, roster, snapshots, parent, child, attempts, create, generation, inventoryId, offline: (value: boolean) => { offline = value }, enable: (value: boolean) => { enabled = value }, now: (value: number) => { now = value } }
}

test("roster keeps provider, assignment and host states independent and qualifies equal agent IDs", async t => {
  const f = await fixture(t), snapshot = await f.roster.snapshot()
  assert.equal(snapshot.agents.length, 2)
  const child = snapshot.agents.find(row => row.agent.hostId === f.child.hostId)!
  assert.equal(child.providerPhase, "ready"); assert.equal(child.attempt?.state, "completed")
  assert.equal(child.connectivity, "connected"); assert.equal(child.depth, 1)
  assert.equal(child.inventoryId, f.inventoryId); assert.equal(child.dispatchable, true)
  assert.deepEqual(child.parent, f.parent)
})

test("disconnect keeps durable last observations while fencing entry even after clock rollback and restart", async t => {
  const f = await fixture(t), first = await f.roster.snapshot()
  f.offline(true); f.now(500)
  const snapshot = await f.create().snapshot(), child = snapshot.agents.find(row => row.agent.hostId === f.child.hostId)!
  assert.equal(child.providerPhase, "ready"); assert.equal(child.attempt?.state, "completed")
  assert.equal(child.connectivity, "disconnected"); assert.equal(child.observedAt, 1000)
  assert.equal(child.dispatchable, false)
  assert.notEqual(snapshot.generation, first.generation)
  f.offline(false); const recovered = await f.roster.snapshot()
  assert.equal(recovered.agents.find(row => row.agent.hostId === f.child.hostId)!.observedAt, 1000)
  assert.equal(recovered.hosts.find(host => host.hostId === f.child.hostId)!.clockRegressed, true)
})

test("missing parents and cycles remain visible as lineage issues instead of inventing a tree", async t => {
  const f = await fixture(t)
  f.snapshots[1]!.agents[0]!.lineage!.parent = { hostId: f.parent.hostId, agentId: randomUUID() }
  const missing = (await f.roster.snapshot()).agents.find(row => row.agent.hostId === f.child.hostId)!
  assert.equal(missing.lineageIssue, "MISSING_PARENT"); assert.equal(missing.dispatchable, false)
  f.snapshots[1]!.agents[0]!.lineage!.parent = f.child
  const cycle = (await f.roster.snapshot()).agents.find(row => row.agent.hostId === f.child.hostId)!
  assert.equal(cycle.lineageIssue, "LINEAGE_CYCLE"); assert.equal(cycle.dispatchable, false)
})

test("a stale provider execution cannot authorize entry and a disabled Bureau has no fresh roster", async t => {
  const f = await fixture(t)
  f.snapshots[1]!.agents[0]!.execution!.handlerGeneration = randomUUID()
  const row = (await f.roster.snapshot()).agents.find(row => row.agent.hostId === f.child.hostId)!
  assert.equal(row.dispatchable, false)
  f.enable(false); await assert.rejects(f.roster.snapshot(), /BUREAU_DISABLED/)
})

test("foreign run membership and substituted attempt identity cannot authorize entry", async t => {
  const f = await fixture(t)
  f.snapshots[0]!.agents[0]!.membership!.runId = randomUUID()
  const row = (await f.roster.snapshot()).agents.find(row => row.agent.hostId === f.child.hostId)!
  assert.equal(row.lineageIssue, "ASSIGNMENT_MISMATCH"); assert.equal(row.dispatchable, false)
})

test("deep child chains remain host qualified and malformed parent identity disconnects that host", async t => {
  const f = await fixture(t), snapshot = f.snapshots[1]!, template = snapshot.agents[0]!
  let parent = f.child
  for (let depth = 2; depth <= 12; depth++) {
    const agent = { hostId: f.child.hostId, agentId: randomUUID() }, assignmentId = randomUUID(), attemptId = randomUUID(), lineage = { runId: f.runId, parent, assignmentId }
    const execution = { ...agent, handlerGeneration: f.generation, providerGeneration: randomUUID() }
    snapshot.agents.push({ ...template, agent, execution, lineage })
    f.assignments.push({ assignmentId, runId: f.runId, activeAttemptId: attemptId, spec: { parent, description: "Depth " + depth } })
    f.attempts.push({ ref: { runId: f.runId, assignmentId, attemptId }, child: agent, lineage, execution, state: "running" })
    parent = agent
  }
  assert.equal((await f.roster.snapshot()).agents.find(row => row.agent.agentId === parent.agentId)!.depth, 12)
  snapshot.agents[0]!.lineage!.parent.hostId = "corrupt"
  const stale = await f.roster.snapshot()
  assert.equal(stale.hosts.find(host => host.hostId === f.child.hostId)!.connectivity, "disconnected")
  assert.equal(stale.agents.filter(row => row.agent.hostId === f.child.hostId).every(row => !row.dispatchable), true)
})