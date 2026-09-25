import { invalid, object, text, parseCapability, parseModels, type Capability, type Model, type ProviderId } from "./types.js"

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