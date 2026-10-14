import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { canonicalDigest } from "../src/orchestration/types.js"
import { createBureauService } from "../src/bureau/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createRemoteOrigins } from "../src/bureau/origins.js"
import { createRemoteHost } from "../src/bureau/remote-host.js"
import { connectHost } from "../src/bridge/task-ssh.js"
import { bridgeFixture } from "./bridge-support.js"
import { bureauFixture } from "./bureau-support.js"

test("an unreachable enrolled host cannot poison a healthy host dispatch", async t => {
  const f = await bureauFixture(t), unreachable = { ...f.host.raw, hostId: "b".repeat(64), async snapshot(): Promise<never> { throw new Error("HOST_UNAVAILABLE") } }
  const healthy = { ...f.host.raw, hostId: f.input.agent.hostId }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), hosts: [unreachable, healthy] })
  f.beforeCleanup(() => core.close())
  await core.initialize(); await core.enable()
  const child = await core.delegate(randomUUID(), f.input.runId, f.input.assignment, f.invocation)
  assert.equal(child.attempt.state, "running")
})

test("connectivity loss preserves the last observed attempt phase", async t => {
  const f = await bureauFixture(t), child = await f.delegate(); let online = true
  const host = { ...f.host.raw, hostId: f.input.agent.hostId, async snapshot() { if (!online) throw new Error("HOST_UNAVAILABLE"); return f.host.raw.snapshot() } }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), hosts: [host] })
  f.beforeCleanup(() => core.close()); await core.initialize(); await core.enable(); online = false
  const view = await core.assignment(child.assignmentId)
  assert.equal(view.attempt.state, "running")
  await assert.rejects(core.delegate(randomUUID(), f.input.runId, f.input.assignment, f.invocation), /HOST_UNAVAILABLE/)
})

test("remote launch strips laptop environment and rejects a retired command before dispatch", async t => {
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn)
  t.after(() => connection.close())
  const requests: unknown[] = []
  f.processes[0]!.peer.onRequest(async (channel, payload) => { if (channel === "snapshot") return connection.snapshot; requests.push(payload); return { commandId: (payload as any).command.commandId, execution: null, effective: null, state: "accepted" } })
  const host = createRemoteHost({ enrollment: f.enrollment, connect: async () => connection })
  const command = { commandId: randomUUID(), runId: randomUUID(), agent: { hostId: f.enrollment.hostId, agentId: randomUUID() }, handlerGeneration: connection.hello.handlerGeneration, bindingEpoch: randomUUID(), cwd: "/workspace", backendId: "codex-acp" as const, modelId: "model-a", overrides: {} }
  await host.launchRoot(command, { environment: { TOKEN: "laptop-secret" }, nativeParams: { mcpServers: [] } })
  assert.equal(JSON.stringify(requests).includes("laptop-secret"), false)
  await assert.rejects(host.launchRoot({ ...command, handlerGeneration: randomUUID() }, { environment: {}, nativeParams: {} }), /STALE_HANDLER/)
  assert.equal(requests.length, 1)
})

for (const outcome of ["report-before-retirement", "retirement-without-report"] as const) test(`remote replay reconciles ${outcome} before classifying attempts`, async t => {
  const f = await bureauFixture(t), child = await f.delegate(), mirror = createRemoteOrigins(f.root, f.input.agent.hostId, f.filesystem)
  const report = { ...child.attempt.ref, commandId: randomUUID(), execution: child.attempt.execution!, report: f.input.report }
  const payload = report, kind = "report-retained", entry = { seq: 1, eventId: report.commandId, kind, payload, digest: canonicalDigest({ kind, payload }) }
  const key = { hostId: f.input.agent.hostId, runId: f.input.runId, streamId: f.input.runId }
  if (outcome === "report-before-retirement") await mirror.import(key, [entry])
  f.host.retire()
  const host = { ...f.host.raw, hostId: key.hostId, async snapshot() { const snapshot = await f.host.raw.snapshot(); return { ...snapshot, replayFences: [{ runId: key.runId, streamId: key.streamId, throughSeq: outcome === "report-before-retirement" ? 1 : 0, checkpoint: 0 }] } } }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), originSources: [mirror], hosts: [host] })
  f.beforeCleanup(() => core.close()); await core.initialize()
  const view = await core.assignment(child.assignmentId)
  assert.equal(view.attempt.state, outcome === "report-before-retirement" ? "completed" : "interrupted")
  if (outcome === "report-before-retirement") { assert.equal((await f.store.readReport(child.attempt.ref.attemptId))?.receipt.state, "accepted"); assert.equal(await mirror.acknowledged(key, entry), true) }
  assert.equal(f.host.promptCount, 1)
})

