import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createRoutedToolOutbox, createToolRouter } from "../src/bureau/tool-routing.js"
import { createBureauService } from "../src/bureau/service.js"
import type { OrchestrationHost, HostAgent } from "../src/bureau/host.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createRemoteOrigins } from "../src/bureau/origins.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import { toolResult } from "../src/orchestration/mcp.js"
import { bureauFixture } from "./bureau-support.js"

function request(f: Awaited<ReturnType<typeof bureauFixture>>) {
  const execution = f.host.agents.values().next().value!.execution!
  return { kind: "call" as const, execution, runId: f.input.runId, bindingEpoch: f.input.bindingEpoch, name: "agency_delegate", args: { commandId: randomUUID(), runId: f.input.runId, bindingEpoch: f.input.bindingEpoch, description: "Remote worker", hostId: f.input.agent.hostId, cwd: f.root, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null }, nativeParams: { mcpServers: [{ name: "external", command: "helper", args: [], env: [{ name: "SECRET", value: "transient-tool-secret" }] }] } }
}

test("offline routed controls retain their identity without retaining session secrets", async t => {
  const f = await bureauFixture(t), input = request(f)
  let online = false
  const outbox = createRoutedToolOutbox({ root: f.root, async send() { if (!online) throw new Error("BRIDGE_EOF"); return toolResult({ state: "completed" }) } })
  const pending = await outbox.call(input)
  assert.equal(JSON.parse(pending.content[0]!.text).state, "pending")
  const intent = await readFile(join(f.root, "orchestration/routed-tools", input.args.commandId + ".json"), "utf8")
  assert.equal(intent.includes("transient-tool-secret"), false)
  assert.equal(intent.includes(input.execution.providerGeneration), true)
  await assert.rejects(outbox.call({ ...input, args: { ...input.args, description: "changed" } }), /COMMAND_CONFLICT/)
  const recovered = createRoutedToolOutbox({ root: f.root, send: async () => toolResult({ state: "completed" }) })
  online = true
  assert.equal(JSON.parse((await recovered.call(input)).content[0]!.text).state, "completed")
})

test("routed intent publication failure sends no side effect", async t => {
  const f = await bureauFixture(t); f.failAt("file-sync", "routed-tools")
  let sent = 0
  const outbox = createRoutedToolOutbox({ root: f.root, filesystem: f.filesystem, async send() { sent++; return toolResult({ state: "completed" }) } })
  await assert.rejects(outbox.call(request(f)), /ENOSPC/)
  assert.equal(sent, 0)
})

test("routed tools require retained origin authority and validate exact current execution", async t => {
  const f = await bureauFixture(t), call = request(f), mirror = createRemoteOrigins(f.root, call.execution.hostId, f.filesystem), key = { hostId: call.execution.hostId, runId: call.runId, streamId: call.runId }
  const launch = { commandId: randomUUID(), runId: call.runId, agent: { hostId: call.execution.hostId, agentId: call.execution.agentId }, execution: call.execution, launchAttemptId: randomUUID(), lineage: null, attempt: null, bindingEpoch: call.bindingEpoch, invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: { modelId: "model-a" } }, kind = "origin-launch"
  const router = createToolRouter({ root: f.root, bureau: f.core, hosts: [f.host.raw], origins: [mirror], journals: createJournalPool(f.root, f.filesystem, f.clock.now, "origin"), environment: f.invocation.environment })
  await assert.rejects(router.call(call), /INVALID_CREDENTIAL/)
  await mirror.import(key, [{ seq: 1, eventId: launch.commandId, kind, payload: launch, digest: canonicalDigest({ kind, payload: launch }) }])
  const result = await router.call(call)
  assert.equal(result.isError, false, JSON.stringify(result))
  const child = JSON.parse(result.content[0]!.text)
  assert.deepEqual(child.lineage.parent, launch.agent)
  await assert.rejects(router.call({ ...call, execution: { ...call.execution, providerGeneration: randomUUID() } }), /STALE_EXECUTION/)
  assert.equal(f.host.promptCount, 1)
})

