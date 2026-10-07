import { object } from "../catalog/types.js"
import { AgentError, agentText } from "./types.js"
import { validateMetadata, type JsonObject } from "./session-config.js"

export function validateStructuredContent(raw: unknown): void {
  const content = object(raw)
  validateMetadata(content)
  if (content.annotations != null) {
    const value = object(content.annotations); validateMetadata(value)
    if (value.audience != null && (!Array.isArray(value.audience) || value.audience.some(role => role !== "assistant" && role !== "user"))) invalid()
    if (value.priority != null && (typeof value.priority !== "number" || !Number.isFinite(value.priority) || value.priority < 0 || value.priority > 1)) invalid()
    if (value.lastModified != null && typeof value.lastModified !== "string") invalid()
  }
  if (content.type === "text") { if (typeof content.text !== "string" || !content.text.isWellFormed()) invalid(); return }
  if (content.type === "image" || content.type === "audio") { if (typeof content.data !== "string" || typeof content.mimeType !== "string") invalid(); return }
  if (content.type === "resource_link") { agentText(content.uri, 1048576); agentText(content.name, 1048576); return }
  if (content.type === "resource") {
    const resource = object(content.resource)
    validateMetadata(resource); agentText(resource.uri, 1048576)
    if ((typeof resource.text === "string") === (typeof resource.blob === "string")) invalid()
    return
  }
  invalid()
}