test("a report received after explicit replacement remains late evidence", async t => {
  const f = await bureauFixture(t), child = await f.delegate(); f.host.retire(); await f.core.reconcile()
  const replacement = await f.core.retry(randomUUID(), child.assignmentId, "replace", f.invocation)
  const mirror = createRemoteOrigins(f.root, f.input.agent.hostId, f.filesystem), report = { ...child.attempt.ref, commandId: randomUUID(), execution: child.attempt.execution!, report: f.input.report }
  const kind = "report-retained", entry = { seq: 1, eventId: report.commandId, kind, payload: report, digest: canonicalDigest({ kind, payload: report }) }
  await mirror.import({ hostId: f.input.agent.hostId, runId: report.runId, streamId: report.runId }, [entry])
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), originSources: [mirror], hosts: [f.host.raw] })
  f.beforeCleanup(() => core.close()); await core.initialize()
  assert.equal((await f.store.readReport(child.attempt.ref.attemptId))?.receipt.state, "late")
  assert.equal((await core.assignment(replacement.assignmentId)).attempt.state, "running")
})

test("a lost origin acknowledgment is retried after durable recipient storage", async t => {
  const f = await bureauFixture(t), bridge = bridgeFixture(t), child = await f.delegate(), mirror = createRemoteOrigins(f.root, bridge.enrollment.hostId, f.filesystem)
  const connection = await connectHost(bridge.enrollment, bridge.spawn), report = { ...child.attempt.ref, commandId: randomUUID(), execution: child.attempt.execution!, report: f.input.report }
  const kind = "report-retained", entry = { seq: 1, eventId: report.commandId, kind, payload: report, digest: canonicalDigest({ kind, payload: report }) }, key = { hostId: bridge.enrollment.hostId, runId: report.runId, streamId: report.runId }
  let attempts = 0
  const snapshot = { ...connection.snapshot, replayFences: [{ runId: key.runId, streamId: key.streamId, throughSeq: 1, checkpoint: 0 }] }
  bridge.processes[0]!.peer.onRequest(async channel => {
    if (channel === "snapshot") return snapshot
    if (channel === "origin-read" || channel === "origin-retained") return { entries: [entry], checkpoint: 0, lastSeq: 1, nextCursor: 1 }
    if (channel === "origin-ack") { attempts++; if (attempts === 1) throw new Error("HOST_UNAVAILABLE"); return { acknowledged: true } }
    throw new Error("unexpected channel")
  })
  const host = createRemoteHost({ enrollment: bridge.enrollment, connect: async () => connection, origins: mirror })
  t.after(() => host.close())
  await host.snapshot()
  assert.equal(attempts, 0)
  await host.originSource!.acknowledge(key, entry)
  assert.equal(await mirror.acknowledged(key, entry), true)
  assert.equal(attempts, 1)
  await host.snapshot()
  assert.equal(attempts, 2)
})

test("remote host accepts tool callbacks on its shared connection", async t => {
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn), calls: unknown[] = []
  const host = createRemoteHost({ enrollment: f.enrollment, connect: async () => connection, onTool: async payload => { calls.push(payload); return { received: true } } })
  t.after(() => host.close()); await host.snapshot()
  const request = { execution: { hostId: f.enrollment.hostId, agentId: randomUUID(), handlerGeneration: connection.hello.handlerGeneration, providerGeneration: randomUUID() }, name: "agency_inspect", args: {} }
  assert.deepEqual(await f.processes[0]!.peer.request("tool", request), { received: true })
  assert.deepEqual(calls, [request])
})

