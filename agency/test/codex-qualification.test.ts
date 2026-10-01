import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test, { type TestContext } from "node:test"
import { runCodexQualification, parseCodexQualificationReport, renderPublishedQualificationSource, durableQualificationWrite, readPrivateJsonWithDigest, type QualificationDependencies } from "../scripts/qualify-codex.js"
import { qualificationFingerprint } from "../src/agent/qualification.js"
import { snapshotLaunchEnvironment, launchEnvironmentDigest } from "../src/agent/environment.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { sameProcess } from "../src/platform/types.js"
import { verifyQualificationAbsence } from "../scripts/qualification-observation.js"
import { qualifiedLaunchContracts } from "../src/agent/qualified-contracts.js"
import { privateRoot } from "./control-support.js"
import { sampleQualifiedContract } from "./agent-support.js"

const methods = ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/prompt", "initialize", "session/load", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/prompt"]
const revision = { reviewedBranch: "moon/agency-agent-lifecycle", reviewedCommit: "a".repeat(40) }

async function fixture(t: TestContext, scenario = "normal") {
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-v4-")), adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const paths = { hostKey: "a".repeat(64), persistentRoot: join(root, "state"), runtimeRoot: join(root, "run"), handlerSocketPath: join(root, "run/handler.sock") }
  await mkdir(paths.persistentRoot, { mode: 0o700 }); await mkdir(paths.runtimeRoot, { mode: 0o700 })
  const manifest = sampleQualifiedContract().qualification!
  manifest.adapterEntrypoint.path = fileURLToPath(new URL("./fixtures/qualification-provider.js", import.meta.url))
  const candidate = { version: 4 as const, manifest, fingerprint: qualificationFingerprint(manifest) }
  const candidatePath = join(root, "candidate-v4.json")
  await durableQualificationWrite(candidatePath, candidate)
  const verification = { ...candidate, nodeVersion: manifest.nodeVersion, selection: manifest.selection, artifacts: { adapterPackageJson: manifest.adapterPackageJson, adapterEntrypoint: manifest.adapterEntrypoint, codexExecutable: manifest.codexExecutable, nodeExecutable: manifest.nodeExecutable } }
  let snapshots = 0
  const environments: Record<string, string>[] = []
  const dependencies: QualificationDependencies = {
    paths, adapter, verify: async () => verification, currentRevision: async () => ({ branch: revision.reviewedBranch, commit: revision.reviewedCommit }),
    handler: (candidatePath, receipts) => ({ file: process.execPath, args: [fileURLToPath(new URL("./fixtures/qualification-handler.js", import.meta.url)), candidatePath, receipts, JSON.stringify(paths)], env: process.env }),
    cwd: () => resolve(".."),
    snapshot: () => { const environment = { ...snapshotLaunchEnvironment(process.env), CODEX_PATH: manifest.codexExecutable.path, QUALIFICATION_FIXTURE_ROOT: root, QUALIFICATION_SCENARIO: scenario, SNAPSHOT: String(++snapshots), SECRET_TOKEN: "must-not-appear-in-report" }; environments.push(environment); return environment },
  }
  t.after(async () => { const current = await inspectHandlerGeneration(paths.runtimeRoot, adapter); assert.notEqual(current?.disposition, "live", "qualification Handler must stop before fixture teardown"); await rm(root, { recursive: true }) })
  return { root, paths, candidate, dependencies, environments, request: { candidatePath, evidenceParent: root, ...revision } }
}

