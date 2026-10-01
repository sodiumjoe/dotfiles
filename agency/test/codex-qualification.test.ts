import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile, symlink, open, readdir, chmod, lstat, rename } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import childProcess, { execFile } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { promisify } from "node:util"
import { productionLaunchContracts } from "../src/agent/contracts.js"
import { launchEvidenceFromQualifiedCandidate, observeArtifact, parseCodexQualificationManifest, qualificationFingerprint, type ArtifactPin } from "../src/agent/qualification.js"
import { qualifiedLaunchContracts } from "../src/agent/qualified-contracts.js"
import { AgentError } from "../src/agent/types.js"
import { sampleQualifiedContract, sampleQualifiedSpec } from "./agent-support.js"
import { verifyInjectedLaunchEvidence } from "../scripts/qualify-codex-handler.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { sameProcess } from "../src/platform/types.js"
import { exchangeAgent as exchangeAgentProtocol } from "../src/agent/protocol.js"
import { codexQualificationMain, durableQualificationWrite, parseCodexQualificationReport, parseQualificationCandidate, pinnedArtifact, qualificationPaths, renderPublishedQualificationSource, runCodexQualification, snapshotTree, validateQualifiedOwnership, type QualificationDependencies } from "../scripts/qualify-codex.js"
import * as qualificationScript from "../scripts/qualify-codex.js"

const reviewedRevision = { reviewedBranch: "moon/agency-agent-lifecycle", reviewedCommit: "1234567890abcdef1234567890abcdef12345678" }
const revisionArgs = ["--reviewed-branch", reviewedRevision.reviewedBranch, "--reviewed-commit", reviewedRevision.reviewedCommit]
const registryBaseline = Object.freeze({ production: JSON.stringify(productionLaunchContracts()), qualified: JSON.stringify(qualifiedLaunchContracts()) })
function assertRegistriesUnchanged(): void {
  assert.equal(JSON.stringify(productionLaunchContracts()), registryBaseline.production)
  assert.equal(JSON.stringify(qualifiedLaunchContracts()), registryBaseline.qualified)
  assert.equal(Object.isFrozen(productionLaunchContracts()), true)
  assert.equal(Object.isFrozen(qualifiedLaunchContracts()), true)
}

const preservedCandidatePath = fileURLToPath(new URL("../../qualification/codex-darwin-arm64.candidate.json", import.meta.url))
const preservedCandidateDigest = "73e440d1698f3e689f12b5dab74b3b9af3316ab9ab826d1c15a3029d3d909270"
const artifactNames = ["adapterPackageJson", "adapterEntrypoint", "codexExecutable", "nodeExecutable"] as const
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
type DigestReader = (path: string, maxBytes: number) => Promise<{ value: unknown; sha256: string }>
function digestReader(): DigestReader {
  const reader = (qualificationScript as unknown as { readPrivateJsonWithDigest?: DigestReader }).readPrivateJsonWithDigest
  assert.equal(typeof reader, "function", "offline construction requires an identity-checked same-buffer digest reader")
  return reader!
}
async function privateFixture(t: TestContext) {
  const root = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyoff-" : "/tmp/agyoff-")
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function preservedCandidate() {
  const bytes = await readFile(preservedCandidatePath)
  assert.equal(digest(bytes), preservedCandidateDigest)
  return JSON.parse(bytes.toString("utf8")) as { manifest: Record<string, unknown> & Record<typeof artifactNames[number], ArtifactPin> }
}
async function offlineFixture(t: TestContext) {
  const root = await privateFixture(t), old = await preservedCandidate(), evidenceParent = join(root, "evidence"), candidatePath = join(root, "candidate.json")
  await mkdir(evidenceParent, { mode: 0o700 })
  const fixturePins = new Map<string, ArtifactPin>()
  for (const name of artifactNames) {
    const path = join(root, name)
    await writeFile(path, "same fixture artifact bytes", { mode: 0o600 })
    fixturePins.set(old.manifest[name].path, await pinnedArtifact(path, digest(await readFile(path))))
  }
  const observedArtifacts: string[] = []
  const dependencies = {
    async observeArtifact(pin: ArtifactPin) {
      const name = artifactNames.find(name => old.manifest[name].path === pin.path)!
      assert.deepEqual(pin, old.manifest[name])
      await observeArtifact(fixturePins.get(pin.path)!)
      observedArtifacts.push(name)
      return structuredClone(pin)
    },
    verify: async (manifest: Parameters<typeof qualificationFingerprint>[0]) => ({ version: 3 as const, manifest, fingerprint: qualificationFingerprint(manifest), nodeVersion: "24.13.0" as const, selection: manifest.selection, artifacts: Object.fromEntries(artifactNames.map(name => [name, manifest[name]])) }),
  }
  const originalReaddir = fsPromises.readdir, originalOpen = fsPromises.open
  fsPromises.open = (async (path: any, flags: any, mode: any) => {
    assert.ok(!artifactNames.some(name => old.manifest[name].path === path), "offline fixture must observe preserved pins through its dependencies")
    return originalOpen(path, flags, mode)
  }) as typeof open
  fsPromises.readdir = (async (path: any, options: any) => {
    assert.ok(!String(path).startsWith("/Users/moon/.codex"), "offline must not enumerate the real Codex root")
    return originalReaddir(path, options)
  }) as typeof readdir
  syncBuiltinESMExports()
  t.after(() => { fsPromises.readdir = originalReaddir; fsPromises.open = originalOpen; syncBuiltinESMExports() })
  const run = () => (qualificationScript.offlineCandidate as (...args: any[]) => ReturnType<typeof qualificationScript.offlineCandidate>)(candidatePath, evidenceParent, dependencies)
  return { root, old, evidenceParent, candidatePath, observedArtifacts, dependencies, fixturePins, run }
}

test("offline prompt-v3 candidate reuses all old candidate pins and emits only closed dormant evidence", async t => {
  const f = await offlineFixture(t), candidate = await f.run()
  assert.equal(candidate.version, 3)
  assert.equal(candidate.manifest.version, 3)
  assert.equal(candidate.manifest.policy, "agency-codex-prompt-smoke-v3")
  assert.equal(candidate.manifest.contractId, "codex-darwin-arm64-agency-prompt-smoke-v3")
  assert.equal(candidate.manifest.protocolVersion, 1)
  for (const name of artifactNames) assert.deepEqual(candidate.manifest[name], f.old.manifest[name])
  for (const name of ["selection", "optionIds"]) assert.deepEqual(candidate.manifest[name as keyof typeof candidate.manifest], f.old.manifest[name])
  const oldEnvironment = f.old.manifest.environment as { fixed: Record<string, string>; private: Record<string, string> }
  assert.deepEqual(candidate.manifest.environment, { fixed: { ...oldEnvironment.fixed, GIT_CONFIG_NOSYSTEM: "1" }, private: oldEnvironment.private })
  assert.deepEqual(candidate.manifest.prompt, { challengePrefix: "AGENCY_CODEX_SMOKE_", challengeBytes: 16, answerBytes: 4096 })
  assert.deepEqual(candidate.manifest.deadlines, { ...f.old.manifest.deadlines as object, promptMs: 90000, overallMs: 150000 })
  assert.equal(Object.hasOwn(candidate.manifest, "userSecurityState"), false)
  assert.deepEqual(f.observedArtifacts, artifactNames)
  assert.equal((await lstat(f.candidatePath)).mode & 0o777, 0o600)
  const evidence = join(f.evidenceParent, "codex-qualification"), entries = await readdir(evidence)
  assert.equal(entries.length, 1); assert.match(entries[0]!, /^offline-/)
  const directory = join(evidence, entries[0]!)
  assert.deepEqual((await readdir(directory)).sort(), ["manifest.json", "report.json"])
  const reportBytes = await readFile(join(directory, "report.json")), report = JSON.parse(reportBytes.toString("utf8"))
  assert.deepEqual(report, { version: 3, stage: "offline", qualified: false, candidate, verification: await f.dependencies.verify(candidate.manifest) })
  assert.deepEqual(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), candidate)
  assert.equal(reportBytes.includes("userSecurityState"), false)
  assert.throws(() => parseCodexQualificationReport(report), { code: "REPORT_INVALID" })
  await assert.rejects(codexQualificationMain(["--stage", "source", "--candidate", f.candidatePath, "--evidence-parent", f.evidenceParent, "--report", join(directory, "report.json"), "--report-sha256", digest(reportBytes), ...revisionArgs]), { code: "REPORT_INVALID" })
  assertRegistriesUnchanged()
  assert.equal(digest(await readFile(preservedCandidatePath)), preservedCandidateDigest)
})

test("offline never overwrites an existing prompt-v3 candidate or creates extra evidence", async t => {
  const f = await offlineFixture(t)
  await writeFile(f.candidatePath, "preserved candidate bytes", { mode: 0o600 })
  await assert.rejects(f.run())
  assert.equal(await readFile(f.candidatePath, "utf8"), "preserved candidate bytes")
  assert.deepEqual(await readdir(f.evidenceParent), [])
  assert.deepEqual(f.observedArtifacts, [])
})

for (const name of artifactNames) test(`offline rejects same-byte replacement identity for old candidate ${name}`, async t => {
  const f = await offlineFixture(t), pin = f.fixturePins.get(f.old.manifest[name].path)!, replacement = pin.path + ".replacement"
  const bytes = await readFile(pin.path)
  await writeFile(replacement, bytes, { mode: 0o600 }); await rename(replacement, pin.path)
  assert.equal(digest(await readFile(pin.path)), pin.sha256)
  await assert.rejects(f.run(), { code: "ADAPTER_UNQUALIFIED" })
  assert.deepEqual(f.observedArtifacts, artifactNames.slice(0, artifactNames.indexOf(name)))
  await assert.rejects(lstat(f.candidatePath), { code: "ENOENT" })
  assert.deepEqual(await readdir(f.evidenceParent), [])
})

