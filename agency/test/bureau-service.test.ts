import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { bureauFixture } from "./bureau-support.js"

test("Bureau allocates durable root, child and grandchild lineage before dispatch", async t => {
  const f = await bureauFixture(t), child = await f.delegate(f.input.commandId)
  assert.deepEqual(child.lineage.parent, f.input.assignment.parent)
  assert.equal(child.lineage.runId, f.input.runId)
  const grandchild = await f.delegate(randomUUID(), { ...f.input.assignment, parent: child.agent })
  assert.deepEqual(grandchild.lineage.parent, child.agent)
  assert.notEqual(grandchild.agent.agentId, child.agent.agentId)
  assert.equal(f.host.promptCount, 2)
  await assert.rejects(f.core.retry(randomUUID(), child.assignmentId, "replace", f.invocation), /ACTIVE_ATTEMPT/)
})

test("delegation duplicates reproduce original reply while inspect returns current state", async t => {
  const f = await bureauFixture(t), child = await f.delegate(f.input.commandId)
  f.host.endTurn(child.attempt.submissionId)
  await f.core.reconcile()
  assert.equal((await f.snapshot()).assignments[0]!.attempt.state, "awaiting_report")
  await f.restartBureau()
  assert.deepEqual(await f.delegate(f.input.commandId), child)
  assert.equal(f.host.launchCalls, 2)
  await assert.rejects(f.delegate(f.input.commandId, { ...f.input.assignment, description: "changed" }), /CONFLICT/)
})

test("identical descriptions with distinct command IDs create independent assignments", async t => {
  const f = await bureauFixture(t), a = await f.delegate(), b = await f.delegate()
  assert.notEqual(a.assignmentId, b.assignmentId)
  assert.notEqual(a.agent.agentId, b.agent.agentId)
})

test("launch reply loss inspects the original command without dispatching another child", async t => {
  const f = await bureauFixture(t); f.host.loseReply()
  const child = await f.delegate(f.input.commandId)
  assert.equal(child.attempt.state, "running")
  assert.equal(f.host.launchCalls, 2)
  assert.deepEqual(await f.delegate(f.input.commandId), child)
})

test("Handler generation retirement interrupts an unfinished attempt without replay", async t => {
  const f = await bureauFixture(t), child = await f.delegate(f.input.commandId)
  f.host.retire(); await f.restartBureau()
  const current = (await f.snapshot()).assignments[0]!
  assert.equal(current.attempt.state, "interrupted")
  assert.deepEqual(current.lineage, child.lineage)
  assert.equal(f.host.launchCalls, 2)
  assert.equal(f.host.promptCount, 1)
})

test("replacement retry allocates fresh attempt and child while preserving prior association", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  f.host.retire(); await f.core.reconcile()
  f.host.defaults({ modeId: "read-only", configValues: { effort: "high" } })
  const next = await f.core.retry(randomUUID(), child.assignmentId, "replace", f.invocation)
  assert.notEqual(next.agent.agentId, child.agent.agentId)
  assert.notEqual(next.attempt.ref.attemptId, child.attempt.ref.attemptId)
  assert.deepEqual(next.lineage.parent, child.lineage.parent)
  assert.equal(next.attempt.effective!.modeId, "read-only")
  assert.equal((await f.core.assignment(child.assignmentId)).attemptIds.length, 2)
})

test("cross-run parents cannot delegate into another run", async t => {
  const f = await bureauFixture(t), root = f.host.addRoot(true)
  const other = await f.core.beginRun(randomUUID(), root, "Other run")
  await assert.rejects(f.core.delegate(randomUUID(), other.runId, f.input.assignment, f.invocation), /INVALID_PARENT/)
})

test("root adoption requires tools and rejects child adoption or unresolved root membership", async t => {
  const f = await bureauFixture(t)
  await assert.rejects(f.core.beginRun(randomUUID(), f.host.addRoot(false), "Unconfigured root"), /SESSION_INPUT_REQUIRED/)
  await assert.rejects(f.core.beginRun(randomUUID(), f.input.assignment.parent, "Rebind root"), /RUN_AFFINITY/)
  const child = await f.delegate()
  await assert.rejects(f.core.beginRun(randomUUID(), child.agent, "Child as root"), /CHILD_AS_ROOT/)
})

test("closing an idle run rotates its binding epoch and allows explicit root association", async t => {
  const f = await bureauFixture(t)
  const closed = await f.core.closeRun(randomUUID(), f.input.runId)
  assert.equal(closed.state, "completed")
  assert.notEqual(closed.bindingEpoch, f.input.bindingEpoch)
  const next = await f.core.beginRun(randomUUID(), closed.root, "Next objective")
  assert.notEqual(next.runId, f.input.runId)
  await assert.rejects(f.core.assertBinding(f.input.runId, f.input.bindingEpoch, closed.root), /STALE_BINDING/)
  await f.core.assertBinding(next.runId, next.bindingEpoch, next.root)
  assert.equal(f.host.stopCalls, 0)
})

