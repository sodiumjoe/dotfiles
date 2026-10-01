import { isAbsolute, normalize } from "node:path"

export const PROVIDERS = ["claude-agent-acp", "codex-acp"] as const
export type ProviderId = typeof PROVIDERS[number]
export type Capability = { state: "unknown" } | { state: "none" } | { state: "values"; values: string[] }
export type Model = { providerId: ProviderId; modelId: string; resolvedModelId: string | null; displayName: string; reasoning: Capability; modes: Capability; availability: "advertised" }
export type ProviderProfile = { id: ProviderId; enabled: boolean; executable: string; adapterPackageJson: string; sdkPackageJson: string | null; configurationFiles: string[] }
export type ConfigEvidence = { fingerprint: string; scope: "declared-config-v1"; providerId: ProviderId; adapterVersion: string; sdkVersion: string | null }
export type CatalogFailure = { code: CatalogErrorCode; message: string }
export type ProviderSnapshot = { providerId: ProviderId; fingerprint: string | null; verifiedAt: number | null; verifiedHandlerGeneration: string | null; providerVersion: string | null; providerVersionSource: "reported" | "unknown"; adapterVersion: string | null; sdkVersion: string | null; models: Model[]; error: CatalogFailure | null }
export type CatalogSnapshot = { version: 1; hostId: string; snapshotId: string; handlerGeneration: string; createdAt: number; providers: ProviderSnapshot[] }
export type RefreshCommand = { version: 1; commandId: string; hostId: string; handlerGeneration: string; batchId: string; fingerprints: Array<{ providerId: ProviderId; fingerprint: string }>; attempts: Array<{ providerId: ProviderId; attemptId: string }>; state: "pending" | "completed" | "interrupted"; snapshotId: string | null }
export type ProbeMeta = { version: 2; hostId: string; handlerGeneration: string; commandId: string; providerId: ProviderId; attemptId: string; fingerprint: string; workPath: string }
export type LegacyProbeMeta = Omit<ProbeMeta, "version"> & { version: 1; agentId: string; leaseId: string }
export type RetainedProbeMeta = ProbeMeta | LegacyProbeMeta
export const CATALOG_TTL_MS = 600000
export const MAX_CATALOG_BYTES = 1024 * 1024
export const catalogMessages = {
  INVALID_CATALOG: "Invalid catalog evidence",
  UNSUPPORTED_PROVIDER_VERSION: "Unsupported discovery dependency version",
  CONFIG_CHANGED: "Declared provider configuration changed",
  PROBE_FAILED: "Provider discovery failed",
  PROBE_TIMEOUT: "Provider discovery timed out",
  PROBE_CLEANUP_UNVERIFIED: "Discovery process cleanup is unverified",
  CATALOG_UNAVAILABLE: "Catalog discovery is unavailable",
  COMMAND_CONFLICT: "Refresh command identity conflicts with retained evidence",
  STALE_HANDLER: "Handler generation changed",
  INCOMPLETE: "Catalog operation remains incomplete",
} as const
export type CatalogErrorCode = keyof typeof catalogMessages
export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode) { super(catalogMessages[code]) }
}
export function failure(error: unknown): CatalogFailure {
  const code = error instanceof CatalogError ? error.code : "CATALOG_UNAVAILABLE"
  return { code, message: catalogMessages[code] }
}
export function invalid(): never { throw new CatalogError("INVALID_CATALOG") }
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid()
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f-\x9f]/u.test(value) || !value.isWellFormed()) invalid()
  return value
}
export function id(value: unknown): string {
  const result = text(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result)) invalid()
  return result
}
export function hash(value: unknown): string {
  const result = text(value)
  if (!/^[0-9a-f]{64}$/.test(result)) invalid()
  return result
}
export function providerId(value: unknown): ProviderId {
  if (value !== "claude-agent-acp" && value !== "codex-acp") invalid()
  return value
}
export function absolutePath(value: unknown): string {
  const result = text(value, 4096)
  if (!isAbsolute(result) || normalize(result) !== result || (result !== "/" && result.endsWith("/"))) invalid()
  return result
}
export function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}
export function isFresh(verifiedAt: number | null, now: number): boolean {
  return verifiedAt !== null && now >= verifiedAt && now - verifiedAt < CATALOG_TTL_MS
}
export function parseCapability(value: unknown): Capability {
  const v = object(value)
  if (v.state === "unknown" || v.state === "none") { keys(v, ["state"]); return { state: v.state } }
  keys(v, ["state", "values"])
  if (v.state !== "values" || !Array.isArray(v.values) || v.values.length < 1 || v.values.length > 32) invalid()
  const values = v.values.map(value => text(value))
  if (new Set(values).size !== values.length) invalid()
  return { state: "values", values: values.sort() }
}
export function parseModel(value: unknown): Model {
  const v = object(value)
  keys(v, ["providerId", "modelId", "resolvedModelId", "displayName", "reasoning", "modes", "availability"])
  if (v.availability !== "advertised") invalid()
  return { providerId: providerId(v.providerId), modelId: text(v.modelId), resolvedModelId: v.resolvedModelId === null ? null : text(v.resolvedModelId), displayName: text(v.displayName, 512), reasoning: parseCapability(v.reasoning), modes: parseCapability(v.modes), availability: "advertised" }
}
export function parseModels(input: unknown, provider: ProviderId): Model[] {
  if (!Array.isArray(input) || input.length > 512 || Buffer.byteLength(JSON.stringify(input)) > MAX_CATALOG_BYTES) invalid()
  const models = input.map(parseModel), ids = new Set<string>()
  for (const model of models) { if (model.providerId !== provider || ids.has(model.modelId)) invalid(); ids.add(model.modelId) }
  return models.sort((a, b) => a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0)
}

