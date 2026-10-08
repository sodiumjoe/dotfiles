import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { createHostCoordination } from "../src/handler/host-coordination.js"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import type { BridgeConnection } from "../src/bridge/ssh.js"
import type { ExecutionRef } from "../src/orchestration/types.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

type Node = { fixture: Awaited<ReturnType<typeof agentServiceFixture>>; coordination: Awaited<ReturnType<typeof createHostCoordination>>; server: Awaited<ReturnType<typeof createHandlerBridge>> }
async function cluster(t: TestContext, publication?: import("../src/bureau/publication-policy.js").PublicationPolicy) {
  const nodes: Node[] = [], connections: BridgeConnection[] = []
  t.after(async () => { for (const connection of connections) connection.close(); for (const node of nodes) await node.coordination.close(); for (const node of nodes) await node.server.close(); for (const node of nodes) { await node.fixture.service.freezeAndDrain(true); await node.fixture.service.verifyDischarged() }; t.diagnostic("cross-host fixture cleanup: zero owned survivors") })
  async function mount(fixture: Node["fixture"]) {
    const hostId = fixture.context.paths.hostKey
    let server: Node["server"]
    let attached: import("../src/bureau/entry.js").EditorReceipt | null = null
    const coordination = await createHostCoordination({ entryDriver: { async ensure() { return { editorId: randomUUID(), session: "owned-entry", pane: "%1" } }, async activate(_intent, editor) { attached = editor }, async inspect() { return attached } }, root: fixture.root, runtimeRoot: fixture.root, hostId, agents: fixture.service, coordinator: (payload, signal) => server.coordinatorRequest(payload, signal), async connect(enrollment) {
      const destination = nodes.find(node => node.fixture.context.paths.hostKey === enrollment.hostId)!
      const peer = await connectHandlerBridge({ root: destination.fixture.root, hostId: enrollment.hostId, handlerGeneration: destination.fixture.service.handlerGeneration }), hello = await peer.ready
      await peer.request("coordinate", {})
      const connection: BridgeConnection = { ...peer, hello, snapshot: await destination.coordination.origin.snapshot(), diagnostics: "", request(channel, payload, options) {
        if (["launch", "launchRoot", "restoreRoot"].includes(channel)) return peer.request("invoke", { channel, payload, invocation: { environment: destination.fixture.input.environment, nativeParams: (payload as { nativeParams: object }).nativeParams } }, options)
        return peer.request(channel, payload, options)
      } }
      connections.push(connection)
      return connection
    } })
    server = await createHandlerBridge({ root: fixture.root, host: coordination.origin, journals: coordination.origins, sourceRevision: "a".repeat(40), replay: () => coordination.replay() })
    return { fixture, coordination, server }
  }
  for (const hostId of ["a", "b", "c", "d"].map(value => value.repeat(64))) {
    const fixture = await agentServiceFixture(t, { hostId, prompt: "hang" })
    nodes.push(await mount(fixture))
  }
  const [laptop, a, b, c] = nodes as [Node, Node, Node, Node]
  for (const node of [a, b, c]) await laptop.coordination.bureau.enroll({ inventoryId: randomUUID(), hostId: node.fixture.context.paths.hostKey, hostname: "fixture-" + node.fixture.context.paths.hostKey[0], agyPath: "/opt/agency/agy", loginShell: "/bin/bash" })
  await laptop.coordination.bureau.enable()
  const invocation = { environment: laptop.fixture.input.environment, nativeParams: { mcpServers: [] } }
  const root = await laptop.coordination.bureau.startRun(randomUUID(), { hostId: a.fixture.context.paths.hostKey, cwd: a.fixture.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Coordinate A, B and C", ...(publication ? { publication } : {}) }, invocation)
  const scope = { runId: root.runId, bindingEpoch: root.bindingEpoch }, rootToken = a.coordination.tools.tokenFor(root.execution!)!
  const delegate = async (node: Node, token: string, destination: Node, description: string, commandId = randomUUID()) => {
    const args = { ...scope, commandId, description, hostId: destination.fixture.context.paths.hostKey, cwd: destination.fixture.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null }
    const result = await node.coordination.tools.call(token, "agency_delegate", args)
    return { args, result, value: JSON.parse(result.content[0]!.text) }
  }
  const report = (node: Node, token: string, assignment: { assignmentId: string; attempt: { ref: { attemptId: string } } }, summary: string) => node.coordination.tools.call(token, "agency_report", { ...scope, commandId: randomUUID(), assignmentId: assignment.assignmentId, attemptId: assignment.attempt.ref.attemptId, report: { status: "completed", summary, issues: [], validation: [], git: null } })
  const child = await delegate(a, rootToken, b, "Worker B")
  assert.equal(child.result.isError, false, JSON.stringify(child.result))
  const childToken = b.coordination.tools.tokenFor(child.value.attempt.execution)!
  const restart = async (node: Node, handler = false) => { await node.coordination.close(); await node.server.close(); if (handler) node.fixture.service = await node.fixture.restart(); Object.assign(node, await mount(node.fixture)) }
  return { nodes, connections, restart, laptop, a, b, c, root, scope, rootToken, child: child.value, childToken, delegate, report }
}

test("four Handler nodes preserve A to B to C lineage and busy-parent wait delivery", { timeout: 30000 }, async t => {
  const f = await cluster(t), grandchild = await f.delegate(f.b, f.childToken, f.c, "Worker C")
  assert.equal(grandchild.result.isError, false, JSON.stringify(grandchild.result))
  assert.deepEqual(f.child.lineage.parent, f.root.root)
  assert.deepEqual(grandchild.value.lineage.parent, f.child.agent)
  assert.equal(grandchild.value.lineage.runId, f.root.runId)
  const waitId = randomUUID(), waiting = f.b.coordination.tools.call(f.childToken, "agency_wait", { ...f.scope, waitId, assignmentIds: [grandchild.value.assignmentId], after: 0, timeoutMs: 10000 })
  await until(async () => await f.laptop.coordination.bureau.waitRecord(waitId) ?? undefined)
  const token = f.c.coordination.tools.tokenFor(grandchild.value.attempt.execution)!
  assert.equal((await f.report(f.c, token, grandchild.value, "C completed")).isError, false)
  const result = await waiting
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(JSON.parse(result.content[0]!.text).reports.length, 1)
  const record = await f.b.fixture.service.sessionRecord(f.child.agent.agentId)
  assert.equal(record!.live, true)
  await assert.rejects(f.b.fixture.service.setSession(f.child.attempt.execution, "session/set_model", { modelId: "model-a" }), (error: unknown) => (error as { code?: string }).code === "BUSY")
  assert.equal(f.a.fixture.spawns(), 1)
  assert.equal(f.b.fixture.spawns(), 1)
  assert.equal(f.c.fixture.spawns(), 1)
})

test("reconnect automatically replays a retained control with its original stable command ID", { timeout: 30000 }, async t => {
  const f = await cluster(t)
  await f.laptop.coordination.bureau.disable()
  const pending = await f.delegate(f.b, f.childToken, f.c, "Offline child C")
  assert.equal(pending.value.state, "pending")
  assert.equal(f.c.fixture.spawns(), 0)
  await f.laptop.coordination.bureau.enable()
  await until(async () => f.c.fixture.spawns() === 1 ? true : undefined, 10000)
  const repeated = await f.b.coordination.tools.call(f.childToken, "agency_delegate", pending.args)
  assert.equal(repeated.isError, false, JSON.stringify(repeated))
  assert.ok(JSON.parse(repeated.content[0]!.text).assignmentId)
  assert.equal(f.c.fixture.spawns(), 1)
  assert.equal(f.b.fixture.spawns(), 1)
})

test("a retired offline control sender cannot block another provider's pending delegation", { timeout: 30000 }, async t => {
  const { readFile } = await import("node:fs/promises"), { join } = await import("node:path")
  const f = await cluster(t), survivor = await f.delegate(f.a, f.rootToken, f.b, "Surviving provider B"), token = f.b.coordination.tools.tokenFor(survivor.value.attempt.execution)!
  await f.laptop.coordination.bureau.disable()
  const stale = await f.delegate(f.b, f.childToken, f.c, "Retired sender's child"), pending = await f.delegate(f.b, token, f.c, "Surviving sender's child")
  assert.equal(stale.value.state, "pending")
  assert.equal(pending.value.state, "pending")
  await f.b.coordination.origin.stop(randomUUID(), f.child.attempt.execution)
  await f.laptop.coordination.bureau.enable()
  await until(async () => f.c.fixture.spawns() === 1 ? true : undefined, 10000)
  const result = await f.b.coordination.tools.call(token, "agency_delegate", pending.args)
  assert.equal(result.isError, false, JSON.stringify(result))
  const terminal = JSON.parse(await readFile(join(f.b.fixture.root, "orchestration/routed-tool-results", stale.args.commandId + ".json"), "utf8"))
  assert.equal(terminal.isError, true)
  assert.deepEqual(JSON.parse(terminal.content[0].text), { error: "STALE_EXECUTION" })
  assert.equal((await f.laptop.coordination.bureau.inspect(f.root.runId)).assignments.filter(item => item.spec.description === "Retired sender's child").length, 0)
  assert.equal(f.c.fixture.spawns(), 1)
  assert.equal(f.b.fixture.spawns(), 2)
})

test("offline report replay preserves providers and accepted evidence through origin retirement", { timeout: 30000 }, async t => {
  const f = await cluster(t)
  await f.laptop.coordination.bureau.disable()
  assert.equal((await f.b.fixture.service.sessionRecord(f.child.agent.agentId))!.live, true)
  const result = await f.report(f.b, f.childToken, f.child, "Retained offline")
  assert.equal(JSON.parse(result.content[0]!.text).state, "retained")
  const before = await f.b.coordination.origins.forRun(f.root.runId).retainedRead(0, 256)
  const report = before.entries.find(entry => entry.kind === "report-retained")!
  assert.equal(await f.b.coordination.origins.forRun(f.root.runId).acknowledged("bureau", report), false)
  await f.b.coordination.origin.stop(randomUUID(), f.child.attempt.execution as ExecutionRef)
  await f.laptop.coordination.bureau.enable()
  await until(async () => (await f.laptop.coordination.bureau.assignment(f.child.assignmentId)).attempt.state === "completed" ? true : undefined)
  assert.equal(await f.b.coordination.origins.forRun(f.root.runId).acknowledged("bureau", report), true)
  assert.equal(f.b.fixture.spawns(), 1)
})

test("coordinator restart reconnects enrolled hosts and accepts an offline report once", { timeout: 30000 }, async t => {
  const f = await cluster(t)
  await f.laptop.coordination.bureau.disable()
  await f.report(f.b, f.childToken, f.child, "Before coordinator restart")
  await f.restart(f.laptop)
  assert.equal((await f.laptop.coordination.bureau.status()).enabled, false)
  await f.laptop.coordination.bureau.enable()
  await until(async () => (await f.laptop.coordination.bureau.assignment(f.child.assignmentId)).attempt.state === "completed" ? true : undefined)
  await f.restart(f.laptop)
  assert.equal((await f.laptop.coordination.bureau.status()).enabled, true)
  const inbox = await f.laptop.coordination.bureau.inbox(f.root.root, f.root.runId)
  assert.equal(inbox.entries.length, 1)
  assert.equal(f.a.fixture.spawns(), 1)
  assert.equal(f.b.fixture.spawns(), 1)
})

for (const replacement of ["a", "b"] as const) test(`${replacement.toUpperCase()} Handler generation replacement fences stale actions without restoring providers`, { timeout: 30000 }, async t => {
  const f = await cluster(t), node = f[replacement], target = replacement === "a" ? f.root.execution! : f.child.attempt.execution
  await f.laptop.coordination.bureau.disable()
  await f.restart(node, true)
  await f.laptop.coordination.bureau.enable()
  await f.laptop.coordination.bureau.reconcile()
  assert.equal(node.fixture.spawns(), 1)
  assert.equal((await node.fixture.service.sessionRecord(target.agentId))!.live, false)
  const adapter = f.laptop.coordination.remote.find(host => host.hostId === target.hostId)!
  await assert.rejects(adapter.submit(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "stale" }] }), /STALE_HANDLER/)
  if (replacement === "b") assert.equal((await f.laptop.coordination.bureau.assignment(f.child.assignmentId)).attempt.state, "interrupted")
  assert.equal(node.fixture.spawns(), 1)
})

