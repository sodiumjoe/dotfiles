import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { observeLaunchContract, parseLaunchContract, productionLaunchContracts, resolveLaunchSpec } from "../src/agent/contracts.js"
import { sampleContract, sampleQualifiedContract, sampleSpec } from "./agent-support.js"
import { privateRoot } from "./control-support.js"

function input() {
  const spec = sampleSpec()
  return { ids: { hostId: spec.hostId, agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration, launchAttemptId: spec.launchAttemptId, commandId: spec.commandId }, selection: spec.selection, cwd: spec.cwd, snapshotId: spec.catalogSnapshotId, provider: spec.catalogEvidence, profile: { id: "codex-acp" as const, enabled: true, executable: "/fixture-codex", adapterPackageJson: "/fixture-package.json", sdkPackageJson: null, configurationFiles: ["/fixture-config.json"] }, configuration: spec.configuration, contract: sampleContract() }
}

test("production has no qualified launch contracts", () => { assert.deepEqual(productionLaunchContracts(), []); assert.ok(Object.isFrozen(productionLaunchContracts())) })

test("session load qualification is explicit while all supplied contracts permit ordinary start", () => {
  for (const sessionLoad of ["unsupported", "candidate", "qualified"] as const) {
    const value = input()
    value.contract.sessionLoad = sessionLoad
    assert.equal(parseLaunchContract(value.contract).sessionLoad, sessionLoad)
    assert.equal(resolveLaunchSpec(value).contractId, "fixture-v1")
  }
  for (const sessionLoad of [undefined, null, true, "true", "enabled"]) assert.throws(() => parseLaunchContract({ ...sampleContract(), sessionLoad }), { code: "ADAPTER_UNQUALIFIED" })
})

test("qualified contracts cannot substitute fixture or arbitrary permission evidence", () => {
  const contract = sampleQualifiedContract()
  assert.equal(parseLaunchContract(contract).permissionEvidence, "agency-deny-all-v1")
  for (const permissionEvidence of ["fixture-contract-v1", "agency-deny-all-v2", "arbitrary", "", null]) assert.throws(() => parseLaunchContract({ ...contract, permissionEvidence }), { code: "ADAPTER_UNQUALIFIED" })
  assert.throws(() => parseLaunchContract({ ...contract, permissionProfiles: ["fixture-deny-v1"] }), { code: "ADAPTER_UNQUALIFIED" })
  assert.deepEqual(productionLaunchContracts(), [])
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
    (v: ReturnType<typeof input>) => { v.contract.adapterVersion = "2.0.0" },
    (v: ReturnType<typeof input>) => { v.contract.providerId = "claude-agent-acp" },
    (v: ReturnType<typeof input>) => { v.configuration.fingerprint = "d".repeat(64) },
    (v: ReturnType<typeof input>) => { v.contract.modes = { state: "values", values: ["review", "review"] } },
    (v: ReturnType<typeof input>) => { v.contract.permissionProfiles = [] },
    (v: ReturnType<typeof input>) => { v.provider.verifiedHandlerGeneration = null },
  ]) { const value = input(); mutate(value); assert.throws(() => resolveLaunchSpec(value)) }
})

test("launch fingerprints bind code, physical identity and policy without importing", async t => {
  const root = await privateRoot(t), entrypoint = join(root, "fixture.mjs")
  await writeFile(entrypoint, "throw new Error('must not import')", { mode: 0o600 })
  const contract = { ...sampleContract(), entrypoint }
  const first = await observeLaunchContract(contract)
  assert.equal(first, await observeLaunchContract(contract))
  assert.notEqual(first, await observeLaunchContract({ ...contract, permissionProfiles: ["other"] }))
  await rename(entrypoint, entrypoint + "-old")
  await writeFile(entrypoint, "throw new Error('must not import')", { mode: 0o600 })
  assert.notEqual(first, await observeLaunchContract(contract))
  await rename(entrypoint, entrypoint + "-new")
  await mkdir(entrypoint)
  await assert.rejects(observeLaunchContract(contract))
})