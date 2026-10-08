import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { createToolBindings } from "../src/orchestration/tool-bindings.js"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { exchangeTool, serveToolSocket } from "../src/orchestration/tool-client.js"
import { loadOrchestrationPins } from "../src/orchestration/receipts.js"
import { serveMcp } from "../src/orchestration/mcp.js"
import { createOrchestrationService } from "../src/orchestration/service.js"
import { createBureauService } from "../src/bureau/service.js"
import { createBureauStore } from "../src/bureau/store.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import { coreFixture } from "./orchestration-support.js"
import type { StorageFileSystem } from "../src/orchestration/storage.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

export async function toolsFixture(t: TestContext, filesystem?: StorageFileSystem) {
  let core: ReturnType<typeof createBureauService>, host: ReturnType<typeof createOrchestrationService>, tools: ReturnType<typeof createToolBindings>, online = true
  t.after(async () => { await core?.close(); tools?.close() })
  const f = await agentServiceFixture(t), origins = createJournalPool(f.root, filesystem, Date.now, "origin"), journals = createJournalPool(f.root), lineage = createLineageStore(f.root), store = createBureauStore(f.root)
  tools = createToolBindings({ socketPath: join(f.root, "tools.sock"), journals: origins, bureau: () => online ? core : undefined, host: () => host })
  host = createOrchestrationService({ root: f.root, hostId: f.context.paths.hostKey, agents: f.service, journals: origins, lineage, tools, relay: envelope => online ? core.acceptReport(envelope) : Promise.reject(new Error("BUREAU_UNAVAILABLE")) })
  core = createBureauService({ store, journals, origins, hosts: [host] })
  await core.initialize(); await core.enable()
  const invocation = { environment: f.input.environment, nativeParams: { mcpServers: [{ name: "external", command: "external-helper", args: [], env: [{ name: "SECRET", value: "external-secret" }] }] } }
  const root = await core.startRun(randomUUID(), { hostId: f.context.paths.hostKey, cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Inspect delegation" }, invocation)
  const token = tools.tokenFor(root.execution!)!
  const scope = { runId: root.runId, bindingEpoch: root.bindingEpoch }
  const spec = { description: "Inspect local state", hostId: root.root.hostId, cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null }
  const call = (name: string, args: Record<string, unknown>, tokenValue = token, signal?: AbortSignal) => tools.call(tokenValue, name, args, signal)
  const delegate = async () => {
    const result = await call("agency_delegate", { ...scope, commandId: randomUUID(), ...spec })
    assert.equal(result.isError, false, JSON.stringify(result))
    const value = JSON.parse(result.content[0]!.text)
    return { value, token: tools.tokenFor(value.attempt.execution)! }
  }
  return { ...f, store, fixtureRoot: f.root, setOnline(value: boolean) { online = value }, origins, journals, tools, host, core, root, scope, spec, token, call, delegate }
}

test("scoped tools infer the reserved parent and reject forged sender and human authority", async t => {
  const f = await toolsFixture(t)
  for (const args of [{ parent: f.root.root }, { execution: f.root.execution }, { sender: f.root.root }]) {
    assert.equal((await f.call("agency_delegate", { ...f.scope, commandId: randomUUID(), ...f.spec, ...args })).isError, true)
  }
  assert.equal((await f.call("agency_permission_decide", {})).isError, true)
  assert.equal((await f.call("agency_acknowledge_reports", {})).isError, true)
  assert.equal((await f.call("agency_recover_stop", {})).isError, true)
  const child = await f.delegate()
  assert.deepEqual(child.value.lineage.parent, f.root.root)
  assert.deepEqual(child.value.attempt.effective, f.root.execution && (await f.service.sessionRecord(child.value.agent.agentId))!.record.settings)
  const context = JSON.parse((await f.call("agency_context", {}, child.token)).content[0]!.text)
  assert.deepEqual(context.execution, child.value.attempt.execution)
  assert.deepEqual(context.attempt, child.value.attempt.ref)
})

test("stable tool IDs repeat durable delegation and distinct IDs intentionally launch twice", async t => {
  const f = await toolsFixture(t), args = { ...f.scope, commandId: randomUUID(), ...f.spec }
  const first = await f.call("agency_delegate", args)
  assert.deepEqual(await f.call("agency_delegate", args), first)
  assert.equal((await f.call("agency_delegate", { ...args, description: "changed" })).isError, true)
  const next = await f.call("agency_delegate", { ...args, commandId: randomUUID() })
  assert.notDeepEqual(next, first)
  assert.equal((await f.core.inspect(f.root.runId)).assignments.length, 2)
})

test("reports reject execution substitution and keep exact receipts after helper reconnection", async t => {
  const f = await toolsFixture(t), child = await f.delegate()
  const args = { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report: { status: "completed", summary: "Finished", issues: [], validation: [], git: null } }
  assert.equal((await f.call("agency_report", { ...args, execution: f.root.execution }, child.token)).isError, true)
  const first = await f.call("agency_report", args, child.token)
  assert.equal(first.isError, false)
  assert.deepEqual(await f.call("agency_report", args, child.token), first)
  assert.equal((await f.call("agency_report", { ...args, report: { ...args.report, summary: "changed" } }, child.token)).isError, true)
})

test("stop authority is limited to same-run descendants and exact stop retries remain readable", async t => {
  const f = await toolsFixture(t), child = await f.delegate()
  assert.equal((await f.call("agency_stop", { ...f.scope, commandId: randomUUID(), agentId: f.root.root.agentId }, child.token)).isError, true)
  assert.equal((await f.call("agency_stop", { ...f.scope, commandId: randomUUID(), agentId: randomUUID() })).isError, true)
  const args = { ...f.scope, commandId: randomUUID(), agentId: child.value.agent.agentId }
  const first = await f.call("agency_stop", args)
  assert.equal(first.isError, false)
  assert.deepEqual(await f.call("agency_stop", args), first)
  assert.equal((await f.call("agency_context", {}, child.token)).isError, true)
})

test("bootstrap bindings allow discovery and reject side effects until ready", async t => {
  const f = await toolsFixture(t), execution = { ...f.root.execution!, agentId: randomUUID(), providerGeneration: randomUUID() }
  f.tools.definition(execution, { commandId: randomUUID(), runId: f.root.runId, agent: { hostId: execution.hostId, agentId: execution.agentId }, execution, launchAttemptId: randomUUID(), lineage: null, attempt: null, bindingEpoch: f.root.bindingEpoch, invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: {} }, { environment: f.input.environment, nativeParams: {} })
  const token = f.tools.tokenFor(execution)!
  assert.equal((await f.call("agency_context", {}, token)).isError, false)
  const denied = await f.call("agency_delegate", { ...f.scope, commandId: randomUUID(), ...f.spec }, token)
  assert.equal(denied.isError, true)
  assert.match(denied.content[0]!.text, /NOT_READY/)
  f.tools.revoke(execution)
  assert.equal((await f.call("agency_context", {}, token)).isError, true)
})

test("wait cancellation ends the durable route while helper disconnect only detaches", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), waitId = randomUUID(), controller = new AbortController()
  const args = { ...f.scope, waitId, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 5000 }
  const waiting = f.call("agency_wait", args, f.token, controller.signal)
  await until(async () => await f.core.waitRecord(waitId) ?? undefined)
  controller.abort()
  assert.equal((await waiting).isError, true)
  assert.equal((await f.core.waitRecord(waitId))!.ended, false)
  await f.tools.cancel(f.token, waitId)
  assert.equal((await f.core.waitRecord(waitId))!.ended, true)
})