test("offline rejects changed old candidate bytes before extracting artifact pins", async t => {
  const f = await offlineFixture(t), originalOpen = fsPromises.open
  fsPromises.open = (async (path: any, flags: any, mode: any) => {
    const handle = await originalOpen(path, flags, mode)
    if (path !== preservedCandidatePath) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (...args: any[]) => {
        const result = await (target.read as any)(...args)
        const bytes = args[0] as Buffer, index = bytes.indexOf('"version":1')
        assert.notEqual(index, -1); bytes[index + 10] = 50
        return result
      }
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.run(), { code: "ADAPTER_UNQUALIFIED" })
    assert.deepEqual(f.observedArtifacts, [])
    assert.deepEqual(await readdir(f.evidenceParent), [])
    assert.equal(digest(await readFile(preservedCandidatePath)), preservedCandidateDigest)
  } finally { fsPromises.open = originalOpen; syncBuiltinESMExports() }
})

test("offline digest reader hashes the exact parsed bytes once and distinguishes whitespace", async t => {
  const root = await privateFixture(t), path = join(root, "value.json"), first = Buffer.from('{"value":1}'), second = Buffer.from(' { "value": 1 } ')
  await writeFile(path, first, { mode: 0o600 })
  const reader = digestReader(), originalOpen = fsPromises.open
  let opens = 0, reads = 0
  const buffers: Buffer[] = []
  fsPromises.open = (async (name: any, flags: any, mode: any) => {
    const handle = await originalOpen(name, flags, mode)
    if (name !== path) return handle
    opens++
    assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    return new Proxy(handle, { get(target, property) {
      if (property === "readFile" || property === "createReadStream") return () => assert.fail("digest reader must use one bounded buffer")
      if (property === "read") return async (...args: any[]) => { reads++; buffers.push(args[0]); return (target.read as any)(...args) }
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open
  syncBuiltinESMExports(); t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports() })
  const a = await reader(path, first.length)
  assert.deepEqual(a, { value: { value: 1 }, sha256: digest(first) }); assert.equal(opens, 1); assert.equal(reads, 1)
  await writeFile(path, second)
  const b = await reader(path, second.length)
  assert.deepEqual(a.value, b.value); assert.notEqual(a.sha256, b.sha256); assert.equal(b.sha256, digest(second)); assert.equal(opens, 2); assert.equal(reads, 2)
  assert.ok(buffers.every(bytes => bytes.every(byte => byte === 0)))
})

for (const stage of ["opened", "read", "final named observation"] as const) test(`offline digest reader rejects replacement at ${stage}`, async t => {
  const root = await privateFixture(t), path = join(root, "value.json"), replacement = join(root, "replacement.json")
  await writeFile(path, '{"value":1}', { mode: 0o600 }); await writeFile(replacement, '{"value":1}', { mode: 0o600 })
  const reader = digestReader(), originalOpen = fsPromises.open, originalLstat = fsPromises.lstat
  let replaced = false
  const replace = async () => { if (!replaced) { replaced = true; await rename(replacement, path) } }
  fsPromises.open = (async (name: any, flags: any, mode: any) => {
    const handle = await originalOpen(name, flags, mode)
    if (name !== path) return handle
    if (stage === "opened") await replace()
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (...args: any[]) => { const result = await (target.read as any)(...args); if (stage === "read") await replace(); return result }
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open
  fsPromises.lstat = (async (name: any, options: any) => { if (name === path && stage === "final named observation") await replace(); return originalLstat(name, options) }) as typeof lstat
  syncBuiltinESMExports(); t.after(() => { fsPromises.open = originalOpen; fsPromises.lstat = originalLstat; syncBuiltinESMExports() })
  await assert.rejects(reader(path, 100), { code: "EVIDENCE_MISSING" })
})

test("offline digest reader rejects symlinks, non-private files and oversized files without content reads", async t => {
  const root = await privateFixture(t), path = join(root, "value.json"), link = join(root, "link.json")
  await writeFile(path, '{"value":1}', { mode: 0o600 }); await symlink(path, link)
  const reader = digestReader(), originalOpen = fsPromises.open
  fsPromises.open = (async (name: any, flags: any, mode: any) => {
    const handle = await originalOpen(name, flags, mode)
    return new Proxy(handle, { get(target, property) {
      if (property === "read" || property === "readFile" || property === "createReadStream") return () => assert.fail("invalid private JSON must not be read")
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open
  syncBuiltinESMExports(); t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports() })
  await assert.rejects(reader(link, 100), { code: "EVIDENCE_MISSING" })
  await chmod(path, 0o644); await assert.rejects(reader(path, 100), { code: "EVIDENCE_MISSING" })
  await chmod(path, 0o600); await assert.rejects(reader(path, 2), { code: "EVIDENCE_MISSING" })
})

async function qualificationHarnessFixture(t: TestContext, scenario = "normal") {
  const registryBefore = productionLaunchContracts()
  const root = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyqt-" : "/tmp/agyqt-")
  const evidenceParent = join(root, "evidence"), user = join(root, "user"), normal = join(root, "normal")
  await mkdir(evidenceParent, { mode: 0o700 }); await mkdir(user, { mode: 0o700 })
  const manifest = sampleQualifiedContract().qualification!
  const packagePath = join(root, "package.json")
  await writeFile(packagePath, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }), { mode: 0o600 })
  for (const [key, path] of [["adapterPackageJson", packagePath], ["adapterEntrypoint", fileURLToPath(new URL("./fixtures/qualification-provider.js", import.meta.url))], ["nodeExecutable", process.execPath], ["codexExecutable", manifest.codexExecutable.path]] as const) manifest[key] = await pinnedArtifact(path, createHash("sha256").update(await readFile(path)).digest("hex"))
  const candidate = { version: 3 as const, manifest, fingerprint: qualificationFingerprint(manifest) }
  const candidatePath = join(root, "candidate.json")
  await writeFile(candidatePath, JSON.stringify(candidate), { mode: 0o600 })
  const executionRoots: string[] = []
  const platform = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const dependencies: QualificationDependencies = {
    adapter: platform, hostKey: "a".repeat(64),
    verify: async () => ({ ...candidate, nodeVersion: "24.13.0", selection: manifest.selection, artifacts: { adapterPackageJson: manifest.adapterPackageJson, adapterEntrypoint: manifest.adapterEntrypoint, codexExecutable: manifest.codexExecutable, nodeExecutable: manifest.nodeExecutable } }),
    handler: (path, execution) => ({ file: process.execPath, args: [fileURLToPath(new URL("./fixtures/qualification-handler.js", import.meta.url)), path, execution, scenario] }),
    normalStatePaths: [normal],
    async createExecutionRoot() { const execution = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyqx-" : "/tmp/agyqx-"); executionRoots.push(execution); return execution },
  }
  ;(dependencies as any).currentRevision = async () => ({ branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit })
  t.after(async () => {
    assertRegistriesUnchanged()
    assert.deepEqual(productionLaunchContracts(), registryBefore)
    for (const execution of executionRoots) {
      const h = await readHandlerRecord(join(execution, "runtime/handler.json")).catch(() => null)
      if (h?.process) assert.equal(await platform.readProcess(h.process.pid), null)
      const launches = await inventoryLaunches(join(execution, "state/launches")).catch(() => [])
      for (const launch of launches) if (launch.record.provider) {
        const group = launch.record.provider.group
        if (scenario === "survivor") {
          const current = await platform.readProcess(group.leader.pid)
          if (current) {
            assert.ok(sameProcess(group.leader, current))
            const members = await platform.readGroup(group.leader.processGroupId)
            assert.ok(members.every(member => group.observed.some(owned => sameProcess(owned, member))))
            assert.deepEqual(await platform.readGroup(group.leader.processGroupId), members)
            await platform.signalGroup(group.leader.processGroupId, "SIGKILL")
            for (let i = 0; i < 100 && (await platform.readGroup(group.leader.processGroupId)).length; i++) await new Promise(resolve => setTimeout(resolve, 25))
          }
        }
        assert.deepEqual(await platform.readGroup(group.leader.processGroupId), [])
      }
      await rm(execution, { recursive: true, force: true })
    }
    await rm(root, { recursive: true, force: true })
  })
  const audit = (name: string) => readFile(join(root, name), "utf8").then(JSON.parse).catch(() => null)
  return { root, user, normal, candidate, registryBefore, executionRoots, providerAudit: () => audit("provider-audit.json"), forwardAudit: () => audit("prompt-forward-audit.json"), request: { candidatePath, evidenceParent, ...reviewedRevision }, dependencies }
}

async function assertClosedQualificationFailure(f: Awaited<ReturnType<typeof qualificationHarnessFixture>>, result: Awaited<ReturnType<typeof runCodexQualification>>, failure: string) {
  const { report, reportPath, reportSha256 } = result
  assert.equal(report.qualified, false)
  assert.equal(report.failure, failure, JSON.stringify(report))
  assert.ok(reportPath)
  assert.match(reportSha256!, /^[0-9a-f]{64}$/)
  const reportBytes = await readFile(reportPath!)
  assert.equal(digest(reportBytes), reportSha256)
  assert.deepEqual(JSON.parse(reportBytes.toString("utf8")), report)
  assert.ok(report.protocol.methods.filter(method => method === "session/new").length <= 1)
  assert.ok(report.protocol.methods.filter(method => method === "session/prompt").length <= 1)
  if (report.observation.receipt) {
    assert.deepEqual(report.protocol.methods, report.observation.receipt.methods)
    assert.deepEqual(report.prompt, report.observation.receipt.prompt)
    assert.equal(report.observation.receipt.transportClosed, true)
    assert.equal(report.observation.receipt.streamsClosed, true)
  }
  assert.equal(report.postconditions.transport, "closed")
  assert.equal(report.postconditions.directChild, "terminal")
  assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(report.postconditions.reservation, "released")
  assert.equal(report.postconditions.providerState, "absent")
  assert.equal(report.postconditions.qualificationCwd, "absent")
  assert.equal(report.postconditions.executionRoot, "absent")
  assert.equal(report.postconditions.lifecycleOperation, "terminal")
  assert.equal(report.postconditions.ownedStreams, "closed")
  assert.equal(report.postconditions.handler, "absent")
  assert.equal(report.postconditions.catalogProfile, "absent")
  assert.equal(report.postconditions.normalAgencyState, "unchanged")
  assert.deepEqual(report.observation.normalAgencyState.after, report.observation.normalAgencyState.before)
  for (const executionRoot of f.executionRoots) await assert.rejects(lstat(executionRoot), { code: "ENOENT" })
  assertRegistriesUnchanged()
  assert.ok(Object.isFrozen(productionLaunchContracts()))
  assert.ok(Object.isFrozen(qualifiedLaunchContracts()))
}

test("qualification rejects invalid reviewed revisions before artifact verification or attempt creation", async t => {
  const f = await qualificationHarnessFixture(t)
  let verified = 0
  f.dependencies.verify = async () => { verified++; throw new Error("verification must not run") }
  for (const revision of [
    {}, { reviewedBranch: reviewedRevision.reviewedBranch }, { reviewedCommit: reviewedRevision.reviewedCommit },
    { ...reviewedRevision, reviewedBranch: "master" }, { ...reviewedRevision, reviewedBranch: "moon/agency-agent-lifecycle\n" },
    ...["", "abc123", "g".repeat(40), "A".repeat(40), "0".repeat(40), reviewedRevision.reviewedCommit + "\n", 123].map(reviewedCommit => ({ ...reviewedRevision, reviewedCommit })),
  ]) {
    await assert.rejects(runCodexQualification({ candidatePath: f.request.candidatePath, evidenceParent: f.request.evidenceParent, ...revision } as typeof f.request, f.dependencies), { code: "ADAPTER_UNQUALIFIED" })
  }
  assert.equal(verified, 0)
  assert.deepEqual(await readdir(f.request.evidenceParent), [])
})

test("default current revision observation uses bounded branch and HEAD commands", async () => {
  const observe = (qualificationScript as unknown as { observeCurrentRevision?: (execute?: unknown) => Promise<{ branch: string; commit: string }> }).observeCurrentRevision
  assert.equal(typeof observe, "function")
  const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const execute = async (file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    return args[0] === "branch" ? { stdout: reviewedRevision.reviewedBranch + "\n", stderr: "" } : { stdout: reviewedRevision.reviewedCommit + "\n", stderr: "" }
  }
  assert.deepEqual(await observe!(execute), { branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit })
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [
    { file: "/usr/bin/git", args: ["branch", "--show-current"] },
    { file: "/usr/bin/git", args: ["rev-parse", "--verify", "HEAD"] },
  ])
  for (const { options } of calls) {
    assert.equal(options.cwd, "/Users/moon/.dotfiles/.worktrees/agency-agent-lifecycle")
    assert.equal(options.timeout, 5000)
    assert.equal(options.maxBuffer, 4096)
    assert.deepEqual(options.env, { HOME: "/var/empty", LC_ALL: "C", PATH: "/usr/bin:/bin" })
    assert.equal(Object.keys(options.env as object).some(key => key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_COMMON_DIR" || key.startsWith("GIT_CONFIG_")), false)
  }
})

test("live qualification rejects current branch or HEAD drift before evidence creation", async t => {
  for (const current of [
    { branch: "master", commit: reviewedRevision.reviewedCommit },
    { branch: reviewedRevision.reviewedBranch, commit: "b".repeat(40) },
  ]) {
    const f = await qualificationHarnessFixture(t)
    let observations = 0
    ;(f.dependencies as any).currentRevision = async () => { observations++; return current }
    await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "ADAPTER_UNQUALIFIED" })
    assert.equal(observations, 1)
    assert.deepEqual(await readdir(f.request.evidenceParent), [])
  }
})

for (const gate of ["artifact", "normal"] as const) test(`initial ${gate} failure writes a not-started report without launching`, async t => {
  const f = await qualificationHarnessFixture(t), verify = f.dependencies.verify
  if (gate === "artifact") f.dependencies.verify = async () => { throw new AgentError("ADAPTER_UNQUALIFIED") }
  else { f.dependencies.verify = verify; await symlink(f.user, f.normal) }
  f.dependencies.handler = () => { throw new Error("must not launch") }
  const result = await runCodexQualification(f.request, f.dependencies), report = result.report
  assert.equal(report.version, 3); assert.equal(report.qualified, false)
  assert.equal(report.failure, gate === "artifact" ? "ADAPTER_UNQUALIFIED" : "NORMAL_STATE_UNAVAILABLE")
  assert.deepEqual(report.prompt, { state: "not_started", challenge: null, prompt: null, answer: null, normalizedAnswer: null, stopReason: null, durationMs: null })
  assert.deepEqual(report.ownership.handlers, []); assert.equal(report.ownership.providerProcessGroup, null)
  assert.ok(result.reportPath); assert.match(result.reportSha256!, /^[0-9a-f]{64}$/)
  assert.deepEqual(parseCodexQualificationReport(JSON.parse(await readFile(result.reportPath!, "utf8"))), report)
  assert.deepEqual(f.executionRoots, [])
})

test("qualification binds the controller revision to the observed current revision", async t => {
  const f = await qualificationHarnessFixture(t)
  let observations = 0
  ;(f.dependencies as any).currentRevision = async () => { observations++; return { branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit } }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(observations, 1)
  assert.equal(report.branch, reviewedRevision.reviewedBranch)
  assert.equal(report.commit, reviewedRevision.reviewedCommit)
})

test("successful fixture qualification has complete postconditions and no profile", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.deepEqual(report.protocol.methods, ["initialize", "session/new", "session/set_config_option:model", "session/set_config_option:reasoning_effort", "session/set_config_option:mode", "session/prompt"])
  assert.deepEqual(report.selection, { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only" })
  assert.equal(report.version, 3)
  assert.deepEqual(report.observation.candidate, f.candidate)
  assert.equal(report.prompt.state, "completed")
  assert.match(report.prompt.challenge!, /^AGENCY_CODEX_SMOKE_[0-9a-f]{32}$/)
  assert.equal(report.prompt.normalizedAnswer, report.prompt.challenge)
  assert.equal(report.prompt.stopReason, "end_turn")
  assert.ok(report.prompt.durationMs! < report.deadlines.prompt.limitMs)
  assert.equal(Object.hasOwn(report.observation, "userSecurityState"), false)
  assert.equal(Object.hasOwn(report.postconditions, "userSecurityState"), false)
  assert.deepEqual(report.postconditions, { transport: "closed", directChild: "terminal", processGroup: "absent", reservation: "released", providerState: "absent", qualificationCwd: "absent", executionRoot: "absent", lifecycleOperation: "terminal", ownedStreams: "closed", handler: "absent", catalogProfile: "absent", normalAgencyState: "unchanged" })
  assert.ok(Object.values(report.deadlines).every(value => value.outcome === "completed"))
  assert.deepEqual(parseCodexQualificationReport(report), report)
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
  for (const version of [1, 2]) assert.throws(() => parseQualificationCandidate({ ...f.candidate, version }), { code: "ADAPTER_UNQUALIFIED" })
  for (const version of [1, 2]) assert.throws(() => parseCodexQualificationReport({ ...report, version }), { code: "REPORT_INVALID" })
})

test("prompt Handler exchange reserves bounded dispatch and reply overhead", async t => {
  const f = await qualificationHarnessFixture(t)
  let promptTimeout: number | null = null
  ;(f.dependencies as any).exchangeAgent = (socket: Parameters<typeof exchangeAgentProtocol>[0], request: Parameters<typeof exchangeAgentProtocol>[1], timeout: number) => {
    if (request.op === "agent_prompt") promptTimeout = timeout
    return exchangeAgentProtocol(socket, request, timeout)
  }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(promptTimeout, 95000)
  assert.ok(promptTimeout > f.candidate.manifest.deadlines.promptMs)
  assert.ok(promptTimeout <= f.candidate.manifest.deadlines.promptMs + f.candidate.manifest.deadlines.commandMs)
})

test("top-level prompt remains not started when the Handler never receives prompt authority", async t => {
  const f = await qualificationHarnessFixture(t)
  ;(f.dependencies as any).exchangeAgent = (socket: Parameters<typeof exchangeAgentProtocol>[0], request: Parameters<typeof exchangeAgentProtocol>[1], timeout: number) => {
    if (request.op === "agent_prompt") { socket.destroy(); return Promise.reject(new AgentError("INVALID_PROTOCOL")) }
    return exchangeAgentProtocol(socket, request, timeout)
  }
  const result = await runCodexQualification(f.request, f.dependencies), { report } = result
  assert.equal(report.qualified, false)
  assert.equal(report.failure, "INVALID_PROTOCOL")
  assert.deepEqual(report.prompt, { state: "not_started", challenge: null, prompt: null, answer: null, normalizedAnswer: null, stopReason: null, durationMs: null })
  assert.equal(report.deadlines.prompt.outcome, "not_reached")
  assert.deepEqual(report.prompt, report.observation.receipt!.prompt)
  assert.deepEqual(report.protocol.methods, report.observation.receipt!.methods)
  await assertClosedQualificationFailure(f, result, "INVALID_PROTOCOL")
})

test("successful prompt qualification removes surrounding whitespace only", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-whitespace")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(report.prompt.state, "completed")
  assert.equal(report.prompt.answer, ` \n${report.prompt.challenge}\n `)
  assert.equal(report.prompt.normalizedAnswer, report.prompt.challenge)
})

for (const scenario of ["prompt-fragmented", "prompt-multiple"] as const) test(`successful qualification accepts ${scenario} text chunks`, async t => {
  const f = await qualificationHarnessFixture(t, scenario)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(report.prompt.state, "completed")
  assert.equal(report.prompt.answer, report.prompt.challenge)
  assert.equal(report.prompt.normalizedAnswer, report.prompt.challenge)
  assert.deepEqual(report.protocol.methods.filter(method => method === "session/prompt"), ["session/prompt"])
  assert.deepEqual(await f.providerAudit(), { scenario, chunks: scenario === "prompt-fragmented" ? 2 : 3 })
})

for (const [scenario, failure] of [
  ["prompt-extra-content", "ADAPTER_UNQUALIFIED"], ["prompt-non-text", "INVALID_PROTOCOL"],
  ["prompt-malformed-result", "INVALID_PROTOCOL"], ["prompt-duplicate-result", "INVALID_PROTOCOL"],
  ["prompt-late-result", "INVALID_PROTOCOL"], ["prompt-wrong-request-id", "INVALID_PROTOCOL"], ["prompt-wrong-session-id", "INVALID_PROTOCOL"],
  ["prompt-max-tokens", "INVALID_PROTOCOL"], ["prompt-max-turn-requests", "INVALID_PROTOCOL"], ["prompt-refusal", "INVALID_PROTOCOL"], ["prompt-cancelled", "INVALID_PROTOCOL"],
  ["prompt-tool-call", "INVALID_PROTOCOL"], ["prompt-tool-call-update", "INVALID_PROTOCOL"],
  ["prompt-permission", "PERMISSION_UNSUPPORTED"], ["prompt-permission-malformed", "INVALID_PROTOCOL"],
  ["prompt-fs-read", "INVALID_PROTOCOL"], ["prompt-fs-write", "INVALID_PROTOCOL"],
  ["prompt-terminal-create", "INVALID_PROTOCOL"], ["prompt-terminal-output", "INVALID_PROTOCOL"], ["prompt-terminal-release", "INVALID_PROTOCOL"], ["prompt-terminal-wait-for-exit", "INVALID_PROTOCOL"], ["prompt-terminal-kill", "INVALID_PROTOCOL"],
  ["prompt-unknown-request", "INVALID_PROTOCOL"], ["prompt-answer-overflow", "INVALID_PROTOCOL"], ["prompt-frame-overflow", "INVALID_PROTOCOL"],
  ["prompt-config-drift", "SELECTION_UNSUPPORTED"],
] as const) test(`prompt failure ${scenario} is single-attempt and fully cleaned`, async t => {
  const f = await qualificationHarnessFixture(t, scenario)
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, failure)
  assert.notEqual(result.report.prompt.state, "not_started")
  assert.deepEqual(result.report.protocol.methods.filter(method => method === "session/prompt"), ["session/prompt"])
  if (scenario === "prompt-tool-call" || scenario === "prompt-tool-call-update") assert.deepEqual(await f.providerAudit(), { scenario, updateKind: scenario === "prompt-tool-call" ? "tool_call" : "tool_call_update" })
  if (scenario === "prompt-late-result") {
    assert.deepEqual(result.report.prompt, { state: "completed", challenge: result.report.prompt.challenge, prompt: result.report.prompt.prompt, answer: result.report.prompt.challenge, normalizedAnswer: result.report.prompt.challenge, stopReason: "end_turn", durationMs: result.report.prompt.durationMs })
    assert.deepEqual(await f.providerAudit(), { scenario, events: ["answer", "result", "late-update"], childAlive: true })
  }
})

test("owned Codex child death after prompt authority retains attempted-prompt evidence and completes cleanup", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-child-death")
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, "STARTUP_FAILED")
  assert.deepEqual(result.report.protocol.methods.filter(method => method === "session/prompt"), ["session/prompt"])
  assert.equal(result.report.prompt.state, "in_flight_failed")
  assert.equal(result.report.prompt.answer, "")
  assert.equal(result.report.prompt.normalizedAnswer, null)
  assert.equal(result.report.prompt.stopReason, null)
  assert.deepEqual(await f.providerAudit(), { scenario: "prompt-child-death", childKilled: true })
})

test("successful prompt publication forwards exactly once", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-forward-success")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.deepEqual(await f.forwardAudit(), { promptWrites: 1 })
  assert.deepEqual(await f.providerAudit(), { scenario: "prompt-forward-success", promptRequests: 1 })
})

for (const [scenario, failure] of [["prompt-forward-timeout", "STARTUP_TIMEOUT"], ["prompt-forward-stop", "STARTUP_FAILED"]] as const) test(`${scenario} releases held publication without forwarding and completes cleanup`, async t => {
  const f = await qualificationHarnessFixture(t, scenario)
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, failure)
  assert.equal(result.report.prompt.state, "in_flight_failed")
  assert.deepEqual(await f.forwardAudit(), null)
  assert.deepEqual(await f.providerAudit(), null)
})

test("prompt abort releases held publication without forwarding and completes cleanup", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-forward-abort")
  ;(f.dependencies as any).exchangeAgent = (socket: Parameters<typeof exchangeAgentProtocol>[0], request: Parameters<typeof exchangeAgentProtocol>[1], timeout: number) => {
    const result = exchangeAgentProtocol(socket, request, timeout)
    if (request.op === "agent_prompt") void (async () => {
      const receipt = join(f.executionRoots.at(-1)!, "receipts", "prompt-publication-held.json")
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await readFile(receipt).then(() => true, () => false)) { socket.destroy(); return }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      socket.destroy()
    })()
    return result
  }
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, "UNAVAILABLE")
  assert.equal(result.report.prompt.state, "in_flight_failed")
  assert.deepEqual(await f.forwardAudit(), null)
  assert.deepEqual(await f.providerAudit(), null)
})

