import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createTaskHandlerBridge as createHandlerBridge } from "./task-bridge-support.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { createOrchestrationService } from "../src/orchestration/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import { agentServiceFixture } from "./agent-support.js"
import { createRemoteHost } from "../src/bureau/remote-host.js"
import { createRemoteOrigins } from "../src/bureau/origins.js"
import { BRIDGE_FRAME_BYTES } from "../src/bridge/protocol.js"
import type { BridgeConnection } from "../src/bridge/task-ssh.js"

async function fixture(t: Parameters<typeof agentServiceFixture>[0], builtRevision = false) {
  const f = await agentServiceFixture(t), hostId = f.context.paths.hostKey, journals = createJournalPool(f.root, undefined, Date.now, "origin")
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage: createLineageStore(f.root), tools: { definition() { return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate() {}, revoke() {} }, relay: async () => { throw new Error("offline") } })
  const server = await createHandlerBridge({ root: f.root, host, journals, ...(builtRevision ? {} : { sourceRevision: "a".repeat(40) }) })
  const peer = await connectHandlerBridge({ root: f.root, hostId, handlerGeneration: f.service.handlerGeneration })
  t.after(async () => { peer.close(); await server.close() })
  return { ...f, hostId, host, peer, journals, server }
}

test("private Handler bridge binds exact runtime identity and exposes retained origin evidence", async t => {
  const f = await fixture(t), runId = randomUUID(), journal = f.journals.forRun(runId), entry = await journal.append(randomUUID(), "report-retained", { runId, assignmentId: randomUUID(), attemptId: randomUUID(), commandId: randomUUID(), execution: { hostId: f.hostId, agentId: randomUUID(), handlerGeneration: f.service.handlerGeneration, providerGeneration: randomUUID() }, report: { status: "completed", summary: "result", issues: [], validation: [], git: null } })
  assert.equal((await f.peer.ready).sourceRevision, "a".repeat(40))
  const key = { hostId: f.hostId, runId, streamId: runId }, page = await f.peer.request("origin-retained", { key, after: 0, limit: 256 }) as { entries: unknown[] }
  assert.deepEqual(page.entries, [entry])
  await f.peer.request("origin-ack", { key, ref: { seq: entry.seq, eventId: entry.eventId, digest: entry.digest } })
  assert.equal(await journal.watermark("bureau"), 1)
  await assert.rejects(f.peer.request("origin-retained", { key: { ...key, hostId: "b".repeat(64) }, after: 0, limit: 256 }), /INVALID_ORIGIN/)
  await assert.rejects(f.peer.request("stop", { commandId: randomUUID(), target: { hostId: f.hostId, agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() } }), /STALE_HANDLER/)
  await assert.rejects(f.peer.request("unknown", {}), /UNSUPPORTED_CAPABILITY/)
})

test("Handler bridge prompt admission waits for durable recipient confirmation", async t => {
  const f = await fixture(t), runId = randomUUID(), receipt = await f.host.launchRoot({ commandId: randomUUID(), runId, agent: { hostId: f.hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {} }, { environment: f.input.environment, nativeParams: {} })
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "remote prompt" }] }, entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const pending = f.peer.request("submit", { target: receipt.execution, request, admissionRequired: true }, { beforeAccepted: async () => { entered.resolve(); await gate.promise } })
  await entered.promise
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
  gate.resolve(); await pending
  await f.service.settledAcp(receipt.execution!, request.submissionId)
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 1)
})

test("persistent bridge coordination forwards authenticated requests and EOF releases only transport", async t => {
  const f = await fixture(t)
  await assert.rejects(f.server.coordinatorRequest({ kind: "fixture" }), /BUREAU_UNAVAILABLE/)
  f.peer.onRequest(async (channel, payload) => { assert.equal(channel, "tool"); return { received: payload } })
  await f.peer.request("coordinate", {})
  assert.deepEqual(await f.server.coordinatorRequest({ kind: "fixture" }), { received: { kind: "fixture" } })
  const second = await connectHandlerBridge({ root: f.root, hostId: f.hostId, handlerGeneration: f.service.handlerGeneration })
  t.after(() => second.close())
  await assert.rejects(second.request("coordinate", {}), /COORDINATOR_EXISTS/)
  f.peer.close(); await f.peer.closed
  const journal = f.journals.forRun(randomUUID())
  assert.equal((await journal.metadata()).lastSeq, 0)
  assert.equal(f.spawns(), 0)
})

test("Handler bridge advertises the built revision without runtime Git discovery", async t => {
  const manifest = JSON.parse(await readFile(new URL("../build-manifest.json", import.meta.url), "utf8"))
  assert.match(manifest.sourceRevision, /^[a-f0-9]{40,64}$/)
  const f = await fixture(t, true)
  assert.equal((await f.peer.ready).sourceRevision, manifest.sourceRevision)
})

