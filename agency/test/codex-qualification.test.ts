import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, open, readdir, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import childProcess, { execFile } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { Readable } from "node:stream"
import { promisify } from "node:util"
import { productionLaunchContracts } from "../src/agent/contracts.js"
import { launchEvidenceFromQualifiedCandidate, parseCodexQualificationManifest, qualificationFingerprint } from "../src/agent/qualification.js"
import type { SecurityIdentity } from "../src/agent/codex-user-security.js"
import { AgentError } from "../src/agent/types.js"
import { sampleQualifiedContract, sampleQualifiedSpec } from "./agent-support.js"
import { verifyInjectedLaunchEvidence } from "../scripts/qualify-codex-handler.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { sameProcess } from "../src/platform/types.js"
import { codexQualificationMain, durableQualificationWrite, parseCodexQualificationReport, parseQualificationCandidate, pinnedArtifact, qualificationPaths, renderPublishedQualificationSource, runCodexQualification, snapshotTree, validateQualifiedOwnership, type QualificationDependencies } from "../scripts/qualify-codex.js"

const reviewedRevision = { reviewedBranch: "moon/agency-agent-lifecycle", reviewedCommit: "1234567890abcdef1234567890abcdef12345678" }
const revisionArgs = ["--reviewed-branch", reviewedRevision.reviewedBranch, "--reviewed-commit", reviewedRevision.reviewedCommit]

