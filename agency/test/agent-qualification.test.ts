import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile, rename, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { contractFromQualifiedCandidate, observeArtifact, parseCodexQualificationManifest, qualificationFingerprint, type ArtifactPin } from "../src/agent/qualification.js"
import { parseLaunchContract, productionLaunchContracts } from "../src/agent/contracts.js"
import { parseQualificationCandidate } from "../scripts/qualify-codex.js"
import { sampleQualifiedContract } from "./agent-support.js"
import { privateRoot } from "./control-support.js"

test("v4 candidate pins artifacts and selection without launch environment or private paths", () => {
  const manifest = sampleQualifiedContract().qualification!
  const candidate = parseQualificationCandidate({ version: 4, manifest, fingerprint: qualificationFingerprint(manifest) })
  assert.equal(candidate.version, 4)
  assert.equal(contractFromQualifiedCandidate(candidate).sessionLoad, "candidate")
  assert.equal(Object.hasOwn(candidate.manifest, "environment"), false)
  assert.equal(Object.hasOwn(candidate.manifest.deadlines, "reservationMs"), false)
  assert.deepEqual(parseLaunchContract(contractFromQualifiedCandidate(candidate)), contractFromQualifiedCandidate(candidate))
  assert.deepEqual(productionLaunchContracts(), [])
  for (const key of ["environment", "qualificationCwd", "attemptRoot", "checkout", "admission", "userSecurityState", "normalState", "helpers"])
    assert.throws(() => parseCodexQualificationManifest({ ...manifest, [key]: {} }))
  for (const version of [1, 2, 3]) assert.throws(() => parseQualificationCandidate({ ...candidate, version }))
  assert.throws(() => parseLaunchContract({ ...contractFromQualifiedCandidate(candidate), environment: {} }))
})

test("v4 manifest rejects altered artifact pins, selection, deadlines, and fingerprint", () => {
  const manifest = sampleQualifiedContract().qualification!
  const changes: Array<(v: any) => void> = [
    v => { v.selection.mode = "workspace-write" }, v => { v.selection.reasoning = "low" }, v => { v.selection.modelId = "other" },
    v => { v.policy = "agency-codex-prompt-smoke-v3" }, v => { v.nodeVersion = "24.12.0" }, v => { v.protocolVersion = 2 },
    v => { v.deadlines.promptMs++ }, v => { v.prompt.answerBytes++ }, v => { v.optionIds.model = "alias" },
    v => { v.adapterEntrypoint.path = "/tmp/../bad" }, v => { v.adapterEntrypoint.identity[8] = "2" },
  ]
  for (const change of changes) { const changed = structuredClone(manifest); change(changed); assert.throws(() => parseCodexQualificationManifest(changed)) }
  assert.throws(() => parseQualificationCandidate({ version: 4, manifest, fingerprint: "0".repeat(64) }))
})

test("artifact verification rejects replacement, changed bytes, and symlinks", async t => {
  const root = await privateRoot(t), path = join(root, "artifact")
  await writeFile(path, "artifact bytes", { mode: 0o600 })
  const stat = await lstat(path, { bigint: true })
  const pin: ArtifactPin = { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].map(String) as unknown as ArtifactPin["identity"] }
  assert.deepEqual(await observeArtifact(pin), pin)
  await assert.rejects(observeArtifact({ ...pin, sha256: "0".repeat(64) }))
  await rename(path, path + ".old"); await writeFile(path, "artifact bytes", { mode: 0o600 })
  await assert.rejects(observeArtifact(pin))
  await symlink(path + ".old", path + ".link"); await assert.rejects(observeArtifact({ ...pin, path: path + ".link" }))
})