test("remote replay transfers an oversized report backlog and a near-limit retained entry", { timeout: 60000 }, async t => {
  const f = await fixture(t), runId = randomUUID(), root = await f.host.launchRoot({ commandId: randomUUID(), runId, agent: { hostId: f.hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {} }, { environment: f.input.environment, nativeParams: {} })
  const journal = f.journals.forRun(runId), key = { hostId: f.hostId, runId, streamId: runId }
  for (let index = 0; index < 18; index++) {
    const commandId = randomUUID()
    await journal.append(commandId, "report-retained", { runId, assignmentId: randomUUID(), attemptId: randomUUID(), commandId, execution: root.execution, report: { status: "completed", summary: "x".repeat(65536), issues: [], validation: [], git: null } })
  }
  const commandId = randomUUID(), payload = { runId, assignmentId: randomUUID(), attemptId: randomUUID(), commandId, execution: root.execution, report: { status: "completed", summary: "x".repeat(65536), issues: Array.from({ length: 15 }, () => "x".repeat(65536)), validation: [], git: null } }
  const size = Buffer.byteLength(JSON.stringify({ seq: 21, eventId: commandId, kind: "report-retained", payload, digest: "a".repeat(64) }))
  payload.report.issues[14] = payload.report.issues[14]!.slice(0, 65536 - (size - BRIDGE_FRAME_BYTES + 100))
  const large = await journal.append(commandId, "report-retained", payload)
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > BRIDGE_FRAME_BYTES - 150)
  const mirror = createRemoteOrigins(f.root, f.hostId), hello = await f.peer.ready
  const connection: BridgeConnection = { ...f.peer, peer: f.peer, hello, snapshot: await f.host.snapshot(), diagnostics: "" }
  const remote = createRemoteHost({ enrollment: { inventoryId: randomUUID(), hostId: f.hostId, hostname: "fixture", agyPath: "/opt/agency/agy", loginShell: "/bin/bash" }, origins: mirror, managed: true, connect: async () => connection })
  t.after(() => remote.close())
  remote.setEnabled(true)
  const observed = await remote.snapshot(), entries = (await mirror.read(key, 0, 256)).entries
  assert.equal(entries.length, (await journal.metadata()).lastSeq)
  assert.deepEqual(entries.at(-1), large)
  assert.equal(await mirror.completed(observed, hello.connectionId), true)
  for (const entry of entries) await remote.originSource!.acknowledge(key, entry)
  assert.equal(await journal.watermark("bureau"), entries.length)
  assert.equal((await remote.stop(randomUUID(), root.execution!)).state, "stopped")
  assert.equal(f.spawns(), 1)
})

test("large host history reconstructs a coherent snapshot and a compact completed fence", { timeout: 30000 }, async t => {
  const f = await fixture(t), readSnapshot = f.host.snapshot.bind(f.host), snapshot = await readSnapshot()
  snapshot.agents = Array.from({ length: 6000 }, () => ({ agent: { hostId: f.hostId, agentId: randomUUID() }, execution: null, phase: "stopped", toolsEnabled: false, lineage: null, membership: null, cwd: f.workspace, settings: { modelId: "model-a" } }))
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > BRIDGE_FRAME_BYTES)
  f.host.snapshot = async () => { const current = await readSnapshot(); return { ...current, agents: [...structuredClone(snapshot.agents), ...current.agents] } }
  const hello = await f.peer.ready, mirror = createRemoteOrigins(f.root, f.hostId)
  const connection: BridgeConnection = { ...f.peer, peer: f.peer, hello, snapshot, diagnostics: "", request: (channel, payload, options) => channel === "launchRoot" ? f.peer.request("invoke", { channel, payload, invocation: { environment: f.input.environment, nativeParams: {} } }, options) : f.peer.request(channel, payload, options) }
  const remote = createRemoteHost({ enrollment: { inventoryId: randomUUID(), hostId: f.hostId, hostname: "fixture", agyPath: "/opt/agency/agy", loginShell: "/bin/bash" }, origins: mirror, managed: true, connect: async () => connection })
  t.after(() => remote.close())
  remote.setEnabled(true)
  const observed = await remote.snapshot()
  assert.deepEqual(observed, snapshot)
  assert.equal(await mirror.completed(observed, hello.connectionId), true)
  assert.equal(await mirror.completed({ ...observed, agents: observed.agents.slice(1) }, hello.connectionId), false)
  assert.equal(await mirror.completed(observed, randomUUID()), false)
  assert.equal(await remote.inspectCommand(randomUUID(), hello.handlerGeneration), null)
  const launched = await remote.launchRoot({ commandId: randomUUID(), runId: randomUUID(), agent: { hostId: f.hostId, agentId: randomUUID() }, handlerGeneration: hello.handlerGeneration, bindingEpoch: randomUUID(), cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {} }, { environment: f.input.environment, nativeParams: {} })
  assert.equal(launched.state, "started")
  assert.equal((await remote.stop(randomUUID(), launched.execution!)).state, "stopped")
  assert.equal(f.spawns(), 1)
})