async function qualificationHarnessFixture(t: TestContext, scenario = "normal") {
  const registryBefore = productionLaunchContracts()
  const root = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyqt-" : "/tmp/agyqt-")
  const evidenceParent = join(root, "evidence"), user = join(root, "user"), normal = join(root, "normal")
  await mkdir(evidenceParent, { mode: 0o700 }); await mkdir(user, { mode: 0o700 })
  const manifest = sampleQualifiedContract().qualification!
  const packagePath = join(root, "package.json")
  await writeFile(packagePath, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }), { mode: 0o600 })
  for (const [key, path] of [["adapterPackageJson", packagePath], ["adapterEntrypoint", fileURLToPath(new URL("./fixtures/qualification-provider.js", import.meta.url))], ["nodeExecutable", process.execPath], ["codexExecutable", manifest.codexExecutable.path]] as const) manifest[key] = await pinnedArtifact(path, createHash("sha256").update(await readFile(path)).digest("hex"))
  const candidate = { version: 2 as const, manifest, fingerprint: qualificationFingerprint(manifest) }
  const candidatePath = join(root, "candidate.json")
  await writeFile(candidatePath, JSON.stringify(candidate), { mode: 0o600 })
  const executionRoots: string[] = []
  const platform = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const dependencies: QualificationDependencies = {
    adapter: platform, hostKey: "a".repeat(64),
    verify: async () => ({ ...candidate, nodeVersion: "24.13.0", selection: manifest.selection, artifacts: { adapterPackageJson: manifest.adapterPackageJson, adapterEntrypoint: manifest.adapterEntrypoint, codexExecutable: manifest.codexExecutable, nodeExecutable: manifest.nodeExecutable } }),
    handler: (path, execution) => ({ file: process.execPath, args: [fileURLToPath(new URL("./fixtures/qualification-handler.js", import.meta.url)), path, execution, scenario] }),
    async descriptorCommand(file, args, options) {
      assert.equal(file, "/usr/sbin/lsof"); assert.deepEqual(args.slice(0, 3), ["-nP", "-a", "-p"]); assert.equal(args[4], "-F0pftn"); assert.ok(options.timeout > 0 && options.timeout <= 5000)
      const pid = Number(args[3]), process = await platform.readProcess(pid)
      assert.ok(process)
      const handler = process.birth.includes("agy-handler:"), adapter = process.birth.includes("agy-provider:")
      let extra = ""
      if (scenario === "descriptor-leak" && adapter || scenario === "child-descriptor-leak" && !handler && !adapter) {
        const audit = JSON.parse(await readFile(join(executionRoots.at(-1)!, "receipts", adapter ? "fd-audit.json" : "child-fd-audit.json"), "utf8"))
        assert.equal(audit.inheritedDirectory, true)
        extra = "f3\0tDIR\0nevidence-directory\0\n"
      }
      return { stdout: `p${pid}\0\nf0\0tPIPE\0npipe0\0\nf1\0tPIPE\0npipe1\0\nf2\0tPIPE\0npipe2\0\n${handler ? "f3\0tunix\0nstatus\0\nf4\0tunix\0ngate\0\n" : ""}${extra}`, stderr: "" }
    },
    observeUserSecurityState: async policy => ({ outcome: "match", reason: null, observation: structuredClone(policy) }), normalStatePaths: [normal],
    async createExecutionRoot() { const execution = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyqx-" : "/tmp/agyqx-"); executionRoots.push(execution); return execution },
  }
  t.after(async () => {
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
  return { root, user, normal, candidate, registryBefore, executionRoots, request: { candidatePath, evidenceParent, ...reviewedRevision }, dependencies }
}

test("capability stdin consumes at most 65 bytes before rejecting excess input", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin")!, input = Readable.from([Buffer.alloc(4096, "a")], { objectMode: false })
  const read = input.read.bind(input)
  let consumed = 0
  input.read = size => { const chunk = read(size); if (chunk) consumed += Buffer.byteLength(chunk); return chunk }
  Object.defineProperty(process, "stdin", { value: input, configurable: true })
  t.after(() => { Object.defineProperty(process, "stdin", descriptor); input.destroy() })
  await assert.rejects(codexQualificationMain(["--stage", "source", "--candidate", "/candidate.json", "--evidence-parent", "/evidence", "--report", "/report.json", "--publication-capability-stdin", "true", ...revisionArgs]), { code: "USAGE" })
  assert.equal(consumed, 65)
})

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

for (const gate of ["artifact", "security-mismatch", "security-unavailable", "security-defect", "normal", "claim"] as const) test(`initial ${gate} failure consumes the attempt before execution`, async t => {
  const f = await qualificationHarnessFixture(t), calls: string[] = [], verify = f.dependencies.verify
  const claim = join(f.request.evidenceParent, "codex-qualification", `${f.candidate.fingerprint}.attempt-consumed.json`)
  f.dependencies.verify = async manifest => {
    calls.push("artifact")
    const marker = JSON.parse(await readFile(claim, "utf8"))
    assert.deepEqual(marker, { version: 2, manifestFingerprint: f.candidate.fingerprint, state: "attempt_consumed", evidence: marker.evidence, branch: reviewedRevision.reviewedBranch, commit: reviewedRevision.reviewedCommit })
    if (gate === "artifact") throw new AgentError("ADAPTER_UNQUALIFIED")
    return verify(manifest)
  }
  f.dependencies.observeUserSecurityState = async policy => {
    calls.push("security")
    if (gate === "security-mismatch") return { outcome: "mismatch", reason: "auth_present", observation: null }
    if (gate === "security-unavailable") return { outcome: "unavailable", reason: "auth_unavailable", observation: null }
    if (gate === "security-defect") throw new Error("observer defect")
    return { outcome: "match", reason: null, observation: policy }
  }
  if (gate === "normal") await symlink(f.user, f.normal)
  Object.defineProperty(f.dependencies, "normalStatePaths", { get() { calls.push("normal"); return [f.normal] } })
  f.dependencies.handler = () => { calls.push("handler"); throw new Error("must not launch") }
  if (gate === "claim") f.dependencies.publish = async (path, value) => {
    assert.equal(path, claim)
    await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 })
    throw new Error("claim sync unavailable")
  }
  if (gate === "claim") await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "EVIDENCE_PUBLICATION_FAILED" })
  else {
    const result = await runCodexQualification(f.request, f.dependencies), report = result.report
    assert.equal(report.version, 2); assert.equal(report.qualified, false)
    assert.equal(report.failure, gate === "artifact" ? "ADAPTER_UNQUALIFIED" : gate === "normal" ? "NORMAL_STATE_UNAVAILABLE" : gate === "security-mismatch" ? "USER_SECURITY_STATE_CHANGED" : "USER_SECURITY_STATE_UNAVAILABLE")
    assert.deepEqual(report.ownership.handlers, []); assert.equal(report.ownership.providerProcessGroup, null)
    assert.equal(report.postconditions.handler, "absent"); assert.equal(report.postconditions.processGroup, "absent")
    assert.deepEqual(report.observation.candidate, f.candidate)
    assert.equal(report.observation.verification === null, gate === "artifact")
    assert.ok(result.reportPath)
    assert.deepEqual(parseCodexQualificationReport(JSON.parse(await readFile(result.reportPath, "utf8"))), report)
    assert.equal(result.publicationCapability, null)
  }
  assert.deepEqual(calls, gate === "claim" ? [] : gate === "artifact" ? ["artifact"] : gate === "normal" ? ["artifact", "security", "normal"] : ["artifact", "security"])
  assert.deepEqual(f.executionRoots, [])
  const before = await readFile(claim), observed = [...calls]
  delete f.dependencies.publish
  await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "ATTEMPT_ALREADY_STARTED" })
  assert.deepEqual(calls, observed); assert.deepEqual(await readFile(claim), before)
  assert.equal((await readdir(dirname(claim))).some(path => path.endsWith(".live-started.json")), false)
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("qualification binds the controller revision without source-worktree Git subprocesses", async t => {
  const f = await qualificationHarnessFixture(t), original = childProcess.execFile
  const execute = promisify(original)
  childProcess.execFile = Object.assign(((...args: Parameters<typeof execFile>) => Reflect.apply(original, childProcess, args)) as typeof execFile, {
    [promisify.custom]: (file: string, argv: readonly string[], options: Parameters<typeof execute>[2]) => {
      if (file === "/usr/bin/git" && (argv[0] === "rev-parse" || argv[0] === "branch")) throw new Error("source-worktree Git is outside qualification authority")
      return execute(file, argv, options)
    },
  })
  syncBuiltinESMExports()
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports() })
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.equal(report.branch, reviewedRevision.reviewedBranch)
  assert.equal(report.commit, reviewedRevision.reviewedCommit)
  const nextRequest = { ...f.request, reviewedCommit: "b".repeat(40) }
  await assert.rejects(runCodexQualification(nextRequest, f.dependencies), { code: "ATTEMPT_ALREADY_STARTED" })
})