export function parseFailure(input: unknown): CatalogFailure {
  const v = object(input)
  keys(v, ["code", "message"])
  if (typeof v.code !== "string" || !Object.hasOwn(catalogMessages, v.code)) invalid()
  const code = v.code as CatalogErrorCode
  if (v.message !== catalogMessages[code]) invalid()
  return { code, message: catalogMessages[code] }
}
export function parseProviderSnapshot(input: unknown): ProviderSnapshot {
  const v = object(input)
  keys(v, ["providerId", "fingerprint", "verifiedAt", "verifiedHandlerGeneration", "providerVersion", "providerVersionSource", "adapterVersion", "sdkVersion", "models", "error"])
  const provider = providerId(v.providerId)
  if (v.providerVersionSource !== "unknown" && v.providerVersionSource !== "reported") invalid()
  if (v.providerVersionSource !== (v.providerVersion === null ? "unknown" : "reported")) invalid()
  const result: ProviderSnapshot = { providerId: provider, fingerprint: v.fingerprint === null ? null : hash(v.fingerprint), verifiedAt: v.verifiedAt === null ? null : timestamp(v.verifiedAt), verifiedHandlerGeneration: v.verifiedHandlerGeneration === null ? null : id(v.verifiedHandlerGeneration), providerVersion: v.providerVersion === null ? null : text(v.providerVersion), providerVersionSource: v.providerVersionSource, adapterVersion: v.adapterVersion === null ? null : text(v.adapterVersion), sdkVersion: v.sdkVersion === null ? null : text(v.sdkVersion), models: parseModels(v.models, provider), error: v.error === null ? null : parseFailure(v.error) }
  if (result.verifiedAt === null ? result.fingerprint !== null || result.verifiedHandlerGeneration !== null || result.models.length > 0 || result.providerVersion !== null : result.fingerprint === null || result.verifiedHandlerGeneration === null || result.adapterVersion === null) invalid()
  return result
}
export function parseSnapshot(input: unknown): CatalogSnapshot {
  const v = object(input)
  keys(v, ["version", "hostId", "snapshotId", "handlerGeneration", "createdAt", "providers"])
  if (v.version !== 1 || !Array.isArray(v.providers) || v.providers.length > 2) invalid()
  const providers = v.providers.map(parseProviderSnapshot)
  if (new Set(providers.map(p => p.providerId)).size !== providers.length) invalid()
  return { version: 1, hostId: hash(v.hostId), snapshotId: id(v.snapshotId), handlerGeneration: id(v.handlerGeneration), createdAt: timestamp(v.createdAt), providers: providers.sort((a, b) => a.providerId < b.providerId ? -1 : 1) }
}
export function parseCommand(input: unknown): RefreshCommand {
  const v = object(input)
  keys(v, ["version", "commandId", "hostId", "handlerGeneration", "batchId", "fingerprints", "attempts", "state", "snapshotId"])
  if (v.version !== 1 || !Array.isArray(v.fingerprints) || !Array.isArray(v.attempts) || v.fingerprints.length > 2 || v.attempts.length !== v.fingerprints.length || !["pending", "completed", "interrupted"].includes(String(v.state))) invalid()
  const fingerprints = v.fingerprints.map(input => { const p = object(input); keys(p, ["providerId", "fingerprint"]); return { providerId: providerId(p.providerId), fingerprint: hash(p.fingerprint) } })
  const attempts = v.attempts.map(input => { const p = object(input); keys(p, ["providerId", "attemptId"]); return { providerId: providerId(p.providerId), attemptId: id(p.attemptId) } })
  if (new Set(fingerprints.map(p => p.providerId)).size !== fingerprints.length || new Set(attempts.map(p => p.attemptId)).size !== attempts.length || attempts.some((p, i) => p.providerId !== fingerprints[i]!.providerId) || fingerprints.some((p, i) => i > 0 && fingerprints[i - 1]!.providerId >= p.providerId)) invalid()
  if ((v.state === "completed") !== (v.snapshotId !== null)) invalid()
  return { version: 1, commandId: id(v.commandId), hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), batchId: id(v.batchId), fingerprints, attempts, state: v.state as RefreshCommand["state"], snapshotId: v.snapshotId === null ? null : id(v.snapshotId) }
}
export function parseProbeMeta(input: unknown): ProbeMeta {
  const v = object(input)
  keys(v, ["version", "hostId", "handlerGeneration", "commandId", "providerId", "attemptId", "fingerprint", "workPath"])
  if (v.version !== 2) invalid()
  return { version: 2, hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), commandId: id(v.commandId), providerId: providerId(v.providerId), attemptId: id(v.attemptId), fingerprint: hash(v.fingerprint), workPath: absolutePath(v.workPath) }
}
export function parseRetainedProbeMeta(input: unknown): RetainedProbeMeta {
  const v = object(input)
  if (v.version === 2) return parseProbeMeta(v)
  keys(v, ["version", "hostId", "handlerGeneration", "commandId", "providerId", "attemptId", "agentId", "leaseId", "fingerprint", "workPath"])
  if (v.version !== 1) invalid()
  return { version: 1, hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), commandId: id(v.commandId), providerId: providerId(v.providerId), attemptId: id(v.attemptId), agentId: id(v.agentId), leaseId: id(v.leaseId), fingerprint: hash(v.fingerprint), workPath: absolutePath(v.workPath) }
}