test("ambient public lifecycle retains context across two providers and fresh environment snapshots", async t => {
  const f = await fixture(t), result = await runCodexQualification(f.request, f.dependencies), report = result.report
  assert.equal(report.failure, null); assert.equal(report.qualified, true)
  assert.deepEqual(report.protocol, { methods, promptCount: 2 })
  assert.equal(report.receipts.flatMap(receipt => (receipt as any).prompts ?? []).length, 2)
  assert.equal(report.first!.sessionId, report.restored!.sessionId)
  assert.notEqual(report.first!.providerGeneration, report.restored!.providerGeneration)
  assert.equal(report.first!.agentId, report.restored!.agentId)
  assert.equal(report.first!.handlerGeneration, report.restored!.handlerGeneration)
  for (const key of ["launchAttemptId", "commandId", "sessionGeneration"] as const) assert.notEqual(report.first![key], report.restored![key])
  assert.equal(report.cwd, resolve("..")); assert.equal(f.environments.length, 2)
  assert.equal(report.startEnvironmentDigest, launchEnvironmentDigest(f.environments[0]!))
  assert.equal(report.restoreEnvironmentDigest, launchEnvironmentDigest(f.environments[1]!))
  assert.notEqual(report.startEnvironmentDigest, report.restoreEnvironmentDigest)
  assert.equal(JSON.stringify(report).includes("must-not-appear-in-report"), false)
  assert.equal(report.ownedGroups.length, 2)
  for (const entry of report.ownedGroups) {
    assert.equal(entry.absence.first!.outcome, "absent"); assert.equal(entry.absence.second!.outcome, "absent")
    assert.ok(entry.absence.second!.startedAt >= entry.absence.first!.endedAt + 25)
  }
  assert.deepEqual(parseCodexQualificationReport(report), report); assert.deepEqual(qualifiedLaunchContracts(), [])
  const source = renderPublishedQualificationSource(f.candidate, report, result.reportSha256!, result.reportSha256!, revision)
  assert.match(source, /"sessionLoad": "qualified"/)
  const requests = (await readFile(join(f.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  const prompts = requests.filter(request => request.method === "session/prompt")
  assert.equal(prompts.length, 2); assert.ok(prompts[0].params.prompt[0].text.includes("agency/package.json"))
  assert.equal(prompts[1].params.prompt[0].text, "Return the nonce from the previous turn without reading files.")
  assert.equal(prompts[1].params.prompt[0].text.includes(report.challenge), false)
})

for (const scenario of ["unsupported-load", "missing-session", "wrong-session", "interrupted-second-prompt", "wrong-first-answer", "wrong-restored-answer"])
  test(`ambient qualification rejects ${scenario} and does not retry`, async t => {
    const f = await fixture(t, scenario), { report } = await runCodexQualification(f.request, f.dependencies)
    assert.equal(report.qualified, false); assert.notEqual(report.failure, null)
    assert.ok(report.protocol.promptCount <= 2); assert.deepEqual(qualifiedLaunchContracts(), [])
  })

test("detached ambient helper is diagnostic and survives owned-group verification", async t => {
  const f = await fixture(t, "ambient-helper"), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true); assert.equal(Object.hasOwn(result.report, "helpers"), false)
  assert.equal(await readFile(join(f.root, "helper-survived"), "utf8"), "yes")
})

test("report parser rejects incomplete, substituted, excessive, or leaking evidence", async t => {
  const f = await fixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  const mutations: Array<(r: any) => void> = [
    r => { r.version = 3 }, r => { r.protocol.promptCount = 3 }, r => { r.protocol.methods.push("session/prompt") },
    r => { r.protocol.methods[1] = "session/load" }, r => { r.protocol.methods.pop() },
    r => { r.restored.providerGeneration = r.first.providerGeneration }, r => { r.restored.sessionId = "other" },
    r => { r.restored.agentId = randomUUID() }, r => { r.restored.sessionGeneration = r.first.sessionGeneration },
    r => { r.first.answer = r.challenge }, r => { r.restored.answer = "wrong" },
    r => { r.ownedGroups.pop() }, r => { r.ownedGroups[1] = r.ownedGroups[0] },
    r => { r.candidate.fingerprint = "0".repeat(64) }, r => { r.startEnvironmentDigest = { SECRET: "value" } },
    r => { r.receipts[1].prompts[0].text += r.challenge }, r => { r.receipts[0].prompts[0].sessionId = "wrong" },
    ...["environment", "environmentValues", "checkout", "admission", "privateRoot", "helpers", "unchangedHome"].map(key => (r: any) => { r[key] = {} }),
  ]
  for (const index of [0, 1]) for (const pass of ["first", "second"]) mutations.push(
    r => { r.ownedGroups[index].absence[pass] = null }, r => { r.ownedGroups[index].absence[pass].outcome = "present" },
    r => { r.ownedGroups[index].absence[pass].identity.leader.birth = "999:changed" }, r => { r.ownedGroups[index].absence[pass].processes.pop() },
    r => { r.ownedGroups[index].absence[pass].group = [r.ownedGroups[index].identity.leader] },
    r => { r.ownedGroups[index].absence[pass].processes[0].observed = r.ownedGroups[index].identity.leader },
    r => { r.ownedGroups[index].absence[pass].processes[0].observed = { ...r.ownedGroups[index].identity.leader, pid: 999999, birth: "999:unrelated" } },
  )
  for (const index of [0, 1]) mutations.push(r => { r.ownedGroups[index].absence.second.endedAt = r.ownedGroups[index].absence.first.startedAt + r.candidate.manifest.deadlines.absenceMs + 1 })
  mutations.push(r => { r.ownedGroups[0].absence.second.startedAt = r.ownedGroups[0].absence.first.endedAt })
  for (const mutate of mutations) { const report = structuredClone(result.report); mutate(report); assert.throws(() => parseCodexQualificationReport(report)) }
  assert.throws(() => renderPublishedQualificationSource(f.candidate, result.report, "0".repeat(64), result.reportSha256!, revision))
  assert.throws(() => renderPublishedQualificationSource(f.candidate, result.report, result.reportSha256!, result.reportSha256!, { ...revision, reviewedCommit: "b".repeat(40) }))
})

for (const pass of [1, 2, 3, 4]) for (const fault of ["missing", "reappearing"]) test(`owned absence pass ${pass} ${fault} fails the lifecycle`, async t => {
  const f = await fixture(t)
  let reads = 0
  f.dependencies.absenceAdapter = { ...f.dependencies.adapter, async readGroup(groupId) {
    if (++reads !== pass) return f.dependencies.adapter.readGroup(groupId)
    if (fault === "missing") throw new Error("observation unavailable")
    const launch = (await inventoryLaunches(join(f.paths.persistentRoot, "launches"))).find(entry => entry.record.provider?.group.leader.pid === groupId)
    assert.ok(launch?.record.provider)
    return [launch.record.provider.group.leader]
  } }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "ABSENCE_UNVERIFIED")
  assert.equal(report.protocol.promptCount, pass <= 2 ? 1 : 2)
})

test("candidate and report publication is exclusive and binds exact report bytes", async t => {
  const root = await privateRoot(t), path = join(root, "preserved.json")
  await durableQualificationWrite(path, { preserved: true })
  const first = await readPrivateJsonWithDigest(path)
  await assert.rejects(durableQualificationWrite(path, { replaced: true })); assert.deepEqual(await readPrivateJsonWithDigest(path), first)
  await writeFile(join(root, "equivalent.json"), '{ "preserved": true }', { mode: 0o600 })
  assert.notEqual((await readPrivateJsonWithDigest(join(root, "equivalent.json"))).sha256, first.sha256)
})

test("ambient CODEX_PATH mismatch fails before a provider launch", async t => {
  const f = await fixture(t), snapshot = f.dependencies.snapshot
  f.dependencies.snapshot = () => ({ ...snapshot(), CODEX_PATH: "/unreviewed/codex" })
  await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "CONFIG_CHANGED" })
})