test("snapshot acknowledges mirrored launch evidence but retains unpublished reports", async t => {
  const f = await bureauFixture(t), child = await f.delegate(), bridge = bridgeFixture(t), connection = await connectHost(bridge.enrollment, bridge.spawn)
  const mirror = createRemoteOrigins(f.root, bridge.enrollment.hostId, f.filesystem), key = { hostId: bridge.enrollment.hostId, runId: f.input.runId, streamId: f.input.runId }
  const launch = { commandId: child.attempt.launchCommandId, runId: key.runId, agent: child.agent, execution: child.attempt.execution!, launchAttemptId: randomUUID(), lineage: child.attempt.lineage, attempt: child.attempt.ref, bindingEpoch: f.input.bindingEpoch, invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: child.attempt.effective! }
  const report = { ...child.attempt.ref, commandId: randomUUID(), execution: child.attempt.execution!, report: f.input.report }
  const events = [{ kind: "origin-launch", payload: launch }, { kind: "report-retained", payload: report }].map(({ kind, payload }, index) => ({ seq: index + 1, eventId: payload.commandId, kind, payload, digest: canonicalDigest({ kind, payload }) }))
  const snapshot = { ...connection.snapshot, replayFences: [{ runId: key.runId, streamId: key.streamId, throughSeq: 2, checkpoint: 0 }] }, acks: number[] = [], reads: number[] = []
  bridge.processes[0]!.peer.onRequest(async (channel, raw) => {
    if (channel === "snapshot") return snapshot
    if (channel === "origin-read") { const after = (raw as { after: number }).after; reads.push(after); return { entries: events.filter(entry => entry.seq > after), checkpoint: 0, lastSeq: 2, nextCursor: 2 } }
    if (channel === "origin-ack") { const ref = (raw as { ref: { seq: number } }).ref; acks.push(ref.seq); assert.equal(await mirror.acknowledged(key, events[ref.seq - 1]!), true); return { acknowledged: true } }
    throw new Error("unexpected channel")
  })
  const host = createRemoteHost({ enrollment: bridge.enrollment, connect: async () => connection, origins: mirror })
  t.after(() => host.close())
  await host.snapshot()
  assert.deepEqual(acks, [1])
  assert.equal(await mirror.acknowledged(key, events[1]!), false)
  await host.snapshot()
  assert.deepEqual(reads, [0, 1])
  assert.deepEqual(acks, [1])
})

test("reconnection recovers retained execution evidence without replaying an unobserved prompt", async t => {
  const f = await bureauFixture(t)
  let online = true
  const host = { ...f.host.raw, hostId: f.input.agent.hostId, async snapshot() { if (!online) throw new Error("HOST_UNAVAILABLE"); return f.host.raw.snapshot() }, async launch(command: Parameters<typeof f.host.raw.launch>[0], invocation: Parameters<typeof f.host.raw.launch>[1]) { await f.host.raw.launch(command, invocation); online = false; throw new Error("BRIDGE_EOF") }, async inspectCommand(commandId: string, generation: string) { if (!online) throw new Error("HOST_UNAVAILABLE"); return f.host.raw.inspectCommand(commandId, generation) } }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), hosts: [host] })
  f.beforeCleanup(() => core.close()); await core.initialize(); await core.enable()
  const commandId = randomUUID()
  await assert.rejects(core.delegate(commandId, f.input.runId, f.input.assignment, f.invocation), /HOST_UNAVAILABLE/)
  const retained = await core.command(commandId)
  online = true; await core.reconcile()
  const assignment = await core.assignment(retained.targetId)
  assert.ok(assignment.attempt.execution)
  assert.equal(assignment.attempt.state, "uncertain")
  assert.equal(f.host.promptCount, 0)
  assert.equal(f.host.launchCalls, 2)
})

test("remote submission receipts reject unknown fields before admission is reported", async t => {
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn)
  t.after(() => connection.close())
  f.processes[0]!.peer.onRequest(async channel => { if (channel === "snapshot") return connection.snapshot; return { submissionId: randomUUID(), state: "accepted", environment: { SECRET: "invalid-receipt" } } })
  const host = createRemoteHost({ enrollment: f.enrollment, connect: async () => connection }), target = { hostId: f.enrollment.hostId, agentId: randomUUID(), handlerGeneration: connection.hello.handlerGeneration, providerGeneration: randomUUID() }
  await assert.rejects(host.submit(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "Check receipt" }] }))
})