test("MCP stdio implements initialization, closed schemas, cancellation and pure bounded JSON", async () => {
  const input = new PassThrough(), output = new PassThrough(), frames: any[] = [], pending = Promise.withResolvers<void>()
  output.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line)) })
  const running = serveMcp({ input, output, call: async (_name, _args, signal) => { await new Promise<void>(resolve => signal!.addEventListener("abort", () => { pending.resolve(); resolve() }, { once: true })); return { content: [{ type: "text", text: "cancelled" }], isError: true } }, cancel: async () => {} })
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } })
  await until(async () => frames.length ? true : undefined)
  assert.equal(frames[0].result.protocolVersion, "2024-11-05")
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  send({ jsonrpc: "2.0", id: 3, method: "unknown" })
  await until(async () => frames.length === 3 ? true : undefined)
  assert.ok(frames[1].result.tools.some((tool: any) => tool.name === "agency_delegate" && tool.inputSchema.additionalProperties === false))
  assert.equal(frames[2].error.code, -32601)
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agency_wait", arguments: { waitId: randomUUID() } } })
  await new Promise(resolve => setImmediate(resolve))
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } })
  await pending.promise
  input.end(); await running
  assert.ok(frames.every(frame => frame.jsonrpc === "2.0"))
})

test("MCP rejects malformed UTF-8, unsupported versions and oversized frames", async () => {
  for (const bytes of [Buffer.from([255, 10]), Buffer.from("x".repeat(1048577) + "\n")]) {
    const input = new PassThrough(), output = new PassThrough(), running = serveMcp({ input, output, call: async () => ({ content: [], isError: false }), cancel: async () => {} })
    input.end(bytes)
    await assert.rejects(running, /INVALID_PROTOCOL|FRAME_TOO_LARGE/)
  }
})

