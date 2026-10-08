import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createOrchestrationService } from "../src/orchestration/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import { parseStartRunInput } from "../src/bureau/service.js"
import { parseHumanControl } from "../src/bureau/human-controls.js"
import { agentServiceFixture } from "./agent-support.js"
import { gitFixture, git } from "./git-support.js"
import type { PublicationReceipt } from "../src/orchestration/git-publication.js"
import type { ExecutionRef } from "../src/orchestration/types.js"

test("human run input retains exact publication destinations and rejects expanded scope", () => {
  const input = { objective: "Implement", hostId: "a".repeat(64), cwd: "/tmp/repo", backendId: "codex-acp", modelId: "model-a", overrides: {}, publication: { destinations: [{ hostId: "b".repeat(64), repository: "/tmp/repo", remote: "origin" }] } }
  assert.deepEqual((parseStartRunInput(input) as unknown as typeof input).publication, input.publication)
  assert.throws(() => parseStartRunInput({ ...input, publication: { ...input.publication, wildcard: true } }))
})
test("Git configuration, verification and integration have explicit human protocol operations", () => {
  for (const input of [
    { op: "git_configure", destinationCwd: "/tmp/repo", remote: "origin", validations: [["node", "--test"]] },
    { op: "git_verify", reportId: randomUUID(), destinationCwd: "/tmp/repo" },
    { op: "git_proposal", proposalId: "a".repeat(64) },
    { op: "git_integrate", commandId: randomUUID(), proposalId: "a".repeat(64), expectedHead: "b".repeat(40), strategy: "merge" },
    { op: "git_abandon", commandId: randomUUID(), proposalId: "a".repeat(64), expectedHead: "b".repeat(40) },
    { op: "git_inspect", commandId: randomUUID() }
  ]) assert.deepEqual(parseHumanControl(input), input)
})
test("origin publication is attempt-bound and completed reports require its retained receipt", async t => {
  const f = await agentServiceFixture(t), g = await gitFixture(t), hostId = f.context.paths.hostKey
  const journals = createJournalPool(f.root, undefined, Date.now, "origin")
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage: createLineageStore(f.root), tools: { definition() { return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate() {}, revoke() {} }, relay: async () => { throw new Error("offline") } })
  const parent = { hostId, agentId: randomUUID() }, ref = { runId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID() }, gitInput = { repository: g.repository, remote: g.remote, baseOid: g.baseOid }
  const command = { commandId: randomUUID(), runId: ref.runId, ref, agent: { hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), spec: { parent, description: "Code", hostId, cwd: g.repository, backendId: "codex-acp" as const, modelId: "model-a", overrides: {}, git: gitInput }, lineage: { runId: ref.runId, parent, assignmentId: ref.assignmentId }, git: { ...gitInput, branch: `moon/agency/${ref.runId}/${ref.assignmentId}/${ref.attemptId}` }, publication: { hostId, repository: g.repository, remote: g.remote }, retryMode: "new" as const, savedSettings: null }
  const launched = await host.launch(command, { environment: f.input.environment, nativeParams: {} }), execution = launched.execution!, oid = await g.commit("result", "result", launched.git!.cwd)
  const report = { status: "completed" as const, summary: "Done", issues: [], validation: [], git: { ...command.git, resultOid: oid, published: true } }
  await assert.rejects(host.report({ ...ref, commandId: randomUUID(), execution, report }), /GIT_PUBLICATION_REQUIRED/)
  const publication = host as unknown as { publish(commandId: string, execution: ExecutionRef, resultOid: string, expectedRemoteOid: string | null): Promise<PublicationReceipt> }
  await assert.rejects(publication.publish(randomUUID(), { ...execution, providerGeneration: randomUUID() }, oid, null), /GIT_PUBLICATION_UNAUTHORIZED/)
  const commandId = randomUUID(), receipt = await publication.publish(commandId, execution, oid, null)
  assert.equal(receipt.state, "published")
  const retained = await host.report({ ...ref, commandId: randomUUID(), execution, report: { ...report, git: { ...report.git, publication: receipt } } })
  assert.equal(retained.state, "retained")
  const entries = (await journals.forRun(ref.runId).retainedRead(0, 256)).entries
  assert.ok(JSON.stringify(entries).includes(receipt.digest))
  assert.equal((await git(["ls-remote", g.remote, "refs/heads/" + command.git.branch], g.repository)).split(/\s/)[0], oid)
})

test("MCP publication uses origin authority offline and model tools cannot reach human Git controls", async () => {
  const { createToolBindings } = await import("../src/orchestration/tool-bindings.js")
  const execution = { hostId: "a".repeat(64), agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() }
  const attempt = { runId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID() }, bindingEpoch = randomUUID()
  let published = 0, routed = 0
  const host = { snapshot: async () => ({ agents: [] }), stop: async () => { throw new Error("unused") }, report: async () => { throw new Error("unused") }, publish: async (_id: string, target: unknown) => { assert.deepEqual(target, execution); published++; return { state: "published" } } }
  const tools = createToolBindings({ socketPath: "/tmp/unused.sock", journals: {} as any, bureau: () => undefined, host: () => host as any, route: async () => { routed++; throw new Error("unexpected route") } })
  tools.definition(execution, { commandId: randomUUID(), runId: attempt.runId, agent: { hostId: execution.hostId, agentId: execution.agentId }, execution, attempt, lineage: null, launchAttemptId: randomUUID(), bindingEpoch, invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: {} }, { environment: { HOME: "/tmp" }, nativeParams: {} })
  tools.activate(execution); const token = tools.tokenFor(execution)!, scope = { runId: attempt.runId, bindingEpoch }
  assert.equal((await tools.call(token, "agency_publish", { ...scope, commandId: randomUUID(), resultOid: "c".repeat(40), expectedRemoteOid: null })).isError, false)
  assert.equal(published, 1); assert.equal(routed, 0)
  for (const name of ["agency_git_configure", "agency_git_integrate", "git_configure", "git_integrate", "git_abandon", "agency_git_abandon"]) assert.equal((await tools.call(token, name, {})).isError, true)
  tools.close()
})

test("Git abandonment CLI reaches only the explicit human controller", async () => {
  const { runBureauClient } = await import("../src/bureau/cli.js"), { dispatchBureau } = await import("../src/bureau/client.js")
  const generation = randomUUID(), commandId = randomUUID(), proposalId = "a".repeat(64), expectedHead = "b".repeat(40), controls: unknown[] = []
  const deps = { environment: async () => ({ paths: { hostKey: "c".repeat(64), runtimeRoot: "/fixture" } }), inspect: async () => ({ disposition: "live", record: { generation, phase: "ready" } }),
    callBureau: async (_env: unknown, request: import("../src/bureau/protocol.js").BureauRequest) => dispatchBureau({} as import("../src/bureau/service.js").BureauService, generation, request, async control => { controls.push(control); return { state: "abandoned" } }),
    stdout() {}, stderr() {}, cwd: () => "/fixture" } as unknown as import("../src/cli/control.js").ControlDependencies
  assert.equal(await runBureauClient(["git", "abandon", commandId, proposalId, "--expected-head", expectedHead], deps), 0)
  assert.deepEqual(controls, [{ op: "git_abandon", commandId, proposalId, expectedHead }])
})