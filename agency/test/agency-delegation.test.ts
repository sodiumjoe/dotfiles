import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createConnection } from "node:net"
import { BUREAU_PROTOCOL, exchangeBureau, type BureauRequest } from "../src/bureau/protocol.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { agentHandlerFixture } from "./agent-support.js"
import { until } from "./control-support.js"

async function fixture(t: Parameters<typeof agentHandlerFixture>[0]) {
  const f = await agentHandlerFixture(t, { nativeAcp: true, selectionCatalog: true, providerScenario: "agency-tools", delegationHelpers: true })
  const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const call = async (request: Omit<BureauRequest, "protocol" | "requestId" | "handlerGeneration">) => exchangeBureau(createConnection(join(f.paths.runtimeRoot, "bureau.sock")), { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.generation, ...request } as BureauRequest, 150000)
  return { ...f, call }
}

test("operational Bureau launches a provider that uses the injected MCP helper", { timeout: 120000 }, async t => {
  const f = await fixture(t)
  assert.equal((await f.call({ op: "bureau_enable" })).ok, true)
  const commandId = randomUUID(), input = { hostId: f.paths.hostKey, cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, objective: "Local delegation fixture" }
  const invocation = { environment: { HOME: join(f.root, "home"), PATH: process.env.PATH!, FIXTURE_ROOT: f.root, FIXTURE_BACKEND: "codex-acp", FIXTURE_AGENCY_TOOLS: "1" }, nativeParams: { mcpServers: [{ name: "external", command: "external-fixture", args: [], env: [{ name: "SECRET", value: "external-fixture-secret" }] }] } }
  const reply = await f.call({ op: "run_start", commandId, input, invocation } as any)
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const run = (reply as any).result
  assert.equal(run.state, "active", JSON.stringify({ run, agents: await f.list() }))
  const bootstrap = JSON.parse(await readFile(join(f.root, "tools-bootstrap-" + run.root.agentId + ".json"), "utf8"))
  assert.equal(bootstrap.list.result.tools.length, 7)
  assert.equal(bootstrap.denied.result.isError, true)
  assert.match(bootstrap.denied.result.content[0].text, /NOT_READY/)
  await writeFile(join(f.root, "tool-action.json"), JSON.stringify({ name: "agency_delegate", arguments: { commandId: randomUUID(), runId: run.runId, bindingEpoch: run.bindingEpoch, description: "Child fixture", hostId: f.paths.hostKey, cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {}, git: null } }), { mode: 0o600 })
  await f.prompt({ agentId: run.execution.agentId, handlerGeneration: run.execution.handlerGeneration, providerGeneration: run.execution.providerGeneration }, "fixture-tools")
  const result = JSON.parse(await readFile(join(f.root, "tools-action-" + run.root.agentId + ".json"), "utf8"))
  assert.equal(result.first.result.isError, false, JSON.stringify(result))
  assert.deepEqual(result.first.result, result.repeated.result)
  const child = JSON.parse(result.first.result.content[0].text)
  const reportId = randomUUID()
  await writeFile(join(f.root, "tool-action.json"), JSON.stringify({ name: "agency_report", arguments: { commandId: reportId, runId: run.runId, bindingEpoch: run.bindingEpoch, assignmentId: child.assignmentId, attemptId: child.attempt.ref.attemptId, report: { status: "completed", summary: "Fixture report", issues: [], validation: [], git: null } } }), { mode: 0o600 })
  await f.prompt({ agentId: child.attempt.execution.agentId, handlerGeneration: child.attempt.execution.handlerGeneration, providerGeneration: child.attempt.execution.providerGeneration }, "fixture-tools")
  const report = JSON.parse(await readFile(join(f.root, "tools-action-" + child.agent.agentId + ".json"), "utf8"))
  assert.equal(report.first.result.isError, false, JSON.stringify(report))
  assert.deepEqual(report.first.result, report.repeated.result)
  await until(async () => { const response = await f.call({ op: "assignment_inspect", assignmentId: child.assignmentId } as any); return response.ok && (response.result as any).attempt.state === "completed" ? true : undefined }, 15000)
  assert.deepEqual((await f.call({ op: "run_start", commandId, input, invocation } as any) as any).result, run)
  await writeFile(join(f.root, "tool-action.json"), JSON.stringify({ name: "agency_stop", arguments: { commandId: randomUUID(), runId: run.runId, bindingEpoch: run.bindingEpoch, agentId: child.agent.agentId } }), { mode: 0o600 })
  await f.prompt({ agentId: run.execution.agentId, handlerGeneration: run.execution.handlerGeneration, providerGeneration: run.execution.providerGeneration }, "fixture-tools")
  const stopped = JSON.parse(await readFile(join(f.root, "tools-action-" + run.root.agentId + ".json"), "utf8"))
  assert.equal(stopped.first.result.isError, false, JSON.stringify(stopped))
  assert.equal(JSON.parse(stopped.first.result.content[0].text).state, "stopped")
  assert.deepEqual(stopped.first.result, stopped.repeated.result)
  const requests = (await readFile(join(f.root, "codex-acp.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  const credentials = requests.flatMap(request => (request.params?.mcpServers ?? []).filter((server: any) => server.name === "agency").flatMap((server: any) => server.env.filter((entry: any) => entry.name === "AGENCY_TOOLS_TOKEN").map((entry: any) => entry.value)))
  assert.ok(credentials.length >= 2)
  for (const entry of await readdir(f.paths.persistentRoot, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const bytes = await readFile(join(entry.parentPath, entry.name))
    for (const credential of [...credentials, "external-fixture-secret"]) assert.equal(bytes.includes(credential), false, entry.name)
  }
  await f.verifyZeroSurvivors()
})

test("corrupt Bureau state leaves ordinary Handler agents available across restart", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t)
  await mkdir(join(f.paths.persistentRoot, "bureau"), { mode: 0o700, recursive: true })
  await writeFile(join(f.paths.persistentRoot, "bureau/enabled.json"), "{", { mode: 0o600 })
  await f.crashHandler(); await f.restart()
  const ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result?.outcome, "started")
  await f.waitCompleted(await f.stop(ready.command.target!))
  await f.verifyZeroSurvivors()
})