test("root reassociation keeps the execution credential and rejects old epoch calls", async t => {
  const f = await toolsFixture(t)
  await assert.rejects(f.core.beginRun(randomUUID(), f.root.root, "active replacement"), /RUN_AFFINITY/)
  await f.core.closeRun(randomUUID(), f.root.runId)
  const next = await f.core.beginRun(randomUUID(), f.root.root, "Next run")
  assert.equal(f.tools.tokenFor(f.root.execution!), f.token)
  const context = JSON.parse((await f.call("agency_context", {})).content[0]!.text)
  assert.equal(context.runId, next.runId)
  assert.equal(context.bindingEpoch, next.bindingEpoch)
  assert.equal((await f.call("agency_delegate", { ...f.scope, commandId: randomUUID(), ...f.spec })).isError, true)
  assert.equal((await f.call("agency_delegate", { runId: next.runId, bindingEpoch: next.bindingEpoch, commandId: randomUUID(), ...f.spec })).isError, false)
})

test("explicit child restore revokes its former token and requires caller external definitions", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), target = child.value.attempt.execution
  const tuple = { agentId: target.agentId, handlerGeneration: target.handlerGeneration, providerGeneration: target.providerGeneration }
  const stopped = await f.service.stop({ ...tuple, commandId: randomUUID() })
  await until(async () => (await f.service.command(stopped.command.commandId, tuple.handlerGeneration)).command.state === "completed" ? true : undefined)
  await f.core.reconcile()
  const restored = await f.core.retry(randomUUID(), child.value.assignmentId, "restore", { environment: f.input.environment, nativeParams: { mcpServers: [{ name: "external", command: "external-helper", args: [], env: [{ name: "SECRET", value: "replacement-secret" }] }] } })
  assert.equal(restored.attempt.state, "running")
  assert.equal((await f.call("agency_context", {}, child.token)).isError, true)
  const next = f.tools.tokenFor(restored.attempt.execution!)!
  assert.notEqual(next, child.token)
  assert.deepEqual(restored.lineage, child.value.lineage)
})

