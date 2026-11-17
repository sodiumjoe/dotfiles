import type { Model } from "../config/models.js"
import type { Backend } from "./backend-config.js"
import type { LaunchContract } from "./contracts.js"
import type { JsonObject, RequestedSettings } from "./session-config.js"


export function backendChoice(backend: Backend, contract: LaunchContract, listing: { models: Model[]; error: string | null }): JsonObject {
  return choice(backend, contract, listing.models, listing.error ? "unavailable" : "fresh", listing.error)
}

function choice(backend: Backend, contract: LaunchContract, available: Model[], discovery: string, discoveryError: string | null): JsonObject {
  const setting = (id: string, name: string, kind: string, values: string[]): JsonObject => ({ id, name, kind, values: values.map(value => ({ value, name: value })) })
  const codex = backend.id === "codex-acp"
  const nativeConfiguration = codex || contract.id === "claude-agent-acp-0.102" && contract.adapterVersion === "0.102.0"
  const modes = codex && contract.id === "codex-acp-2.6" && contract.adapterVersion === "2.6.0"
    ? [setting("mode", "Mode", "config", ["read-only", "agent", "agent-full-access"])] : []
  const models = available.map(model => {
    const settings: JsonObject[] = []
    if (model.reasoning.state === "values" && contract.reasoningOption) settings.push(setting(codex ? "reasoning_effort" : contract.reasoningOption, "Reasoning effort", "config", model.reasoning.values))
    if (!modes.length && model.modes.state === "values") settings.push(setting(nativeConfiguration ? contract.modeOption ?? "mode" : "modeId", "Mode", nativeConfiguration ? "config" : "field", model.modes.values))
    return { id: model.modelId, name: model.displayName, selection: nativeConfiguration ? { configValues: { [contract.modelOption]: model.modelId } } : { modelId: model.modelId }, settings }
  })
  return { id: backend.id, defaults: structuredClone(backend.initial), discovery, discoveryError, models, settings: modes }
}

export function namedSettings(contract: LaunchContract, model?: string, mode?: string): RequestedSettings {
  const native = contract.providerId === "codex-acp" || contract.id === "claude-agent-acp-0.102" && contract.adapterVersion === "0.102.0"
  const values: Record<string, string> = {}
  if (model !== undefined && native) values[contract.modelOption] = model
  if (mode !== undefined && native && contract.modeOption) values[contract.modeOption] = mode
  return { ...(model !== undefined && !native ? { modelId: model } : {}), ...(mode !== undefined && !(native && contract.modeOption) ? { modeId: mode } : {}), ...(Object.keys(values).length ? { configValues: values } : {}) }
}