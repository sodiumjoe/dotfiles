import { createHash, randomUUID } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, normalize } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { readBoundedFile } from "../catalog/config.js"
import type { ConfigEvidence, ProviderProfile, ProviderSnapshot } from "../catalog/types.js"
import type { LaunchEvidence } from "../catalog/service.js"
import { AgentError } from "./types.js"
import type { LaunchContract } from "./contracts.js"

export type ArtifactPin = {
  path: string
  sha256: string
  identity: readonly [dev: string, ino: string, size: string, mtimeNs: string, ctimeNs: string, mode: string, uid: string, gid: string, nlink: "1"]
}

export type LaunchEnvironmentPolicy = {
  fixed: Readonly<Record<string, string>>
  private: Readonly<Record<string, string>>
}

export type CodexQualificationManifest = {
  version: 1
  policy: "agency-codex-deny-all-v1"
  platform: "darwin"
  architecture: "arm64"
  providerId: "codex-acp"
  contractId: "codex-darwin-arm64-agency-deny-all-v1"
  adapterPackage: "@agentclientprotocol/codex-acp"
  adapterVersion: "1.7.0"
  adapterPackageJson: ArtifactPin
  adapterEntrypoint: ArtifactPin
  codexExecutable: ArtifactPin
  nodeExecutable: ArtifactPin
  nodeVersion: "24.13.0"
  protocolVersion: 1
  qualificationCwd: { source: "attempt-root"; relative: "checkout" }
  deadlines: {
    commandMs: 5_000
    reservationMs: 5_000
    spawnMs: 5_000
    initializeMs: 15_000
    sessionMs: 15_000
    optionMs: 5_000
    transportCloseMs: 1_000
    processTerminateMs: 5_000
    absenceMs: 2_000
    overallMs: 45_000
  }
  selection: { modelId: "gpt-5.6-sol"; reasoning: "high"; mode: "read-only"; permissionProfile: "deny-all" }
  optionIds: { model: "model"; reasoning: "reasoning_effort"; mode: "mode" }
  environment: LaunchEnvironmentPolicy
  userStatePaths: readonly ["/Users/moon/.codex"]
}