test("successful fixture qualification has complete postconditions and no profile", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.deepEqual(report.protocol.methods, ["initialize", "session/new", "session/set_config_option:model", "session/set_config_option:reasoning_effort", "session/set_config_option:mode"])
  assert.deepEqual(report.selection, { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only" })
  assert.equal(report.version, 2)
  assert.deepEqual(report.observation.candidate, f.candidate)
  assert.deepEqual(report.observation.userSecurityState.before, { outcome: "match", reason: null, observation: f.candidate.manifest.userSecurityState })
  assert.deepEqual(report.observation.userSecurityState.after, report.observation.userSecurityState.before)
  assert.equal(Object.hasOwn(report.observation, "userState"), false)
  assert.equal(Object.hasOwn(report.postconditions, "userState"), false)
  assert.deepEqual(report.postconditions, { transport: "closed", directChild: "terminal", processGroup: "absent", reservation: "released", providerState: "absent", qualificationCwd: "absent", executionRoot: "absent", lifecycleOperation: "terminal", ownedHandles: "closed", handler: "absent", userSecurityState: "unchanged", catalogProfile: "absent", normalAgencyState: "unchanged" })
  assert.ok(Object.values(report.deadlines).every(value => value.outcome === "completed"))
  assert.deepEqual(parseCodexQualificationReport(report), report)
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
  assert.throws(() => parseCodexQualificationReport({ ...report, version: 1 }), { code: "REPORT_INVALID" })
  await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "ATTEMPT_ALREADY_STARTED" })
})

