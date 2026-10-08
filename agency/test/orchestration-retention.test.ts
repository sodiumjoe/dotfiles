import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { loadOrchestrationPins } from "../src/orchestration/receipts.js"
import { bureauFixture } from "./bureau-support.js"

test("bootstrap pins retain unresolved agent and dispatch command evidence", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  const pins = await loadOrchestrationPins(f.root)
  assert.ok(pins.paths.includes(`agents/records/${child.agent.agentId}.json`))
  assert.ok(pins.paths.includes(`agents/commands/${child.attempt.launchCommandId}.json`))
  assert.ok(pins.paths.includes(`agents/records/${f.input.assignment.parent.agentId}.json`))
})

test("missing origin preparation cannot authorize retirement of an uncertain dispatch", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  f.host.retire()
  const snapshot = f.host.raw.snapshot
  f.host.raw.snapshot = async () => ({ ...await snapshot(), replayFences: [] })
  await f.core.reconcile()
  const pins = await loadOrchestrationPins(f.root)
  assert.ok(pins.paths.includes(`agents/commands/${child.attempt.launchCommandId}.json`))
})

test("cancelled closed runs release completed relationship pins without forgetting providers", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  await f.core.cancel(randomUUID(), f.input.runId)
  await f.core.closeRun(randomUUID(), f.input.runId)
  assert.equal((await loadOrchestrationPins(f.root)).paths.includes(`agents/records/${child.agent.agentId}.json`), false)
  assert.equal(f.host.stopCalls, 0)
})