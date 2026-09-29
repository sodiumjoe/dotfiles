import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, open, readdir, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { productionLaunchContracts } from "../src/agent/contracts.js"
import { launchEvidenceFromQualifiedCandidate, qualificationFingerprint } from "../src/agent/qualification.js"
import { sampleQualifiedContract, sampleQualifiedSpec } from "./agent-support.js"
import { verifyInjectedLaunchEvidence } from "../scripts/qualify-codex-handler.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { sameProcess } from "../src/platform/types.js"
import { durableQualificationWrite, parseCodexQualificationReport, pinnedArtifact, qualificationPaths, renderPublishedQualificationSource, runCodexQualification, snapshotTree, validateQualifiedOwnership, type QualificationDependencies } from "../scripts/qualify-codex.js"

async function qualificationHarnessFixture(t: TestContext, scenario = "normal") {
  const root = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyqt-" : "/tmp/agyqt-")
  const evidenceParent = join(root, "evidence"), user = join(root, "user"), normal = join(root, "normal")
  await mkdir(evidenceParent, { mode: 0o700 }); await mkdir(user, { mode: 0o700 })
  const manifest = sampleQualifiedContract().qualification!
  const packagePath = join(root, "package.json")
  await writeFile(packagePath, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }), { mode: 0o600 })
  for (const [key, path] of [["adapterPackageJson", packagePath], ["adapterEntrypoint", fileURLToPath(new URL("./fixtures/qualification-provider.js", import.meta.url))], ["nodeExecutable", process.execPath], ["codexExecutable", manifest.codexExecutable.path]] as const) manifest[key] = await pinnedArtifact(path, createHash("sha256").update(await readFile(path)).digest("hex"))
  const candidate = { version: 1 as const, manifest, fingerprint: qualificationFingerprint(manifest) }
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
    userStatePaths: [user], normalStatePaths: [normal],
    async createExecutionRoot() { const execution = await mkdtemp(process.platform === "darwin" ? "/private/tmp/agyqx-" : "/tmp/agyqx-"); executionRoots.push(execution); return execution },
  }
  t.after(async () => {
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
  return { root, user, candidate, request: { candidatePath, evidenceParent }, dependencies }
}

test("successful fixture qualification has complete postconditions and no profile", async t => {
  const f = await qualificationHarnessFixture(t)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true, JSON.stringify(report))
  assert.deepEqual(report.protocol.methods, ["initialize", "session/new", "session/set_config_option:model", "session/set_config_option:reasoning_effort", "session/set_config_option:mode"])
  assert.deepEqual(report.selection, { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only" })
  assert.deepEqual(report.postconditions, { transport: "closed", directChild: "terminal", processGroup: "absent", reservation: "released", providerState: "absent", qualificationCwd: "absent", executionRoot: "absent", lifecycleOperation: "terminal", ownedHandles: "closed", handler: "absent", userState: "unchanged", catalogProfile: "absent", normalAgencyState: "unchanged" })
  assert.ok(Object.values(report.deadlines).every(value => value.outcome === "completed"))
  assert.deepEqual(parseCodexQualificationReport(report), report)
  assert.deepEqual(productionLaunchContracts(), [])
  const { report: again } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(again.qualified, false); assert.equal(again.failure, "ATTEMPT_ALREADY_STARTED")
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
  assert.deepEqual(productionLaunchContracts(), [])
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
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", join(directory, name, "report-failed.json")]), { code: 1 })
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
  const { report: again } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(again.qualified, false); assert.equal(again.failure, "ATTEMPT_ALREADY_STARTED"); assert.deepEqual(again.ownership.handlers, [])
})

test("source rejects a success report while its publication is still pending", async t => {
  const f = await qualificationHarnessFixture(t)
  let rejected = 0, visible = ""
  f.dependencies.publish = async (path, value) => {
    await durableQualificationWrite(path, value)
    if (!path.endsWith("/report.json") || !(value as { qualified: boolean }).qualified) return
    visible = path
    for (const capability of [[], ["--publication-capability", (value as { publication: { capabilityHash: string } }).publication.capabilityHash]]) {
      try { await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", path, ...capability]) } catch { rejected++ }
    }
  }
  const { report, publicationCapability } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, true)
  assert.equal(rejected, 2)
  assert.ok(publicationCapability)
  assert.ok(!JSON.stringify(report).includes(publicationCapability))
  assert.match(renderPublishedQualificationSource(f.candidate, report, publicationCapability), /qualifiedLaunchContracts/)
  assert.throws(() => renderPublishedQualificationSource(f.candidate, report, "0".repeat(64)), { code: "EVIDENCE_PUBLICATION_FAILED" })
  const source = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", visible, "--publication-capability", publicationCapability])
  assert.match(source.stdout, /qualifiedLaunchContracts/); assert.deepEqual(productionLaunchContracts(), [])
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
  const { report, publicationCapability } = await runCodexQualification(f.request, f.dependencies)
  await chmod(dirname(visible), 0o700)
  assert.equal(publicationCapability, null)
  assert.equal(report.qualified, false); assert.equal(report.failure, "EVIDENCE_PUBLICATION_FAILED")
  assert.equal(JSON.parse(await readFile(visible, "utf8")).qualified, true)
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", visible]), { code: 1 })
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/qualify-codex.js", import.meta.url)), "--stage", "source", "--candidate", f.request.candidatePath, "--evidence-parent", f.request.evidenceParent, "--report", visible, "--publication-capability", "0".repeat(64)]), { code: 1 })
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
  assert.equal(publicationCapability, null); assert.deepEqual(productionLaunchContracts(), [])
})

test("missing descriptor evidence prevents qualification", async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.descriptorCommand = async () => ({ stdout: "", stderr: "" })
  const { report, publicationCapability } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "DESCRIPTOR_UNAVAILABLE")
  assert.equal(report.observation.descriptors, null); assert.equal(report.postconditions.ownedHandles, "unknown")
  assert.equal(report.postconditions.handler, "absent"); assert.equal(report.postconditions.processGroup, "absent")
  assert.equal(publicationCapability, null); assert.deepEqual(productionLaunchContracts(), [])
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
  assert.equal(report.postconditions.handler, "absent"); assert.deepEqual(productionLaunchContracts(), [])
})