test("root restore reconstructs only the internal server with a fresh execution credential", async t => {
  const f = await toolsFixture(t), target = f.root.execution!
  const stopped = await f.service.stop({ agentId: target.agentId, handlerGeneration: target.handlerGeneration, providerGeneration: target.providerGeneration, commandId: randomUUID() })
  await until(async () => (await f.service.command(stopped.command.commandId, target.handlerGeneration)).command.state === "completed" ? true : undefined)
  const restored = await f.core.restoreRun(randomUUID(), f.root.runId, { environment: f.input.environment, nativeParams: { mcpServers: [{ name: "external", command: "external-helper", args: [], env: [] }] } })
  assert.equal(restored.state, "active")
  assert.notEqual(restored.execution!.providerGeneration, target.providerGeneration)
  assert.equal((await f.call("agency_context", {})).isError, true)
  const token = f.tools.tokenFor(restored.execution!)!
  assert.equal((await f.call("agency_context", {}, token)).isError, false)
})

test("an in-flight old-epoch call cannot adopt authority discovered by another helper", async t => {
  const f = await toolsFixture(t), asserted = f.core.assertBinding, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.core.assertBinding = async (...args) => { await asserted(...args); entered.resolve(); await release.promise }
  const pending = f.call("agency_delegate", { ...f.scope, commandId: randomUUID(), ...f.spec })
  await entered.promise
  await f.core.closeRun(randomUUID(), f.root.runId)
  const next = await f.core.beginRun(randomUUID(), f.root.root, "new authority")
  await f.call("agency_context", {})
  release.resolve()
  assert.equal((await pending).isError, true)
  assert.equal((await f.core.inspect(next.runId)).assignments.length, 0)
})

test("descendant stop follows immutable lineage after an ancestor is replaced", async t => {
  const f = await toolsFixture(t), child = await f.delegate()
  const reply = await f.call("agency_delegate", { ...f.scope, commandId: randomUUID(), ...f.spec, description: "Grandchild" }, child.token)
  assert.equal(reply.isError, false)
  const grandchild = JSON.parse(reply.content[0]!.text)
  const target = child.value.attempt.execution, stopped = await f.service.stop({ agentId: target.agentId, handlerGeneration: target.handlerGeneration, providerGeneration: target.providerGeneration, commandId: randomUUID() })
  await until(async () => (await f.service.command(stopped.command.commandId, target.handlerGeneration)).command.state === "completed" ? true : undefined)
  await f.core.reconcile()
  await f.core.retry(randomUUID(), child.value.assignmentId, "replace", { environment: f.input.environment, nativeParams: {} })
  const result = await f.call("agency_stop", { ...f.scope, commandId: randomUUID(), agentId: grandchild.agent.agentId })
  assert.equal(result.isError, false, JSON.stringify(result))
})

test("inspection exposes one report body and remains bounded", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), report = { status: "completed", summary: "Report body", issues: ["issue"], validation: [], git: null }
  await f.call("agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report }, child.token)
  const result = await f.call("agency_inspect", { runId: f.root.runId, assignmentId: child.value.assignmentId })
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.content[0]!.text).report, report)
  assert.equal(result.content[0]!.text.split("Report body").length, 2)
})

test("large report inspection uses bounded reversible pages", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), report = { status: "completed", summary: "large", issues: [...Array.from({ length: 12 }, () => '"'.repeat(30000)), "界".repeat(18000)], validation: [], git: null }
  const reply = await f.call("agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report }, child.token)
  assert.equal(reply.isError, false)
  const args = { runId: f.root.runId, assignmentId: child.value.assignmentId }, pieces: string[] = []
  let after = 0
  do {
    const response = await f.call("agency_inspect", { ...args, reportAfter: after })
    assert.equal(response.isError, false, JSON.stringify(response))
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024)
    const page = JSON.parse(response.content[0]!.text).reportPage
    assert.equal(page.offset, after)
    pieces.push(page.text); after = page.nextCursor
  } while (after !== null)
  assert.deepEqual(JSON.parse(pieces.join("")), report)
})

test("closed Bureau instances reject later dispatch", async t => {
  const f = await toolsFixture(t)
  f.core.close()
  await assert.rejects(f.core.delegate(randomUUID(), f.root.runId, { ...f.spec, backendId: "codex-acp", parent: f.root.root }, { environment: f.input.environment, nativeParams: {} }), /BUREAU_UNAVAILABLE/)
  assert.equal((await f.core.status()).writeAvailable, false)
})