test("prompt abort revokes forwarding before delayed wrapper cleanup", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-forward-abort-gap")
  ;(f.dependencies as any).exchangeAgent = (socket: Parameters<typeof exchangeAgentProtocol>[0], request: Parameters<typeof exchangeAgentProtocol>[1], timeout: number) => {
    const result = exchangeAgentProtocol(socket, request, timeout)
    if (request.op === "agent_prompt") void (async () => {
      const waitFor = async (path: string) => {
        for (let attempt = 0; attempt < 500; attempt++) {
          if (await readFile(path).then(() => true, () => false)) return
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.fail(`timed out waiting for ${path}`)
      }
      await waitFor(join(f.executionRoots.at(-1)!, "receipts/prompt-publication-held.json"))
      socket.destroy()
      await waitFor(join(f.root, "provider-cleanup-blocked.json"))
      await writeFile(join(f.root, "release-prompt-publication"), "release", { mode: 0o600 })
      try { await waitFor(join(f.root, "prompt-publication-resumed.json")) }
      finally { await writeFile(join(f.root, "release-provider-cleanup"), "release", { mode: 0o600 }) }
    })()
    return result
  }
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, "UNAVAILABLE")
  assert.deepEqual(await f.forwardAudit(), null)
  assert.deepEqual(await f.providerAudit(), null)
  assert.equal(result.report.prompt.state, "in_flight_failed")
})

