import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { agentHandlerFixture } from "./agent-support.js"
import { acpFixture, editorFixture } from "./acp-support.js"
import { until } from "./control-support.js"
import { BUREAU_PROTOCOL, exchangeBureau, type BureauRequest } from "../src/bureau/protocol.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { exchangeTool } from "../src/orchestration/tool-client.js"
import { createBureauStore } from "../src/bureau/store.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { journalEntries } from "../src/orchestration/reports.js"
import type { AssignmentView, RunView } from "../src/bureau/types.js"
import type { ProcessIdentity } from "../src/platform/types.js"

type RequestOperation<T = BureauRequest> = T extends unknown ? Omit<T, "protocol" | "requestId" | "handlerGeneration"> : never

export async function linuxStackFixture(t: TestContext) {
  const f = await agentHandlerFixture(t, { nativeAcp: true, selectionCatalog: true, delegationHelpers: true })
  const call = async (operation: RequestOperation) => {
    const generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
    const reply = await exchangeBureau(createConnection(join(f.paths.runtimeRoot, "bureau.sock")), { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, ...operation } as BureauRequest, 150000)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    return reply.ok ? reply.result : null
  }
  const invocation = { environment: { HOME: join(f.root, "home"), PATH: process.env.PATH!, FIXTURE_ROOT: f.root, FIXTURE_BACKEND: "codex-acp", FIXTURE_AGENCY_TOOLS: "1", AGENCY_TEST_OWNERSHIP_MODULE: fileURLToPath(new URL("./fixtures/ownership.js", import.meta.url)), ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("AGENCY_TEST_") && value !== undefined)) }, nativeParams: {} }
  await call({ op: "bureau_enable" })
  const root = await call({ op: "run_start", commandId: randomUUID(), input: { hostId: f.paths.hostKey, cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Linux current stack" }, invocation } as any) as RunView
  async function tool(agentId: string, name: string, args: Record<string, unknown>) {
    const descriptor = JSON.parse(await readFile(join(f.root, "tools-descriptor-" + agentId + ".json"), "utf8"))
    const token = descriptor.env.find((env: { name: string; value: string }) => env.name === "AGENCY_TOOLS_TOKEN").value
    const response = await exchangeTool(join(f.paths.runtimeRoot, "orchestration.sock"), token, "call", name, args)
    assert.equal(response.isError, false, JSON.stringify(response))
    return JSON.parse(response.content[0]!.text)
  }
  const delegate = async () => await call({ op: "assignment_create", commandId: randomUUID(), runId: root.runId, input: { parent: root.root, description: "Linux worker", hostId: f.paths.hostKey, cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null }, invocation } as any) as AssignmentView
  const report = async (child: AssignmentView) => tool(child.agent.agentId, "agency_report", { commandId: randomUUID(), runId: root.runId, bindingEpoch: root.bindingEpoch, assignmentId: child.assignmentId, attemptId: child.attempt.ref.attemptId, report: { status: "completed", summary: "Linux retained report", issues: [], validation: [], git: null } })
  return { ...f, rootRun: root, call, tool, delegate, report }
}

async function evidence(t: TestContext, f: Awaited<ReturnType<typeof agentHandlerFixture>>, name: string) {
  await f.verifyZeroSurvivors()
  const cleanup = await f.cleanupEvidence(), owned: ProcessIdentity[] = [...f.owned, ...cleanup.providers.flatMap(value => value.provider?.group.observed ?? [])]
  assert.deepEqual(cleanup.survivors, [])
  t.diagnostic("agy-linux-case-evidence:" + JSON.stringify({ name, owned, cleanupVerified: true }))
}

if (process.env.AGENCY_LINUX_STACK_CASES === "1") {
  test("root-tools-report-wait", { timeout: 150000 }, async t => {
    const f = await linuxStackFixture(t), child = await f.delegate(), waitId = randomUUID()
    const waiting = f.tool(f.rootRun.root.agentId, "agency_wait", { waitId, runId: f.rootRun.runId, bindingEpoch: f.rootRun.bindingEpoch, assignmentIds: [child.assignmentId], after: 0, timeoutMs: 60000 })
    void waiting.catch(() => undefined)
    await until(async () => await createBureauStore(f.paths.persistentRoot).readWait(waitId) ? true : undefined)
    await f.call({ op: "bureau_disable" })
    await assert.rejects(waiting, /BUREAU_DISABLED/)
    assert.equal((await f.report(child)).state, "retained")
    await f.call({ op: "bureau_enable" })
    const result = await f.tool(f.rootRun.root.agentId, "agency_wait", { waitId, runId: f.rootRun.runId, bindingEpoch: f.rootRun.bindingEpoch, assignmentIds: [child.assignmentId], after: 0, timeoutMs: 60000 })
    assert.equal(result.kind, "reports")
    assert.equal(result.reports.length, 1)
    assert.equal((await createBureauStore(f.paths.persistentRoot).readReport(child.attempt.ref.attemptId))!.input.report.summary, "Linux retained report")
    await evidence(t, f, "root-tools-report-wait")
  })

  test("notification-admission", { timeout: 150000 }, async t => {
    const f = await linuxStackFixture(t), child = await f.delegate()
    await f.report(child)
    const inbox = await until(async () => { const value = await f.call({ op: "inbox_inspect", parent: f.rootRun.root, runId: f.rootRun.runId, after: 0 }) as import("../src/bureau/inbox.js").InboxView; return value.deliveries.some(delivery => delivery.channel === "prompt" && delivery.state === "delivered") ? value : undefined }, 30000)
    const receipt = inbox.deliveries.find(value => value.channel === "prompt")!
    assert.equal(receipt.state, "delivered")
    const admitted = JSON.parse(await readFile(join(f.root, "notification-admission-" + f.rootRun.root.agentId + ".json"), "utf8"))
    assert.equal(admitted.receiptBeforeDispatch, true)
    assert.equal(admitted.submissionId, receipt.deliveryId)
    const entries = await journalEntries(createJournalPool(f.paths.persistentRoot, undefined, Date.now, "origin").forRun(f.rootRun.runId))
    assert.ok(entries.some(entry => entry.kind === "notification-receipt" && (entry.payload as any).state === "accepted"))
    const requests = (await readFile(join(f.root, "codex-acp.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    const prompts = requests.filter(frame => frame.method === "session/prompt")
    assert.equal(prompts.filter(frame => frame.params.prompt[0]?.text.startsWith("Delegated assignments reported:")).length, 1, JSON.stringify(prompts))
    assert.equal(prompts.filter(frame => frame.params.prompt[0]?.text === "Linux worker").length, 1, JSON.stringify(prompts))
    await evidence(t, f, "notification-admission")
  })

  test("headless-permission", { timeout: 90000 }, async t => {
    const f = await acpFixture(t), peer = await f.connect()
    await peer.request("initialize", { protocolVersion: 1 })
    const created = await peer.request("session/new", { cwd: f.workspace, mcpServers: [] }), sid = String(created.sessionId), target = await f.tuple(sid)
    peer.close()
    const prompt = f.prompt(target, "permission"); void prompt.catch(() => undefined)
    await until(async () => (await f.requests("codex-acp")).some(frame => frame.method === "session/prompt") ? true : undefined)
    assert.deepEqual(await f.tuple(sid), target)
    const observer = await f.connect()
    await observer.request("initialize", { protocolVersion: 1 })
    await observer.request("session/load", { sessionId: sid, cwd: f.workspace, mcpServers: [] })
    const offered = await observer.next("session/request_permission")
    observer.respond(offered.id, { outcome: { outcome: "selected", optionId: "allow-once" } })
    await prompt
    await evidence(t, f, "headless-permission")
  })

  test("shared-observers-detach-cancel", { timeout: 90000 }, async t => {
    const f = await acpFixture(t), first = await f.connect(), second = await f.connect()
    await first.request("initialize", { protocolVersion: 1 }); await second.request("initialize", { protocolVersion: 1 })
    const created = await first.request("session/new", { cwd: f.workspace, mcpServers: [] }), sid = String(created.sessionId), target = await f.tuple(sid)
    await second.request("session/load", { sessionId: sid, cwd: f.workspace, mcpServers: [] })
    const prompt = first.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "held" }] }); void prompt.catch(() => undefined)
    await until(async () => (await f.requests("codex-acp")).some(frame => frame.method === "session/prompt") ? true : undefined)
    first.close()
    await second.request("session/cancel", { sessionId: sid })
    await until(async () => (await f.requests("codex-acp")).some(frame => frame.method === "session/cancel") ? true : undefined)
    assert.deepEqual(await f.tuple(sid), target)
    await f.release("codex-acp")
    await evidence(t, f, "shared-observers-detach-cancel")
  })

  test("handler-reconcile-restore", { timeout: 90000 }, async t => {
    const f = await acpFixture(t), peer = await f.connect()
    await peer.request("initialize", { protocolVersion: 1 })
    const created = await peer.request("session/new", { cwd: f.workspace, mcpServers: [] }), sid = String(created.sessionId), original = await f.tuple(sid)
    const prompt = peer.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "held" }] }); void prompt.catch(() => undefined)
    await until(async () => (await f.requests("codex-acp")).some(frame => frame.method === "session/prompt") ? true : undefined)
    await f.crashHandler(); await assert.rejects(prompt); await f.restart({ nativeAcp: true, selectionCatalog: true })
    assert.equal((await f.list()).agents[0]!.cleanup, "verified")
    await f.restoreSession(sid, { AGENCY_TEST_EDITOR_MARKER: "fresh-linux-invocation" })
    const restored = await f.tuple(sid)
    assert.notEqual(restored.handlerGeneration, original.handlerGeneration)
    assert.notEqual(restored.providerGeneration, original.providerGeneration)
    assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt").length, 1)
    assert.ok((await f.requests("codex-acp")).some(frame => frame.method === "fixture/environment" && frame.params?.AGENCY_TEST_EDITOR_MARKER === "fresh-linux-invocation"))
    await evidence(t, f, "handler-reconcile-restore")
  })

  test("editor-replacement", { timeout: 120000 }, async t => {
    const f = await acpFixture(t), first = await editorFixture(f)
    await first.lua("(function() AgencyFixture.new({cwd=vim.fn.getcwd()}); return true end)()")
    await until(async () => await first.lua("fixture_manager.session_id ~= nil and not fixture_manager._is_restoring_session") ? true : undefined)
    const sid = String(await first.lua("fixture_manager.session_id")), target = await f.tuple(sid)
    await first.exit()
    const second = await editorFixture(f), record = (await f.inventory()).agents[0]!
    await second.lua(`(function() AgencyFixture.open(vim.json.decode(${JSON.stringify(JSON.stringify({ record, live: true }))})); return true end)()`)
    await until(async () => await second.lua("fixture_manager.session_id ~= nil and not fixture_manager._is_restoring_session") ? true : undefined)
    assert.equal(await second.lua("fixture_manager.session_id"), sid)
    assert.deepEqual(await f.tuple(sid), target)
    await second.exit()
    await evidence(t, f, "editor-replacement")
  })
}