test("offline tools retain reports and reject delegation, waits and stops", async t => {
  const f = await toolsFixture(t), child = await f.delegate()
  f.setOnline(false)
  for (const [name, args] of [
    ["agency_delegate", { ...f.scope, commandId: randomUUID(), ...f.spec }],
    ["agency_wait", { ...f.scope, waitId: randomUUID(), assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 }],
    ["agency_stop", { ...f.scope, commandId: randomUUID(), agentId: child.value.agent.agentId }]
  ] as const) assert.match((await f.call(name, args)).content[0]!.text, /BUREAU_UNAVAILABLE/)
  const args = { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report: { status: "completed", summary: "Offline evidence", issues: [], validation: [], git: null } }
  const retained = await f.call("agency_report", args, child.token)
  assert.equal(retained.isError, false)
  assert.equal(JSON.parse(retained.content[0]!.text).state, "retained")
  f.setOnline(true); await f.host.replay()
  assert.equal((await f.core.assignment(child.value.assignmentId)).attempt.state, "completed")
  assert.equal(JSON.parse((await f.call("agency_report", args, child.token)).content[0]!.text).state, "accepted")
})

test("MCP negotiates supported versions, rejects unknown versions and answers ping", async () => {
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "future"]) {
    const input = new PassThrough(), output = new PassThrough(), frames: any[] = []
    output.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line)) })
    const running = serveMcp({ input, output, call: async () => ({ content: [], isError: false }), cancel: async () => {} })
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n")
    await until(async () => frames.length === 1 ? true : undefined)
    if (protocolVersion === "future") assert.match(frames[0].error.message, /UNSUPPORTED_PROTOCOL_VERSION/)
    else {
      assert.equal(frames[0].result.protocolVersion, protocolVersion)
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n")
      await until(async () => frames.length === 2 ? true : undefined)
      assert.deepEqual(frames[1].result, {})
    }
    input.end(); await running
  }
})

test("MCP notifications never emit error responses", async () => {
  const input = new PassThrough(), output = new PassThrough(), frames: any[] = []
  output.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line)) })
  const running = serveMcp({ input, output, call: async () => ({ content: [], isError: false }), cancel: async () => { throw new Error("INVALID_WAIT") } })
  input.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: "invalid" }) + "\n")
  await running
  assert.deepEqual(frames, [])
})

test("socket wait cancellation persists while stdio EOF only detaches", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), path = join(f.fixtureRoot, "tools.sock")
  const server = await bindPrivateSocket(f.fixtureRoot, "tools.sock", socket => { void serveToolSocket(socket, f.tools) })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  for (const explicit of [false, true]) {
    const input = new PassThrough(), output = new PassThrough(), waitId = randomUUID()
    const running = serveMcp({ input, output, call: (name, args, signal) => exchangeTool(path, f.token, "call", name, args, signal), cancel: async waitId => { await exchangeTool(path, f.token, "cancel", "agency_wait", { waitId }) } })
    const send = (value: unknown) => input.write(JSON.stringify(value) + "\n")
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    await new Promise(resolve => setImmediate(resolve))
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agency_wait", arguments: { ...f.scope, waitId, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 10000 } } })
    await until(async () => await f.core.waitRecord(waitId) ?? undefined)
    if (explicit) {
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })
      await until(async () => (await f.core.waitRecord(waitId))!.ended ? true : undefined)
    }
    input.end(); await running
    assert.equal((await f.core.waitRecord(waitId))!.ended, explicit)
    if (!explicit) await f.core.cancelWait(waitId)
  }
})