test("absent ambient CODEX_PATH fails before a provider launch", async t => {
  const f = await fixture(t), snapshot = f.dependencies.snapshot
  f.dependencies.snapshot = () => { const environment = { ...snapshot() }; delete environment.CODEX_PATH; return environment }
  await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "CONFIG_CHANGED" })
})

test("qualification waits through disappearing Handler metadata before absence proof", async t => {
  const f = await fixture(t), adapter = f.dependencies.adapter
  let handlerPid: number | undefined, injected = false
  f.dependencies.adapter = { ...adapter, async readProcess(pid) {
    const value = await adapter.readProcess(pid)
    if (value?.birth.includes(":agy-handler:")) handlerPid = pid
    if (pid === handlerPid && value === null && !injected) {
      injected = true
      const error = new Error("process disappeared during identity observation"); error.name = "DarwinObservationUnavailable"; throw error
    }
    return value
  } }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(injected, true); assert.equal(report.failure, null); assert.equal(report.qualified, true)
})

async function cleanFixtureHandler(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const current = await inspectHandlerGeneration(f.paths.runtimeRoot, f.dependencies.adapter)
  if (current?.disposition !== "live" || !current.record.process) return
  const process = current.record.process
  const observed = await f.dependencies.adapter.readProcess(process.pid)
  assert.ok(observed && sameProcess(process, observed))
  await f.dependencies.adapter.signalGroup(process.pid, "SIGKILL")
  for (let attempt = 0; attempt < 100 && await f.dependencies.adapter.readProcess(process.pid); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const proof = await verifyQualificationAbsence(f.dependencies.adapter, { leader: process, observed: [process] }, 2000)
  assert.equal(proof.first?.outcome, "absent"); assert.equal(proof.second?.outcome, "absent")
}

test("qualification cannot claim or shut down a Handler that wins the startup race", async t => {
  const f = await fixture(t), handler = f.dependencies.handler
  let ordinaryGeneration: string | undefined
  f.dependencies.handler = (path, receipts) => {
    const command = handler(path, receipts)
    const source = `import {startOrConnect} from ${JSON.stringify(new URL("../src/platform/singleton.js", import.meta.url).href)}; import {createDarwinAdapter} from ${JSON.stringify(new URL("../src/platform/darwin.js", import.meta.url).href)}; import {createLinuxAdapter} from ${JSON.stringify(new URL("../src/platform/linux.js", import.meta.url).href)}; const result = await startOrConnect({root:${JSON.stringify(f.paths.runtimeRoot)},hostId:${JSON.stringify(f.paths.hostKey)},handler:JSON.parse(process.argv[1]),adapter:process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter(),timeoutMs:15000}); console.log(result.record.generation)`
    ordinaryGeneration = execFileSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify({ file: command.file, args: command.args })], { encoding: "utf8", timeout: 20000 }).trim()
    return command
  }
  try {
    const { report } = await runCodexQualification(f.request, f.dependencies)
    assert.equal(report.qualified, false); assert.equal(report.failure, "HANDLER_ACTIVE"); assert.equal(report.protocol.promptCount, 0)
    const current = await inspectHandlerGeneration(f.paths.runtimeRoot, f.dependencies.adapter)
    assert.equal(current?.disposition, "live"); assert.equal(current?.record.generation, ordinaryGeneration)
    await assert.rejects(readFile(join(f.root, "requests.jsonl")), { code: "ENOENT" })
  } finally { await cleanFixtureHandler(f) }
})