test("routed supervisors delegate and stop descendants using full cross-host identity", async t => {
  const f = await bureauFixture(t), call = request(f), remoteHostId = "b".repeat(64), generation = randomUUID(), agents = new Map<string, HostAgent>(), launches: Parameters<typeof f.host.raw.launch>[0][] = []
  const remote: OrchestrationHost = {
    hostId: remoteHostId,
    async snapshot() { return { hostId: remoteHostId, handlerGeneration: generation, backendChoices: ["codex-acp"], agents: [...agents.values()], receipts: [], replayFences: [] } },
    async launch(command) {
      launches.push(command)
      const execution = { ...command.agent, handlerGeneration: generation, providerGeneration: randomUUID() }
      agents.set(command.agent.agentId, { agent: command.agent, execution, phase: "ready", toolsEnabled: true, lineage: command.lineage, membership: { runId: command.runId, bindingEpoch: command.bindingEpoch }, cwd: command.spec.cwd, settings: { modelId: "model-a" } })
      return { commandId: command.commandId, execution, effective: { modelId: "model-a" }, state: "started" }
    },
    async launchRoot() { throw new Error("unused") }, async inspectCommand() { return null }, async submission() { return null },
    async submit(_target, submission) { return { submissionId: submission.submissionId, digest: "a".repeat(64), state: "accepted", stopReason: null, failure: null, acceptedSeq: 1, completedSeq: null } },
    async stop(commandId, execution) { assert.equal(execution.hostId, remoteHostId); agents.get(execution.agentId)!.phase = "stopped"; return { commandId, execution, state: "stopped" } }
  }
  const hosts = [f.host.raw, remote], core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), hosts })
  f.beforeCleanup(() => core.close()); await core.initialize(); await core.enable()
  const mirror = createRemoteOrigins(f.root, call.execution.hostId, f.filesystem), launch = { commandId: randomUUID(), runId: call.runId, agent: { hostId: call.execution.hostId, agentId: call.execution.agentId }, execution: call.execution, launchAttemptId: randomUUID(), lineage: null, attempt: null, bindingEpoch: call.bindingEpoch, invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: { modelId: "model-a" } }, kind = "origin-launch"
  await mirror.import({ hostId: call.execution.hostId, runId: call.runId, streamId: call.runId }, [{ seq: 1, eventId: launch.commandId, kind, payload: launch, digest: canonicalDigest({ kind, payload: launch }) }])
  const router = createToolRouter({ root: f.root, bureau: core, hosts, origins: [mirror], journals: createJournalPool(f.root, f.filesystem, f.clock.now, "origin"), environment: f.invocation.environment })
  const result = await router.call({ ...call, args: { ...call.args, hostId: remoteHostId } })
  assert.equal(result.isError, false, JSON.stringify(result))
  const child = JSON.parse(result.content[0]!.text)
  assert.equal(child.agent.hostId, remoteHostId)
  assert.equal(launches.length, 1)
  const inspection = await router.call({ ...call, name: "agency_inspect", args: { runId: call.runId, assignmentId: child.assignmentId } })
  assert.equal(inspection.isError, false, JSON.stringify(inspection))
  const stop = { ...call, name: "agency_stop", args: { commandId: randomUUID(), runId: call.runId, bindingEpoch: call.bindingEpoch, agent: child.agent } }
  const stopped = await router.call(stop)
  assert.equal(stopped.isError, false, JSON.stringify(stopped))
  assert.equal(JSON.parse(stopped.content[0]!.text).state, "stopped")
  assert.deepEqual(await router.call(stop), stopped)
})

test("routed reports use retained historical evidence after provider retirement", async t => {
  const f = await bureauFixture(t), child = await f.delegate(), mirror = createRemoteOrigins(f.root, f.input.agent.hostId, f.filesystem)
  const report = { ...child.attempt.ref, commandId: randomUUID(), execution: child.attempt.execution!, report: f.input.report }
  const kind = "report-retained", entry = { seq: 1, eventId: report.commandId, kind, payload: report, digest: canonicalDigest({ kind, payload: report }) }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), hosts: [f.host.raw], originSources: [mirror] })
  f.beforeCleanup(() => core.close()); await core.initialize(); await core.enable(); f.host.retire()
  await mirror.import({ hostId: report.execution.hostId, runId: report.runId, streamId: report.runId }, [entry])
  const router = createToolRouter({ root: f.root, bureau: core, hosts: [f.host.raw], origins: [mirror], journals: createJournalPool(f.root, f.filesystem, f.clock.now, "origin") })
  const payload = { kind: "report", envelope: { input: report, origin: { seq: entry.seq, eventId: entry.eventId, digest: entry.digest } } }
  await assert.rejects(router.dispatch(payload, undefined, "b".repeat(64)), /INVALID_ORIGIN/)
  const receipt = await router.dispatch(payload, undefined, report.execution.hostId)
  assert.equal((receipt as { state: string }).state, "accepted")
  assert.equal((await core.assignment(child.assignmentId)).attempt.state, "completed")
  assert.deepEqual(await router.dispatch(payload), receipt)
})