test("Handler death during prompt recovers from prompt evidence published before provider forwarding", async t => {
  const f = await qualificationHarnessFixture(t, "handler-death")
  const result = await runCodexQualification(f.request, f.dependencies)
  const { report, reportPath, reportSha256 } = result
  assert.equal(report.qualified, false)
  assert.equal(report.failure, "UNAVAILABLE")
  assert.ok(reportPath)
  assert.equal(digest(await readFile(reportPath!)), reportSha256)
  assert.equal(report.ownership.handlers.length, 2)
  assert.ok(report.observation.receipt)
  assert.equal(report.observation.receipt!.terminal, false)
  assert.equal(report.observation.receipt!.transportClosed, false)
  assert.equal(report.observation.receipt!.streamsClosed, false)
  assert.equal(report.prompt.state, "in_flight_failed")
  assert.match(report.prompt.challenge!, /^AGENCY_CODEX_SMOKE_[0-9a-f]{32}$/)
  assert.equal(report.prompt.answer, "")
  assert.equal(report.prompt.normalizedAnswer, null)
  assert.equal(report.prompt.stopReason, null)
  assert.deepEqual(report.prompt, report.observation.receipt!.prompt)
  assert.deepEqual(report.protocol.methods, report.observation.receipt!.methods)
  assert.deepEqual(report.protocol.methods.filter(method => method === "session/prompt"), ["session/prompt"])
  assert.ok(report.observation.retained.recovery)
  assert.equal(report.observation.retained.recovery!.consistent, true)
  assert.equal(report.observation.retained.recovery!.launch!.phase, "cleanup_verified")
  assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(report.postconditions.reservation, "released")
  assert.equal(report.postconditions.providerState, "absent")
  assert.equal(report.postconditions.qualificationCwd, "absent")
  assert.equal(report.postconditions.executionRoot, "absent")
  assert.equal(report.postconditions.lifecycleOperation, "terminal")
  assert.equal(report.postconditions.handler, "absent")
  assert.equal(report.postconditions.catalogProfile, "absent")
  assert.equal(report.postconditions.normalAgencyState, "unchanged")
  assert.equal(report.observation.absence!.outcome, "completed")
  assert.equal(report.observation.absence!.handler, "absent")
  assert.equal(report.observation.absence!.provider, "absent")
  for (const executionRoot of f.executionRoots) await assert.rejects(lstat(executionRoot), { code: "ENOENT" })
  assertRegistriesUnchanged()
})