test("qualification retains ownership and cleans a Handler after readiness timeout", async t => {
  const f = await fixture(t), handler = f.dependencies.handler
  f.dependencies.handler = (path, receipts) => { const command = handler(path, receipts); return { ...command, args: [...command.args, "readiness-timeout"] } }
  try {
    const { report } = await runCodexQualification(f.request, f.dependencies)
    assert.equal(report.qualified, false); assert.equal(report.protocol.promptCount, 0)
    const retained = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
    assert.ok(retained.process)
    const proof = await verifyQualificationAbsence(f.dependencies.adapter, { leader: retained.process, observed: [retained.process] }, 2000)
    assert.equal(proof.first?.outcome, "absent"); assert.equal(proof.second?.outcome, "absent")
  } finally { await cleanFixtureHandler(f) }
})

test("revision verification ignores ambient Git metadata redirects", async t => {
  const root = await privateRoot(t)
  execFileSync("/usr/bin/git", ["init", "-q", "--initial-branch", "redirected", root])
  execFileSync("/usr/bin/git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"])
  const expected = { branch: execFileSync("/usr/bin/git", ["branch", "--show-current"], { encoding: "utf8" }).trim(), commit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }
  const source = `import {observeCurrentRevision} from ${JSON.stringify(new URL("../scripts/qualify-codex.js", import.meta.url).href)}; console.log(JSON.stringify(await observeCurrentRevision()))`
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root, GIT_COMMON_DIR: join(root, ".git") } })
  assert.deepEqual(JSON.parse(output), expected)
})