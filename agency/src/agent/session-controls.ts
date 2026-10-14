import { absolutePath, id, keys, object, providerId, type ProviderId } from "../catalog/types.js"
import { AgentError, parseStopInput, parseTuple, type AgentTuple, type AgentView, type CommandView, type StopInput } from "./types.js"
import { canonicalJson, parseRequestedSettings, type JsonObject, type RequestedSettings } from "./session-config.js"
import { EDITOR_TURN_LIMITS, validateTurnInput } from "./session-events.js"
import { sessionInputs, type AgentService } from "./service.js"
import type { LaunchEnvironment } from "./environment.js"
import type { SubmissionReceipt } from "./turns.js"

export type SessionStartInput = { commandId: string; handlerGeneration: string; cwd: string; backendId: ProviderId; settings?: RequestedSettings; nativeParams?: JsonObject }
export type RuntimeSessionRequest =
  | { op: "agent_session_start"; input: SessionStartInput }
  | { op: "agent_session_inspect"; agentId: string }
  | { op: "agent_session_command"; commandId: string; commandGeneration: string }
  | { op: "agent_session_submit"; target: AgentTuple; submissionId: string; text: string }
  | { op: "agent_session_submission" | "agent_session_cancel"; target: AgentTuple; submissionId: string }
  | { op: "agent_stop"; input: StopInput }
export type RuntimeSessionResult = CommandView
  | { state: "session"; agentId: string; agent: AgentView | null }
  | { state: "session_command"; commandId: string; commandGeneration: string; receipt: CommandView | null }
  | { state: "submission"; target: AgentTuple; submissionId: string; receipt: SubmissionReceipt | null }

export function isRuntimeSessionRequest(request: { op: string }): request is RuntimeSessionRequest {
  return ["agent_session_start", "agent_session_inspect", "agent_session_command", "agent_session_submit", "agent_session_submission", "agent_session_cancel", "agent_stop"].includes(request.op)
}
export function isRuntimeSessionMutation(request: RuntimeSessionRequest): boolean {
  return ["agent_session_start", "agent_session_submit", "agent_session_cancel", "agent_stop"].includes(request.op)
}
export function parseRuntimeSessionOperation(raw: unknown): RuntimeSessionRequest {
  try {
    const v = object(raw)
    if (v.op === "agent_session_start") {
      keys(v, ["op", "input"])
      const value = object(v.input)
      keys(value, ["commandId", "handlerGeneration", "cwd", "backendId", ...(Object.hasOwn(value, "settings") ? ["settings"] : []), ...(Object.hasOwn(value, "nativeParams") ? ["nativeParams"] : [])])
      const cwd = absolutePath(value.cwd)
      const nativeParams = Object.hasOwn(value, "nativeParams") ? JSON.parse(canonicalJson(object(value.nativeParams))) as JsonObject : undefined
      sessionInputs(cwd, nativeParams)
      return { op: v.op, input: { commandId: id(value.commandId), handlerGeneration: id(value.handlerGeneration), cwd, backendId: providerId(value.backendId), ...(Object.hasOwn(value, "settings") ? { settings: parseRequestedSettings(value.settings) } : {}), ...(nativeParams ? { nativeParams } : {}) } }
    }
    if (v.op === "agent_stop") { keys(v, ["op", "input"]); return { op: v.op, input: parseStopInput(v.input) } }
    if (v.op === "agent_session_inspect") { keys(v, ["op", "agentId"]); return { op: v.op, agentId: id(v.agentId) } }
    if (v.op === "agent_session_command") { keys(v, ["op", "commandId", "commandGeneration"]); return { op: v.op, commandId: id(v.commandId), commandGeneration: id(v.commandGeneration) } }
    if (v.op === "agent_session_submit" || v.op === "agent_session_submission" || v.op === "agent_session_cancel") {
      keys(v, ["op", "target", "submissionId", ...(v.op === "agent_session_submit" ? ["text"] : [])])
      const target = parseTuple(v.target), submissionId = id(v.submissionId)
      if (v.op === "agent_session_submit") { validateTurnInput(v.text as string, EDITOR_TURN_LIMITS); return { op: v.op, target, submissionId, text: v.text as string } }
      return { op: v.op, target, submissionId }
    }
    throw new AgentError("INVALID_PROTOCOL")
  } catch (error) { if (error instanceof AgentError && error.code === "INPUT_TOO_LARGE") throw error; throw new AgentError("INVALID_PROTOCOL") }
}
export async function dispatchRuntimeSession(agents: AgentService, request: RuntimeSessionRequest, environment: () => LaunchEnvironment): Promise<RuntimeSessionResult> {
  switch (request.op) {
    case "agent_session_start": { const v = request.input; return agents.beginSession({ commandId: v.commandId, cwd: v.cwd, backendId: v.backendId, selection: v.settings ?? {}, nativeParams: v.nativeParams ?? {}, environment: environment() }) }
    case "agent_session_inspect": return { state: "session", agentId: request.agentId, agent: await agents.sessionRecord(request.agentId) }
    case "agent_session_command": return { state: "session_command", commandId: request.commandId, commandGeneration: request.commandGeneration, receipt: await agents.commandReceipt(request.commandId, request.commandGeneration) }
    case "agent_session_submit": return { state: "submission", target: request.target, submissionId: request.submissionId, receipt: await agents.submit(request.target, { submissionId: request.submissionId, text: request.text, limits: EDITOR_TURN_LIMITS }) }
    case "agent_session_submission": return { state: "submission", target: request.target, submissionId: request.submissionId, receipt: await agents.submission(request.target, request.submissionId) }
    case "agent_session_cancel": return { state: "submission", target: request.target, submissionId: request.submissionId, receipt: await agents.cancel(request.target, request.submissionId) }
    case "agent_stop": return agents.stop(request.input)
  }
}