for (const [scenario, failure, promptState] of [["adapter-exit", "STARTUP_FAILED", "not_started"], ["codex-exit", "STARTUP_FAILED", "not_started"], ["prompt-exit", "STARTUP_FAILED", "in_flight_failed"]] as const) test(`${scenario} retains failure evidence and completes owned cleanup`, async t => {
  const f = await qualificationHarnessFixture(t, scenario)
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, failure)
  assert.equal(result.report.prompt.state, promptState)
  assert.equal(result.report.protocol.methods.filter(method => method === "session/prompt").length, promptState === "in_flight_failed" ? 1 : 0)
})

test("prompt client abort after Handler authority settles once and completes cleanup", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-abort")
  ;(f.dependencies as any).exchangeAgent = (socket: Parameters<typeof exchangeAgentProtocol>[0], request: Parameters<typeof exchangeAgentProtocol>[1], timeout: number) => {
    const result = exchangeAgentProtocol(socket, request, timeout)
    if (request.op === "agent_prompt") void (async () => {
      const receipts = join(f.executionRoots.at(-1)!, "receipts")
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await readdir(receipts)).some(name => name.endsWith(".prompt.json"))) { socket.destroy(); return }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      socket.destroy()
    })()
    return result
  }
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, "UNAVAILABLE")
  assert.equal(result.report.prompt.state, "in_flight_failed")
  assert.deepEqual(result.report.protocol.methods.filter(method => method === "session/prompt"), ["session/prompt"])
})

test("prompt deadline records one timed-out attempt and completes cleanup", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-deadline")
  const result = await runCodexQualification(f.request, f.dependencies)
  await assertClosedQualificationFailure(f, result, "STARTUP_TIMEOUT")
  assert.equal(result.report.prompt.state, "in_flight_failed")
  assert.ok(result.report.prompt.durationMs! >= result.report.deadlines.prompt.limitMs)
  assert.equal(result.report.deadlines.prompt.outcome, "timed_out")
  assert.deepEqual(result.report.protocol.methods.filter(method => method === "session/prompt"), ["session/prompt"])
})

for (const [scenario, failure] of [
  ["permission", "PERMISSION_UNSUPPORTED"], ["unexpected-rpc", "INVALID_PROTOCOL"],
  ["fs/read_text_file", "INVALID_PROTOCOL"], ["fs/write_text_file", "INVALID_PROTOCOL"], ["terminal/create", "INVALID_PROTOCOL"],
  ["protocol-version", "INVALID_PROTOCOL"], ["auth-required", "AUTH_REQUIRED"], ["auth-malformed", "INVALID_PROTOCOL"],
  ["auth-wrong-method", "STARTUP_FAILED"], ["auth-spoofed", "INVALID_PROTOCOL"],
  ["missing-option", "SELECTION_UNSUPPORTED"], ["duplicate-option", "INVALID_PROTOCOL"],
  ["adapter-exit", "STARTUP_FAILED"], ["codex-exit", "STARTUP_FAILED"], ["prompt-exit", "STARTUP_FAILED"], ["prompt-max-tokens", "INVALID_PROTOCOL"],
  ["handler-startup", "HANDLER_STARTUP_FAILED"], ["stop-failure", "CLEANUP_UNVERIFIED"],
  ["state-removal", "CLEANUP_UNVERIFIED"], ["missing-evidence", "EVIDENCE_MISSING"],
  ...["model", "reasoning", "mode"].flatMap(phase => ["model", "reasoning", "mode", "alias"].map(field => [`substitute-${phase}-${field}`, "SELECTION_UNSUPPORTED"])),
] as const) test(`fixture qualification rejects ${scenario}`, async t => {
  const f = await qualificationHarnessFixture(t, scenario)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, failure, JSON.stringify(report))
  assert.equal(report.postconditions.handler, "absent")
  assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(report.authentication, scenario === "auth-required" ? "auth_required" : report.authentication)
  if (scenario === "prompt-exit") assert.deepEqual(report.prompt, { state: "in_flight_failed", challenge: report.prompt.challenge, prompt: report.prompt.prompt, answer: "", normalizedAnswer: null, stopReason: null, durationMs: report.prompt.durationMs })
  if (scenario === "prompt-exit") assert.equal(report.deadlines.prompt.outcome, "failed")
  if (scenario === "prompt-max-tokens") { assert.equal(report.prompt.state, "completed"); assert.equal(report.prompt.stopReason, "max_tokens"); assert.equal(report.prompt.normalizedAnswer, report.prompt.challenge) }
  if (scenario === "prompt-max-tokens") assert.equal(report.deadlines.prompt.outcome, "completed")
  if (scenario === "prompt-exit" || scenario === "prompt-max-tokens") assert.deepEqual(parseCodexQualificationReport(report), report)
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
  assert.throws(() => parseCodexQualificationReport({ ...report, qualified: true, failure: null }))
})

test("report publication fsync failure cannot qualify or register", async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.publish = async (path, value) => {
    if (path.endsWith("/report.json")) return durableQualificationWrite(path, value, { open: (async (...args: Parameters<typeof open>) => { const handle = await open(...args); handle.sync = async () => { throw new Error("fixture fsync failure") }; return handle }) as typeof open })
    await durableQualificationWrite(path, value)
  }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "EVIDENCE_PUBLICATION_FAILED")
  assert.throws(() => parseCodexQualificationReport({ ...report, qualified: true }))
  const directory = join(f.request.evidenceParent, "codex-qualification")
  for (const name of await readdir(directory)) if (name.startsWith("attempt-")) {
    assert.ok(!(await readdir(join(directory, name))).includes("report.json"))
    const failed = JSON.parse(await readFile(join(directory, name, "report-failed.json"), "utf8"))
    assert.equal(parseCodexQualificationReport(failed).qualified, false)
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", join(directory, name, "report-failed.json"), ...revisionArgs]), { code: 1 })
  }
})

test("source generation is bound to the exact report bytes and reviewed candidate", async t => {
  const f = await qualificationHarnessFixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  assert.ok(result.reportPath); assert.match(result.reportSha256!, /^[0-9a-f]{64}$/)
  const bytes = await readFile(result.reportPath!), observed = digest(bytes)
  assert.equal(result.reportSha256, observed)
  assert.match(renderPublishedQualificationSource(f.candidate, result.report, observed, observed, reviewedRevision), /export const codexDarwinArm64QualifiedContract: LaunchContract/)
  assert.throws(() => renderPublishedQualificationSource(f.candidate, result.report, "0".repeat(64), observed, reviewedRevision), { code: "EVIDENCE_PUBLICATION_FAILED" })
  assert.throws(() => renderPublishedQualificationSource({ ...f.candidate, fingerprint: "0".repeat(64) }, result.report, observed, observed, reviewedRevision), { code: "ADAPTER_UNQUALIFIED" })
  const equivalent = Buffer.from(JSON.stringify(result.report, null, 2)), equivalentPath = join(f.root, "equivalent.json")
  await writeFile(equivalentPath, equivalent, { mode: 0o600 })
  assert.notEqual(digest(equivalent), observed)
  assert.throws(() => renderPublishedQualificationSource(f.candidate, JSON.parse(equivalent.toString()), observed, digest(equivalent), reviewedRevision), { code: "EVIDENCE_PUBLICATION_FAILED" })
  for (const revision of [{ ...reviewedRevision, reviewedCommit: "b".repeat(40) }, { ...reviewedRevision, reviewedBranch: "master" }]) {
    assert.throws(() => renderPublishedQualificationSource(f.candidate, result.report, observed, observed, revision), { code: "ADAPTER_UNQUALIFIED" })
  }
  for (const version of [1, 2]) {
    assert.throws(() => renderPublishedQualificationSource({ ...f.candidate, version } as typeof f.candidate, result.report, observed, observed, reviewedRevision), { code: "ADAPTER_UNQUALIFIED" })
    assert.throws(() => renderPublishedQualificationSource(f.candidate, { ...result.report, version }, observed, observed, reviewedRevision), { code: "REPORT_INVALID" })
  }
})

