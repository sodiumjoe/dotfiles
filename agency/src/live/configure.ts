import { withNativeSession } from "../agent/acp.js"
import { object } from "../config/validate.js"
import { projectRestorableSettings, type JsonObject, type SessionConfiguration } from "../agent/session-config.js"
import type { EventLog } from "../handler/event-log.js"
import { RequestError } from "./errors.js"
import type { LiveAgent } from "./state.js"

export type SettingRequest = { method: "session/set_config_option" | "session/set_model" | "session/set_mode"; params: JsonObject }

function offered(option: JsonObject): Array<string | boolean> {
  if (option.type === "boolean") return [true, false]
  const values = (entries: unknown): Array<string | boolean> => Array.isArray(entries) ? entries.flatMap(entry => { const value = entry as JsonObject | null; return value && (typeof value.value === "string" || typeof value.value === "boolean") ? [value.value] : values(value?.options) }) : []
  return values(option.options)
}

function current(snapshot: SessionConfiguration, request: SettingRequest): unknown {
  if (request.method === "session/set_model") return snapshot.models?.currentModelId ?? null
  if (request.method === "session/set_mode") return snapshot.modes?.currentModeId ?? null
  return snapshot.configOptions.find(option => option.id === request.params.configId)?.currentValue ?? null
}

export function settingRequest(agent: LiveAgent, setting: string, value: string | boolean): SettingRequest {
  const snapshot = agent.owner!.snapshot(), contract = agent.contract!
  const configId = setting === "model" ? contract.modelOption : setting === "mode" ? contract.modeOption : setting
  if (configId !== null && snapshot.configOptions.some(option => option.id === configId)) return { method: "session/set_config_option", params: { configId, value } }
  if (setting === "model" && snapshot.models && typeof value === "string") return { method: "session/set_model", params: { modelId: value } }
  if (setting === "mode" && snapshot.modes && typeof value === "string") return { method: "session/set_mode", params: { modeId: value } }
  throw new RequestError("INVALID", "agent " + agent.agentId + " has no setting " + setting)
}

export function unchanged(agent: LiveAgent, request: SettingRequest): boolean {
  const value = request.method === "session/set_model" ? request.params.modelId : request.method === "session/set_mode" ? request.params.modeId : request.params.value
  return current(agent.owner!.snapshot(), request) === value
}

export async function configure(agent: LiveAgent, request: SettingRequest, input: { events?: EventLog; publish(agent: LiveAgent): void }): Promise<JsonObject> {
  const { method, params } = request, snapshot = agent.owner!.snapshot(), contract = agent.contract!
  const modeChange = method === "session/set_mode" || method === "session/set_config_option" && params.configId === contract.modeOption
  if (agent.turns!.busy() && !(modeChange && contract.providerId === "claude-agent-acp")) throw new RequestError("BUSY", "agent " + agent.agentId + " is running a turn")
  if (agent.configuring) throw new RequestError("BUSY", "agent " + agent.agentId + " is already changing a setting")
  let choices: Array<string | boolean>, label: string
  if (method === "session/set_model" || method === "session/set_mode") {
    const model = method === "session/set_model", state = model ? snapshot.models : snapshot.modes, available = state?.[model ? "availableModels" : "availableModes"]
    choices = Array.isArray(available) ? available.map(entry => object(entry)[model ? "modelId" : "id"]).filter((value): value is string => typeof value === "string") : []
    label = model ? "model" : "mode"
    if (!choices.includes(params[model ? "modelId" : "modeId"] as string)) throw new RequestError("INVALID", label + " " + String(params[model ? "modelId" : "modeId"]) + " is not offered; offered: " + choices.join(", "))
  } else {
    const option = snapshot.configOptions.find(value => value.id === params.configId)
    if (!option) throw new RequestError("INVALID", "agent " + agent.agentId + " has no setting " + String(params.configId))
    choices = offered(option); label = String(params.configId)
    const projected = projectRestorableSettings({ configOptions: [{ ...option, currentValue: params.value! }] }).configValues?.[label]
    if ((option.type === "select" || option.type === "boolean") && (projected === undefined || !choices.includes(projected))) throw new RequestError("INVALID", label + " " + String(params.value) + " is not offered; offered: " + choices.join(", "))
  }
  const before = current(snapshot, request)
  agent.configuring++
  try {
    const result = await agent.owner!.request(method, withNativeSession(params, agent.session!.sessionId), agent.controller.signal)
    input.events?.append({ type: "settings_changed", agentId: agent.agentId, setting: label, before: before as string | boolean | null, after: current(agent.owner!.snapshot(), request) as string | boolean | null })
    input.publish(agent)
    return result
  } finally { agent.configuring-- }
}