test("durable writer refuses existing files and symlinks", async t => {
  const f = await qualificationHarnessFixture(t), path = join(f.root, "exclusive.json")
  await durableQualificationWrite(path, { value: 1 })
  await assert.rejects(durableQualificationWrite(path, { value: 2 }), { code: "EEXIST" })
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { value: 1 })
  await symlink(path, join(f.root, "link.json"))
  await assert.rejects(durableQualificationWrite(join(f.root, "link.json"), { value: 2 }))
})

test("tree observation rejects symlinks and detects user-state drift without retaining names", async t => {
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

test("an oversized user-state tree fails before Handler startup", async t => {
  const f = await qualificationHarnessFixture(t), handle = await open(join(f.user, "large"), "wx", 0o600)
  await handle.truncate(268435457); await handle.close()
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "USER_STATE_UNAVAILABLE")
  assert.deepEqual(report.ownership.handlers, []); assert.deepEqual(productionLaunchContracts(), [])
})

test("an unreadable user-state tree has a closed prelaunch failure", async t => {
  const f = await qualificationHarnessFixture(t), path = join(f.user, "unreadable")
  await writeFile(path, "unreadable", { mode: 0o600 }); await chmod(path, 0)
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "USER_STATE_UNAVAILABLE")
  assert.deepEqual(report.ownership.handlers, []); assert.deepEqual(productionLaunchContracts(), [])
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
  assert.deepEqual(productionLaunchContracts(), [])
})

test("user-state drift prevents qualification after successful ACP and stop", async t => {
  const f = await qualificationHarnessFixture(t)
  f.dependencies.beforeCleanup = async () => { await writeFile(join(f.user, "changed"), "new") }
  const { report } = await runCodexQualification(f.request, f.dependencies)
  assert.equal(report.qualified, false); assert.equal(report.failure, "USER_STATE_CHANGED")
  assert.equal(report.postconditions.userState, "changed"); assert.equal(report.postconditions.handler, "absent")
  assert.equal(report.postconditions.processGroup, "absent"); assert.deepEqual(productionLaunchContracts(), [])
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
  assert.deepEqual(productionLaunchContracts(), [])
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
    (r: any) => { r.failure = "unbounded failure text" }, (r: any) => { r.extra = true },
  ]) {
    const value = structuredClone(baseline); mutate(value)
    assert.throws(() => parseCodexQualificationReport(value))
  }
  assert.throws(() => validateQualifiedOwnership({ ...baseline.ownership, extra: true }))
})