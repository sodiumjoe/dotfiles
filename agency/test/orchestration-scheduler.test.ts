import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { createBureauService } from "../src/bureau/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { notificationsFixture } from "./bureau-notifications-support.js"
import { createConversation } from "../src/agent/conversation.js"
import { createTurnCoordinator } from "../src/agent/turns.js"
import type { AcpSubmissionRequest, SubmissionReceipt } from "../src/agent/turns.js"
import type { AgentRef } from "../src/orchestration/types.js"
import { until } from "./control-support.js"

async function fixture(t: TestContext) {
  const f = await notificationsFixture(t), target = (await f.host.raw.snapshot()).agents.find(agent => agent.agent.agentId === f.parent.agentId)!.execution!
  const conversation = createConversation(target), answer = Promise.withResolvers<Record<string, unknown>>()
  let calls = 0, providerFailure = false, settled: (parent: AgentRef) => void = () => {}
  f.host.raw.onSettled = listener => { settled = listener; return () => { settled = () => {} } }
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, cancel: async () => {}, onSettled: () => settled(f.parent), invokeAcp: async () => { calls++; if (providerFailure) throw new Error("provider failed"); await answer.promise; return { stopReason: "end_turn" } } })
  const original = f.host.raw.submit
  f.host.raw.submit = async (execution, request, admission) => execution.agentId === f.parent.agentId ? (turns.submitAcp as unknown as (request: AcpSubmissionRequest, admission?: () => Promise<void>) => Promise<SubmissionReceipt>)(request, admission) : original(execution, request)
  f.host.raw.submission = async (execution, submissionId) => execution.agentId === f.parent.agentId ? turns.inspect(submissionId) : null
  t.after(() => { turns.close(null); conversation.close() })
  const schedule = () => (f.core as unknown as { schedule(parent: AgentRef): Promise<void> }).schedule(f.parent)
  return { ...f, get core() { return f.core }, schedule, target, turns, answer, get calls() { return calls }, failProvider() { providerFailure = true }, automatic() { f.core.close(); const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), origins: f.origins, hosts: [f.host.raw], notifications: true }); t.after(() => core.close()); return core }, async human() { return turns.submitAcp({ submissionId: randomUUID(), prompt: [{ type: "text", text: "human" }] }) } }
}

