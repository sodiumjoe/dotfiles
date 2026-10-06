import { object, text } from "../catalog/types.js"

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }
export type RequestedSettings = { modelId?: string; modeId?: string; configValues?: Record<string, string | boolean> }
export type RestorableSettings = RequestedSettings
export type SessionConfiguration = { configOptions: JsonObject[]; models: JsonObject | null; modes: JsonObject | null; availableCommands: JsonObject[]; revision: number }

export function validateMetadata(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, "_meta")) object(value._meta)
}

export function validateConfiguration(result: JsonObject): void {
  validateMetadata(result)
  if (Object.hasOwn(result, "configOptions")) {
    if (!Array.isArray(result.configOptions)) throw new Error("invalid configuration options")
    const ids = new Set<string>()
    for (const raw of result.configOptions) {
      const option = object(raw), id = text(option.id, 1024)
      validateMetadata(option)
      if (ids.has(id)) throw new Error("duplicate configuration option")
      ids.add(id)
      if (typeof option.type !== "string") throw new Error("invalid configuration option type")
      if (option.type === "boolean" && typeof option.currentValue !== "boolean") throw new Error("invalid boolean option")
      if (option.type !== "select") continue
      if (!Array.isArray(option.options) || typeof option.currentValue !== "string") throw new Error("invalid select option")
      const values = new Set<string>()
      const choice = (raw: unknown) => {
        const item = object(raw), value = text(item.value, 4096)
        validateMetadata(item)
        if (values.has(value)) throw new Error("duplicate select value")
        values.add(value)
      }
      for (const raw of option.options) {
        const item = object(raw)
        validateMetadata(item)
        if (Object.hasOwn(item, "options")) {
          text(item.group, 1024)
          if (!Array.isArray(item.options)) throw new Error("invalid option group")
          item.options.forEach(choice)
        } else choice(item)
      }
      if (!values.has(option.currentValue)) throw new Error("unadvertised current value")
    }
  }
  for (const [field, choices, key, current] of [["models", "availableModels", "modelId", "currentModelId"], ["modes", "availableModes", "id", "currentModeId"]]) {
    if (!Object.hasOwn(result, field!)) continue
    const state = object(result[field!])
    validateMetadata(state)
    if (!Array.isArray(state[choices!])) throw new Error("invalid legacy configuration")
    const ids = (state[choices!] as unknown[]).map(raw => { const item = object(raw); validateMetadata(item); return text(item[key!], 1024) })
    if (new Set(ids).size !== ids.length || !ids.includes(text(state[current!], 1024))) throw new Error("invalid current legacy selection")
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  const v = object(value)
  return "{" + Object.keys(v).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(v[key])).join(",") + "}"
}

export function parseRequestedSettings(input: unknown): RequestedSettings {
  const v = object(input), result: RequestedSettings = {}
  if (Object.keys(v).some(key => !["modelId", "modeId", "configValues"].includes(key))) throw new Error("invalid session settings")
  if (v.modelId !== undefined) result.modelId = text(v.modelId, 1024)
  if (v.modeId !== undefined) result.modeId = text(v.modeId, 1024)
  if (v.configValues !== undefined) {
    const values = object(v.configValues)
    if (Object.keys(values).length > 128) throw new Error("too many session settings")
    result.configValues = Object.fromEntries(Object.entries(values).map(([id, value]) => {
      text(id, 1024)
      return [id, typeof value === "boolean" ? value : text(value, 4096)]
    }))
  }
  return result
}

function publicValue(option: Record<string, unknown>): string | boolean | undefined {
  if (option.type === "boolean" && typeof option.currentValue === "boolean") return option.currentValue
  if (option.type !== "select" || typeof option.currentValue !== "string" || !Array.isArray(option.options)) return undefined
  const values: string[] = []
  for (const raw of option.options) {
    const choice = object(raw)
    if (Array.isArray(choice.options)) {
      for (const nested of choice.options) {
        const item = object(nested)
        if (typeof item.value === "string") values.push(item.value)
      }
    } else if (typeof choice.value === "string") values.push(choice.value)
  }
  return values.includes(option.currentValue) ? option.currentValue : undefined
}

export function projectRestorableSettings(input: unknown): RestorableSettings {
  const snapshot = object(input), result: RestorableSettings = {}, values: Record<string, string | boolean> = {}
  if (Array.isArray(snapshot.configOptions)) for (const raw of snapshot.configOptions) {
    const option = object(raw), value = publicValue(option)
    if (value !== undefined) Object.defineProperty(values, text(option.id, 1024), { value, enumerable: true })
  }
  if (Object.keys(values).length) result.configValues = values
  if (snapshot.models !== null && snapshot.models !== undefined) {
    const models = object(snapshot.models)
    if (typeof models.currentModelId === "string" && Array.isArray(models.availableModels) && models.availableModels.some(raw => object(raw).modelId === models.currentModelId)) result.modelId = models.currentModelId
  }
  if (snapshot.modes !== null && snapshot.modes !== undefined) {
    const modes = object(snapshot.modes)
    if (typeof modes.currentModeId === "string" && Array.isArray(modes.availableModes) && modes.availableModes.some(raw => object(raw).id === modes.currentModeId)) result.modeId = modes.currentModeId
  }
  return result
}

export function nonRestorableOptionIds(input: unknown): string[] {
  const snapshot = object(input)
  if (!Array.isArray(snapshot.configOptions)) return []
  return [...new Set(snapshot.configOptions.map(object).filter(option => publicValue(option) === undefined).map(option => text(option.id, 1024)))].sort()
}

export function configurationSnapshot(result: JsonObject, revision = 0): SessionConfiguration {
  return {
    configOptions: Array.isArray(result.configOptions) ? result.configOptions.map(value => structuredClone(object(value)) as JsonObject) : [],
    models: result.models && !Array.isArray(result.models) && typeof result.models === "object" ? structuredClone(result.models) : null,
    modes: result.modes && !Array.isArray(result.modes) && typeof result.modes === "object" ? structuredClone(result.modes) : null,
    availableCommands: Array.isArray(result.availableCommands) ? result.availableCommands.map(value => structuredClone(object(value)) as JsonObject) : [],
    revision,
  }
}