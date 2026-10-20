import { randomUUID } from "node:crypto"
import { hash, id, keys, object } from "../catalog/types.js"
import { AgentError } from "../agent/types.js"
import { parseRuntimeSessionOperation, type RuntimeSessionRequest, type RuntimeSessionResult } from "../agent/session-controls.js"
import type { ControlDependencies } from "../cli/control.js"
import { hostArguments, openHostAccess } from "./cli.js"
import { HOST_PROTOCOL, type HostReply } from "./protocol.js"
import { createHostRuntimeClient, sessionMutationReference, SessionOutcomeUnknown, SessionOwnerError, type SessionMutationReference } from "./runtime.js"

function observationExit(operation: RuntimeSessionRequest, result: RuntimeSessionResult): number {
  if (operation.op === "agent_session_inspect") return result.state === "session" && result.agent ? 0 : 69
  if (operation.op === "agent_session_command") {
    if (result.state !== "session_command" || !result.receipt) return 69
    const command = result.receipt.command
    return command.state === "completed" && ["started", "stopped"].includes(command.result?.outcome ?? "") ? 0 : 75
  }
  if (operation.op === "agent_session_submission") {
    if (result.state !== "submission" || !result.receipt) return 69
    return result.receipt.state === "completed" ? 0 : 75
  }
  return 0
}
export async function runSessionClient(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const requestId = randomUUID()
  let executing = false, hostId: string | null = null, generation: string | null = null, commandId: string | undefined, reference: SessionMutationReference | undefined, close: (() => void) | undefined
  const emit = (value: { ok: true; result: RuntimeSessionResult } | { ok: false; error: Extract<HostReply, { ok: false }>["error"] }) => deps.stdout(JSON.stringify({ protocol: HOST_PROTOCOL, requestId, hostId, handlerGeneration: generation, ...(commandId ? { commandId } : {}), ...value }) + "\n")
  try {
    const args = hostArguments(argv), [group, action, argument] = args.positional, flags = args.flags
    if (group !== "session" || !args.local && !flags.has("--host") || [...flags.keys()].some(flag => !["--host", "--input-json"].includes(flag))) throw new AgentError("USAGE")
    const selected = flags.has("--host") ? hash(flags.get("--host")) : undefined
    let raw: object
    if (action === "inspect") {
      if (args.positional.length !== 3 || flags.has("--input-json")) throw new AgentError("USAGE")
      raw = { op: "agent_session_inspect", agentId: id(argument) }
    } else if (action === "command") {
      if (args.positional.length !== 3) throw new AgentError("USAGE")
      const input = object(JSON.parse(flags.get("--input-json") ?? "null")); keys(input, ["commandGeneration"])
      raw = { op: "agent_session_command", commandId: id(argument), commandGeneration: id(input.commandGeneration) }
    } else {
      if (args.positional.length !== 2 || !["start", "submit", "submission", "cancel", "stop"].includes(action ?? "")) throw new AgentError("USAGE")
      const input = object(JSON.parse(flags.get("--input-json") ?? "null"))
      raw = action === "start" || action === "stop" ? { op: action === "start" ? "agent_session_start" : "agent_stop", input } : { ...input, op: "agent_session_" + action }
      if (Object.hasOwn(input, "op")) throw new AgentError("USAGE")
    }
    const operation = parseRuntimeSessionOperation(raw)
    commandId = "input" in operation ? operation.input.commandId : operation.op === "agent_session_command" ? operation.commandId : undefined
    hostId = selected ?? null
    if (hostId) reference = sessionMutationReference(hostId, operation)
    executing = true
    const access = await openHostAccess(deps)
    close = access.close
    hostId ??= access.env.paths.hostKey
    reference = sessionMutationReference(hostId, operation)
    const client = createHostRuntimeClient({ localHostId: access.env.paths.hostKey, async route(route, signal) {
      const result = await access.route(route, signal)
      if (route.channel === "host-identity") generation = id(object(result).handlerGeneration)
      return result
    } })
    const result = await client.session(hostId, operation)
    emit({ ok: true, result })
    return observationExit(operation, result)
  } catch (error) {
    const code = error instanceof SessionOutcomeUnknown ? error.code : error instanceof AgentError ? error.code : executing ? "UNAVAILABLE" : "USAGE"
    const original = error instanceof SessionOutcomeUnknown || error instanceof SessionOwnerError ? error.reference ?? reference : reference
    emit({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...(original ? { reference: original } : {}) } })
    if (["USAGE", "INVALID_PROTOCOL", "INPUT_TOO_LARGE"].includes(code)) return 64
    return ["OUTCOME_UNKNOWN", "BUSY", "COMMAND_CONFLICT", "INCOMPLETE"].includes(code) ? 75 : 69
  } finally { close?.() }
}