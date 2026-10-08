import type { Socket } from "node:net"
import { id, keys, object, text } from "../catalog/types.js"
import { parseLaunchEnvironment } from "../agent/environment.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import { boundedText, fail, parseAgentRef, parseAssignmentSpec, type AgentRef, type AssignmentSpec } from "../orchestration/types.js"
import { parseStartRunInput, type StartRunInput } from "./service.js"
import type { Invocation } from "./host.js"

export const BUREAU_PROTOCOL = "agency-bureau-v1"
type Base = { protocol: typeof BUREAU_PROTOCOL; requestId: string; handlerGeneration: string }
export type BureauRequest = Base & (
  { op: "bureau_enable" | "bureau_disable" | "bureau_status" | "run_list" } |
  { op: "run_inspect"; runId: string; after?: string } |
  { op: "assignment_inspect"; assignmentId: string } |
  { op: "command_inspect"; commandId: string } |
  { op: "run_cancel" | "run_close" | "run_forget"; commandId: string; runId: string } |
  { op: "run_start"; commandId: string; input: StartRunInput; invocation: Invocation } |
  { op: "run_begin"; commandId: string; root: AgentRef; objective: string } |
  { op: "assignment_create"; commandId: string; runId: string; input: AssignmentSpec; invocation: Invocation } |
  { op: "assignment_retry"; commandId: string; assignmentId: string; mode: "restore" | "replace"; invocation: Invocation }
)
export type BureauReply = Base & ({ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } })
function parseInvocation(value: unknown): Invocation {
  const v = object(value); keys(v, ["environment", "nativeParams"])
  return { environment: parseLaunchEnvironment(v.environment), nativeParams: object(v.nativeParams) as Invocation["nativeParams"] }
}
export function parseBureauRequest(raw: unknown): BureauRequest {
  const v = object(raw), op = text(v.op), base: Base = { protocol: BUREAU_PROTOCOL, requestId: id(v.requestId), handlerGeneration: id(v.handlerGeneration) }
  if (v.protocol !== BUREAU_PROTOCOL) fail("INVALID_PROTOCOL")
  const exact = (...fields: string[]) => keys(v, ["protocol", "requestId", "handlerGeneration", "op", ...fields])
  switch (op) {
    case "bureau_enable": case "bureau_disable": case "bureau_status": case "run_list": exact(); return { ...base, op }
    case "run_inspect": exact("runId", ...(v.after === undefined ? [] : ["after"])); return { ...base, op, runId: id(v.runId), ...(v.after === undefined ? {} : { after: id(v.after) }) }
    case "command_inspect": exact("commandId"); return { ...base, op, commandId: id(v.commandId) }
    case "assignment_inspect": exact("assignmentId"); return { ...base, op, assignmentId: id(v.assignmentId) }
    case "run_cancel": case "run_close": case "run_forget": exact("commandId", "runId"); return { ...base, op, commandId: id(v.commandId), runId: id(v.runId) }
    case "run_start": exact("commandId", "input", "invocation"); return { ...base, op, commandId: id(v.commandId), input: parseStartRunInput(v.input), invocation: parseInvocation(v.invocation) }
    case "run_begin": exact("commandId", "root", "objective"); return { ...base, op, commandId: id(v.commandId), root: parseAgentRef(v.root), objective: boundedText(v.objective, 65536, false) }
    case "assignment_create": exact("commandId", "runId", "input", "invocation"); return { ...base, op, commandId: id(v.commandId), runId: id(v.runId), input: parseAssignmentSpec(v.input), invocation: parseInvocation(v.invocation) }
    case "assignment_retry": {
      exact("commandId", "assignmentId", "mode", "invocation")
      if (v.mode !== "restore" && v.mode !== "replace") fail("INVALID_PROTOCOL")
      return { ...base, op, commandId: id(v.commandId), assignmentId: id(v.assignmentId), mode: v.mode, invocation: parseInvocation(v.invocation) }
    }
    default: return fail("INVALID_PROTOCOL")
  }
}
export function parseBureauReply(raw: unknown): BureauReply {
  const v = object(raw); keys(v, ["protocol", "requestId", "handlerGeneration", "ok", v.ok === true ? "result" : "error"])
  const base: Base = { protocol: BUREAU_PROTOCOL, requestId: id(v.requestId), handlerGeneration: id(v.handlerGeneration) }
  if (v.protocol !== BUREAU_PROTOCOL || typeof v.ok !== "boolean") fail("INVALID_PROTOCOL")
  if (v.ok) return { ...base, ok: true, result: v.result }
  const error = object(v.error); keys(error, ["code", "message"])
  return { ...base, ok: false, error: { code: text(error.code), message: boundedText(error.message, 2048) } }
}
export async function exchangeBureau(socket: Socket, request: BureauRequest, timeoutMs = 5000): Promise<BureauReply> {
  try {
    const frame = encodeFrame(parseBureauRequest(request))
    const receiving = receiveFrame(socket, timeoutMs)
    socket.end(frame)
    const reply = parseBureauReply(await receiving)
    if (reply.requestId !== request.requestId || reply.handlerGeneration !== request.handlerGeneration) fail("STALE_HANDLER")
    return reply
  } finally { socket.destroy() }
}