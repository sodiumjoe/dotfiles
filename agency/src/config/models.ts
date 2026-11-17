import { invalid, keys, object, providerId, text, type ProviderId, type CatalogErrorCode } from "./validate.js"

export type Capability = { state: "unknown" } | { state: "none" } | { state: "values"; values: string[] }
export type Model = { providerId: ProviderId; modelId: string; resolvedModelId: string | null; displayName: string; reasoning: Capability; modes: Capability; availability: "advertised" }
export type CatalogFailure = { code: CatalogErrorCode; message: string }
export type ProviderSnapshot = { providerId: ProviderId; fingerprint: string | null; verifiedAt: number | null; verifiedHandlerGeneration: string | null; providerVersion: string | null; providerVersionSource: "reported" | "unknown"; adapterVersion: string | null; sdkVersion: string | null; models: Model[]; error: CatalogFailure | null }
const MAX_MODEL_BYTES = 1024 * 1024
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
  if (!Array.isArray(input) || input.length > 512 || Buffer.byteLength(JSON.stringify(input)) > MAX_MODEL_BYTES) invalid()
  const models = input.map(parseModel), ids = new Set<string>()
  for (const model of models) { if (model.providerId !== provider || ids.has(model.modelId)) invalid(); ids.add(model.modelId) }
  return models.sort((a, b) => a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0)
}
function normalize(input: unknown, provider: ProviderId): Model[] {
  if (!Array.isArray(input) || input.length > 512) invalid()
  return parseModels(input.map(value => {
    const v = object(value)
    let reasoning: Capability = { state: "unknown" }
    if (provider === "claude-agent-acp") {
      if (v.supportsEffort !== undefined && typeof v.supportsEffort !== "boolean") invalid()
      if (v.supportedEffortLevels !== undefined && !Array.isArray(v.supportedEffortLevels)) invalid()
      const values = v.supportedEffortLevels as unknown[] | undefined
      if (v.supportsEffort === false) {
        if (values !== undefined && values.length > 0) invalid()
        reasoning = { state: "none" }
      } else if (values !== undefined && values.length > 0) reasoning = parseCapability({ state: "values", values })
    } else {
      if (v.supportedReasoningEfforts !== undefined && !Array.isArray(v.supportedReasoningEfforts)) invalid()
      const values = v.supportedReasoningEfforts as unknown[] | undefined
      if (values !== undefined && values.length > 0) reasoning = parseCapability({ state: "values", values: values.map(value => object(value).reasoningEffort) })
    }
    return { providerId: provider, modelId: text(provider === "claude-agent-acp" ? v.value : v.id), resolvedModelId: v.resolvedModel === undefined ? null : text(v.resolvedModel), displayName: text(v.displayName, 512), reasoning, modes: { state: "unknown" }, availability: "advertised" }
  }), provider)
}
export function normalizeClaude(input: unknown): Model[] { return normalize(input, "claude-agent-acp") }
export function normalizeCodex(input: unknown): Model[] { return normalize(input, "codex-acp") }