test("run closure refuses active attempts and cancellation does not stop children", async t => {
  const f = await bureauFixture(t); await f.delegate()
  await assert.rejects(f.core.closeRun(randomUUID(), f.input.runId), /UNRESOLVED/)
  const result = await f.core.cancel(randomUUID(), f.input.runId)
  assert.equal(result.state, "cancelled")
  assert.equal((await f.snapshot()).assignments[0]!.attempt.state, "cancelled")
  assert.equal(f.host.stopCalls, 0)
  await assert.rejects(f.delegate(), /RUN_CANCELLED/)
})

test("Bureau disable retains providers and rejects new orchestration writes", async t => {
  const f = await bureauFixture(t), before = f.host.launchCalls
  await f.core.disable()
  assert.equal((await f.core.status()).enabled, false)
  await assert.rejects(f.delegate(), /BUREAU_DISABLED/)
  assert.equal(f.host.launchCalls, before); assert.equal(f.host.stopCalls, 0)
  await f.core.enable(); await f.delegate()
  assert.equal(f.host.launchCalls, before + 1)
})

test("forget seals run and create-command identity against old retries", async t => {
  const f = await bureauFixture(t), commandId = randomUUID()
  const run = await f.core.startRun(commandId, f.input.rootInput, f.invocation)
  await assert.rejects(f.core.forget(randomUUID(), run.runId), /UNRESOLVED/)
  await f.core.closeRun(randomUUID(), run.runId)
  await f.core.forget(randomUUID(), run.runId)
  await f.restartBureau()
  await assert.rejects(f.core.inspect(run.runId), /FORGOTTEN/)
  await assert.rejects(f.core.startRun(commandId, f.input.rootInput, f.invocation), /FORGOTTEN/)
})

test("non-null Git assignment is rejected before any host launch", async t => {
  const f = await bureauFixture(t), before = f.host.launchCalls
  await assert.rejects(f.core.delegate(randomUUID(), f.input.runId, { ...f.input.assignment, git: { remote: "origin", repository: f.root, baseOid: "a".repeat(40) } }, f.invocation), /UNSUPPORTED_CAPABILITY/)
  assert.equal(f.host.launchCalls, before)
})

test("Bureau persists invocation digests without environment or MCP credentials", async t => {
  const f = await bureauFixture(t); await f.delegate(f.input.commandId)
  for (const area of ["bureau/commands", "bureau/runs", "bureau/assignments", "bureau/attempts"]) {
    for (const name of await readdir(join(f.root, area))) {
      const contents = await readFile(join(f.root, area, name), "utf8")
      assert.ok(!contents.includes("transient-secret"))
      assert.ok(!contents.includes('"environment":'))
    }
  }
  await assert.rejects(f.core.delegate(f.input.commandId, f.input.runId, f.input.assignment, { ...f.invocation, environment: { TOKEN: "changed" } }), /CONFLICT/)
})

test("Bureau publication failure prevents provider launch and leaves inspection available", async t => {
  const f = await bureauFixture(t), before = f.host.launchCalls
  f.failAt("write")
  await assert.rejects(f.delegate(), /ENOSPC/)
  assert.equal(f.host.launchCalls, before)
  assert.equal((await f.snapshot()).runId, f.input.runId)
})

test("restore retry preserves the logical child and saved settings", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  f.host.retire(); await f.core.reconcile()
  f.host.defaults({ modeId: "read-only", configValues: { effort: "high" } })
  const restored = await f.core.retry(randomUUID(), child.assignmentId, "restore", f.invocation)
  assert.deepEqual(restored.agent, child.agent)
  assert.deepEqual(restored.attempt.effective, child.attempt.effective)
  assert.notEqual(restored.attempt.execution!.providerGeneration, child.attempt.execution!.providerGeneration)
  assert.notEqual(restored.attempt.submissionId, child.attempt.submissionId)
})

test("Bureau write failure suspends writes until storage recovery is verified", async t => {
  const f = await bureauFixture(t), before = f.host.launchCalls
  f.failAt("write")
  await assert.rejects(f.delegate(), /ENOSPC/)
  await assert.rejects(f.delegate(), /BUREAU_UNAVAILABLE/)
  assert.equal(f.host.launchCalls, before)
  await f.core.enable(); await f.delegate()
  assert.equal(f.host.launchCalls, before + 1)
})

test("a closed run cannot be reopened by cancellation after root reassociation", async t => {
  const f = await bureauFixture(t)
  await f.core.closeRun(randomUUID(), f.input.runId)
  const next = await f.core.beginRun(randomUUID(), f.input.assignment.parent, "Next run")
  await assert.rejects(f.core.cancel(randomUUID(), f.input.runId), /RUN_CLOSED/)
  await f.core.assertBinding(next.runId, next.bindingEpoch, next.root)
})