test("busy parent keeps a stable queued delivery and batches both reports after idle", async t => {
  const f = await fixture(t), second = await f.delegate(), human = await f.human()
  await f.report(); await f.report(second); await f.schedule()
  assert.equal(f.calls, 1)
  const queued = (await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!
  assert.equal(queued.state, "queued")
  f.answer.resolve({}); await f.turns.settledAcp(human.submissionId)
  await f.schedule()
  assert.equal(f.calls, 2)
  const delivered = (await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!
  assert.equal(delivered.deliveryId, queued.deliveryId)
  assert.equal(delivered.sources.length, 2)
})

test("saved wait delivery suppresses notification prompts", async t => {
  const f = await fixture(t)
  await f.report(); await f.core.wait(f.waitInput); await f.schedule()
  assert.equal(f.calls, 0)
})

test("notification admission waits for durable publication and never steals routing on failure", async t => {
  const f = await fixture(t)
  await f.report()
  f.failAt("file-sync", "/origin-runs/")
  await assert.rejects(f.schedule(), /ENOSPC/)
  assert.equal(f.calls, 0)
  assert.equal(f.turns.busy(), false)
})

test("same live execution reconciles a lost notification reply without another prompt", async t => {
  const f = await fixture(t), submit = f.host.raw.submit
  await f.report()
  f.host.raw.submit = async (execution, request, admission) => { await submit(execution, request, admission); throw new Error("lost reply") }
  await f.schedule()
  assert.equal(f.calls, 1)
  await f.restart(); await f.schedule()
  assert.equal(f.calls, 1)
  f.answer.resolve({})
  await until(async () => f.turns.busy() ? undefined : true)
  await f.schedule()
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!.state, "delivered")
})

test("attempted notifications stay interrupted after provider retirement and explicit restoration", async t => {
  const f = await fixture(t)
  await f.report(); await f.schedule()
  f.host.retire()
  await f.restart(); await f.schedule()
  const delivery = (await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!
  assert.equal(delivery.state, "interrupted")
  assert.equal(f.calls, 1)
  const agent = f.host.agents.get(f.parent.agentId)!
  agent.phase = "ready"; agent.execution = { ...f.target, handlerGeneration: (await f.host.raw.snapshot()).handlerGeneration, providerGeneration: randomUUID() }
  await f.schedule()
  assert.equal(f.calls, 1)
})

test("explicit notification retry uses a fresh stable ID and preserves prior attempt evidence", async t => {
  const f = await fixture(t)
  await f.report(); await f.schedule()
  const previous = (await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!
  f.answer.resolve({}); await until(async () => f.turns.busy() ? undefined : true)
  f.host.retire(); await f.restart(); await f.schedule()
  const agent = f.host.agents.get(f.parent.agentId)!
  agent.phase = "ready"; agent.execution = { ...f.target, handlerGeneration: (await f.host.raw.snapshot()).handlerGeneration, providerGeneration: randomUUID() }
  const commandId = randomUUID(), retry = f.core as unknown as { retryNotification(commandId: string, deliveryId: string, target: typeof f.target, bindingEpoch: string): Promise<unknown> }
  const receipt = await retry.retryNotification(commandId, previous.deliveryId, agent.execution, f.input.bindingEpoch)
  assert.deepEqual(await retry.retryNotification(commandId, previous.deliveryId, agent.execution, f.input.bindingEpoch), receipt)
  await f.schedule()
  assert.equal(f.calls, 2)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries.some(delivery => delivery.deliveryId === commandId), true)
})

test("an admission fsync failure after dispatch intent invokes no ACP", async t => {
  const f = await fixture(t), submit = f.host.raw.submit
  await f.report()
  f.host.raw.submit = async (execution, request, admission) => {
    f.failAt("file-sync", "/origin-runs/")
    return submit(execution, request, admission)
  }
  await assert.rejects(f.schedule(), /ENOSPC|BUREAU_UNAVAILABLE/)
  assert.equal(f.calls, 0)
  assert.equal(f.turns.busy(), false)
  await f.restart(); await f.schedule()
  assert.equal(f.calls, 0)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!.state, "uncertain")
})

test("crash after claim publication allows only the never-dispatched batch to resume", async t => {
  const f = await fixture(t), write = f.store.writeDelivery
  await f.report()
  let failure = true
  f.store.writeDelivery = async (delivery, previous) => { await write(delivery, previous); if (failure && delivery.state === "claimed") { failure = false; throw new Error("crash before dispatch intent") } }
  await assert.rejects(f.schedule(), /crash before dispatch intent/)
  assert.equal(f.calls, 0)
  await f.restart(); await f.schedule()
  assert.equal(f.calls, 1)
})

test("parent settlement schedules a queued report once without model polling", async t => {
  const f = await fixture(t), core = f.automatic()
  await core.initialize()
  const human = await f.human()
  await f.report(f.child, core)
  await until(async () => (await core.inbox(f.parent, f.input.runId)).deliveries.some(delivery => delivery.state === "queued") ? true : undefined)
  assert.equal(f.calls, 1)
  f.answer.resolve({}); await f.turns.settledAcp(human.submissionId)
  await until(async () => f.calls === 2 ? true : undefined)
  await until(async () => (await core.inbox(f.parent, f.input.runId)).deliveries.some(delivery => delivery.state === "delivered") ? true : undefined)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(f.calls, 2)
})

test("live waits get delivery priority over automatic parent scheduling", async t => {
  const f = await fixture(t), core = f.automatic()
  await core.initialize()
  const waiting = core.wait(f.waitInput)
  await until(async () => await core.waitRecord(f.waitInput.waitId) ?? undefined)
  await f.report(f.child, core)
  assert.equal((await waiting).kind, "reports")
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(f.calls, 0)
})

test("provider failure after admission retains an uncertain delivery without replay", async t => {
  const f = await fixture(t)
  f.failProvider(); await f.report(); await f.schedule()
  assert.equal(f.calls, 1)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!.state, "uncertain")
  await f.restart(); await f.schedule()
  assert.equal(f.calls, 1)
})

test("report arrival during a lost control reply is scheduled after the in-flight batch settles", async t => {
  const f = await fixture(t), second = await f.delegate(), core = f.automatic(), submit = f.host.raw.submit, gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let held = false
  f.host.raw.submit = async (execution, request, admission) => {
    const receipt = await submit(execution, request, admission)
    if (!held && execution.agentId === f.parent.agentId) { held = true; entered.resolve(); await gate.promise }
    return receipt
  }
  f.answer.resolve({}); await core.initialize()
  await f.report(f.child, core); await entered.promise
  await f.report(second, core)
  gate.resolve()
  await until(async () => f.calls === 2 ? true : undefined, 5000)
  assert.equal(f.calls, 2)
})

test("a large valid report produces a bounded notification without disabling Bureau writes", async t => {
  const f = await fixture(t)
  const input = { ...f.child.attempt.ref, commandId: randomUUID(), execution: f.child.attempt.execution!, report: { status: "completed" as const, summary: "large", issues: Array.from({ length: 12 }, () => '"'.repeat(30000)), validation: [], git: null } }
  const event = await f.origins.forRun(f.input.runId).append(input.commandId, "report-retained", input)
  await f.core.acceptReport({ input, origin: { seq: event.seq, eventId: event.eventId, digest: event.digest } })
  await f.schedule()
  assert.equal(f.calls, 1)
  assert.equal((await f.core.status()).writeAvailable, true)
})