for (const [scenario, failure] of [
  ["permission", "PERMISSION_UNSUPPORTED"], ["unexpected-rpc", "PERMISSION_UNSUPPORTED"],
  ["fs/read_text_file", "PERMISSION_UNSUPPORTED"], ["fs/write_text_file", "PERMISSION_UNSUPPORTED"], ["terminal/create", "PERMISSION_UNSUPPORTED"],
  ["protocol-version", "INVALID_PROTOCOL"], ["auth-required", "AUTH_REQUIRED"], ["auth-malformed", "INVALID_PROTOCOL"],
  ["auth-wrong-method", "STARTUP_FAILED"], ["auth-spoofed", "INVALID_PROTOCOL"],
  ["missing-option", "SELECTION_UNSUPPORTED"], ["duplicate-option", "INVALID_PROTOCOL"],
  ["adapter-exit", "STARTUP_FAILED"], ["codex-exit", "STARTUP_FAILED"],
  ["handler-startup", "HANDLER_STARTUP_FAILED"], ["stop-failure", "CLEANUP_UNVERIFIED"],
  ["state-removal", "CLEANUP_UNVERIFIED"], ["missing-evidence", "EVIDENCE_MISSING"], ["descriptor-leak", "DESCRIPTOR_LEAK"], ["child-descriptor-leak", "DESCRIPTOR_LEAK"],
  ...["model", "reasoning", "mode"].flatMap(phase => ["model", "reasoning", "mode", "alias"].map(field => [`substitute-${phase}-${field}`, "SELECTION_UNSUPPORTED"])),
] as const) test(`fixture qualification rejects ${scenario}`, async t => {
  const f = await qualificationHarnessFixture(t, scenario)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, failure, JSON.stringify(report))
  assert.equal(report.postconditions.handler, "absent")
  assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(report.authentication, scenario === "auth-required" ? "auth_required" : report.authentication)
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

test("marker fsync failure consumes the only attempt before Handler launch", async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.publish = async (path, value) => {
    if (path.endsWith(".live-started.json")) return durableQualificationWrite(path, value, { open: (async (...args: Parameters<typeof open>) => { const handle = await open(...args); handle.sync = async () => { throw new Error("fixture fsync failure") }; return handle }) as typeof open })
    await durableQualificationWrite(path, value)
  }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "EVIDENCE_PUBLICATION_FAILED"); assert.deepEqual(report.ownership.handlers, [])
  delete f.dependencies.publish
  await assert.rejects(runCodexQualification(f.request, f.dependencies), { code: "ATTEMPT_ALREADY_STARTED" })
})

