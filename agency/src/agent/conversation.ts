import { cloneWireJson, wireJsonBytes } from "../acp/wire-json.js"
import { displayTitle, type AcpObservation } from "./session-events.js"
import { AgentError, type AgentFailure, type AgentPhase, type AgentTuple, type NativeSessionIdentity, type SessionEvidence, type StartSelection, type JsonObject } from "./types.js"

export type TurnState = "accepted" | "running" | "completed" | "failed"
export type ConversationEvent =
  | { kind: "submitted"; submissionId: string; text: string; prompt?: JsonObject[]; meta?: JsonObject; originConnectionId?: string }
  | ({ kind: "update" } & AcpObservation)
  | { kind: "turn"; submissionId: string; state: TurnState; stopReason: import("./session-events.js").StopReason | null; failure: AgentFailure | null }
  | { kind: "lifecycle"; phase: AgentPhase; session?: SessionEvidence | NativeSessionIdentity | null; selection?: StartSelection; cwd?: string; failure?: AgentFailure | null }
export type RetainedEvent = ConversationEvent & { seq: number; encodedBytes: number }
export type ConversationMetadata = { phase: AgentPhase; session: SessionEvidence | NativeSessionIdentity | null; selection: StartSelection | null; cwd: string; failure: AgentFailure | null; title: ReturnType<typeof displayTitle> | null; plan: unknown[]; planTruncated: boolean; usage: { used: number; size: number; cost?: unknown } | null }
export type ConversationSnapshot = { target: AgentTuple; metadata: ConversationMetadata; firstSeq: number; lastSeq: number; historyTruncated: boolean; events: RetainedEvent[]; currentTurn: { submissionId: string; state: TurnState } | null }
export type ConversationNotification = { kind: "event"; event: RetainedEvent; firstSeq: number; historyTruncated: boolean } | { kind: "closed" }
export type ConversationListener = (notification: ConversationNotification) => void
export type ConversationObservation = { snapshot: ConversationSnapshot; close(): void }
export type ConversationDisplay = { title: string | null; activity: "working" | "idle" }
export type Conversation = { display(): ConversationDisplay; append(event: ConversationEvent): number; observe(listener: ConversationListener): ConversationObservation; close(): void }

export function createConversation(target: AgentTuple, limits: { bytes?: number; events?: number } = {}): Conversation {
  const maxBytes = limits.bytes ?? 16777216, maxEvents = limits.events ?? 8192, tuple = cloneWireJson(target)
  if (![maxBytes, maxEvents].every(value => Number.isSafeInteger(value) && value > 0)) throw new AgentError("INVALID_AGENT_STATE")
  const listeners = new Set<ConversationListener>(), events: RetainedEvent[] = []
  const metadata: ConversationMetadata = { phase: "starting", session: null, selection: null, cwd: "", failure: null, title: null, plan: [], planTruncated: false, usage: null }
  let bytes = 0, lastSeq = 0, historyTruncated = false, closed = false, currentTurn: ConversationSnapshot["currentTurn"] = null
  const firstSeq = (): number => events[0]?.seq ?? lastSeq + 1
  const notify = (value: ConversationNotification): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try { listener(cloneWireJson(value)) } catch {}
    }
  }
  const plainTitle = (raw: string): string => raw.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()
  const fallbackTitle = (raw: string): void => {
    if (metadata.title) return
    const title = plainTitle(raw)
    if (title) metadata.title = displayTitle(title)
  }
  return {
    display() { return { title: plainTitle(metadata.title?.title ?? "") || null, activity: currentTurn && ["accepted", "running"].includes(currentTurn.state) ? "working" : "idle" } },
    append(value) {
      if (closed) throw new AgentError("NOT_READY")
      if (lastSeq >= Number.MAX_SAFE_INTEGER - 1) throw new AgentError("INVALID_AGENT_STATE")
      const raw = { ...cloneWireJson(value), seq: lastSeq + 1 }
      const event = { ...raw, encodedBytes: wireJsonBytes(raw) }
      if (value.kind === "lifecycle") {
        metadata.phase = value.phase
        if (Object.hasOwn(value, "session")) metadata.session = cloneWireJson(value.session ?? null)
        if (value.selection) metadata.selection = cloneWireJson(value.selection)
        if (value.cwd !== undefined) metadata.cwd = value.cwd
        metadata.failure = cloneWireJson(value.failure ?? null)
      } else if (value.kind === "submitted") {
        fallbackTitle(value.text)
        currentTurn = { submissionId: value.submissionId, state: "accepted" }
      } else if (value.kind === "turn") currentTurn = { submissionId: value.submissionId, state: value.state }
      else if (value.kind === "update") {
        const update = value.update
        if (update.sessionUpdate === "session_info_update" && typeof update.title === "string" && update.title.trim()) metadata.title = displayTitle(update.title)
        if (update.sessionUpdate === "user_message_chunk") {
          const content = update.content as JsonObject | undefined
          if (content?.type === "text" && typeof content.text === "string") fallbackTitle(content.text)
        }
        if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
          metadata.plan = []
          for (const entry of update.entries) {
            const next = [...metadata.plan, entry]
            if (Buffer.byteLength(JSON.stringify(next)) > 16384) break
            metadata.plan.push(cloneWireJson(entry))
          }
          metadata.planTruncated = metadata.plan.length < update.entries.length
        }
        if (update.sessionUpdate === "usage_update") {
          const cost = update.cost as JsonObject | null | undefined
          metadata.usage = { used: Number(update.used), size: Number(update.size), ...(cost ? { cost: { amount: cost.amount, currency: displayTitle(String(cost.currency)).title } } : {}) }
        }
      }
      if (Buffer.byteLength(JSON.stringify(metadata)) > 65536) throw new AgentError("INVALID_PROTOCOL")
      lastSeq = event.seq; events.push(event); bytes += wireJsonBytes(event)
      while (events.length > maxEvents || bytes > maxBytes) {
        bytes -= wireJsonBytes(events.shift()!); historyTruncated = true
      }
      notify({ kind: "event", event, firstSeq: firstSeq(), historyTruncated })
      return lastSeq
    },
    observe(listener) {
      if (closed) throw new AgentError("NOT_READY")
      const snapshot = cloneWireJson({ target: tuple, metadata, firstSeq: firstSeq(), lastSeq, historyTruncated, events, currentTurn })
      listeners.add(listener)
      return { snapshot, close() { listeners.delete(listener) } }
    },
    close() {
      if (closed) return
      closed = true; notify({ kind: "closed" }); listeners.clear(); events.length = 0; bytes = 0
      metadata.plan = []; metadata.usage = null; metadata.title = null; metadata.session = null; metadata.selection = null; currentTurn = null
    },
  }
}