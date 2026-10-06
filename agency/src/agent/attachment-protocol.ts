import { object } from "../catalog/types.js"
import { id } from "../catalog/types.js"
import type { ConversationMetadata, ConversationSnapshot, RetainedEvent } from "./conversation.js"
import { EDITOR_TURN_LIMITS, boundedText, knownKeys, validateNativeUpdate, validateStructuredContent, validateTurnInput, type StopReason } from "./session-events.js"
import { validateMetadata } from "./session-config.js"
import { AgentError, parseAgentFailure, parseSelection, parseSession, parseNativeIdentity, parseTuple, type AgentFailure, type AgentTuple, type StartSelection } from "./types.js"
import type { SubmissionReceipt } from "./turns.js"

export const ATTACHMENT_PROTOCOL = "agency-attachment/1"
export const ATTACHMENT_FRAME_BYTES = 2097152
export const ATTACHMENT_QUEUE_BYTES = 4194304
export const ATTACHMENT_LIMITS = Object.freeze({ ...EDITOR_TURN_LIMITS, historyBytes: 16777216, historyEvents: 8192, metadataBytes: 65536 })
type Base = { protocol: typeof ATTACHMENT_PROTOCOL; target: AgentTuple }
export type AttachmentRequest = Base & { requestId: string } & ({ op: "attach" } | { op: "submit"; submissionId: string; text: string } | { op: "cancel" | "inspect-submission"; submissionId: string })
export type AttachmentFrame = Base & (
  | { type: "snapshot_begin"; snapshotId: string; sessionId: string; cwd: string; selection: StartSelection | null; metadata: ConversationMetadata; firstSeq: number; lastSeq: number; historyTruncated: boolean; currentTurn: ConversationSnapshot["currentTurn"]; limits: typeof ATTACHMENT_LIMITS }
  | { type: "snapshot_events"; snapshotId: string; chunkIndex: number; events: RetainedEvent[] }
  | { type: "snapshot_end"; snapshotId: string; firstSeq: number; lastSeq: number; chunkCount: number; historyTruncated: boolean }
  | { type: "event"; event: RetainedEvent; firstSeq: number; historyTruncated: boolean }
  | { type: "response"; requestId: string; ok: true; receipt: SubmissionReceipt | null }
  | { type: "response"; requestId: string; ok: false; error: AgentFailure })
  | { protocol: typeof ATTACHMENT_PROTOCOL; target: AgentTuple | null; type: "fault"; error: AgentFailure }

