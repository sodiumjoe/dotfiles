import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, link, mkdir, open, readFile, lstat, rename, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test, { type TestContext } from "node:test"
import { parseLaunchContract, productionLaunchContracts, resolveLaunchSpec } from "../src/agent/contracts.js"
import { contractFromQualifiedCandidate, launchEvidenceFromQualifiedCandidate, observeArtifact, parseCodexQualificationManifest, qualificationFingerprint, renderQualifiedContractSource, verifyCodexQualification, type ArtifactPin } from "../src/agent/qualification.js"
import { parseQualificationCandidate } from "../scripts/qualify-codex.js"
import { qualifiedLaunchContracts } from "../src/agent/qualified-contracts.js"
import { privateRoot } from "./control-support.js"
import { sampleSpec } from "./agent-support.js"

const managedCodex = "/Users/moon/.cache/stripe/codex/0.155.1/codex-aarch64-apple-darwin"
const canVerify = process.platform === "darwin" && process.arch === "arm64" && process.versions.node === "24.13.0" && existsSync(managedCodex)

async function pin(path: string): Promise<ArtifactPin> {
  const stat = await lstat(path, { bigint: true })
  return { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].map(String) as unknown as ArtifactPin["identity"] }
}

function wrongSha(sha256: string): string { return (sha256[0] === "0" ? "1" : "0") + sha256.slice(1) }

async function qualificationFixture(t: TestContext) {
  const root = await privateRoot(t)
  const packageJson = join(root, "package.json"), entrypoint = join(root, "adapter.mjs"), codex = join(root, "codex")
  await writeFile(packageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }), { mode: 0o600 })
  await writeFile(entrypoint, "throw new Error('must not import')", { mode: 0o600 })
  await writeFile(codex, "must not execute", { mode: 0o700 })
  const manifest = {
    version: 3, policy: "agency-codex-prompt-smoke-v3", platform: "darwin", architecture: "arm64", providerId: "codex-acp", contractId: "codex-darwin-arm64-agency-prompt-smoke-v3",
    adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.7.0", adapterPackageJson: await pin(packageJson), adapterEntrypoint: await pin(entrypoint), codexExecutable: existsSync(managedCodex) ? await pin(managedCodex) : { ...await pin(codex), path: managedCodex }, nodeExecutable: await pin(process.execPath), nodeVersion: "24.13.0", protocolVersion: 1,
    qualificationCwd: { source: "attempt-root", relative: "checkout" },
    prompt: { challengePrefix: "AGENCY_CODEX_SMOKE_", challengeBytes: 16, answerBytes: 4096 },
    deadlines: { commandMs: 5000, reservationMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 },
    selection: { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only", permissionProfile: "deny-all" },
    optionIds: { model: "model", reasoning: "reasoning_effort", mode: "mode" },
    environment: {
      fixed: { CODEX_PATH: "/Users/moon/.cache/stripe/codex/0.155.1/codex-aarch64-apple-darwin", INITIAL_AGENT_MODE: "read-only", MODEL_PROVIDER: "litellm", PATH: "/usr/local/bin:/usr/bin:/bin", CODEX_CONFIG: JSON.stringify({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "workspace-write", mcp_servers: {} }) },
      private: { HOME: "home", CODEX_HOME: "home/codex", XDG_CONFIG_HOME: "xdg/config", XDG_CACHE_HOME: "xdg/cache", XDG_STATE_HOME: "xdg/state", TMPDIR: "tmp" },
    },
  }
  return { root, manifest, packageJson, entrypoint, codex, async replaceSameBytes(path: string) { const content = await readFile(path); await rename(path, `${path}.old`); await writeFile(path, content, { mode: path === codex ? 0o700 : 0o600 }) } }
}