test("root launch rejects a receipt from another logical agent", async t => {
  const f = await bureauFixture(t), original = f.host.raw.launchRoot
  f.host.raw.launchRoot = async (command, invocation) => {
    const receipt = await original(command, invocation)
    return { ...receipt, execution: { ...receipt.execution!, agentId: randomUUID() } }
  }
  await assert.rejects(f.core.startRun(randomUUID(), f.input.rootInput, f.invocation), /INVALID_RECEIPT/)
})

test("a second run cannot advance the first run journal cursor", async t => {
  const f = await bureauFixture(t), before = (await f.snapshot()).journalCursor
  await f.core.startRun(randomUUID(), f.input.rootInput, f.invocation)
  assert.equal((await f.snapshot()).journalCursor, before)
})

test("delegation captures transient inputs before awaiting durable publication", async t => {
  const f = await bureauFixture(t), invocation = structuredClone(f.invocation), original = f.host.raw.launch
  let launched: typeof invocation | null = null
  f.host.raw.launch = async (command, supplied) => { launched = structuredClone(supplied); return original(command, supplied) }
  const pending = f.core.delegate(randomUUID(), f.input.runId, f.input.assignment, invocation)
  invocation.environment = { TOKEN: "changed" }
  invocation.nativeParams = { mcpServers: [{ name: "changed", command: "changed", args: [], env: [] }] }
  await pending
  assert.deepEqual(launched, f.invocation)
})

test("pending command inspection exposes reserved identities without redispatch", async t => {
  const f = await bureauFixture(t), original = f.host.raw.launch
  f.host.raw.launch = async (command, invocation) => {
    const receipt = await original(command, invocation)
    return { ...receipt, execution: { ...receipt.execution!, agentId: randomUUID() } }
  }
  await assert.rejects(f.delegate(f.input.commandId), /INVALID_RECEIPT/)
  const command = await (f.core as unknown as { command(id: string): Promise<{ state: string; targetId: string; launchCommandId: string; handlerGeneration: string }> }).command(f.input.commandId)
  assert.equal(command.state, "pending")
  assert.ok(await f.store.readAssignment(command.targetId))
  assert.ok(command.launchCommandId)
  assert.equal(command.handlerGeneration, (await f.host.raw.snapshot()).handlerGeneration)
  await assert.rejects(f.delegate(f.input.commandId), /COMMAND_UNCERTAIN/)
  assert.equal(f.host.launchCalls, 2)
})

test("run inspection pages large assignment replies without dropping assignments", async t => {
  const f = await bureauFixture(t), first = await f.delegate()
  for (let index = 0; index < 20; index++) {
    const assignmentId = randomUUID(), attemptId = randomUUID()
    await f.store.writeAttempt({ ...first.attempt, ref: { ...first.attempt.ref, assignmentId, attemptId }, lineage: { ...first.lineage, assignmentId } }, null)
    await f.store.writeAssignment({ version: 1, assignmentId, runId: f.input.runId, spec: { ...first.spec, description: "x".repeat(65536) }, attemptIds: [attemptId], activeAttemptId: attemptId, journal: null }, null)
  }
  const seen = new Set<string>()
  let after: string | null = null
  do {
    const page = await (f.core.inspect as unknown as (runId: string, after: string | null) => Promise<Awaited<ReturnType<typeof f.core.inspect>> & { nextAssignmentCursor: string | null }>)(f.input.runId, after)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 400000)
    for (const assignment of page.assignments) { assert.ok(!seen.has(assignment.assignmentId)); seen.add(assignment.assignmentId) }
    after = page.nextAssignmentCursor
    assert.notEqual(after, undefined)
  } while (after !== null)
  assert.equal(seen.size, 21)
})

test("generation change without origin replay evidence remains uncertain", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  f.host.retire()
  const snapshot = f.host.raw.snapshot
  f.host.raw.snapshot = async () => ({ ...await snapshot(), replayFences: [] })
  await f.core.reconcile()
  assert.equal((await f.core.assignment(child.assignmentId)).attempt.state, "uncertain")
})

test("root reconciliation observes its saved launch command without reissuing it", async t => {
  const f = await bureauFixture(t), original = f.host.raw.launchRoot
  let commandId = ""
  f.host.raw.launchRoot = async (command, invocation) => {
    commandId = command.commandId
    await original(command, invocation)
    return { commandId, execution: null, effective: null, state: "uncertain" }
  }
  const run = await f.core.startRun(randomUUID(), f.input.rootInput, f.invocation)
  assert.equal(run.state, "starting")
  await f.core.reconcile()
  assert.equal((await f.core.inspect(run.runId)).state, "active")
  assert.equal(f.host.launchCalls, 2)
})

test("malformed host receipt cannot publish a running attempt", async t => {
  const f = await bureauFixture(t), original = f.host.raw.launch
  for (const change of [{ state: "invented" }, { effective: { unexpected: true } }, { execution: { hostId: f.input.agent.hostId, agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: "not-a-uuid" } }]) {
    f.host.raw.launch = async (command, invocation) => ({ ...await original(command, invocation), ...change }) as Awaited<ReturnType<typeof original>>
    await assert.rejects(f.delegate(), /INVALID_RECEIPT/)
  }
})