function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid()
  return Number(value)
}
const boolean = (value: unknown): void => { if (typeof value !== "boolean") invalid() }
const reason = (value: unknown): StopReason => { if (typeof value !== "string" || !["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(value)) invalid(); return value as StopReason }
const state = (value: unknown): void => { if (typeof value !== "string" || !["accepted", "running", "completed", "failed"].includes(value)) invalid() }
const phase = (value: unknown): void => { if (typeof value !== "string" || !["starting", "ready", "recoverable", "restoring", "stopping", "stopped", "failed", "interrupted"].includes(value)) invalid() }
function exact(value: Record<string, unknown>, fields: readonly string[]): void { knownKeys(value, fields, fields) }
function text(value: unknown, max: number, allowEmpty = false): string {
  const result = boundedText(value, max)
  if (!allowEmpty && !result.length) invalid()
  return result
}
function target(value: Record<string, unknown>): void {
  if (value.protocol !== ATTACHMENT_PROTOCOL) invalid()
  parseTuple(value.target)
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > ATTACHMENT_FRAME_BYTES) invalid()
}
function boundary(value: Record<string, unknown>): void {
  integer(value.firstSeq, 1); integer(value.lastSeq)
  if (Number(value.firstSeq) > Number(value.lastSeq) + 1) invalid()
  boolean(value.historyTruncated)
  if (value.historyTruncated === false && value.firstSeq !== 1) invalid()
}
function currentTurn(value: unknown): void {
  if (value === null) return
  const turn = object(value); exact(turn, ["submissionId", "state"]); id(turn.submissionId); state(turn.state)
}
function session(value: unknown): void {
  if (Object.hasOwn(object(value), "sessionGeneration")) parseSession(value)
  else parseNativeIdentity(value)
}
function metadata(value: unknown): void {
  const item = object(value)
  exact(item, ["phase", "session", "selection", "cwd", "failure", "title", "plan", "planTruncated", "usage"])
  if (Buffer.byteLength(JSON.stringify(item)) > 65536) invalid()
  phase(item.phase)
  if (item.session !== null) session(item.session)
  if (item.selection !== null) parseSelection(item.selection)
  text(item.cwd, 4096, true)
  if (item.failure !== null) parseAgentFailure(item.failure)
  if (item.title !== null) {
    const title = object(item.title); exact(title, ["title", "titleTruncated", "titleOriginalBytes"])
    text(title.title, 1024, true); boolean(title.titleTruncated); integer(title.titleOriginalBytes, Buffer.byteLength(String(title.title)), 1048576)
    if (title.titleTruncated !== (Number(title.titleOriginalBytes) > Buffer.byteLength(String(title.title)))) invalid()
  }
  boolean(item.planTruncated)
  validateNativeUpdate({ sessionUpdate: "plan", entries: item.plan })
  if (item.usage !== null) validateNativeUpdate({ sessionUpdate: "usage_update", ...object(item.usage) })
}
export function parseSubmissionReceipt(value: unknown): SubmissionReceipt {
  const receipt = object(value)
  exact(receipt, ["submissionId", "digest", "state", "stopReason", "failure", "acceptedSeq", "completedSeq"])
  id(receipt.submissionId); state(receipt.state); integer(receipt.acceptedSeq, 1)
  if (typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)) invalid()
  if (receipt.completedSeq !== null) integer(receipt.completedSeq, Number(receipt.acceptedSeq) + 1)
  if (receipt.stopReason !== null) reason(receipt.stopReason)
  if (receipt.failure !== null) parseAgentFailure(receipt.failure)
  if (receipt.state === "completed" ? receipt.stopReason === null || receipt.failure !== null || receipt.completedSeq === null : receipt.state === "failed" ? receipt.failure === null || receipt.stopReason !== null || receipt.completedSeq === null : receipt.failure !== null || receipt.stopReason !== null || receipt.completedSeq !== null) invalid()
  return structuredClone(receipt) as SubmissionReceipt
}
export function parseRetainedEvent(value: unknown): RetainedEvent {
  const event = object(value), common = ["kind", "seq", "encodedBytes"]
  integer(event.seq, 1); integer(event.encodedBytes, 1, ATTACHMENT_FRAME_BYTES)
  if (event.kind === "submitted") {
    knownKeys(event, [...common, "submissionId", "text"], [...common, "submissionId", "text", "prompt", "meta", "originConnectionId"]); id(event.submissionId); text(event.text, 262144, true)
    if (event.prompt !== undefined) {
      if (!Array.isArray(event.prompt) || !event.prompt.length) invalid()
      event.prompt.forEach(validateStructuredContent)
    } else validateTurnInput(event.text as string, EDITOR_TURN_LIMITS)
    if (event.meta !== undefined) validateMetadata({ _meta: event.meta })
    if (event.originConnectionId !== undefined) id(event.originConnectionId)
  } else if (event.kind === "update") {
    knownKeys(event, [...common, "update", "replay"], [...common, "update", "replay", "params", "meta"]); boolean(event.replay); validateNativeUpdate(event.update)
    if (event.params !== undefined) validateMetadata(object(event.params))
    if (event.meta !== undefined) object(event.meta)
  } else if (event.kind === "turn") {
    exact(event, [...common, "submissionId", "state", "stopReason", "failure"]); id(event.submissionId); state(event.state)
    if (event.stopReason !== null) reason(event.stopReason)
    if (event.failure !== null) parseAgentFailure(event.failure)
    if (event.state === "completed" ? event.stopReason === null || event.failure !== null : event.state === "failed" ? event.failure === null || event.stopReason !== null : event.failure !== null || event.stopReason !== null) invalid()
  } else if (event.kind === "lifecycle") {
    knownKeys(event, [...common, "phase"], [...common, "phase", "session", "selection", "cwd", "failure"]); phase(event.phase)
    if (event.session !== undefined && event.session !== null) session(event.session)
    if (event.selection !== undefined) parseSelection(event.selection)
    if (event.cwd !== undefined) text(event.cwd, 4096)
    if (event.failure !== undefined && event.failure !== null) parseAgentFailure(event.failure)
  } else invalid()
  return structuredClone(event) as RetainedEvent
}
export function parseAttachmentRequest(value: unknown): AttachmentRequest {
  try {
    const request = object(value), base = ["protocol", "target", "requestId", "op"]
    target(request); id(request.requestId)
    if (request.op === "attach") exact(request, base)
    else if (request.op === "submit") { exact(request, [...base, "submissionId", "text"]); id(request.submissionId); validateTurnInput(request.text as string, EDITOR_TURN_LIMITS) }
    else if (request.op === "cancel" || request.op === "inspect-submission") { exact(request, [...base, "submissionId"]); id(request.submissionId) }
    else invalid()
    return structuredClone(request) as AttachmentRequest
  } catch (error) { if (error instanceof AgentError && error.code === "INPUT_TOO_LARGE") throw error; invalid() }
}
export function parseAttachmentFrame(value: unknown): AttachmentFrame {
  try {
    const frame = object(value), base = ["protocol", "target", "type"]
    if (frame.type === "fault" && frame.target === null) { if (frame.protocol !== ATTACHMENT_PROTOCOL) invalid() }
    else target(frame)
    if (frame.type === "snapshot_begin") {
      exact(frame, [...base, "snapshotId", "sessionId", "cwd", "selection", "metadata", "firstSeq", "lastSeq", "historyTruncated", "currentTurn", "limits"])
      id(frame.snapshotId); text(frame.sessionId, 1024); text(frame.cwd, 4096); if (frame.selection !== null) parseSelection(frame.selection); metadata(frame.metadata); boundary(frame); currentTurn(frame.currentTurn)
      const limits = object(frame.limits); exact(limits, Object.keys(ATTACHMENT_LIMITS))
      if (Object.entries(ATTACHMENT_LIMITS).some(([key, value]) => limits[key] !== value)) invalid()
      const info = object(frame.metadata)
      if (info.phase !== "ready" || object(info.session).sessionId !== frame.sessionId || info.cwd !== frame.cwd || JSON.stringify(info.selection) !== JSON.stringify(frame.selection)) invalid()
    } else if (frame.type === "snapshot_events") {
      exact(frame, [...base, "snapshotId", "chunkIndex", "events"]); id(frame.snapshotId); integer(frame.chunkIndex, 0, 8191)
      if (!Array.isArray(frame.events) || !frame.events.length || frame.events.length > 8192) invalid()
      frame.events.forEach(parseRetainedEvent)
    } else if (frame.type === "snapshot_end") {
      exact(frame, [...base, "snapshotId", "firstSeq", "lastSeq", "chunkCount", "historyTruncated"]); id(frame.snapshotId); boundary(frame); integer(frame.chunkCount, 0, 8192)
    } else if (frame.type === "event") {
      exact(frame, [...base, "event", "firstSeq", "historyTruncated"])
      const event = parseRetainedEvent(frame.event)
      integer(frame.firstSeq, 1, event.seq + 1); boolean(frame.historyTruncated)
      if (frame.historyTruncated === false && frame.firstSeq !== 1) invalid()
    } else if (frame.type === "response") {
      if (frame.ok === true) { exact(frame, [...base, "requestId", "ok", "receipt"]); if (frame.receipt !== null) parseSubmissionReceipt(frame.receipt) }
      else if (frame.ok === false) { exact(frame, [...base, "requestId", "ok", "error"]); parseAgentFailure(frame.error) }
      else invalid()
      id(frame.requestId)
    } else if (frame.type === "fault") { exact(frame, [...base, "error"]); parseAgentFailure(frame.error) }
    else invalid()
    return structuredClone(frame) as AttachmentFrame
  } catch { invalid() }
}

export function createNdjsonDecoder(onFrame: (value: unknown, wireBytes: number) => void, onFault: (error: AgentError) => void): { feed(bytes: Buffer): void; end(): void } {
  let parts: Buffer[] = [], size = 0, closed = false
  const fail = (): void => { if (closed) return; closed = true; parts = []; size = 0; onFault(new AgentError("INVALID_PROTOCOL")) }
  return {
    feed(bytes) {
      if (closed) return
      let start = 0
      while (start < bytes.length && !closed) {
        const lf = bytes.indexOf(10, start), end = lf === -1 ? bytes.length : lf
        const part = bytes.subarray(start, end)
        if (size + part.length + 1 > ATTACHMENT_FRAME_BYTES) { fail(); return }
        if (part.length) { parts.push(Buffer.from(part)); size += part.length }
        if (lf === -1) return
        let value: unknown
        try { if (!size) throw new Error(); value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size))) } catch { fail(); return }
        const wireBytes = size + 1
        parts = []; size = 0; start = lf + 1
        onFrame(value, wireBytes)
      }
    },
    end() { if (closed) return; if (size) fail(); else closed = true },
  }
}