test("unresolved scoped stops pin command evidence and block run closure", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = f.host.stop
  f.host.stop = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  const commandId = randomUUID(), stopping = f.call("agency_stop", { ...f.scope, commandId, agentId: child.value.agent.agentId })
  await entered.promise
  const report = { status: "completed", summary: "Done", issues: [], validation: [], git: null }
  await f.call("agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report }, child.token)
  const waitId = randomUUID()
  await f.core.wait({ waitId, runId: f.root.runId, parent: f.root.root, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 })
  await f.core.cancelWait(waitId)
  await until(async () => { await f.core.schedule(f.root.root); return (await f.store.listDeliveries()).some(delivery => delivery.channel === "prompt" && delivery.state === "delivered") ? true : undefined })
  try {
    await assert.rejects(f.core.closeRun(randomUUID(), f.root.runId), /UNRESOLVED/)
    assert.ok((await loadOrchestrationPins(f.fixtureRoot)).paths.includes(`agents/commands/${commandId}.json`))
  } finally { release.resolve(); await stopping }
})

test("an in-flight old-epoch stop cannot act after root reassociation", async t => {
  const f = await toolsFixture(t), child = await f.delegate()
  await f.call("agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report: { status: "completed", summary: "Done", issues: [], validation: [], git: null } }, child.token)
  const waitId = randomUUID()
  await f.core.wait({ waitId, runId: f.root.runId, parent: f.root.root, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 }); await f.core.cancelWait(waitId)
  await until(async () => { await f.core.schedule(f.root.root); return (await f.store.listDeliveries()).some(delivery => delivery.channel === "prompt" && delivery.state === "delivered") ? true : undefined })
  const asserted = f.core.assertBinding, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.core.assertBinding = async (...args) => { await asserted(...args); entered.resolve(); await release.promise }
  const pending = f.call("agency_stop", { ...f.scope, commandId: randomUUID(), agentId: child.value.agent.agentId })
  await entered.promise; await f.core.closeRun(randomUUID(), f.root.runId); await f.core.beginRun(randomUUID(), f.root.root, "New run"); release.resolve()
  assert.equal((await pending).isError, true)
  assert.equal((await f.service.sessionRecord(child.value.agent.agentId))!.record.phase, "ready")
})

test("MCP accepts omitted tool arguments and inert request metadata", async () => {
  const input = new PassThrough(), output = new PassThrough(), frames: any[] = [], calls: unknown[] = []
  output.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line)) })
  const running = serveMcp({ input, output, call: async (name, args) => { calls.push({ name, args }); return { content: [], isError: false } }, cancel: async () => {} })
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  await until(async () => frames.length === 1 ? true : undefined)
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agency_context", _meta: { progressToken: "fixture" } } })
  input.end(); await running
  assert.deepEqual(calls, [{ name: "agency_context", args: {} }])
  assert.equal(frames[1].result.isError, false)
})

test("MCP bounds retained in-flight request bytes", async () => {
  const input = new PassThrough(), output = new PassThrough(), frames: any[] = []
  output.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line)) })
  const running = serveMcp({ input, output, call: async (_name, _args, signal) => { await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true })); return { content: [], isError: true } }, cancel: async () => {} })
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  await until(async () => frames.length === 1 ? true : undefined)
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  for (let id = 2; id < 5; id++) send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "agency_context", arguments: { payload: "x".repeat(800000) } } })
  input.end(); await assert.rejects(running, /QUEUE_TOO_LARGE/)
})

test("stop retry reverifies a visible but unconfirmed intent before issuing stop", async t => {
  const disk = await coreFixture(t), f = await toolsFixture(t, disk.filesystem), child = await f.delegate(), original = f.host.stop
  let calls = 0
  f.host.stop = async (...args) => { calls++; return original(...args) }
  const args = { ...f.scope, commandId: randomUUID(), agentId: child.value.agent.agentId }
  for (let n = 0; n < 2; n++) {
    disk.failAt("directory-sync", "journal/commits")
    assert.equal((await f.call("agency_stop", args)).isError, true)
    assert.equal(calls, 0)
  }
  assert.equal((await f.call("agency_stop", args)).isError, false)
  assert.equal(calls, 1)
})

