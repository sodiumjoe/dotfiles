import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { Socket } from "node:net"
import { createHostCoordination } from "../src/handler/host-coordination.js"
import { createHostInventory, type HostEnrollment } from "../src/bureau/hosts.js"
import { createTaskHandlerBridge as createHandlerBridge } from "./task-bridge-support.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import type { BridgeConnection } from "../src/bridge/ssh.js"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { exchangeTool, serveToolSocket } from "../src/orchestration/tool-client.js"
import { journalEntries } from "../src/orchestration/reports.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import type { AssignmentView } from "../src/bureau/types.js"
import { agentServiceFixture } from "./agent-support.js"
import { until, delay } from "./control-support.js"

const prompts = (fixture: Awaited<ReturnType<typeof agentServiceFixture>>) => fixture.methodHistory.filter(method => method === "session/prompt").length

async function composition(t: TestContext) {
  let local: Awaited<ReturnType<typeof createHostCoordination>> | undefined
  const origins: Awaited<ReturnType<typeof createHostCoordination>>[] = [], servers: { close(): Promise<unknown> }[] = [], sockets = new Set<Socket>()
  t.after(async () => {
    await local?.close()
    for (const socket of sockets) socket.destroy()
    for (const server of servers.reverse()) await server.close()
    for (const origin of origins) await origin.close()
    assert.equal(sockets.size, 0)
  })
  const coordinator = await agentServiceFixture(t, { hostId: "c".repeat(64), prompt: "hang" })
  const a = await agentServiceFixture(t, { hostId: "a".repeat(64), prompt: "hang" })
  const b = await agentServiceFixture(t, { hostId: "b".repeat(64), prompt: "hang" })
  const roots = [coordinator.root, a.root, b.root]
  t.after(async () => {
    for (const fixture of [coordinator, a, b]) await fixture.cleanupOwned()
    for (const root of roots) await assert.rejects(lstat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
    t.diagnostic(JSON.stringify({ fixtureRoots: roots, rootsAbsent: true, socketsClosed: true }))
  })
  const endpoints = new Map<string, { fixture: typeof a; origin: typeof local & {}; enrollment: HostEnrollment }>(), connections: BridgeConnection[] = []
  for (const fixture of [a, b]) {
    let bridge: Awaited<ReturnType<typeof createHandlerBridge>>
    const origin = await createHostCoordination({ root: fixture.root, runtimeRoot: fixture.root, hostId: fixture.context.paths.hostKey, agents: fixture.service, coordinator: (payload, signal) => bridge.coordinatorRequest(payload, signal) })
    origins.push(origin)
    bridge = await createHandlerBridge({ root: fixture.root, host: origin.origin, journals: origin.origins, sourceRevision: "37c8c10b01ee9d873507f382b0ef8db5e14bad36", replay: () => origin.replay() })
    servers.push(bridge)
    const toolsServer = await bindPrivateSocket(fixture.root, "orchestration.sock", socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket))
      void serveToolSocket(socket, origin.tools).catch(() => socket.destroy())
    })
    servers.push({ close: () => new Promise<void>((resolve, reject) => toolsServer.close(error => error ? reject(error) : resolve())) })
    const enrollment = { inventoryId: randomUUID(), hostId: fixture.context.paths.hostKey, hostname: "fixture-" + fixture.context.paths.hostKey[0], agyPath: "/fixture/agy", loginShell: "/bin/bash" }
    await createHostInventory(coordinator.root).enroll(enrollment)
    endpoints.set(enrollment.hostId, { fixture, origin, enrollment })
  }
  const make = () => createHostCoordination({ root: coordinator.root, runtimeRoot: coordinator.root, hostId: coordinator.context.paths.hostKey, agents: coordinator.service, coordinator: async () => { throw new Error("BUREAU_UNAVAILABLE") }, connect: async enrollment => {
    const endpoint = endpoints.get(enrollment.hostId)!
    assert.deepEqual(enrollment, endpoint.enrollment)
    const peer = await connectHandlerBridge({ root: endpoint.fixture.root, hostId: enrollment.hostId, handlerGeneration: endpoint.fixture.service.handlerGeneration }), hello = await peer.ready
    await peer.request("coordinate", {})
    const connection: BridgeConnection = { ...peer, hello, snapshot: await endpoint.origin.origin.snapshot(), diagnostics: "", request(channel, payload, options) {
      if (["launch", "launchRoot", "restoreRoot"].includes(channel)) return peer.request("invoke", { channel, payload, invocation: { environment: endpoint.fixture.input.environment, nativeParams: (payload as { nativeParams: object }).nativeParams } }, options)
      return peer.request(channel, payload, options)
    } }
    connections.push(connection)
    return connection
  } })
  local = await make()
  await local.bureau.enable()
  const root = await local.bureau.startRun(randomUUID(), { hostId: a.context.paths.hostKey, cwd: a.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Fixture parent" }, { environment: coordinator.input.environment, nativeParams: { mcpServers: [] } })
  const aOrigin = endpoints.get(a.context.paths.hostKey)!.origin, bOrigin = endpoints.get(b.context.paths.hostKey)!.origin
  void aOrigin.origin.submit(root.execution!, { submissionId: randomUUID(), prompt: [{ type: "text", text: "Fixture parent" }] }).catch(() => undefined)
  await a.promptEntered
  const token = aOrigin.tools.tokenFor(root.execution!)!, scope = { runId: root.runId, bindingEpoch: root.bindingEpoch }
  const call = (name: string, args: Record<string, unknown>) => exchangeTool(join(a.root, "orchestration.sock"), token, "call", name, args)
  const delegated = await call("agency_delegate", { ...scope, commandId: randomUUID(), hostId: b.context.paths.hostKey, cwd: b.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null, description: "Fixture worker" })
  assert.equal(delegated.isError, false, JSON.stringify(delegated))
  const child = JSON.parse(delegated.content[0]!.text) as AssignmentView
  await b.promptEntered
  const report = () => exchangeTool(join(b.root, "orchestration.sock"), bOrigin.tools.tokenFor(child.attempt.execution!)!, "call", "agency_report", { ...scope, commandId: randomUUID(), ...child.attempt.ref, report: { status: "completed", summary: "Fixture report", issues: [], validation: [], git: null } })
  return { get local() { return local! }, a, b, aOrigin, bOrigin, root, child, scope, call, report, connections,
    async restart() { await local!.close(); local = await make() }
  }
}

for (const scenario of ["before-deadline", "disabled-restart", "expired-with-report", "expired-without-report"]) test("routed remote wait recovers on ordinary enable: " + scenario, { timeout: 20000 }, async t => {
  const f = await composition(t), expired = scenario.startsWith("expired")
  const args = { ...f.scope, waitId: randomUUID(), assignmentIds: [f.child.assignmentId], after: 0, timeoutMs: expired ? 3000 : 10000 }
  const before = await f.aOrigin.origin.snapshot(), promptCounts = [prompts(f.a), prompts(f.b)]
  const waiting = f.call("agency_wait", args)
  const savedBefore = await until(async () => await f.local.bureau.waitRecord(args.waitId) ?? undefined)
  await f.local.bureau.disable()
  const detached = await waiting
  assert.equal(detached.isError, true)
  assert.deepEqual(JSON.parse(detached.content[0]!.text), { code: "INVALID_TOOL_INPUT" })
  assert.deepEqual(await f.local.bureau.waitRecord(args.waitId), savedBefore)
  if (scenario !== "expired-without-report") {
    const report = await f.report()
    assert.equal(report.isError, false, JSON.stringify(report))
    assert.equal(JSON.parse(report.content[0]!.text).state, "retained")
  }
  if (expired) await delay(Math.max(1, savedBefore.deadline - Date.now() + 30))
  if (scenario === "disabled-restart") {
    const count = f.connections.length
    await f.restart()
    assert.equal(f.connections.length, count)
    assert.deepEqual(await f.local.bureau.waitRecord(args.waitId), savedBefore)
    assert.deepEqual(await f.local.bureau.status(), { enabled: false, ready: true, writeAvailable: true })
  }
  await f.local.bureau.enable()
  const result = await until(async () => (await f.local.bureau.waitRecord(args.waitId))?.result ?? undefined)
  assert.equal(result.kind, scenario === "expired-without-report" ? "timeout" : "reports")
  const savedAfter = (await f.local.bureau.waitRecord(args.waitId))!
  assert.deepEqual(savedAfter.input, savedBefore.input)
  assert.deepEqual(savedAfter.target, savedBefore.target)
  assert.equal(savedAfter.bindingEpoch, savedBefore.bindingEpoch)
  assert.equal(savedAfter.deadline, savedBefore.deadline)
  assert.equal(savedAfter.digest, canonicalDigest({ input: savedBefore.input, target: savedBefore.target, bindingEpoch: savedBefore.bindingEpoch }))
  const replay = await f.call("agency_wait", args)
  assert.equal(replay.isError, false, JSON.stringify(replay))
  assert.deepEqual(JSON.parse(replay.content[0]!.text), result)
  assert.deepEqual(await f.local.bureau.waitRecord(args.waitId), savedAfter)
  const inbox = await f.local.bureau.inbox(f.root.root, f.root.runId)
  assert.equal(inbox.deliveries.length, scenario === "expired-without-report" ? 0 : 1)
  if (scenario !== "expired-without-report") {
    assert.equal(result.reports.length, 1)
    assert.equal(inbox.deliveries[0]!.channel, "wait")
    assert.equal(inbox.deliveries[0]!.state, "delivered")
    assert.equal(inbox.deliveries[0]!.routeId, args.waitId)
    const entries = await journalEntries(f.bOrigin.origins.forRun(f.root.runId))
    assert.ok(entries.some(entry => entry.kind === "report-retained" && entry.eventId === result.reports[0]!.eventId))
  }
  const after = await f.aOrigin.origin.snapshot()
  assert.deepEqual(after.agents.find(agent => agent.agent.agentId === f.root.root.agentId)!.execution, before.agents.find(agent => agent.agent.agentId === f.root.root.agentId)!.execution)
  assert.deepEqual([prompts(f.a), prompts(f.b)], promptCounts)
  assert.deepEqual(promptCounts, [1, 1])
  assert.equal(f.connections.length, 4)
  t.diagnostic(JSON.stringify({ scenario, detached, savedBefore, savedAfter, result, replay, deliveries: inbox.deliveries, promptCountsBefore: promptCounts, promptCountsAfter: [prompts(f.a), prompts(f.b)], status: await f.local.bureau.status() }))
})