test("source rejects a success report while its publication is still pending", async t => {
  const f = await qualificationHarnessFixture(t)
  let rejected = 0, visible = "", resolved = false, copied = false
  const copy = join(f.root, "report-copy.json")
  f.dependencies.publish = async (path, value) => {
    await durableQualificationWrite(path, value)
    if (path === copy) { assert.equal(resolved, false); copied = true }
    if (!path.endsWith("/report.json") || !(value as { qualified: boolean }).qualified) return
    assert.equal(resolved, false)
    visible = path
    for (const capability of [[], ["--publication-capability", (value as { publication: { capabilityHash: string } }).publication.capabilityHash]]) {
      try { await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", path, ...revisionArgs, ...capability]) } catch { rejected++ }
    }
  }
  const result = await runCodexQualification({ ...f.request, reportPath: copy }, f.dependencies).then(result => { resolved = true; return result })
  const { report, publicationCapability } = result
  assert.equal(report.qualified, true)
  assert.equal(copied, true)
  await t.test("returns the exact published report path", async () => {
    assert.ok("reportPath" in result)
    assert.equal(result.reportPath, visible)
    assert.deepEqual(JSON.parse(await readFile(visible, "utf8")), report)
    assert.deepEqual(JSON.parse(await readFile(copy, "utf8")), report)
  })
  assert.equal(rejected, 2)
  assert.ok(publicationCapability)
  assert.ok(!JSON.stringify(report).includes(publicationCapability))
  await t.test("emits the named contract source", () => {
    assert.match(renderPublishedQualificationSource(f.candidate, report, publicationCapability, reviewedRevision), /export const codexDarwinArm64QualifiedContract: LaunchContract/)
  })
  assert.throws(() => renderPublishedQualificationSource(f.candidate, report, "0".repeat(64), reviewedRevision), { code: "EVIDENCE_PUBLICATION_FAILED" })
  assert.throws(() => renderPublishedQualificationSource({ ...f.candidate, version: 1 } as unknown as typeof f.candidate, report, publicationCapability, reviewedRevision), { code: "ADAPTER_UNQUALIFIED" })
  for (const field of [...Array.from({ length: 9 }, (_, index) => index), "sha256"] as const) {
    const manifest = structuredClone(f.candidate.manifest), target = manifest.userSecurityState.config.target
    if (field === "sha256") target.sha256 = "b".repeat(64)
    else { const identity = [...target.identity]; identity[field] = String(BigInt(identity[field]!) + 1n); target.identity = identity as unknown as SecurityIdentity }
    const changed = { version: 2 as const, manifest: parseCodexQualificationManifest(manifest), fingerprint: qualificationFingerprint(manifest) }
    assert.notEqual(changed.fingerprint, f.candidate.fingerprint)
    assert.throws(() => parseQualificationCandidate({ ...changed, fingerprint: f.candidate.fingerprint }), { code: "ADAPTER_UNQUALIFIED" })
    assert.throws(() => parseCodexQualificationReport({ ...report, observation: { ...report.observation, candidate: changed } }), { code: "REPORT_INVALID" })
    assert.throws(() => renderPublishedQualificationSource(changed, report, publicationCapability, reviewedRevision), { code: "ADAPTER_UNQUALIFIED" })
  }
  for (const revision of [undefined, { ...reviewedRevision, reviewedCommit: "b".repeat(40) }, { ...reviewedRevision, reviewedBranch: "master" }]) {
    await t.test(`rejects the wrong revision handoff ${JSON.stringify(revision)}`, () => {
      assert.throws(() => Reflect.apply(renderPublishedQualificationSource, undefined, [f.candidate, report, publicationCapability, revision]), { code: "ADAPTER_UNQUALIFIED" })
    })
  }
  const sourceArgs = ["--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", visible, "--publication-capability", publicationCapability]
  await assert.rejects(codexQualificationMain(sourceArgs), { code: "ADAPTER_UNQUALIFIED" })
  await assert.rejects(codexQualificationMain([...sourceArgs, "--reviewed-branch", reviewedRevision.reviewedBranch, "--reviewed-commit", "b".repeat(40)]), { code: "ADAPTER_UNQUALIFIED" })
  const stdinArgs = [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), ...sourceArgs.slice(0, -2), "--publication-capability-stdin", "true", ...revisionArgs]
  const source = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath, stdinArgs, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
    assert.ok(!child.spawnargs.some(arg => arg.includes(publicationCapability)))
    child.stdin!.end(publicationCapability + "\n")
  })
  assert.match(source.stdout, /export const codexDarwinArm64QualifiedContract: LaunchContract/); assert.deepEqual(productionLaunchContracts(), f.registryBefore)
  assert.ok(!source.stdout.includes(publicationCapability)); assert.ok(!source.stderr.includes(publicationCapability)); assert.ok(!source.stdout.includes(visible))
  assert.ok(!(await readFile(visible, "utf8")).includes(publicationCapability))
  const generatedPath = join(f.root, "generated.mts")
  await writeFile(generatedPath, source.stdout, { mode: 0o600 })
  const generated = await import(pathToFileURL(generatedPath).href)
  assert.deepEqual(Object.keys(generated), ["codexDarwinArm64QualifiedContract"])
  assert.deepEqual(generated.codexDarwinArm64QualifiedContract.qualification, f.candidate.manifest)
  assert.ok(!(await readFile(generatedPath, "utf8")).includes(publicationCapability))
  for (const input of [publicationCapability, publicationCapability.toUpperCase() + "\n", publicationCapability + "\n\n", publicationCapability + "\n" + "x".repeat(1024), ""]) {
    const invalid = await new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>(resolve => {
      const child = execFile(process.execPath, stdinArgs, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }))
      child.stdin!.end(input)
    })
    assert.equal(invalid.code, 1); assert.equal(invalid.stdout, ""); assert.equal(invalid.stderr, "USAGE\n")
  }
  await assert.rejects(codexQualificationMain([...sourceArgs, ...revisionArgs, "--publication-capability-stdin", "true"]), { code: "USAGE" })
  await assert.rejects(codexQualificationMain([...sourceArgs.slice(0, -2), ...revisionArgs, "--publication-capability-stdin", "false"]), { code: "USAGE" })
})