test("stop retry reverifies a visible but unconfirmed receipt before acknowledgment", async t => {
  const disk = await coreFixture(t), f = await toolsFixture(t, disk.filesystem), child = await f.delegate(), original = f.host.stop
  f.host.stop = async (...args) => { const receipt = await original(...args); disk.failAt("directory-sync", "journal/commits"); return receipt }
  const args = { ...f.scope, commandId: randomUUID(), agentId: child.value.agent.agentId }
  assert.equal((await f.call("agency_stop", args)).isError, true)
  const journal = f.origins.forRun(f.root.runId), append = journal.append
  let failReceipt = true
  journal.append = async (...args) => { if (args[1] === "scoped-stop-receipt" && failReceipt) { failReceipt = false; disk.failAt("directory-sync", "journal/commits") }; return append(...args) }
  assert.equal((await f.call("agency_stop", args)).isError, true)
  const result = await f.call("agency_stop", args)
  assert.equal(result.isError, false)
  assert.equal(JSON.parse(result.content[0]!.text).state, "stopped")
})

test("human scoped-stop recovery survives sender retirement and returns the original receipt", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), commandId = randomUUID(), journal = f.origins.forRun(f.root.runId)
  const command = { commandId, runId: f.root.runId, bindingEpoch: f.root.bindingEpoch, sender: f.root.execution!, target: child.value.attempt.execution }
  const { canonicalDigest } = await import("../src/orchestration/types.js")
  await journal.append(commandId, "scoped-stop", { ...command, digest: canonicalDigest(command) })
  f.tools.revoke(f.root.execution!)
  const recover = () => (f.core as unknown as { recoverScopedStop(runId: string, commandId: string): Promise<unknown> }).recoverScopedStop(f.root.runId, commandId)
  const receipt = await recover()
  assert.deepEqual(receipt, { commandId, execution: child.value.attempt.execution, state: "stopped" })
  assert.deepEqual(await recover(), receipt)
  assert.equal((await loadOrchestrationPins(f.fixtureRoot)).paths.includes(`agents/commands/${commandId}.json`), false)
  assert.equal((await f.service.sessionRecord(child.value.agent.agentId))!.record.phase, "stopped")
})

test("queued tool wait cannot acquire a replacement provider execution", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), waitId = randomUUID(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), asserted = f.core.assertBinding
  const invocation = await f.host.invocation(f.root.execution!)
  f.core.assertBinding = async (...args) => { await asserted(...args); entered.resolve(); await release.promise }
  const waiting = f.call("agency_wait", { ...f.scope, waitId, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 })
  await entered.promise
  await f.host.stop(randomUUID(), f.root.execution!)
  const restored = await f.core.restoreRun(randomUUID(), f.root.runId, invocation)
  assert.notDeepEqual(restored.execution, f.root.execution)
  release.resolve()
  const result = await waiting
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /STALE_EXECUTION|STALE_BINDING/)
  assert.equal(await f.core.waitRecord(waitId), null)
})

test("large tool wait results preserve report references within the MCP response bound", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), waitId = randomUUID()
  const report = { status: "completed" as const, summary: "Large findings", issues: Array.from({ length: 12 }, () => '"'.repeat(30000)), validation: [], git: null }
  assert.equal((await f.call("agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report }, child.token)).isError, false)
  const args = { ...f.scope, waitId, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 }
  const first = await f.call("agency_wait", args)
  assert.equal(first.isError, false)
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "result", result: first })) < 1024 * 1024)
  const response = JSON.parse(first.content[0]!.text)
  assert.equal(response.reports[0].reportTruncated, true)
  assert.equal(response.reports[0].report.assignmentId, child.value.assignmentId)
  assert.equal(response.reports[0].report.attemptId, child.value.attempt.ref.attemptId)
  assert.equal(response.reports[0].report.report.issueCount, 12)
  assert.deepEqual(await f.call("agency_wait", args), first)
  const input = new PassThrough(), output = new PassThrough(), frames: any[] = []
  output.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line)) })
  const serving = serveMcp({ input, output, call: (name, args, signal) => f.call(name, args, f.token, signal), cancel: id => f.core.cancelWait(id).then(() => {}) })
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n")
  await until(async () => frames.length === 1 ? true : undefined)
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agency_wait", arguments: args } }) + "\n")
  await until(async () => frames.length === 2 ? true : undefined)
  input.end(); await serving
  assert.deepEqual(frames[1].result, first)
  assert.equal(frames[1].error, undefined)
  const evidence = JSON.parse((await f.call("agency_inspect", { runId: f.root.runId, assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId })).content[0]!.text)
  assert.equal(evidence.reportAttemptId, child.value.attempt.ref.attemptId)
  assert.notEqual(evidence.reportPage.nextCursor, null)
  assert.deepEqual((await f.core.waitRecord(waitId))!.result!.reports[0]!.report.report, report)
  assert.equal((await f.core.inbox(f.root.root, f.root.runId)).pending.length, 0)
})