test("source generation rejects same-buffer report replacement without starting revalidation", async t => {
  const f = await qualificationHarnessFixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  const replacement = join(f.root, "replacement-report.json"), bytes = await readFile(result.reportPath!)
  await writeFile(replacement, bytes, { mode: 0o600 })
  const originalOpen = fsPromises.open
  let replaced = false, revalidated = 0
  fsPromises.open = (async (path: any, flags: any, mode: any) => {
    const handle = await originalOpen(path, flags, mode)
    if (path !== result.reportPath) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (...args: any[]) => {
        const value = await (target.read as any)(...args)
        if (!replaced) { replaced = true; await rename(replacement, result.reportPath!) }
        return value
      }
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open
  syncBuiltinESMExports()
  const dependencies = { ...f.dependencies, async currentRevision() { revalidated++; return { branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit } }, async verify(value: Parameters<QualificationDependencies["verify"]>[0]) { revalidated++; return f.dependencies.verify(value) } }
  try {
    await assert.rejects(codexQualificationMain(["--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", result.reportPath!, "--report-sha256", result.reportSha256!, ...revisionArgs], dependencies), { code: "EVIDENCE_MISSING" })
    assert.equal(revalidated, 0)
  } finally { fsPromises.open = originalOpen; syncBuiltinESMExports() }
})

test("source generation rejects current branch or HEAD drift before revalidation", async t => {
  const f = await qualificationHarnessFixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  for (const current of [
    { branch: "master", commit: reviewedRevision.reviewedCommit },
    { branch: reviewedRevision.reviewedBranch, commit: "b".repeat(40) },
  ]) {
    let observations = 0
    ;(f.dependencies as any).currentRevision = async () => { observations++; return current }
    const args = ["--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", result.reportPath!, "--report-sha256", result.reportSha256!, ...revisionArgs]
    await assert.rejects(Reflect.apply(codexQualificationMain, undefined, [args, f.dependencies]), { code: "ADAPTER_UNQUALIFIED" })
    assert.equal(observations, 1)
  }
})

test("source generation binds report hash, candidate, and report revision before revalidation", async t => {
  const f = await qualificationHarnessFixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  const changedManifest = parseCodexQualificationManifest({ ...structuredClone(f.candidate.manifest), adapterEntrypoint: { ...f.candidate.manifest.adapterEntrypoint, sha256: "0".repeat(64) } })
  const changedCandidate = { version: 3 as const, manifest: changedManifest, fingerprint: qualificationFingerprint(changedManifest) }
  const changedCandidatePath = join(f.root, "changed-candidate.json")
  await writeFile(changedCandidatePath, JSON.stringify(changedCandidate), { mode: 0o600 })
  const cases = [
    { name: "hash", candidatePath: f.request.candidatePath, reportSha256: "0".repeat(64), revision: reviewedRevision, code: "EVIDENCE_PUBLICATION_FAILED" },
    { name: "candidate", candidatePath: changedCandidatePath, reportSha256: result.reportSha256!, revision: reviewedRevision, code: "ADAPTER_UNQUALIFIED" },
    { name: "revision", candidatePath: f.request.candidatePath, reportSha256: result.reportSha256!, revision: { ...reviewedRevision, reviewedCommit: "b".repeat(40) }, code: "ADAPTER_UNQUALIFIED" },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    const revalidators: string[] = [], platform = f.dependencies.adapter, verify = f.dependencies.verify
    const dependencies = {
      ...f.dependencies,
      async currentRevision() { revalidators.push("revision"); return { branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit } },
      async verify(manifest: Parameters<QualificationDependencies["verify"]>[0]) { revalidators.push("artifact"); return verify(manifest) },
      adapter: {
        ...platform,
        async readProcess(pid: number) { revalidators.push("process"); return platform.readProcess(pid) },
        async readGroup(group: number) { revalidators.push("group"); return platform.readGroup(group) },
      },
    } as QualificationDependencies
    Object.defineProperty(dependencies, "normalStatePaths", { enumerable: true, get() { revalidators.push("normal"); return f.dependencies.normalStatePaths } })
    const args = ["--stage", "source", "--candidate", item.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", result.reportPath!, "--report-sha256", item.reportSha256, "--reviewed-branch", item.revision.reviewedBranch, "--reviewed-commit", item.revision.reviewedCommit]
    await assert.rejects(Reflect.apply(codexQualificationMain, undefined, [args, dependencies]), { code: item.code })
    assert.deepEqual(revalidators, [])
  })
})

test("failed secondary publication returns only the durable failure report and hash", async t => {
  const f = await qualificationHarnessFixture(t), copy = join(f.root, "report-copy.json")
  f.dependencies.publish = async (path, value) => {
    if (path === copy) throw new Error("secondary publication failed")
    await durableQualificationWrite(path, value)
  }
  const result = await runCodexQualification({ ...f.request, reportPath: copy }, f.dependencies)
  assert.equal(result.report.failure, "EVIDENCE_PUBLICATION_FAILED")
  assert.ok("reportPath" in result && typeof result.reportPath === "string")
  assert.match(result.reportSha256!, /^[0-9a-f]{64}$/)
  assert.ok(result.reportPath.endsWith("/report-failed.json"))
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report)
  assert.throws(() => renderPublishedQualificationSource(f.candidate, result.report, "0".repeat(64), result.reportSha256!, reviewedRevision), { code: "ADAPTER_UNQUALIFIED" })
})

for (const kind of ["delayed", "never-settling"] as const) test(`${kind} parent absence prevents qualification and retains roots`, async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.absenceAdapter = { readProcess: () => kind === "never-settling" ? new Promise(() => undefined) : new Promise(resolve => setTimeout(() => resolve(null), 1300)), async readGroup() { return [] } }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "ABSENCE_TIMEOUT")
  assert.equal(report.deadlines.absence.outcome, "timed_out")
  assert.equal(report.observation.absence!.outcome, "timed_out")
  assert.equal(report.postconditions.handler, "unknown"); assert.equal(report.postconditions.processGroup, "unknown")
  assert.equal(report.postconditions.ownedStreams, "closed"); assert.equal(report.postconditions.executionRoot, "present")
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("qualification succeeds without descriptor inspection and retains cleanup proof", async t => {
  const f = await qualificationHarnessFixture(t)
  const original = childProcess.execFile
  let inspections = 0
  childProcess.execFile = ((...args: Parameters<typeof execFile>) => {
    if (args[0] === "/usr/sbin/lsof") { inspections++; throw new Error("descriptor inspection excluded") }
    return original(...args)
  }) as typeof execFile
  syncBuiltinESMExports(); t.after(() => { childProcess.execFile = original; syncBuiltinESMExports() })
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(inspections, 0)
  assert.equal(Object.hasOwn(report.observation, "descriptors"), false)
  assert.deepEqual(report.postconditions, { transport: "closed", directChild: "terminal", processGroup: "absent", reservation: "released", providerState: "absent", qualificationCwd: "absent", executionRoot: "absent", lifecycleOperation: "terminal", ownedStreams: "closed", handler: "absent", catalogProfile: "absent", normalAgencyState: "unchanged" })
  assert.equal(report.observation.receipt!.streamsClosed, true)
  assert.equal(report.observation.receipt!.terminal, true)
  assert.equal(report.observation.receipt!.transportClosed, true)
  assert.deepEqual(report.observation.normalAgencyState.before, report.observation.normalAgencyState.after)
  assert.equal(report.observation.absence!.outcome, "completed")
  assert.equal(report.observation.absence!.passes, 2)
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("report and source accept no descriptor inventory but require remaining cleanup evidence", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report, reportSha256 } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.ok(reportSha256)
  assert.equal(Object.hasOwn(report.observation, "descriptors"), false)
  assert.equal(parseCodexQualificationReport(report).qualified, true)
  assert.match(renderPublishedQualificationSource(f.candidate, report, reportSha256, reportSha256, reviewedRevision), /codexDarwinArm64QualifiedContract/)
  const cases: Array<[string, (value: any) => void]> = [
    ["missing receipt", value => { value.observation.receipt = null }],
    ...["terminal", "transportClosed", "streamsClosed"].map(key => [`receipt ${key}`, (value: any) => { value.observation.receipt[key] = false }] as [string, (value: any) => void]),
    ...Object.keys(report.postconditions).map(key => [`postcondition ${key}`, (value: any) => { value.postconditions[key] = "unknown" }] as [string, (value: any) => void]),
    ["missing absence", value => { value.observation.absence = null }],
    ["missing process identity", value => { value.observation.absence.targets.pop() }],
    ["changed normal state", value => { value.observation.normalAgencyState.after = [] }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = structuredClone(report); mutate(value)
    assert.throws(() => parseCodexQualificationReport(value))
    assert.throws(() => renderPublishedQualificationSource(f.candidate, value, reportSha256, reportSha256, reviewedRevision))
  })
})

test("surviving provider group prevents qualification and retains state", async t => {
  const f = await qualificationHarnessFixture(t, "survivor")
  const platform = f.dependencies.adapter
  let providerGroup = 0
  f.dependencies.beforeCleanup = async (_root, report) => { providerGroup = report.ownership.providerProcessGroup!.leader.processGroupId }
  f.dependencies.adapter = { ...platform, async signalGroup(group, signal) { if (group !== providerGroup) await platform.signalGroup(group, signal) } }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "CLEANUP_UNVERIFIED", JSON.stringify(report))
  assert.equal(report.postconditions.processGroup, "present"); assert.equal(report.postconditions.executionRoot, "present")
  assert.equal(report.postconditions.handler, "absent"); assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("durable writer refuses existing files and symlinks", async t => {
  const f = await qualificationHarnessFixture(t), path = join(f.root, "exclusive.json")
  await durableQualificationWrite(path, { value: 1 })
  await assert.rejects(durableQualificationWrite(path, { value: 2 }), { code: "EEXIST" })
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { value: 1 })
  await symlink(path, join(f.root, "link.json"))
  await assert.rejects(durableQualificationWrite(join(f.root, "link.json"), { value: 2 }))
})

test("tree observation rejects symlinks and detects normal-state drift without retaining names", async t => {
  const f = await qualificationHarnessFixture(t)
  await writeFile(join(f.user, "private-name"), "secret")
  const before = await snapshotTree(f.user)
  assert.equal(before.entries, 2); assert.equal(before.bytes, 6)
  assert.ok(!JSON.stringify(before).includes("private-name")); assert.ok(!JSON.stringify(before).includes("secret"))
  await writeFile(join(f.user, "private-name"), "changed")
  assert.notDeepEqual(await snapshotTree(f.user), before)
  await symlink(join(f.user, "private-name"), join(f.user, "link"))
  await assert.rejects(snapshotTree(f.user), { code: "USER_STATE_UNAVAILABLE" })
})

test("an oversized normal-state tree fails before Handler startup", async t => {
  const f = await qualificationHarnessFixture(t), handle = await open(join(f.user, "large"), "wx", 0o600)
  await handle.truncate(268435457); await handle.close()
  f.dependencies.normalStatePaths = [f.user]
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "NORMAL_STATE_UNAVAILABLE")
  assert.deepEqual(report.ownership.handlers, []); assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("an unreadable normal-state tree has a closed prelaunch failure", async t => {
  const f = await qualificationHarnessFixture(t), path = join(f.user, "unreadable")
  await writeFile(path, "unreadable", { mode: 0o600 }); await chmod(path, 0)
  f.dependencies.normalStatePaths = [f.user]
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "NORMAL_STATE_UNAVAILABLE")
  assert.deepEqual(report.ownership.handlers, []); assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("a pending start beyond reservationMs keeps a healthy Handler alive", async t => {
  const f = await qualificationHarnessFixture(t, "slow-session")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify({ failure: report.failure, deadlines: report.deadlines, postconditions: report.postconditions }))
  assert.equal(report.ownership.handlers.length, 1)
})

test("a reservation fail-stop recovers once without another start", async t => {
  const f = await qualificationHarnessFixture(t, "reservation-hang")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "STARTUP_TIMEOUT")
  assert.equal(report.ownership.handlers.length, 2); assert.equal(report.postconditions.reservation, "released")
  assert.equal(report.postconditions.handler, "absent"); assert.equal(report.ownership.providerProcessGroup, null)
})

test("an initial command-publication timeout recovers with no retry", async t => {
  const f = await qualificationHarnessFixture(t, "command-hang")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "COMMAND_START_TIMEOUT")
  assert.equal(report.ownership.handlers.length, 2); assert.equal(report.postconditions.handler, "absent")
})