test("qualification binds executable paths, identities, bytes, version and selections", { skip: !canVerify }, async t => {
  const f = await qualificationFixture(t)
  const manifest = parseCodexQualificationManifest(f.manifest)
  const observation = await verifyCodexQualification(manifest)
  assert.equal(observation.nodeVersion, "24.13.0")
  assert.deepEqual(observation.selection, { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only", permissionProfile: "deny-all" })
})

test("qualification independently verifies every artifact pin", { skip: !canVerify }, async t => {
  for (const name of ["adapterPackageJson", "adapterEntrypoint", "codexExecutable", "nodeExecutable"] as const) {
    await t.test(`${name} rejects a wrong SHA`, async t => {
      const f = await qualificationFixture(t)
      const manifest = parseCodexQualificationManifest(f.manifest)
      await verifyCodexQualification(manifest)
      manifest[name].sha256 = wrongSha(manifest[name].sha256)
      await assert.rejects(verifyCodexQualification(manifest), { code: "ADAPTER_UNQUALIFIED" })
    })
  }
  for (const name of ["adapterPackageJson", "adapterEntrypoint"] as const) {
    await t.test(`${name} rejects same-byte replacement`, async t => {
      const f = await qualificationFixture(t)
      const manifest = parseCodexQualificationManifest(f.manifest)
      await verifyCodexQualification(manifest)
      await f.replaceSameBytes(manifest[name].path)
      await assert.rejects(verifyCodexQualification(manifest), { code: "ADAPTER_UNQUALIFIED" })
    })
  }
})

test("manifest rejects extra fields and every unapproved selection and policy change", async t => {
  const f = await qualificationFixture(t)
  const base = f.manifest
  assert.equal(parseCodexQualificationManifest(base).version, 3)
  const changes: Array<[string, (v: typeof base) => void]> = [
    ["extra field", v => { Object.assign(v, { extra: true }) }],
    ["version 2", v => { v.version = 2 }],
    ["policy v2", v => { v.policy = "agency-codex-deny-all-v2" }],
    ["contract v2", v => { v.contractId = "codex-darwin-arm64-agency-deny-all-v2" }],
    ["provider", v => { v.providerId = "claude-agent-acp" }],
    ["platform", v => { v.platform = "linux" }],
    ["architecture", v => { v.architecture = "x64" }],
    ["Node version", v => { v.nodeVersion = "24.12.0" }],
    ["adapter version", v => { v.adapterVersion = "1.8.0" }],
    ["model", v => { v.selection.modelId = "gpt-5.6" }],
    ["reasoning", v => { v.selection.reasoning = "medium" }],
    ["mode", v => { v.selection.mode = "workspace-write" }],
    ["option ID", v => { v.optionIds.reasoning = "reasoning" }],
    ["protocol", v => { v.protocolVersion = 2 }],
    ["deadline", v => { v.deadlines.optionMs = 6000 }],
    ["prompt deadline", v => { v.deadlines.promptMs = 90001 }],
    ["overall deadline", v => { v.deadlines.overallMs = 149999 }],
    ["challenge prefix", v => { v.prompt.challengePrefix = "OTHER_" }],
    ["challenge bytes", v => { v.prompt.challengeBytes = 15 }],
    ["answer bytes", v => { v.prompt.answerBytes = 4095 }],
    ["cwd", v => { v.qualificationCwd.relative = "elsewhere" }],
    ["environment key", v => { Object.assign(v.environment.fixed, { NODE_OPTIONS: "--inspect" }) }],
    ["Node path override", v => { Object.assign(v.environment.fixed, { NODE_PATH: "/tmp/modules" }) }],
    ["Agency environment override", v => { Object.assign(v.environment.fixed, { AGENCY_TEST: "1" }) }],
    ["Git environment override", v => { Object.assign(v.environment.fixed, { GIT_DIR: "/tmp/git" }) }],
    ["inherited environment source", v => { Object.assign(v.environment, { inherit: ["PATH"] }) }],
    ["duplicate environment key", v => { Object.assign(v.environment.private, { PATH: "home/path" }) }],
    ["secret literal", v => { v.environment.fixed.CODEX_CONFIG = "sk_test_secret" }],
    ["private absolute path", v => { v.environment.private.HOME = "/tmp/home" }],
    ["private traversal", v => { v.environment.private.HOME = "../home" }],
    ["missing deny-all evidence", v => { v.policy = "other" }],
    ["reintroduced security state", v => { Object.assign(v, { userSecurityState: {} }) }],
    ["noncanonical artifact", v => { v.adapterEntrypoint.path += "/../adapter.mjs" }],
    ["invalid identity", v => { v.codexExecutable.identity = [...v.codexExecutable.identity.slice(0, 8), "2"] as unknown as ArtifactPin["identity"] }],
    ["oversized artifact", v => { v.adapterEntrypoint.identity = [...v.adapterEntrypoint.identity.slice(0, 2), "268435457", ...v.adapterEntrypoint.identity.slice(3)] as unknown as ArtifactPin["identity"] }],
  ]
  for (const [name, mutate] of changes) {
    const value = structuredClone(base)
    mutate(value)
    assert.throws(() => parseCodexQualificationManifest(value), { code: "ADAPTER_UNQUALIFIED" }, name)
  }
})

test("artifact observation rejects symlinks and replacement with identical bytes", async t => {
  const f = await qualificationFixture(t)
  const entrypoint = f.manifest.adapterEntrypoint
  assert.deepEqual(await observeArtifact(entrypoint), entrypoint)
  await f.replaceSameBytes(f.entrypoint)
  await assert.rejects(observeArtifact(entrypoint), { code: "ADAPTER_UNQUALIFIED" })
  const link = join(f.root, "link")
  await symlink(f.codex, link)
  await assert.rejects(observeArtifact({ ...await pin(f.codex), path: link }), { code: "ADAPTER_UNQUALIFIED" })
})

test("artifact observation rejects content, mode, link count, ownership and file-type drift", async t => {
  const f = await qualificationFixture(t)
  const original = f.manifest.adapterEntrypoint
  await writeFile(f.entrypoint, "changed contents", { mode: 0o600 })
  await assert.rejects(observeArtifact(original), { code: "ADAPTER_UNQUALIFIED" })
  const changed = await pin(f.entrypoint)
  await chmod(f.entrypoint, 0o700)
  await assert.rejects(observeArtifact(changed), { code: "ADAPTER_UNQUALIFIED" })
  const modePin = await pin(f.entrypoint)
  await link(f.entrypoint, join(f.root, "hardlink"))
  await assert.rejects(observeArtifact(modePin), { code: "ADAPTER_UNQUALIFIED" })
  const codex = await pin(f.codex)
  for (const index of [6, 7]) {
    const identity = [...codex.identity]
    identity[index] = String(BigInt(identity[index]!) + 1n)
    await assert.rejects(observeArtifact({ ...codex, identity: identity as unknown as ArtifactPin["identity"] }), { code: "ADAPTER_UNQUALIFIED" })
  }
  const directory = join(f.root, "directory")
  await mkdir(directory)
  await assert.rejects(observeArtifact({ ...codex, path: directory }), { code: "ADAPTER_UNQUALIFIED" })
  const oversized = join(f.root, "oversized")
  const handle = await open(oversized, "w", 0o600)
  try { await handle.truncate(256 * 1024 * 1024 + 1) } finally { await handle.close() }
  const stat = await lstat(oversized, { bigint: true })
  const oversizedPin: ArtifactPin = { path: oversized, sha256: "0".repeat(64), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].map(String) as unknown as ArtifactPin["identity"] }
  await assert.rejects(observeArtifact(oversizedPin), { code: "ADAPTER_UNQUALIFIED" })
})

test("artifact observation rejects wrong SHA with unchanged file identity", async t => {
  const f = await qualificationFixture(t)
  const valid = f.manifest.adapterEntrypoint
  const wrong = { ...valid, sha256: wrongSha(valid.sha256) }
  assert.deepEqual((await pin(f.entrypoint)).identity, wrong.identity)
  await assert.rejects(observeArtifact(wrong), { code: "ADAPTER_UNQUALIFIED" })
  assert.deepEqual(await observeArtifact(valid), valid)
})

test("offline verification rejects package metadata and alternate Node paths", { skip: !canVerify }, async t => {
  const f = await qualificationFixture(t)
  await writeFile(f.packageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.8.0" }), { mode: 0o600 })
  f.manifest.adapterPackageJson = await pin(f.packageJson)
  await assert.rejects(verifyCodexQualification(parseCodexQualificationManifest(f.manifest)), { code: "ADAPTER_UNQUALIFIED" })
  await writeFile(f.packageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }), { mode: 0o600 })
  f.manifest.adapterPackageJson = await pin(f.packageJson)
  f.manifest.nodeExecutable = await pin(f.codex)
  await assert.rejects(verifyCodexQualification(parseCodexQualificationManifest(f.manifest)), { code: "ADAPTER_UNQUALIFIED" })
})