test("operational scoped stop updates attempts and waits without restarting Bureau", async t => {
  const f = await toolsFixture(t), child = await f.delegate()
  await until(async () => (await f.store.readAttempt(child.value.attempt.ref.attemptId))?.state === "awaiting_report" ? true : undefined)
  const result = await f.call("agency_stop", { ...f.scope, commandId: randomUUID(), agentId: child.value.agent.agentId })
  assert.equal(result.isError, false)
  await until(async () => (await f.store.readAttempt(child.value.attempt.ref.attemptId))?.state === "interrupted" ? true : undefined)
  assert.equal((await f.core.assignment(child.value.assignmentId)).attempt.state, "interrupted")
  const wait = await f.core.wait({ waitId: randomUUID(), runId: f.root.runId, parent: f.root.root, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 })
  assert.equal(wait.kind, "terminal_failure")
  const retry = await f.core.retry(randomUUID(), child.value.assignmentId, "replace", { environment: f.input.environment, nativeParams: { mcpServers: [] } })
  assert.notEqual(retry.agent.agentId, child.value.agent.agentId)
})

test("human scoped-stop recovery never stops a replacement target", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), commandId = randomUUID(), original = child.value.attempt.execution
  const { canonicalDigest } = await import("../src/orchestration/types.js")
  const command = { commandId, runId: f.root.runId, bindingEpoch: f.root.bindingEpoch, sender: f.root.execution!, target: original }
  await f.origins.forRun(f.root.runId).append(commandId, "scoped-stop", { ...command, digest: canonicalDigest(command) })
  const invocation = await f.host.invocation(original)
  await f.host.stop(randomUUID(), original)
  const restored = await f.core.retry(randomUUID(), child.value.assignmentId, "restore", invocation)
  const receipt = await f.core.recoverScopedStop(f.root.runId, commandId)
  assert.equal(receipt.state, "stale")
  assert.deepEqual(receipt.execution, original)
  assert.notDeepEqual(restored.attempt.execution, original)
  assert.equal((await f.service.sessionRecord(restored.agent.agentId))!.record.phase, "ready")
  assert.deepEqual(await f.core.recoverScopedStop(f.root.runId, commandId), receipt)
})

test("replacement credentials cannot replay a wait admitted by an older execution", async t => {
  const f = await toolsFixture(t), child = await f.delegate(), waitId = randomUUID()
  await f.call("agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: child.value.assignmentId, attemptId: child.value.attempt.ref.attemptId, report: { status: "completed", summary: "Finished", issues: [], validation: [], git: null } }, child.token)
  const args = { ...f.scope, waitId, assignmentIds: [child.value.assignmentId], after: 0, timeoutMs: 0 }
  assert.equal((await f.call("agency_wait", args)).isError, false)
  const invocation = await f.host.invocation(f.root.execution!)
  await f.host.stop(randomUUID(), f.root.execution!)
  const restored = await f.core.restoreRun(randomUUID(), f.root.runId, invocation)
  const result = await f.call("agency_wait", args, f.tools.tokenFor(restored.execution!)!)
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /STALE_BINDING/)
  assert.deepEqual((await f.core.waitRecord(waitId))!.target, f.root.execution)
})