test("failed secondary publication returns only the durable failure report without a capability", async t => {
  const f = await qualificationHarnessFixture(t), copy = join(f.root, "report-copy.json")
  f.dependencies.publish = async (path, value) => {
    if (path === copy) throw new Error("secondary publication failed")
    await durableQualificationWrite(path, value)
  }
  const result = await runCodexQualification({ ...f.request, reportPath: copy }, f.dependencies)
  assert.equal(result.report.failure, "EVIDENCE_PUBLICATION_FAILED")
  assert.equal(result.publicationCapability, null)
  assert.ok("reportPath" in result && typeof result.reportPath === "string")
  assert.ok(result.reportPath.endsWith("/report-failed.json"))
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report)
  assert.throws(() => renderPublishedQualificationSource(f.candidate, result.report, "0".repeat(64), reviewedRevision), { code: "ADAPTER_UNQUALIFIED" })
})

test("source rejects visible success bytes after fsync and invalidation both fail", async t => {
  const f = await qualificationHarnessFixture(t)
  let visible = ""
  f.dependencies.publish = async (path, value) => {
    if (!path.endsWith("/report.json")) return durableQualificationWrite(path, value)
    visible = path
    try { await durableQualificationWrite(path, value, { open: (async (...args: Parameters<typeof open>) => { const handle = await open(...args); handle.sync = async () => { throw new Error("fixture fsync failure") }; return handle }) as typeof open }) }
    catch (error) { await chmod(dirname(path), 0); throw error }
  }
  const result = await runCodexQualification(f.request, f.dependencies)
  const { report, publicationCapability } = result
  await chmod(dirname(visible), 0o700)
  assert.ok("reportPath" in result)
  assert.equal(result.reportPath, null)
  assert.equal(publicationCapability, null)
  assert.equal(report.qualified, false); assert.equal(report.failure, "EVIDENCE_PUBLICATION_FAILED")
  assert.equal(JSON.parse(await readFile(visible, "utf8")).qualified, true)
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", visible, ...revisionArgs]), { code: 1 })
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", visible, "--publication-capability", "0".repeat(64), ...revisionArgs]), { code: 1 })
})

for (const kind of ["delayed", "never-settling"] as const) test(`${kind} parent absence prevents qualification and retains roots`, async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.absenceAdapter = { readProcess: () => kind === "never-settling" ? new Promise(() => undefined) : new Promise(resolve => setTimeout(() => resolve(null), 1300)), async readGroup() { return [] } }
  const { report, publicationCapability } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "ABSENCE_TIMEOUT")
  assert.equal(report.deadlines.absence.outcome, "timed_out")
  assert.equal(report.observation.absence!.outcome, "timed_out")
  assert.equal(report.postconditions.handler, "unknown"); assert.equal(report.postconditions.processGroup, "unknown")
  assert.equal(report.postconditions.ownedHandles, "unknown"); assert.equal(report.postconditions.executionRoot, "present")
  assert.equal(publicationCapability, null); assert.deepEqual(productionLaunchContracts(), f.registryBefore)
})