test("routed wait cancellation verifies the original execution and preserves the wait record", async t => {
  const f = await bureauFixture(t), call = request(f), child = await f.delegate(), waitId = randomUUID(), journal = createJournalPool(f.root, f.filesystem, f.clock.now, "origin")
  const launch = { commandId: randomUUID(), runId: call.runId, agent: { hostId: call.execution.hostId, agentId: call.execution.agentId }, execution: call.execution, launchAttemptId: randomUUID(), lineage: null, attempt: null, bindingEpoch: call.bindingEpoch, invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: { modelId: "model-a" } }
  await journal.forRun(call.runId).append(launch.commandId, "origin-launch", launch)
  const { createLocalOrigins } = await import("../src/bureau/origins.js")
  const router = createToolRouter({ root: f.root, bureau: f.core, hosts: [f.host.raw], origins: [createLocalOrigins(call.execution.hostId, journal)], journals: journal })
  const controller = new AbortController(), waiting = router.call({ ...call, name: "agency_wait", args: { runId: call.runId, bindingEpoch: call.bindingEpoch, waitId, assignmentIds: [child.assignmentId], after: 0, timeoutMs: 10000 } }, controller.signal)
  const { until } = await import("./control-support.js")
  await until(async () => await f.core.waitRecord(waitId) ?? undefined)
  controller.abort(); await waiting
  assert.equal((await f.core.waitRecord(waitId))!.ended, false)
  await router.dispatch({ kind: "cancel", execution: call.execution, runId: call.runId, bindingEpoch: call.bindingEpoch, waitId })
  assert.equal((await f.core.waitRecord(waitId))!.result!.kind, "cancelled")
  await assert.rejects(router.dispatch({ kind: "cancel", execution: { ...call.execution, providerGeneration: randomUUID() }, runId: call.runId, bindingEpoch: call.bindingEpoch, waitId }), /STALE_EXECUTION/)
})

test("reconnect replays pending controls once and rejects malformed result receipts", async t => {
  const f = await bureauFixture(t), call = request(f)
  let online = false, sends = 0
  const outbox = createRoutedToolOutbox({ root: f.root, async send() { if (!online) throw new Error("BRIDGE_EOF"); sends++; return toolResult({ state: "completed" }) } })
  await outbox.call(call); online = true
  await outbox.replay(); await outbox.replay()
  assert.equal(sends, 1)
  assert.equal(JSON.parse((await outbox.call(call)).content[0]!.text).state, "completed")
  const malformed = createRoutedToolOutbox({ root: f.root, send: async () => ({ content: [], isError: false, environment: { SECRET: "invalid" } } as any) })
  await assert.rejects(malformed.call({ ...call, args: { ...call.args, commandId: randomUUID() } }), /INVALID_TOOL_RESULT/)
})

test("lost coordinator replies replay the retained delegation without creating another provider", async t => {
  const f = await bureauFixture(t), call = request(f)
  let drop = true
  const outbox = createRoutedToolOutbox({ root: f.root, async send(raw) {
    assert.equal(raw.kind, "call")
    const request = raw as typeof call
    const result = await f.core.delegate(request.args.commandId, call.runId, { ...f.input.assignment, description: request.args.description }, f.invocation)
    if (drop) { drop = false; throw new Error("BRIDGE_EOF") }
    return toolResult(result)
  } })
  assert.equal(JSON.parse((await outbox.call(call)).content[0]!.text).state, "pending")
  await outbox.replay()
  const result = JSON.parse((await outbox.call(call)).content[0]!.text)
  assert.equal(result.attempt.state, "running")
  assert.equal((await f.core.inspect(call.runId)).assignments.length, 1)
  assert.equal(f.host.launchCalls, 2)
  assert.equal(f.host.promptCount, 1)
})

test("one uncertain routed failure does not prevent another retained control from replaying", async t => {
  const f = await bureauFixture(t), first = request(f), second = { ...first, args: { ...first.args, commandId: randomUUID(), description: "Independent pending delegation" } }
  let online = false, failed = true
  const outbox = createRoutedToolOutbox({ root: f.root, async send(raw) {
    if (!online) throw new Error("BRIDGE_EOF")
    const call = raw as typeof first
    if (call.args.commandId === first.args.commandId && failed) throw new Error("ENOSPC")
    return toolResult(await f.core.delegate(call.args.commandId, call.runId, { ...f.input.assignment, description: call.args.description }, f.invocation))
  } })
  await outbox.call(first); await outbox.call(second); online = true
  await outbox.replay().catch(() => undefined)
  assert.equal((await f.core.inspect(first.runId)).assignments.length, 1)
  assert.equal(f.host.promptCount, 1)
  await assert.rejects(readFile(join(f.root, "orchestration/routed-tool-results", first.args.commandId + ".json")), (error: unknown) => (error as { code?: string }).code === "ENOENT")
  failed = false
  await outbox.replay()
  assert.equal((await f.core.inspect(first.runId)).assignments.length, 2)
  assert.equal(f.host.promptCount, 2)
})