import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createHostCoordination } from "../src/handler/host-coordination.js"
import { createHostInventory } from "../src/bureau/hosts.js"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import type { BridgeConnection } from "../src/bridge/ssh.js"
import { until } from "./control-support.js"
import { agentServiceFixture } from "./agent-support.js"

test("Handler composition routes remote controls and reports through the persistent coordinator", async t => {
  const a = await agentServiceFixture(t), b = await agentServiceFixture(t, { hostId: "b".repeat(64) })
  const enrollment = { inventoryId: randomUUID(), hostId: b.context.paths.hostKey, hostname: "devbox-b", agyPath: "/usr/local/bin/agy", loginShell: "/bin/bash" }
  await createHostInventory(a.root).enroll(enrollment)
  let server: Awaited<ReturnType<typeof createHandlerBridge>> | undefined
  const remote = await createHostCoordination({ root: b.root, runtimeRoot: b.root, hostId: b.context.paths.hostKey, agents: b.service, coordinator: (payload, signal) => server!.coordinatorRequest(payload, signal) })
  server = await createHandlerBridge({ root: b.root, host: remote.origin, journals: remote.origins, sourceRevision: "a".repeat(40) })
  t.after(async () => { await local.close(); await server!.close(); await remote.close() })
  const connections: BridgeConnection[] = []
  const local = await createHostCoordination({ root: a.root, runtimeRoot: a.root, hostId: a.context.paths.hostKey, agents: a.service, coordinator: async () => { throw new Error("BUREAU_UNAVAILABLE") }, connect: async value => {
    assert.deepEqual(value, enrollment)
    const peer = await connectHandlerBridge({ root: b.root, hostId: value.hostId, handlerGeneration: b.service.handlerGeneration }), hello = await peer.ready
    await peer.request("coordinate", {})
    const connection: BridgeConnection = { ...peer, hello, snapshot: await remote.origin.snapshot(), diagnostics: "", async request(channel, payload, options) {
      if (["launch", "launchRoot", "restoreRoot"].includes(channel)) return peer.request("invoke", { channel, payload, invocation: { environment: b.input.environment, nativeParams: (payload as { nativeParams: object }).nativeParams } }, options)
      return peer.request(channel, payload, options)
    } }
    connections.push(connection)
    return connection
  } })
  await local.bureau.enable()
  const root = await local.bureau.startRun(randomUUID(), { hostId: a.context.paths.hostKey, cwd: a.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Coordinate remote work" }, { environment: a.input.environment, nativeParams: { mcpServers: [] } })
  const child = await local.bureau.delegate(randomUUID(), root.runId, { parent: root.root, hostId: b.context.paths.hostKey, cwd: b.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null, description: "Inspect the devbox" }, { environment: a.input.environment, nativeParams: { mcpServers: [] } })
  const token = remote.tools.tokenFor(child.attempt.execution!)!, scope = { runId: root.runId, bindingEpoch: root.bindingEpoch }
  const delegated = await remote.tools.call(token, "agency_delegate", { ...scope, commandId: randomUUID(), hostId: a.context.paths.hostKey, cwd: a.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null, description: "Inspect laptop state" })
  assert.equal(delegated.isError, false, JSON.stringify(delegated))
  assert.equal(JSON.parse(delegated.content[0]!.text).agent.hostId, a.context.paths.hostKey)
  const grandchildView = JSON.parse(delegated.content[0]!.text), waitId = randomUUID(), controller = new AbortController()
  const waiting = remote.tools.call(token, "agency_wait", { ...scope, waitId, assignmentIds: [grandchildView.assignmentId], after: 0, timeoutMs: 10000 }, controller.signal)
  await until(async () => await local.bureau.waitRecord(waitId) ?? undefined)
  controller.abort(new Error("TRANSPORT_DETACHED")); await waiting
  assert.equal((await local.bureau.waitRecord(waitId))!.ended, false)
  await remote.tools.cancel(token, waitId)
  assert.equal((await local.bureau.waitRecord(waitId))!.result!.kind, "cancelled")
  const result = await remote.tools.call(token, "agency_report", { ...scope, commandId: randomUUID(), ...child.attempt.ref, report: { status: "completed", summary: "Remote checks finished", issues: [], validation: [], git: null } })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(JSON.parse(result.content[0]!.text).state, "accepted")
  assert.equal((await local.bureau.assignment(child.assignmentId)).attempt.state, "completed")
  const stopId = randomUUID(), grandchild = JSON.parse(delegated.content[0]!.text)
  const stopped = await remote.tools.call(token, "agency_stop", { ...scope, commandId: stopId, agent: grandchild.agent })
  assert.equal(stopped.isError, false, JSON.stringify(stopped))
  assert.equal((await local.bureau.recoverScopedStop(root.runId, stopId)).state, "stopped")
  await remote.bureau.enable()
  assert.equal((await remote.bureau.status()).ready, true)
  assert.equal(connections.length, 1)
  assert.equal(a.spawns(), 2)
  assert.equal(b.spawns(), 1)
})