test("missing descriptor evidence prevents qualification", async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.descriptorCommand = async () => ({ stdout: "", stderr: "" })
  const { report, publicationCapability } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "DESCRIPTOR_UNAVAILABLE")
  assert.equal(report.observation.descriptors, null); assert.equal(report.postconditions.ownedHandles, "unknown")
  assert.equal(report.postconditions.handler, "absent"); assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(publicationCapability, null); assert.deepEqual(productionLaunchContracts(), f.registryBefore)
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

for (const check of [
  { outcome: "mismatch", reason: "auth_present", observation: null },
  { outcome: "mismatch", reason: "requirements_present", observation: null },
  { outcome: "unavailable", reason: "auth_unavailable", observation: null },
  { outcome: "unavailable", reason: "root_unavailable", observation: null },
] as const) test(`security ${check.reason} prevents qualification after successful ACP and stop`, async t => {
  const f = await qualificationHarnessFixture(t)
  let after = false
  f.dependencies.beforeCleanup = async () => { after = true }
  f.dependencies.observeUserSecurityState = async policy => { if (after && check.reason === "root_unavailable") throw new Error("observer defect"); return after ? check : { outcome: "match", reason: null, observation: policy } }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, check.outcome === "mismatch" ? "USER_SECURITY_STATE_CHANGED" : "USER_SECURITY_STATE_UNAVAILABLE")
  assert.equal(report.postconditions.userSecurityState, check.outcome === "mismatch" ? "changed" : "unknown")
  assert.deepEqual(report.observation.userSecurityState.after, check)
  assert.equal(report.postconditions.handler, "absent"); assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(report.observation.absence!.handler, "absent"); assert.equal(report.observation.absence!.provider, "absent")
  assert.deepEqual(productionLaunchContracts(), f.registryBefore)
  assert.deepEqual(parseCodexQualificationReport(report), report)
})

for (const changed of ["handler", "provider", "command", "agent", "session"] as const) test(`runtime ${changed} evidence substitution is rejected before stop`, async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.beforeCleanup = async (_root, report) => {
    if (changed === "handler") report.ownership.handlers[0]!.process.birth = "1:agy-handler:" + report.ownership.handlers[0]!.launchAttemptId
    if (changed === "provider") report.ownership.providerProcessGroup!.leader.parentPid++
    if (changed === "command") report.observation.retained.command!.result!.session!.sessionId = "replaced"
    if (changed === "agent") report.observation.retained.agent!.spec.leaseId = "00000000-0000-4000-8000-999999999999"
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
  for (const invalidCheck of [
    { outcome: "mismatch", reason: "auth_unavailable", observation: null },
    { outcome: "unavailable", reason: "auth_present", observation: null },
    { outcome: "mismatch", reason: "auth_present", observation: f.candidate.manifest.userSecurityState },
    { outcome: "unavailable", reason: "auth_unavailable", observation: f.candidate.manifest.userSecurityState },
    { outcome: "match", reason: null, observation: null },
    { outcome: "mismatch", reason: "auth_present", observation: null, extra: true },
    { outcome: "mismatch", reason: "auth_present" },
  ]) {
    const failed = { ...baseline, qualified: false, failure: "USER_SECURITY_STATE_CHANGED", observation: { ...baseline.observation, userSecurityState: { before: baseline.observation.userSecurityState.before, after: invalidCheck } } }
    assert.throws(() => parseCodexQualificationReport(failed), { code: "REPORT_INVALID" })
  }
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
    (r: any) => { r.observation.descriptors = null }, (r: any) => { r.observation.descriptors.processes.pop() },
    (r: any) => { r.observation.absence = null }, (r: any) => { r.observation.absence.outcome = "timed_out" },
    (r: any) => { r.observation.absence.durationMs = r.observation.absence.limitMs },
    (r: any) => { r.observation.absence.targets.pop() }, (r: any) => { r.publication.capabilityHash = null },
    (r: any) => { r.observation.verification = null }, (r: any) => { r.observation.verification.fingerprint = "0".repeat(64) },
    (r: any) => { r.observation.version = 2 }, (r: any) => { r.observation.userState = { before: [], after: [] } },
    (r: any) => { r.postconditions.userState = "unchanged" },
    (r: any) => { r.observation.userSecurityState.before = null }, (r: any) => { r.observation.userSecurityState.after = null },
    (r: any) => { r.observation.userSecurityState.before.outcome = "other" },
    (r: any) => { r.observation.userSecurityState.after.reason = "auth_present" },
    (r: any) => { r.observation.userSecurityState.after.extra = true },
    (r: any) => { r.observation.userSecurityState.after.observation.config.target.sha256 = "b".repeat(64) },
    (r: any) => { r.observation.userSecurityState.after = { outcome: "mismatch", reason: "auth_present", observation: null } },
    (r: any) => { r.observation.userSecurityState.after = { outcome: "unavailable", reason: "auth_unavailable", observation: null } },
    (r: any) => { r.failure = "unbounded failure text" }, (r: any) => { r.extra = true },
  ]) {
    const value = structuredClone(baseline); mutate(value)
    assert.throws(() => parseCodexQualificationReport(value))
  }
  assert.throws(() => validateQualifiedOwnership({ ...baseline.ownership, extra: true }))
})