test("the parent overall deadline includes a pending stop and records timeout", async t => {
  const f = await qualificationHarnessFixture(t, "parent-overall")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "OVERALL_TIMEOUT")
  assert.equal(report.deadlines.overall.outcome, "timed_out")
  assert.equal(report.ownership.handlers.length, 2)
  assert.equal(report.postconditions.handler, "absent"); assert.equal(report.postconditions.processGroup, "absent")
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

for (const changed of ["handler", "provider", "command", "agent", "session"] as const) test(`runtime ${changed} evidence substitution is rejected before stop`, async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.beforeCleanup = async (_root, report) => {
    if (changed === "handler") report.ownership.handlers[0]!.process.birth = "1:agy-handler:" + report.ownership.handlers[0]!.launchAttemptId
    if (changed === "provider") report.ownership.providerProcessGroup!.leader.parentPid++
    if (changed === "command") report.observation.retained.command!.result!.session!.sessionId = "replaced"
    if (changed === "agent") report.observation.retained.agent!.launch.launchAttemptId = "00000000-0000-4000-8000-999999999999"
    if (changed === "session") report.session!.sessionId = "replaced"
  }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "OWNERSHIP_INVALID")
  assert.equal(report.postconditions.handler, "absent"); assert.equal(report.postconditions.processGroup, "absent")
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("qualification paths reject noncanonical or oversized sockets", () => {
  assert.throws(() => qualificationPaths("/tmp/../tmp/attempt", "a".repeat(64)))
  assert.throws(() => qualificationPaths("/tmp/" + "x".repeat(100), "a".repeat(64)))
})

test("injected launch evidence rejects a substituted contract or permission profile", async t => {
  const f = await qualificationHarnessFixture(t), spec = sampleQualifiedSpec()
  const evidence = launchEvidenceFromQualifiedCandidate(f.candidate, spec.handlerGeneration, Date.now())
  Object.assign(spec, { catalogSnapshotId: evidence.snapshotId, catalogEvidence: evidence.provider, configuration: evidence.configuration, contractFingerprint: f.candidate.fingerprint })
  await verifyInjectedLaunchEvidence(f.candidate, evidence, spec, evidence)
  await assert.rejects(verifyInjectedLaunchEvidence(f.candidate, evidence, { ...spec, contractId: "substituted" }, evidence), { code: "CONFIG_CHANGED" })
  await assert.rejects(verifyInjectedLaunchEvidence(f.candidate, evidence, { ...spec, selection: { ...spec.selection, permissionProfile: "substituted" } }, evidence), { code: "CONFIG_CHANGED" })
})

test("qualified report rejects missing and substituted identity and session evidence", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report: baseline } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(baseline.qualified, true, JSON.stringify(baseline))
  const withinOverall = structuredClone(baseline)
  withinOverall.observation.receipt!.durations.overall = 149999
  assert.equal(parseCodexQualificationReport(withinOverall).qualified, true)
  for (const mutate of [
    (r: any) => { r.ownership.handlers = [] }, (r: any) => { r.ownership.handlers.push(r.ownership.handlers[0]) },
    (r: any) => { r.ownership.handlers[0].generation = "00000000-0000-4000-8000-999999999999" },
    (r: any) => { r.ownership.handlers[0].process.extra = true }, (r: any) => { r.ownership.providerProcessGroup = null },
    (r: any) => { r.ownership.providerProcessGroup.leader.parentPid++ }, (r: any) => { r.ownership.agentId = r.ownership.leaseId },
    (r: any) => { r.observation.retained.handlers[0].hostId = "b".repeat(64) },
    (r: any) => { r.observation.retained.launch.launchBootId = "other-boot" },
    (r: any) => { for (const group of [r.ownership.providerProcessGroup, r.observation.retained.launch.provider.group]) { group.leader.bootId = "other-boot"; for (const p of group.observed) p.bootId = "other-boot" } },
    (r: any) => { r.session = null }, (r: any) => { r.session.sessionId = "substituted" },
    (r: any) => { r.session.modelId = "gpt-5.6" }, (r: any) => { r.session.reasoning.value = "low" },
    (r: any) => { r.session.mode = "write" }, (r: any) => { r.session.permissionEvidence = "fixture-contract-v1" },
    (r: any) => { r.deadlines.overall.outcome = "not_reached" }, (r: any) => { r.postconditions.processGroup = "present" },
    (r: any) => { r.observation.descriptors = {} },
    (r: any) => { r.observation.absence = null }, (r: any) => { r.observation.absence.outcome = "timed_out" },
    (r: any) => { r.observation.absence.durationMs = r.observation.absence.limitMs },
    (r: any) => { r.observation.absence.targets.pop() },
    (r: any) => { r.observation.verification = null }, (r: any) => { r.observation.verification.fingerprint = "0".repeat(64) },
    (r: any) => { r.observation.candidate.fingerprint = "0".repeat(64) }, (r: any) => { r.observation.candidate.manifest.adapterEntrypoint.sha256 = "0".repeat(64) },
    (r: any) => { r.observation.version = 2 }, (r: any) => { r.observation.userState = { before: [], after: [] } },
    (r: any) => { r.postconditions.userState = "unchanged" },
    (r: any) => { r.prompt.answer += "extra" }, (r: any) => { r.prompt.answer = "x".repeat(4097) }, (r: any) => { r.prompt.prompt += "x" }, (r: any) => { r.prompt.challenge = "AGENCY_CODEX_SMOKE_short" }, (r: any) => { r.prompt.normalizedAnswer = "wrong" },
    (r: any) => { r.prompt.stopReason = "max_tokens" }, (r: any) => { r.prompt.durationMs = 90000 },
    (r: any) => { r.qualified = false; r.failure = "STARTUP_FAILED"; r.prompt.state = "in_flight_failed" },
    (r: any) => { r.protocol.methods.pop() },
    (r: any) => { r.failure = "unbounded failure text" }, (r: any) => { r.extra = true },
  ]) {
    const value = structuredClone(baseline); mutate(value)
    assert.throws(() => parseCodexQualificationReport(value))
  }
  assert.throws(() => validateQualifiedOwnership({ ...baseline.ownership, extra: true }))
})

test("report parser rejects contradictory prompt receipt evidence", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report: baseline } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(baseline.qualified, true, JSON.stringify(baseline))
  const cases: Array<[string, (report: any) => void]> = [
    ["receipt prompt", r => { r.observation.receipt.prompt.answer += "x" }],
    ["receipt methods", r => { r.observation.receipt.methods.pop() }],
    ["protocol methods", r => { r.protocol.methods.pop() }],
    ["prompt method without attempt", r => { const empty = { state: "not_started", challenge: null, prompt: null, answer: null, normalizedAnswer: null, stopReason: null, durationMs: null }; r.qualified = false; r.failure = "STARTUP_FAILED"; r.prompt = empty; r.observation.receipt.prompt = empty }],
    ["attempt without prompt method", r => { r.qualified = false; r.failure = "STARTUP_FAILED"; r.protocol.methods.pop(); r.observation.receipt.methods.pop() }],
    ["receipt prompt duration", r => { r.observation.receipt.prompt.durationMs += 1 }],
    ["receipt phase duration", r => { r.observation.receipt.durations.prompt += 1 }],
    ["top-level prompt duration", r => { r.prompt.durationMs += 1 }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const report = structuredClone(baseline)
    mutate(report)
    assert.throws(() => parseCodexQualificationReport(report), { code: "REPORT_INVALID" })
  })
})

test("prompt receipt preserves multibyte whitespace split across stdout Buffers", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-unicode-fragmented")
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(report.prompt.answer, `\u2003${report.prompt.challenge}\u2003`)
  assert.equal(report.prompt.normalizedAnswer, report.prompt.challenge)
  assert.deepEqual(report.observation.receipt!.prompt, report.prompt)
})