test("SSH loss preserves provider state while provider exit changes the assignment", { timeout: 30000 }, async t => {
  const f = await cluster(t), initial = (await f.laptop.coordination.bureau.assignment(f.child.assignmentId)).attempt.state
  await f.laptop.coordination.bureau.disable()
  assert.equal((await f.b.fixture.service.sessionRecord(f.child.agent.agentId))!.live, true)
  assert.equal((await f.laptop.coordination.bureau.assignment(f.child.assignmentId)).attempt.state, initial)
  f.b.fixture.exit(f.child.agent.agentId)
  await until(async () => (await f.b.fixture.service.sessionRecord(f.child.agent.agentId))!.record.phase === "failed" ? true : undefined)
  await f.laptop.coordination.bureau.enable()
  await f.laptop.coordination.bureau.reconcile()
  assert.equal((await f.laptop.coordination.bureau.assignment(f.child.assignmentId)).attempt.state, "failed")
  assert.equal(f.b.fixture.spawns(), 1)
})

test("an independent local run on an enrolled host does not enter the laptop Bureau", { timeout: 30000 }, async t => {
  const f = await cluster(t)
  await f.b.coordination.bureau.enable()
  const local = await f.b.coordination.bureau.startRun(randomUUID(), { hostId: f.b.fixture.context.paths.hostKey, cwd: f.b.fixture.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Independent local run" }, { environment: f.b.fixture.input.environment, nativeParams: { mcpServers: [] } })
  await f.laptop.coordination.bureau.reconcile()
  assert.equal((await f.laptop.coordination.bureau.list()).length, 1)
  assert.equal((await f.b.coordination.bureau.list()).length, 1)
  const stream = await f.b.coordination.origins.forRun(local.runId).retainedRead(0, 256)
  assert.ok(stream.entries.length)
  for (const entry of stream.entries) assert.equal(await f.b.coordination.origins.forRun(local.runId).acknowledged("bureau", entry), false)
  assert.equal(f.b.fixture.spawns(), 2)
})

test("busy parent receives one notification when its turn settles", { timeout: 30000 }, async t => {
  const f = await cluster(t)
  await f.a.coordination.origin.submit(f.root.execution!, { submissionId: randomUUID(), prompt: [{ type: "text", text: "Human turn" }] })
  await f.a.fixture.promptEntered
  await f.report(f.b, f.childToken, f.child, "Notification after settlement")
  await until(async () => (await f.laptop.coordination.bureau.inbox(f.root.root, f.root.runId)).entries.length === 1 ? true : undefined)
  const prompts = () => f.a.fixture.methodHistory.filter(method => method === "session/prompt").length
  assert.equal(prompts(), 1)
  await f.laptop.coordination.bureau.schedule(f.root.root)
  assert.equal((await f.laptop.coordination.bureau.inbox(f.root.root, f.root.runId)).deliveries[0]!.state, "queued")
  f.a.fixture.completePrompt(f.root.root.agentId)
  await until(async () => (await f.laptop.coordination.bureau.inbox(f.root.root, f.root.runId)).deliveries.some(delivery => delivery.state === "accepted" || delivery.state === "completed") ? true : undefined)
  await f.laptop.coordination.bureau.reconcile()
  assert.equal(prompts(), 2)
  assert.equal((await f.laptop.coordination.bureau.inbox(f.root.root, f.root.runId)).deliveries.length, 1)
})

test("failed enrollment publication cannot mutate adapters or start transport", { timeout: 30000 }, async t => {
  const { defaultFileSystem } = await import("../src/orchestration/storage.js")
  const f = await cluster(t), previous = defaultFileSystem.rename, inventoryId = randomUUID(), count = f.connections.length
  defaultFileSystem.rename = async (source, destination) => { if (String(destination).endsWith(`/hosts/${inventoryId}.json`)) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); return previous(source, destination) }
  try { await assert.rejects(f.laptop.coordination.bureau.enroll({ inventoryId, hostId: "e".repeat(64), hostname: "fixture-e", agyPath: "/opt/agency/agy", loginShell: "/bin/bash" }), /ENOSPC/) }
  finally { defaultFileSystem.rename = previous }
  assert.equal(f.laptop.coordination.remote.length, 3)
  assert.equal((await f.laptop.coordination.bureau.enrolledHosts()).length, 3)
  assert.equal(f.connections.length, count)
  assert.equal(f.c.fixture.spawns(), 0)
})

test("human permissions from remote parent A route through laptop Bureau to origin B", { timeout: 30000 }, async t => {
  const f = await cluster(t), execution = f.child.attempt.execution
  let responses = 0
  const ref = await f.b.fixture.service.permissionRouting.open({ agentId: execution.agentId, handlerGeneration: execution.handlerGeneration, providerGeneration: execution.providerGeneration },
    { toolCall: { toolCallId: "same-native-tool", title: "Child B edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
    f.b.fixture.workspace, async () => { responses++ })
  const snapshot = await f.a.coordination.human({ op: "permission_snapshot" }) as { pending: Array<{ ref: unknown }> }
  assert.deepEqual(snapshot.pending.map(offer => offer.ref), [ref])
  const commandId = randomUUID()
  const receipt = await f.a.coordination.human({ op: "permission_decide", commandId, ref, optionId: "allow" }) as { state: string }
  assert.equal(receipt.state, "applied")
  assert.equal((await f.a.coordination.human({ op: "permission_decide", commandId, ref, optionId: "allow" }) as { state: string }).state, "applied")
  assert.equal(responses, 1)
  await assert.rejects(f.a.coordination.human({ op: "delegate", commandId }), /UNSUPPORTED_HUMAN_CONTROL/)
})

test("four Handler roster and entry route from remote parent through Bureau to the exact origin", { timeout: 30000 }, async t => {
  const f = await cluster(t), grandchild = await f.delegate(f.b, f.childToken, f.c, "Worker C")
  assert.equal(grandchild.result.isError, false)
  const roster = await f.a.coordination.human({ op: "roster_snapshot" }) as import("../src/bureau/roster.js").RosterSnapshot
  assert.equal(roster.hosts.length, 4)
  const child = roster.agents.find(row => row.agent.agentId === f.child.agent.agentId)!, deepest = roster.agents.find(row => row.agent.agentId === grandchild.value.agent.agentId)!
  assert.equal(child.depth, 1); assert.equal(deepest.depth, 2)
  assert.equal(child.providerPhase, "ready"); assert.equal(child.attempt!.state, "running"); assert.equal(child.connectivity, "connected")
  const execution = child.execution!, ref = { inventoryId: child.inventoryId!, hostId: child.agent.hostId,
    target: { agentId: execution.agentId, handlerGeneration: execution.handlerGeneration, providerGeneration: execution.providerGeneration } }
  const prepared = await f.a.coordination.human({ op: "entry_prepare", commandId: randomUUID(), ref }) as { intent: import("../src/bureau/entry.js").EntryIntent; enrollment: { hostId: string } }
  assert.deepEqual(prepared.intent.ref, ref); assert.equal(prepared.enrollment.hostId, ref.hostId)
  const consumed = await f.b.coordination.human({ op: "entry_consume", commandId: prepared.intent.commandId, digest: prepared.intent.digest, hostId: ref.hostId, inventoryId: ref.inventoryId }) as { state: string }
  assert.equal(consumed.state, "consumed")
  await assert.rejects(f.a.coordination.human({ op: "entry_consume", commandId: prepared.intent.commandId, digest: prepared.intent.digest, hostId: ref.hostId, inventoryId: ref.inventoryId }), /HOST_IDENTITY_CHANGED/)
  assert.equal(f.a.fixture.spawns(), 1); assert.equal(f.b.fixture.spawns(), 1); assert.equal(f.c.fixture.spawns(), 1)
})

test("remote code publication, offline report replay and human immutable integration compose", { timeout: 45000 }, async t => {
  const { gitFixture, git } = await import("./git-support.js"), g = await gitFixture(t)
  const f = await cluster(t, { destinations: [{ hostId: "c".repeat(64), repository: g.repository, remote: g.remote }] })
  const result = await f.a.coordination.tools.call(f.rootToken, "agency_delegate", { ...f.scope, commandId: randomUUID(), description: "Implement code", hostId: "c".repeat(64), cwd: g.repository, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: { repository: g.repository, remote: g.remote, baseOid: g.baseOid } })
  assert.equal(result.isError, false, JSON.stringify(result))
  const assignment = JSON.parse(result.content[0]!.text), token = f.b.coordination.tools.tokenFor(assignment.attempt.execution)!, preparation = assignment.attempt.git
  const oid = await g.commit("code", "verified", preparation.cwd)
  const publishId = randomUUID(), published = await f.b.coordination.tools.call(token, "agency_publish", { ...f.scope, commandId: publishId, resultOid: oid, expectedRemoteOid: null })
  assert.equal(published.isError, false, JSON.stringify(published)); assert.equal(JSON.parse(published.content[0]!.text).state, "published")
  await f.laptop.coordination.bureau.disable()
  const report = await f.b.coordination.tools.call(token, "agency_report", { ...f.scope, commandId: randomUUID(), assignmentId: assignment.assignmentId, attemptId: assignment.attempt.ref.attemptId,
    report: { status: "completed", summary: "Code complete", issues: [], validation: [{ argv: ["sh", "-c", "worker claim"], cwd: preparation.cwd, exitCode: 0, result: "Claim only" }], git: { ...preparation.exchange, resultOid: oid, published: true, publicationCommandId: publishId } } })
  assert.equal(report.isError, false, JSON.stringify(report)); assert.equal(JSON.parse(report.content[0]!.text).state, "retained")
  await f.laptop.coordination.bureau.enable()
  await until(async () => (await f.laptop.coordination.bureau.assignment(assignment.assignmentId)).attempt.state === "completed" ? true : undefined, 15000)
  await f.laptop.coordination.human({ op: "git_configure", destinationCwd: g.destination, remote: g.remote, validations: [[process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync('code.txt','utf8'))"]] })
  const proposal = await f.a.coordination.human({ op: "git_verify", reportId: assignment.attempt.ref.attemptId, destinationCwd: g.destination }) as import("../src/bureau/git-results.js").ResultProposal
  assert.deepEqual(proposal.issues, []); assert.equal(proposal.validations[0]!.result, "verified")
  const newer = await g.commit("later", "later", preparation.cwd)
  assert.equal((await f.b.coordination.origin.publish(randomUUID(), assignment.attempt.execution, newer, oid)).state, "published")
  const receipt = await f.a.coordination.human({ op: "git_integrate", commandId: randomUUID(), proposalId: proposal.proposalId, expectedHead: proposal.destination.head, strategy: "merge" }) as { state: string }
  assert.equal(receipt.state, "integrated")
  await git(["merge-base", "--is-ancestor", oid, "HEAD"], g.destination)
  await assert.rejects(git(["merge-base", "--is-ancestor", newer, "HEAD"], g.destination))
})