test("two-child qualification requires exact retained descriptor identities", async t => {
  const f = await qualificationHarnessFixture(t, "two-children")
  const { report, publicationCapability } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.ok(publicationCapability)
  const children = report.observation.descriptors!.processes.filter(p => p.role === "child")
  assert.equal(children.length, 2)
  const baseline = structuredClone(report)
  baseline.observation.descriptors!.processes.reverse()
  assert.equal(parseCodexQualificationReport(baseline).qualified, true)
  assert.match(renderPublishedQualificationSource(f.candidate, baseline, publicationCapability, reviewedRevision), /codexDarwinArm64QualifiedContract/)
  for (const mutation of ["omitted", "substituted-birth", "substituted-parent", "extra"] as const) {
    const value = structuredClone(baseline), descriptors = value.observation.descriptors!.processes, absence = value.observation.absence!
    const child = descriptors.find(p => p.role === "child")!
    if (mutation === "omitted") descriptors.splice(descriptors.indexOf(child), 1)
    else if (mutation === "extra") {
      const extra = structuredClone(child)
      extra.process.pid = Math.max(...absence.targets.map(p => p.pid)) + 1
      descriptors.push(extra); absence.targets.push(structuredClone(extra.process))
    } else {
      if (mutation === "substituted-birth") child.process.birth = "1:substituted"
      else child.process.parentPid = descriptors.find(p => p.role === "child" && p !== child)!.process.pid
      Object.assign(absence.targets.find(p => p.pid === child.process.pid)!, child.process)
    }
    await t.test(`parser rejects ${mutation} descriptor identity`, () => { assert.throws(() => parseCodexQualificationReport(value), { code: "REPORT_INVALID" }) })
    await t.test(`source rejects ${mutation} descriptor identity`, () => { assert.throws(() => renderPublishedQualificationSource(f.candidate, value, publicationCapability, reviewedRevision), { code: "REPORT_INVALID" }) })
  }
  await t.test("runtime retains both initialized children before readiness", () => {
    for (const group of [report.ownership.providerProcessGroup!, report.observation.retained.launch!.provider!.group]) {
      assert.equal(group.observed.length, 3)
      for (const child of children) assert.deepEqual(group.observed.find(p => p.pid === child.process.pid), child.process)
    }
  })
})