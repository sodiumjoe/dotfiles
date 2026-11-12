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

export function validateNativeUpdate(raw: unknown, inspectToolContent = true): ValidatedSessionUpdate {
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
    if (inspectToolContent && update.content != null) {
      if (!Array.isArray(update.content)) invalid()
      for (const raw of update.content) {
        const item = object(raw); validateMetadata(item)
        if (item.type === "content") validateStructuredContent(item.content)
        else if (item.type === "diff") { if (typeof item.path !== "string" || typeof item.newText !== "string" || item.oldText != null && typeof item.oldText !== "string") invalid() }
        else if (item.type === "terminal") agentText(item.terminalId, 1024)
        else invalid()
      }
    }
    if (inspectToolContent && update.locations != null) {
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