test("report parser derives prompt deadline outcome from authoritative receipt prompt evidence", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report: baseline } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(baseline.qualified, true, JSON.stringify(baseline))
  const failed = (prompt: any, outcome: string) => {
    const report: any = structuredClone(baseline)
    report.qualified = false; report.failure = "STARTUP_FAILED"; report.prompt = structuredClone(prompt); report.observation.receipt!.prompt = structuredClone(prompt); report.deadlines.prompt.outcome = outcome
    if (prompt.state === "not_started") {
      report.protocol.methods.pop(); report.observation.receipt!.methods.pop(); delete report.observation.receipt!.durations.prompt
    } else if (prompt.state === "completed") report.observation.receipt!.durations.prompt = prompt.durationMs
    else delete report.observation.receipt!.durations.prompt
    return report
  }
  const empty = { state: "not_started", challenge: null, prompt: null, answer: null, normalizedAnswer: null, stopReason: null, durationMs: null }
  const inFlight = { ...structuredClone(baseline.prompt), state: "in_flight_failed", answer: "", normalizedAnswer: null, stopReason: null, durationMs: 1 }
  const completed = structuredClone(baseline.prompt)
  const timedOut = { ...inFlight, durationMs: baseline.deadlines.prompt.limitMs + 1 }
  const completedTimedOut = { ...completed, durationMs: baseline.deadlines.prompt.limitMs + 1 }
  const cases = [failed(empty, "not_reached"), failed(inFlight, "failed"), failed(completed, "completed"), failed(timedOut, "timed_out"), failed(completedTimedOut, "timed_out")]
  for (const report of cases) {
    assert.deepEqual(parseCodexQualificationReport(report), report)
    for (const outcome of ["not_reached", "failed", "completed", "timed_out"]) if (outcome !== report.deadlines.prompt.outcome) {
      const contradictory: any = structuredClone(report); contradictory.deadlines.prompt.outcome = outcome
      assert.throws(() => parseCodexQualificationReport(contradictory), { code: "REPORT_INVALID" })
    }
  }
  for (const durationMs of [150001, Infinity, NaN, -1]) {
    const unbounded = failed({ ...completed, durationMs }, "timed_out")
    assert.throws(() => parseCodexQualificationReport(unbounded), { code: "REPORT_INVALID" })
  }
  for (const stopReason of [["end_turn"], { toString: "end_turn" }, {}]) await t.test(`rejects non-string prompt stopReason ${JSON.stringify(stopReason)}`, () => {
    const invalid = failed({ ...completed, stopReason }, "completed")
    assert.throws(() => parseCodexQualificationReport(invalid), { code: "REPORT_INVALID" })
  })
})

test("completed over-deadline receipts retain prompt and method evidence after root removal", async t => {
  const f = await qualificationHarnessFixture(t, "prompt-over-deadline-receipt")
  const result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, false)
  assert.equal(result.report.prompt.state, "completed")
  assert.equal(result.report.prompt.durationMs, 90001)
  assert.equal(result.report.prompt.answer, result.report.prompt.challenge)
  assert.equal(result.report.deadlines.prompt.outcome, "timed_out")
  assert.equal(result.report.protocol.methods.at(-1), "session/prompt")
  assert.equal(result.report.postconditions.executionRoot, "absent")
  assert.deepEqual(parseCodexQualificationReport(JSON.parse(await readFile(result.reportPath!, "utf8"))), result.report)
})

test("source generation rechecks authenticated private paths and emits exact source bytes", async t => {
  const f = await qualificationHarnessFixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  const root = f.executionRoots[0]!, cwd = result.report.observation.retained.agent!.definition.cwd
  const privatePaths = [root, cwd, join(root, "state/agents/provider-state", result.report.ownership.launchAttemptId!), join(root, "state/catalog/providers.json")]
  const args = ["--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", result.reportPath!, "--report-sha256", result.reportSha256!, ...revisionArgs]
  let stdout = ""
  t.mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true }) as typeof process.stdout.write)
  assert.equal(await codexQualificationMain(args, f.dependencies), 0)
  const expected = renderPublishedQualificationSource(f.candidate, result.report, result.reportSha256!, result.reportSha256!, reviewedRevision)
  await t.test("exact bytes", () => { assert.equal(stdout, expected); assert.equal(stdout.endsWith("\n"), false) })
  for (const recreated of privatePaths) {
    await t.test(`recreated ${recreated.slice(root.length) || "execution root"}`, async () => {
    await mkdir(dirname(recreated), { recursive: true, mode: 0o700 })
    if (recreated.endsWith(".json")) await writeFile(recreated, "{}", { mode: 0o600 })
    else await mkdir(recreated, { recursive: true, mode: 0o700 })
    let revalidated = 0
    stdout = ""
    const dependencies = { ...f.dependencies, async currentRevision() { revalidated++; return { branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit } } }
    try {
      await assert.rejects(codexQualificationMain(args, dependencies), { code: "CLEANUP_UNVERIFIED" })
      assert.equal(revalidated, 0)
      assert.equal(stdout, "")
    } finally { await rm(root, { recursive: true }) }
    })
  }
  await symlink(f.user, root)
  await assert.rejects(codexQualificationMain(args, f.dependencies), { code: "CLEANUP_UNVERIFIED" })
  await rm(root)
  const dependencies = { ...f.dependencies, async verify(manifest: Parameters<QualificationDependencies["verify"]>[0]) { await mkdir(root, { mode: 0o700 }); return f.dependencies.verify(manifest) } }
  stdout = ""
  await assert.rejects(codexQualificationMain(args, dependencies), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(stdout, "")
  await rm(root, { recursive: true })
})


test("source rejects retained private path substitution before mutable observations", async t => {
  const f = await qualificationHarnessFixture(t), result = await runCodexQualification(f.request, f.dependencies)
  assert.equal(result.report.qualified, true, JSON.stringify(result.report))
  const changed = structuredClone(result.report)
  changed.observation.retained.handlers[0]!.socketPath = join(f.user, "handler.sock")
  const reportPath = join(f.root, "changed-private-path.json"), bytes = JSON.stringify(changed)
  await writeFile(reportPath, bytes, { mode: 0o600 })
  let revalidated = 0
  const dependencies = { ...f.dependencies, async currentRevision() { revalidated++; return { branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit } } }
  await assert.rejects(codexQualificationMain(["--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", reportPath, "--report-sha256", digest(Buffer.from(bytes)), ...revisionArgs], dependencies), { code: "REPORT_INVALID" })
  assert.equal(revalidated, 0)
})

test("two-child qualification requires exact retained process absence identities", async t => {
  const f = await qualificationHarnessFixture(t, "two-children")
  const { report, reportSha256 } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.ok(reportSha256)
  const children = report.ownership.providerProcessGroup!.observed.filter(p => p.pid !== report.ownership.providerProcessGroup!.leader.pid)
  assert.equal(children.length, 2)
  const baseline = structuredClone(report)
  baseline.observation.absence!.targets.reverse()
  assert.equal(parseCodexQualificationReport(baseline).qualified, true)
  assert.match(renderPublishedQualificationSource(f.candidate, baseline, reportSha256, reportSha256, reviewedRevision), /codexDarwinArm64QualifiedContract/)
  for (const mutation of ["omitted", "substituted-birth", "substituted-parent", "extra"] as const) {
    const value = structuredClone(baseline), absence = value.observation.absence!
    const child = absence.targets.find(p => p.pid === children[0]!.pid)!
    if (mutation === "omitted") absence.targets.splice(absence.targets.indexOf(child), 1)
    else if (mutation === "extra") {
      const extra = structuredClone(child)
      extra.pid = Math.max(...absence.targets.map(p => p.pid)) + 1
      absence.targets.push(extra)
    } else {
      if (mutation === "substituted-birth") child.birth = "1:substituted"
      else child.parentPid = children[1]!.pid
    }
    await t.test(`parser rejects ${mutation} process identity`, () => { assert.throws(() => parseCodexQualificationReport(value), { code: "REPORT_INVALID" }) })
    await t.test(`source rejects ${mutation} process identity`, () => { assert.throws(() => renderPublishedQualificationSource(f.candidate, value, reportSha256, reportSha256, reviewedRevision), { code: "REPORT_INVALID" }) })
  }
  await t.test("runtime retains both initialized children before readiness", () => {
    for (const group of [report.ownership.providerProcessGroup!, report.observation.retained.launch!.provider!.group]) {
      assert.equal(group.observed.length, 3)
      for (const child of children) assert.deepEqual(group.observed.find(p => p.pid === child.pid), child)
    }
  })
  for (const mutation of ["missing children", "cyclic child ancestry"] as const) await t.test(`parser and source reject ${mutation} across retained views`, () => {
    const value = structuredClone(baseline)
    const groups = [value.ownership.providerProcessGroup!, value.observation.retained.launch!.provider!.group]
    if (mutation === "missing children") {
      for (const group of groups) group.observed = group.observed.filter(p => p.pid === group.leader.pid)
      value.observation.absence!.targets = value.observation.absence!.targets.filter(p => !children.some(child => child.pid === p.pid))
    } else {
      for (const processes of [...groups.map(group => group.observed), value.observation.absence!.targets]) {
        for (const child of children) processes.find(p => p.pid === child.pid)!.parentPid = children.find(peer => peer.pid !== child.pid)!.pid
      }
    }
    assert.throws(() => parseCodexQualificationReport(value))
    assert.throws(() => renderPublishedQualificationSource(f.candidate, value, reportSha256, reportSha256, reviewedRevision))
  })
})