export type CodexQualificationCandidate = { version: 1; manifest: CodexQualificationManifest; fingerprint: string }
export type CodexQualificationObservation = CodexQualificationCandidate & {
  nodeVersion: "24.13.0"
  selection: CodexQualificationManifest["selection"]
  artifacts: { adapterPackageJson: ArtifactPin; adapterEntrypoint: ArtifactPin; codexExecutable: ArtifactPin; nodeExecutable: ArtifactPin }
}

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const fixed = {
  CODEX_PATH: "/Users/moon/.cache/stripe/codex/0.155.1/codex-aarch64-apple-darwin",
  INITIAL_AGENT_MODE: "read-only",
  MODEL_PROVIDER: "litellm",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  CODEX_CONFIG: JSON.stringify({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "workspace-write", mcp_servers: {} }),
}
const privatePaths = { HOME: "home", CODEX_HOME: "home/codex", XDG_CONFIG_HOME: "xdg/config", XDG_CACHE_HOME: "xdg/cache", XDG_STATE_HOME: "xdg/state", TMPDIR: "tmp" }
const deadlines = { commandMs: 5000, reservationMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 45000 }
const selection = { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only", permissionProfile: "deny-all" }
const optionIds = { model: "model", reasoning: "reasoning_effort", mode: "mode" }

function invalid(): never { throw new AgentError("ADAPTER_UNQUALIFIED") }
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid()
  return value as Record<string, unknown>
}
function exact(value: unknown, expected: Record<string, unknown>): void {
  const actual = record(value, Object.keys(expected))
  if (!isDeepStrictEqual(actual, expected)) invalid()
}
function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096 || !value.isWellFormed() || /[\x00-\x1f\x7f]/u.test(value) || !isAbsolute(value) || normalize(value) !== value || value.endsWith("/") || value.split("/").includes("..")) invalid()
  return value
}
function parsePin(value: unknown): ArtifactPin {
  const v = record(value, ["path", "sha256", "identity"])
  const path = canonicalPath(v.path)
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256) || !Array.isArray(v.identity) || v.identity.length !== 9 || v.identity.some(part => typeof part !== "string" || !/^(0|[1-9][0-9]*)$/.test(part)) || v.identity[8] !== "1" || BigInt(v.identity[2]) > BigInt(MAX_ARTIFACT_BYTES)) invalid()
  return { path, sha256: v.sha256, identity: [...v.identity] as unknown as ArtifactPin["identity"] }
}
function parseManifest(value: unknown): CodexQualificationManifest {
  const v = record(value, ["version", "policy", "platform", "architecture", "providerId", "contractId", "adapterPackage", "adapterVersion", "adapterPackageJson", "adapterEntrypoint", "codexExecutable", "nodeExecutable", "nodeVersion", "protocolVersion", "qualificationCwd", "deadlines", "selection", "optionIds", "environment", "userStatePaths"])
  if (v.version !== 1 || v.policy !== "agency-codex-deny-all-v1" || v.platform !== "darwin" || v.architecture !== "arm64" || v.providerId !== "codex-acp" || v.contractId !== "codex-darwin-arm64-agency-deny-all-v1" || v.adapterPackage !== "@agentclientprotocol/codex-acp" || v.adapterVersion !== "1.7.0" || v.nodeVersion !== "24.13.0" || v.protocolVersion !== 1) invalid()
  exact(v.qualificationCwd, { source: "attempt-root", relative: "checkout" })
  exact(v.deadlines, deadlines)
  exact(v.selection, selection)
  exact(v.optionIds, optionIds)
  const environment = record(v.environment, ["fixed", "private"])
  exact(environment.fixed, fixed)
  exact(environment.private, privatePaths)
  if (Object.keys(fixed).some(key => Object.hasOwn(privatePaths, key))) invalid()
  if (!isDeepStrictEqual(v.userStatePaths, ["/Users/moon/.codex"])) invalid()
  const adapterPackageJson = parsePin(v.adapterPackageJson), adapterEntrypoint = parsePin(v.adapterEntrypoint), codexExecutable = parsePin(v.codexExecutable), nodeExecutable = parsePin(v.nodeExecutable)
  if (new Set([adapterPackageJson.path, adapterEntrypoint.path, codexExecutable.path, nodeExecutable.path]).size !== 4 || codexExecutable.path !== fixed.CODEX_PATH) invalid()
  return {
    version: 1, policy: "agency-codex-deny-all-v1", platform: "darwin", architecture: "arm64", providerId: "codex-acp", contractId: "codex-darwin-arm64-agency-deny-all-v1", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.7.0", adapterPackageJson, adapterEntrypoint, codexExecutable, nodeExecutable, nodeVersion: "24.13.0", protocolVersion: 1,
    qualificationCwd: { source: "attempt-root", relative: "checkout" }, deadlines: { ...deadlines } as CodexQualificationManifest["deadlines"], selection: { ...selection } as CodexQualificationManifest["selection"], optionIds: { ...optionIds } as CodexQualificationManifest["optionIds"],
    environment: { fixed: { ...fixed }, private: { ...privatePaths } }, userStatePaths: ["/Users/moon/.codex"],
  }
}
export function parseCodexQualificationManifest(value: unknown): CodexQualificationManifest {
  try { return parseManifest(value) } catch { return invalid() }
}
export function qualificationFingerprint(manifest: CodexQualificationManifest): string { return createHash("sha256").update(JSON.stringify(manifest)).digest("hex") }
function parseCandidate(value: CodexQualificationCandidate): CodexQualificationCandidate {
  try {
    const v = record(value, ["version", "manifest", "fingerprint"])
    const manifest = parseManifest(v.manifest)
    if (v.version !== 1 || v.fingerprint !== qualificationFingerprint(manifest)) invalid()
    return { version: 1, manifest, fingerprint: v.fingerprint }
  } catch { return invalid() }
}
function identity(stat: BigIntStats): ArtifactPin["identity"] {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].map(String) as unknown as ArtifactPin["identity"]
}
export async function observeArtifact(input: ArtifactPin): Promise<ArtifactPin> {
  try {
    const pin = parsePin(input)
    if (await realpath(pin.path) !== pin.path) invalid()
    const before = await lstat(pin.path, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_ARTIFACT_BYTES) || !isDeepStrictEqual(identity(before), pin.identity)) invalid()
    const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let digest: string
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !isDeepStrictEqual(identity(opened), pin.identity)) invalid()
      const hash = createHash("sha256")
      let bytes = 0
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length
        if (bytes > MAX_ARTIFACT_BYTES) invalid()
        hash.update(chunk)
      }
      if (BigInt(bytes) !== before.size || !isDeepStrictEqual(identity(await handle.stat({ bigint: true })), pin.identity)) invalid()
      digest = hash.digest("hex")
    } finally { await handle.close() }
    if (digest !== pin.sha256 || !isDeepStrictEqual(identity(await lstat(pin.path, { bigint: true })), pin.identity) || await realpath(pin.path) !== pin.path) invalid()
    return pin
  } catch { return invalid() }
}
export async function verifyCodexQualification(input: CodexQualificationManifest): Promise<CodexQualificationObservation> {
  const manifest = parseCodexQualificationManifest(input)
  if (process.platform !== manifest.platform || process.arch !== manifest.architecture || process.versions.node !== manifest.nodeVersion || process.execPath !== manifest.nodeExecutable.path) invalid()
  const artifacts = {
    adapterPackageJson: await observeArtifact(manifest.adapterPackageJson), adapterEntrypoint: await observeArtifact(manifest.adapterEntrypoint), codexExecutable: await observeArtifact(manifest.codexExecutable), nodeExecutable: await observeArtifact(manifest.nodeExecutable),
  }
  try {
    const bytes = await readBoundedFile(manifest.adapterPackageJson.path, 1024 * 1024)
    if (bytes === null) invalid()
    const packageJson: unknown = JSON.parse(bytes.toString("utf8"))
    if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson) || (packageJson as Record<string, unknown>).name !== manifest.adapterPackage || (packageJson as Record<string, unknown>).version !== manifest.adapterVersion) invalid()
    await observeArtifact(manifest.adapterPackageJson)
  } catch { return invalid() }
  return { version: 1, manifest, fingerprint: qualificationFingerprint(manifest), nodeVersion: manifest.nodeVersion, selection: manifest.selection, artifacts }
}
export function contractFromQualifiedCandidate(input: CodexQualificationCandidate): LaunchContract {
  const candidate = parseCandidate(input), manifest = candidate.manifest
  return { id: manifest.contractId, providerId: manifest.providerId, adapterVersion: manifest.adapterVersion, entrypoint: manifest.adapterEntrypoint.path, fingerprint: candidate.fingerprint, modes: { state: "values", values: [manifest.selection.mode] }, reasoning: { state: "values", values: [manifest.selection.reasoning] }, effectiveMode: null, permissionProfiles: [manifest.selection.permissionProfile], modelOption: manifest.optionIds.model, reasoningOption: manifest.optionIds.reasoning, modeOption: manifest.optionIds.mode, environment: manifest.environment, permissionEvidence: "agency-deny-all-v1", qualification: manifest }
}
export function launchEvidenceFromQualifiedCandidate(input: CodexQualificationCandidate, handlerGeneration: string, now: number): LaunchEvidence {
  const candidate = parseCandidate(input), manifest = candidate.manifest
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(handlerGeneration) || !Number.isSafeInteger(now) || now < 0) invalid()
  const profile: ProviderProfile = { id: manifest.providerId, enabled: true, executable: manifest.codexExecutable.path, adapterPackageJson: manifest.adapterPackageJson.path, sdkPackageJson: null, configurationFiles: [] }
  const configuration: ConfigEvidence = { fingerprint: candidate.fingerprint, scope: "declared-config-v1", providerId: manifest.providerId, adapterVersion: manifest.adapterVersion, sdkVersion: null }
  const provider: ProviderSnapshot = { providerId: manifest.providerId, fingerprint: candidate.fingerprint, verifiedAt: now, verifiedHandlerGeneration: handlerGeneration, providerVersion: null, providerVersionSource: "unknown", adapterVersion: manifest.adapterVersion, sdkVersion: null, error: null, models: [{ providerId: manifest.providerId, modelId: manifest.selection.modelId, resolvedModelId: null, displayName: manifest.selection.modelId, reasoning: { state: "values", values: [manifest.selection.reasoning] }, modes: { state: "values", values: [manifest.selection.mode] }, availability: "advertised" }] }
  return { snapshotId: randomUUID(), profile, provider, configuration }
}
export function renderQualifiedContractSource(input: CodexQualificationCandidate, evidence: { qualified: true; manifestFingerprint: string }): string {
  const candidate = parseCandidate(input)
  if (evidence.qualified !== true || evidence.manifestFingerprint !== candidate.fingerprint) invalid()
  return `import type { LaunchContract } from "./contracts.js"\nimport { contractFromQualifiedCandidate } from "./qualification.js"\nexport function qualifiedLaunchContracts(): readonly LaunchContract[] { return Object.freeze([contractFromQualifiedCandidate(${JSON.stringify(candidate)})]) }`
}