test("production registry cannot acquire a candidate implicitly", () => {
  assert.deepEqual(qualifiedLaunchContracts(), [])
  assert.deepEqual(productionLaunchContracts(), [])
  assert.ok(Object.isFrozen(qualifiedLaunchContracts()))
  assert.ok(Object.isFrozen(productionLaunchContracts()))
})

test("qualified candidate derives exact contract and catalog evidence", { skip: !canVerify }, async t => {
  const f = await qualificationFixture(t)
  const observed = await verifyCodexQualification(parseCodexQualificationManifest(f.manifest))
  const candidate = { version: 3 as const, manifest: observed.manifest, fingerprint: observed.fingerprint }
  const contract = contractFromQualifiedCandidate(candidate)
  assert.equal(contract.permissionEvidence, "agency-deny-all-v1")
  assert.deepEqual(contract.environment, f.manifest.environment)
  assert.equal(contract.qualification?.codexExecutable.path, managedCodex)
  const evidence = launchEvidenceFromQualifiedCandidate(candidate, "00000000-0000-4000-8000-000000000002", 1000)
  assert.match(evidence.snapshotId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(evidence.profile.executable, managedCodex)
  assert.equal(evidence.profile.adapterPackageJson, f.packageJson)
  assert.equal(evidence.provider.models[0]?.modelId, "gpt-5.6-sol")
  assert.equal(evidence.configuration.fingerprint, observed.fingerprint)
  const source = renderQualifiedContractSource(candidate, { qualified: true, manifestFingerprint: candidate.fingerprint })
  const sourcePath = join(f.root, "codex-qualified-contract.mts")
  await symlink(fileURLToPath(new URL("../src/agent/qualification.js", import.meta.url)), join(f.root, "qualification.js"))
  await writeFile(sourcePath, source)
  const generated = await import(pathToFileURL(sourcePath).href)
  assert.deepEqual(Object.keys(generated), ["codexDarwinArm64QualifiedContract"])
  assert.deepEqual(parseLaunchContract(generated.codexDarwinArm64QualifiedContract), contract)
  assert.throws(() => renderQualifiedContractSource(candidate, { qualified: true, manifestFingerprint: "0".repeat(64) }), { code: "ADAPTER_UNQUALIFIED" })
})

async function qualifiedResolveInput(t: TestContext) {
  const f = await qualificationFixture(t)
  const observation = await verifyCodexQualification(parseCodexQualificationManifest(f.manifest))
  const candidate = { version: 3 as const, manifest: observation.manifest, fingerprint: observation.fingerprint }
  const spec = sampleSpec()
  const evidence = launchEvidenceFromQualifiedCandidate(candidate, spec.handlerGeneration, 1000)
  return { ids: { hostId: spec.hostId, agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId, startCommandId: spec.startCommandId }, selection: { providerId: "codex-acp" as const, modelId: "gpt-5.6-sol", reasoning: { kind: "value" as const, value: "high" }, mode: "read-only", permissionProfile: "deny-all" }, checkout: spec.checkout, ...evidence, contract: contractFromQualifiedCandidate(candidate) }
}

test("production contract rejects catalog evidence from a different executable", { skip: !canVerify }, async t => {
  const value = await qualifiedResolveInput(t)
  assert.equal(resolveLaunchSpec(value).selection.modelId, "gpt-5.6-sol")
  value.profile.executable = "/usr/local/bin/codex"
  assert.throws(() => resolveLaunchSpec(value), { code: "ADAPTER_UNQUALIFIED" })
})

test("qualified contract rejects another advertised model", { skip: !canVerify }, async t => {
  const value = await qualifiedResolveInput(t)
  value.provider.models.push({ ...value.provider.models[0]!, modelId: "gpt-5.6" })
  value.selection.modelId = "gpt-5.6"
  assert.throws(() => resolveLaunchSpec(value), { code: "SELECTION_UNSUPPORTED" })
})

test("production contract requires the complete deny-all manifest and closed catalog profile", { skip: !canVerify }, async t => {
  const baseline = await qualifiedResolveInput(t)
  for (const mutate of [
    (v: typeof baseline) => { v.contract.entrypoint = "/tmp/replacement.mjs" },
    (v: typeof baseline) => { v.contract.fingerprint = "a".repeat(64) },
    (v: typeof baseline) => { v.contract.permissionEvidence = "fixture-contract-v1" },
    (v: typeof baseline) => { v.contract.modelOption = "other" },
    (v: typeof baseline) => { Object.assign(v.contract.environment.fixed, { PATH: "/usr/bin" }) },
    (v: typeof baseline) => { v.profile.adapterPackageJson = "/tmp/replacement.json" },
    (v: typeof baseline) => { v.profile.sdkPackageJson = "/tmp/sdk.json" },
    (v: typeof baseline) => { v.profile.configurationFiles.push("/tmp/config.json") },
  ]) {
    const value = structuredClone(baseline)
    mutate(value)
    assert.throws(() => resolveLaunchSpec(value), { code: "ADAPTER_UNQUALIFIED" })
  }
  assert.throws(() => parseLaunchContract({ ...baseline.contract, qualification: null }), { code: "ADAPTER_UNQUALIFIED" })
})