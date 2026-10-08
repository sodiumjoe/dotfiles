import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { createOrchestrationService } from "../src/orchestration/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import { agentServiceFixture } from "./agent-support.js"

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