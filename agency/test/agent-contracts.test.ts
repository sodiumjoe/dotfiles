import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { configureLaunchContract, observeLaunchContract, parseLaunchContract, resolveLaunchSpec } from "../src/agent/contracts.js"
import { sampleContract, sampleStaticContract, sampleSpec } from "./agent-support.js"
import { privateRoot } from "./control-support.js"

function input() {
  const spec = sampleSpec()
  return { ids: { hostId: spec.hostId, agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration, launchAttemptId: spec.launchAttemptId, commandId: spec.commandId }, selection: spec.selection, cwd: spec.cwd, snapshotId: spec.catalogSnapshotId, provider: spec.catalogEvidence, configuration: spec.configuration, contract: sampleContract() }
}

async function configured(t: Parameters<typeof privateRoot>[0]) {
  const root = await privateRoot(t), directory = join(root, "adapter"), executable = join(root, "codex")
  await mkdir(join(directory, "dist"), { recursive: true, mode: 0o700 })
  await writeFile(executable, "native", { mode: 0o700 })
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0", main: "dist/index.js" }), { mode: 0o600 })
  await writeFile(join(directory, "dist/index.js"), "throw new Error('must not import')", { mode: 0o600 })
  const profile = { id: "codex-acp" as const, enabled: true, executable, adapterPackageJson: join(directory, "package.json"), sdkPackageJson: null, configurationFiles: [] }
  const configuration = { fingerprint: "b".repeat(64), scope: "declared-config-v1" as const, providerId: "codex-acp" as const, adapterVersion: "1.0.0", sdkVersion: null }
  return { directory, profile, configuration }
}

test("session load support is a static boolean capability", () => {
  for (const sessionLoad of [false, true]) assert.equal(parseLaunchContract({ ...sampleStaticContract(), sessionLoad }).sessionLoad, sessionLoad)
  for (const sessionLoad of [undefined, null, "candidate", "qualified", "unsupported", "true"]) assert.throws(() => parseLaunchContract({ ...sampleStaticContract(), sessionLoad }), { code: "ADAPTER_UNQUALIFIED" })
})

test("configured contracts resolve the declared package entry without qualification evidence", async t => {
  const f = await configured(t), contract = await configureLaunchContract(sampleStaticContract(), f.profile, f.configuration)
  assert.equal(contract.entrypoint, join(f.directory, "dist/index.js"))
  assert.match(contract.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(await observeLaunchContract(contract), contract.fingerprint)
  const json = JSON.stringify(contract)
  for (const token of ["candidate", "qualified", "manifest", "report", "artifactPin", "qualification"]) assert.equal(json.includes(token), false)
})

test("configured contracts reject provider, package, version, and configuration disagreement", async t => {
  const f = await configured(t)
  await assert.rejects(configureLaunchContract({ ...sampleStaticContract(), providerId: "claude-agent-acp" }, f.profile, f.configuration), { code: "ADAPTER_UNQUALIFIED" })
  await assert.rejects(configureLaunchContract({ ...sampleStaticContract(), adapterPackage: "@agentclientprotocol/other" }, f.profile, f.configuration), { code: "ADAPTER_UNQUALIFIED" })
  await assert.rejects(configureLaunchContract({ ...sampleStaticContract(), adapterVersion: "2.0.0" }, f.profile, f.configuration), { code: "ADAPTER_UNQUALIFIED" })
  await assert.rejects(configureLaunchContract(sampleStaticContract(), { ...f.profile, enabled: false }, f.configuration), { code: "ADAPTER_UNQUALIFIED" })
  await assert.rejects(configureLaunchContract(sampleStaticContract(), f.profile, { ...f.configuration, providerId: "claude-agent-acp" }), { code: "ADAPTER_UNQUALIFIED" })
})

test("explicit selections resolve without substitution", () => {
  const value = input(), spec = resolveLaunchSpec(value)
  assert.equal(spec.selection.mode, "review")
  assert.equal(spec.selection.modelId, "model-a")
  assert.deepEqual(spec.selection.reasoning, { kind: "value", value: "high" })
  for (const selection of [
    { modelId: "alias" }, { modelId: "" }, { modelId: " \t" }, { modelId: "bad\n" }, { modelId: "\ud800" }, { modelId: "x".repeat(257) },
    { permissionProfile: "unrestricted" }, { reasoning: { kind: "value", value: "extreme" } }, { mode: "unlisted" }, { mode: null },
  ]) assert.throws(() => resolveLaunchSpec({ ...input(), selection: { ...value.selection, ...selection } } as Parameters<typeof resolveLaunchSpec>[0]))
})

test("unknown reasoning cannot be treated as absence and explicit none needs both authorities", () => {
  const value = input()
  value.selection.reasoning = { kind: "none" }
  value.provider.models[0]!.reasoning = { state: "unknown" }
  value.contract.reasoning = { state: "none" }; value.contract.reasoningOption = null
  assert.throws(() => resolveLaunchSpec(value))
  value.provider.models[0]!.reasoning = { state: "none" }
  assert.deepEqual(resolveLaunchSpec(value).selection.reasoning, { kind: "none" })
  value.contract.reasoning = { state: "unknown" }
  assert.throws(() => resolveLaunchSpec(value))
})

test("sole and nonselectable modes are explicit effective selections", () => {
  const value = input()
  value.selection.mode = null!
  value.contract.modes = { state: "values", values: ["review"] }
  assert.equal(resolveLaunchSpec(value).selection.mode, "review")
  value.contract.modes = { state: "none" }; value.contract.effectiveMode = "review"; value.contract.modeOption = null
  assert.equal(resolveLaunchSpec(value).selection.mode, "review")
  value.provider.models[0]!.modes = { state: "values", values: ["other"] }
  assert.throws(() => resolveLaunchSpec(value))
})

test("contract and evidence disagreement cannot authorize a launch", () => {
  for (const mutate of [
    (v: ReturnType<typeof input>) => { v.configuration.fingerprint = "d".repeat(64) },
    (v: ReturnType<typeof input>) => { v.contract.modes = { state: "values", values: ["review", "review"] } },
    (v: ReturnType<typeof input>) => { v.contract.permissionProfiles = [] },
    (v: ReturnType<typeof input>) => { v.provider.verifiedHandlerGeneration = null },
  ]) { const value = input(); mutate(value); assert.throws(() => resolveLaunchSpec(value)) }
})

test("launch fingerprints bind static policy and configured entrypoint", async t => {
  const f = await configured(t), contract = await configureLaunchContract(sampleStaticContract(), f.profile, f.configuration)
  assert.equal(contract.fingerprint, await observeLaunchContract(contract))
  assert.notEqual(contract.fingerprint, await observeLaunchContract({ ...contract, permissionProfiles: ["other"] }))
  await rename(contract.entrypoint, contract.entrypoint + "-old")
  await writeFile(contract.entrypoint, "throw new Error('must not import')", { mode: 0o600 })
  assert.equal(contract.fingerprint, await observeLaunchContract(contract))
})