export function validateNativeUpdate(raw: unknown): ValidatedSessionUpdate {
  const update = object(raw), kind = agentText(update.sessionUpdate)
  validateMetadata(update)
  if (["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(kind)) validateStructuredContent(update.content)
  if (kind === "current_mode_update") agentText(update.currentModeId)
  if (kind === "config_option_update" && !Array.isArray(update.configOptions)) invalid()
  if (kind === "tool_call" || kind === "tool_call_update") {
    agentText(update.toolCallId, 1024)
    if (update.title != null && typeof update.title !== "string") invalid()
    if (update.kind != null && (typeof update.kind !== "string" || !["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"].includes(update.kind))) invalid()
    if (update.status != null && (typeof update.status !== "string" || !["pending", "in_progress", "completed", "failed"].includes(update.status))) invalid()
    if (update.content != null) {
      if (!Array.isArray(update.content)) invalid()
      for (const raw of update.content) {
        const item = object(raw); validateMetadata(item)
        if (item.type === "content") validateStructuredContent(item.content)
        else if (item.type === "diff") { if (typeof item.path !== "string" || typeof item.newText !== "string" || item.oldText != null && typeof item.oldText !== "string") invalid() }
        else if (item.type === "terminal") agentText(item.terminalId, 1024)
        else invalid()
      }
    }
    if (update.locations != null) {
      if (!Array.isArray(update.locations)) invalid()
      for (const raw of update.locations) { const location = object(raw); validateMetadata(location); if (typeof location.path !== "string" || location.line != null && (!Number.isSafeInteger(location.line) || Number(location.line) < 0)) invalid() }
    }
  }
  if (kind === "plan") {
    if (!Array.isArray(update.entries)) invalid()
    for (const raw of update.entries) { const entry = object(raw); validateMetadata(entry); if (typeof entry.content !== "string" || typeof entry.priority !== "string" || !["high", "medium", "low"].includes(entry.priority) || typeof entry.status !== "string" || !["pending", "in_progress", "completed"].includes(entry.status)) invalid() }
  }
  if (kind === "session_info_update") {
    if (update.title != null && typeof update.title !== "string") invalid()
    if (update.updatedAt != null && (typeof update.updatedAt !== "string" || !Number.isFinite(Date.parse(update.updatedAt)))) invalid()
  }
  if (kind === "usage_update") {
    if (!Number.isSafeInteger(update.used) || !Number.isSafeInteger(update.size) || Number(update.used) < 0 || Number(update.size) < 0) invalid()
    if (update.cost != null) {
      const cost = object(update.cost); validateMetadata(cost)
      if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0 || typeof cost.currency !== "string") invalid()
    }
  }
  if (kind === "available_commands_update") {
    if (!Array.isArray(update.availableCommands)) invalid()
    for (const raw of update.availableCommands) {
      const command = object(raw); validateMetadata(command); agentText(command.name, 1024)
      if (typeof command.description !== "string") invalid()
      if (command.input != null) { const input = object(command.input); validateMetadata(input); if (typeof input.hint !== "string") invalid() }
    }
  }
  return update as ValidatedSessionUpdate
}

export function validateNativePromptResponse(result: Record<string, unknown>): void {
  validateMetadata(result)
  if (typeof result.stopReason !== "string" || !STOP_REASONS.includes(result.stopReason as StopReason)) invalid()
  if (result.usage != null) {
    const usage = object(result.usage); validateMetadata(usage)
    for (const name of ["totalTokens", "inputTokens", "outputTokens"]) if (!Object.hasOwn(usage, name)) invalid()
    for (const name of ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"]) {
      if (usage[name] != null && (!Number.isSafeInteger(usage[name]) || Number(usage[name]) < 0)) invalid()
    }
  }
}

export type StopReason = "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal"
const STOP_REASONS: readonly StopReason[] = ["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"]
export type TurnResult = { stopReason: StopReason; text: string }
export type TurnOptions = { inputBytes: number; outputBytes: number; encodedTextBytes: number; allowEmptyAnswer: boolean }
export const EDITOR_TURN_LIMITS: Readonly<TurnOptions> = Object.freeze({ inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true })
export const LEGACY_TURN_LIMITS: Readonly<TurnOptions> = Object.freeze({ inputBytes: 4096, outputBytes: 4096, encodedTextBytes: 917504, allowEmptyAnswer: false })
export type ValidatedSessionUpdate = { sessionUpdate: string; [field: string]: unknown }
export type AcpObservation = { update: ValidatedSessionUpdate; replay: boolean; params?: JsonObject; meta?: JsonObject }

export function validateTurnInput(text: string, limits: TurnOptions): void {
  if (typeof text !== "string" || !text.length || !text.isWellFormed()) throw new AgentError("INVALID_AGENT_STATE")
  if (Buffer.byteLength(text) > limits.inputBytes || Buffer.byteLength(JSON.stringify(text)) > limits.encodedTextBytes) throw new AgentError("INPUT_TOO_LARGE")
}

export function displayTitle(title: string): { title: string; titleTruncated: boolean; titleOriginalBytes: number } {
  const bytes = Buffer.byteLength(title)
  let value = "", retained = 0
  for (const point of title) {
    const length = Buffer.byteLength(point)
    if (retained + length > 1024) break
    value += point; retained += length
  }
  return { title: value, titleTruncated: retained < bytes, titleOriginalBytes: bytes }
}

function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
export function knownKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
}
export function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || !value.isWellFormed()) invalid()
  return value
}
export function metadata(value: unknown, max = 16384): void {
  if (value === null) return
  const v = object(value)
  if (Object.keys(v).length > 128) invalid()
  try { if (Buffer.byteLength(JSON.stringify(v)) > max) invalid() } catch { invalid() }
}
function annotations(value: unknown): void {
  if (value === null) return
  const v = object(value); knownKeys(v, [], ["audience", "lastModified", "priority", "_meta"])
  if (Object.hasOwn(v, "audience") && v.audience !== null && (!Array.isArray(v.audience) || v.audience.length > 2 || v.audience.some(role => role !== "assistant" && role !== "user"))) invalid()
  if (Object.hasOwn(v, "lastModified") && v.lastModified !== null) boundedText(v.lastModified, 64)
  if (Object.hasOwn(v, "priority") && v.priority !== null && (typeof v.priority !== "number" || !Number.isFinite(v.priority))) invalid()
  if (Object.hasOwn(v, "_meta")) metadata(v._meta)
}
function contentText(value: unknown): string {
  const content = object(value); knownKeys(content, ["type", "text"], ["type", "text", "annotations", "_meta"])
  if (content.type !== "text") invalid()
  if (Object.hasOwn(content, "annotations")) annotations(content.annotations)
  if (Object.hasOwn(content, "_meta")) metadata(content._meta)
  return boundedText(content.text, 1048576)
}
export function contentChunk(update: Record<string, unknown>): string {
  knownKeys(update, ["sessionUpdate", "content"], ["sessionUpdate", "content", "messageId", "_meta"])
  if (Object.hasOwn(update, "messageId") && update.messageId !== null) agentText(update.messageId, 1024)
  if (Object.hasOwn(update, "_meta")) metadata(update._meta)
  return contentText(update.content)
}
function informational(update: Record<string, unknown>, kind: string): boolean {
  if (kind === "tool_call" || kind === "tool_call_update") {
    knownKeys(update, kind === "tool_call" ? ["sessionUpdate", "toolCallId", "title"] : ["sessionUpdate", "toolCallId"], ["sessionUpdate", "toolCallId", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput", "_meta"])
    if (Buffer.byteLength(JSON.stringify(update)) > 1048576) invalid()
    agentText(update.toolCallId, 1024)
    if (update.title !== undefined && update.title !== null) boundedText(update.title, 4096)
    if (update.kind !== undefined && update.kind !== null && !["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"].includes(update.kind as string)) invalid()
    if (update.status !== undefined && update.status !== null && !["pending", "in_progress", "completed", "failed"].includes(update.status as string)) invalid()
    if (update.content !== undefined && update.content !== null) {
      if (!Array.isArray(update.content) || update.content.length > 32) invalid()
      for (const raw of update.content) {
        const item = object(raw)
        if (item.type === "content") {
          knownKeys(item, ["type", "content"], ["type", "content", "_meta"])
          contentText(item.content)
        } else if (item.type === "diff") {
          knownKeys(item, ["type", "path", "newText"], ["type", "path", "oldText", "newText", "_meta"])
          boundedText(item.path, 4096); boundedText(item.newText, 1048576)
          if (item.oldText !== undefined && item.oldText !== null) boundedText(item.oldText, 1048576)
        } else if (item.type === "terminal") {
          knownKeys(item, ["type", "terminalId"], ["type", "terminalId", "_meta"])
          agentText(item.terminalId, 1024)
        } else invalid()
        if (Object.hasOwn(item, "_meta")) metadata(item._meta)
      }
    }
    if (update.locations !== undefined && update.locations !== null) {
      if (!Array.isArray(update.locations) || update.locations.length > 64) invalid()
      for (const raw of update.locations) {
        const location = object(raw); knownKeys(location, ["path"], ["path", "line", "_meta"]); boundedText(location.path, 4096)
        if (location.line !== undefined && location.line !== null && (!Number.isSafeInteger(location.line) || Number(location.line) < 0)) invalid()
        if (Object.hasOwn(location, "_meta")) metadata(location._meta)
      }
    }
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
    for (const key of ["rawInput", "rawOutput"]) if (Object.hasOwn(update, key) && Buffer.byteLength(JSON.stringify(update[key])) > 65536) invalid()
    return true
  }
  if (kind === "agent_thought_chunk") { contentChunk(update); return true }
  if (kind === "plan") {
    knownKeys(update, ["sessionUpdate", "entries"], ["sessionUpdate", "entries", "_meta"])
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
    if (!Array.isArray(update.entries) || update.entries.length > 32 || Buffer.byteLength(JSON.stringify(update.entries)) > 65536) invalid()
    for (const raw of update.entries) {
      const entry = object(raw); knownKeys(entry, ["content", "priority", "status"], ["content", "priority", "status", "_meta"]); boundedText(entry.content, 4096)
      if (typeof entry.priority !== "string" || !["high", "medium", "low"].includes(entry.priority) || typeof entry.status !== "string" || !["pending", "in_progress", "completed"].includes(entry.status)) invalid()
      if (Object.hasOwn(entry, "_meta")) metadata(entry._meta)
    }
    return true
  }
  if (kind === "session_info_update") {
    const names = Object.keys(update)
    if (names.length < 2 || names.length > 4 || names.some(key => !["sessionUpdate", "title", "updatedAt", "_meta"].includes(key))) invalid()
    if (Object.hasOwn(update, "title") && update.title !== null) boundedText(update.title, 1048576)
    if (Object.hasOwn(update, "updatedAt") && update.updatedAt !== null) {
      const timestamp = boundedText(update.updatedAt, 64)
      if (new Date(timestamp).toISOString() !== timestamp) invalid()
    }
    if (Object.hasOwn(update, "_meta")) metadata(update._meta, 65536)
    return true
  }
  if (kind === "usage_update") {
    const names = Object.keys(update)
    if (names.length < 3 || names.length > 5 || names.some(key => !["sessionUpdate", "used", "size", "cost", "_meta"].includes(key))) invalid()
    if (!Number.isSafeInteger(update.used) || !Number.isSafeInteger(update.size) || Number(update.used) < 0 || Number(update.size) < 0 || Number(update.used) > Number(update.size)) invalid()
    if (Object.hasOwn(update, "cost") && update.cost !== null) {
      const cost = object(update.cost); knownKeys(cost, ["amount", "currency"], ["amount", "currency", "_meta"])
      if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0 || typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) invalid()
      if (Object.hasOwn(cost, "_meta")) metadata(cost._meta)
    }
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
    return true
  }
  return false
}
export function validatePromptResponse(value: Record<string, unknown>): StopReason {
  knownKeys(value, ["stopReason"], ["stopReason", "usage", "_meta"])
  if (!STOP_REASONS.includes(value.stopReason as StopReason)) invalid()
  if (Object.hasOwn(value, "usage") && value.usage !== null) {
    const usage = object(value.usage)
    knownKeys(usage, ["totalTokens", "inputTokens", "outputTokens"], ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens", "_meta"])
    for (const name of ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const) {
      const amount = usage[name]
      if (amount !== undefined && amount !== null && (!Number.isSafeInteger(amount) || Number(amount) < 0)) invalid()
    }
    if (Object.hasOwn(usage, "_meta")) metadata(usage._meta)
  }
  if (Object.hasOwn(value, "_meta")) metadata(value._meta, 65536)
  return value.stopReason as StopReason
}

export function validateSessionUpdate(value: unknown): ValidatedSessionUpdate {
  const update = object(value), kind = agentText(update.sessionUpdate)
  if (kind === "user_message_chunk" || kind === "agent_message_chunk") contentChunk(update)
  else if (kind === "current_mode_update") {
    knownKeys(update, ["sessionUpdate", "currentModeId"], ["sessionUpdate", "currentModeId", "_meta"])
    agentText(update.currentModeId)
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
  } else if (kind === "config_option_update") {
    knownKeys(update, ["sessionUpdate", "configOptions"], ["sessionUpdate", "configOptions", "_meta"])
    if (!Array.isArray(update.configOptions) || update.configOptions.length > 128) invalid()
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
  } else if (kind === "available_commands_update") {
    knownKeys(update, ["sessionUpdate", "availableCommands"], ["sessionUpdate", "availableCommands", "_meta"])
    if (!Array.isArray(update.availableCommands) || update.availableCommands.length > 128 || Buffer.byteLength(JSON.stringify(update.availableCommands)) > 65536) invalid()
    for (const raw of update.availableCommands) {
      const command = object(raw)
      knownKeys(command, ["name", "description"], ["name", "description", "input", "_meta"])
      agentText(command.name); boundedText(command.description, 4096)
      if (command.input !== undefined && command.input !== null) {
        const input = object(command.input); knownKeys(input, ["hint"], ["hint", "_meta"])
        boundedText(input.hint, 4096)
        if (Object.hasOwn(input, "_meta")) metadata(input._meta)
      }
      if (Object.hasOwn(command, "_meta")) metadata(command._meta)
    }
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
  } else if (!informational(update, kind)) invalid()
  return structuredClone(update) as ValidatedSessionUpdate
}