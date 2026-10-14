import { randomUUID } from "node:crypto"
import { hash, id, keys, object } from "../catalog/types.js"
import { BRIDGE_FRAME_BYTES } from "../bridge/protocol.js"
import type { AgentTuple, AgentErrorCode } from "../agent/types.js"
import { isRuntimeSessionRequest, isRuntimeSessionMutation, parseRuntimeSessionOperation, type RuntimeSessionRequest, type RuntimeSessionResult } from "../agent/session-controls.js"
import { isRuntimeHumanRequest } from "../agent/human-controls.js"
import { AGENT_PROTOCOL, parseAgentReply, validateAgentReply, parseAgentRequest, agentErrorReply, type AgentRequest, type AgentReply } from "../agent/protocol.js"
import { AgentError } from "../agent/types.js"
import type { HandlerBridge } from "../bridge/server.js"

export function registerRuntimeEndpoint(bridge: HandlerBridge, dispatch: (request: AgentRequest) => Promise<AgentReply>): () => void {
  return bridge.register(["runtime-read", "runtime-write"], async ({ channel, payload }) => {
    let request: AgentRequest | undefined
    try {
      request = parseAgentRequest(payload)
      const mutation = isRuntimeSessionRequest(request) ? isRuntimeSessionMutation(request) : request.op === "agent_permission_decide"
      if (!isRuntimeHumanRequest(request) && !isRuntimeSessionRequest(request) || mutation !== (channel === "runtime-write")) throw new AgentError("INVALID_PROTOCOL")
      return await dispatch(request)
    } catch (error) {
      if (request) return agentErrorReply(request, error)
      const requestId = (() => { try { return id(object(payload).requestId) } catch { return randomUUID() } })()
      return agentErrorReply({ requestId, handlerGeneration: null }, error)
    }
  })
}
export type HostIdentity = { hostId: string; handlerGeneration: string }
export type HostRuntimeClient = { session(hostId: string, operation: RuntimeSessionRequest, signal?: AbortSignal): Promise<RuntimeSessionResult>; identity(hostId: string, signal?: AbortSignal): Promise<HostIdentity>; human(hostId: string, operation: import("../agent/human-controls.js").RuntimeHumanRequest, signal?: AbortSignal): Promise<import("../agent/human-controls.js").RuntimeHumanResult> }
export class RuntimeOutcomeUnknown extends Error {
  readonly code = "OUTCOME_UNKNOWN"
  constructor(readonly reference: { hostId: string; commandId: string }, cause: unknown) { super("Outcome unknown; inspect the command on its owner before repeating the operation", { cause }) }
}
export type SessionMutationReference =
  | { kind: "command"; hostId: string; handlerGeneration: string; commandId: string }
  | { kind: "submission"; hostId: string; target: AgentTuple; submissionId: string }
export class SessionOwnerError extends AgentError {
  constructor(code: AgentErrorCode, readonly reference: SessionMutationReference | undefined) { super(code) }
}
export class SessionOutcomeUnknown extends Error {
  readonly code = "OUTCOME_UNKNOWN"
  constructor(readonly reference: SessionMutationReference, cause: unknown) { super("Outcome unknown; inspect the original command or submission on its owner", { cause }) }
}
export function sessionMutationReference(hostId: string, operation: RuntimeSessionRequest): SessionMutationReference | undefined {
  if (operation.op === "agent_session_start" || operation.op === "agent_stop") return { kind: "command", hostId, handlerGeneration: operation.input.handlerGeneration, commandId: operation.input.commandId }
  if (operation.op === "agent_session_submit" || operation.op === "agent_session_cancel") return { kind: "submission", hostId, target: operation.target, submissionId: operation.submissionId }
  return undefined
}
export function validateSessionOwner(result: RuntimeSessionResult, hostId: string): void {
  const command = result.state === "command" ? result.command : result.state === "session_command" ? result.receipt?.command : undefined
  if (command && command.hostId !== hostId || result.state === "session" && result.agent && result.agent.record.definition.hostId !== hostId) throw new AgentError("INVALID_PROTOCOL")
}
export function createHostRuntimeClient(input: { localHostId: string; route(route: import("./router.js").HostRoute, signal?: AbortSignal): Promise<unknown> }): HostRuntimeClient {
  const identity = async (hostId: string, signal?: AbortSignal): Promise<HostIdentity> => {
    const value = object(await input.route({ hostId, channel: "host-identity", payload: {} }, signal))
    keys(value, ["hostId", "handlerGeneration"])
    if (hash(value.hostId) !== hostId) throw new AgentError("INVALID_PROTOCOL")
    return { hostId, handlerGeneration: id(value.handlerGeneration) }
  }
  return { identity, async session(hostId, raw, signal) {
    hash(hostId)
    const operation = parseRuntimeSessionOperation(raw), reference = sessionMutationReference(hostId, operation)
    let owner: HostIdentity
    try {
      if (Buffer.byteLength(JSON.stringify(operation)) > BRIDGE_FRAME_BYTES - 4096) throw new AgentError("INPUT_TOO_LARGE")
      owner = await identity(hostId, signal)
      const expected = "input" in operation ? operation.input.handlerGeneration : "target" in operation ? operation.target.handlerGeneration : owner.handlerGeneration
      if (expected !== owner.handlerGeneration) throw new AgentError("STALE_HANDLER")
    } catch (error) { throw new SessionOwnerError(error instanceof AgentError ? error.code : "UNAVAILABLE", reference) }
    const request: AgentRequest = { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: owner.handlerGeneration, ...operation }
    let reply: AgentReply
    try {
      reply = parseAgentReply(await input.route({ hostId, channel: isRuntimeSessionMutation(operation) ? "runtime-write" : "runtime-read", payload: request }, signal))
      validateAgentReply(reply, request)
      if (reply.ok) validateSessionOwner(reply.result as RuntimeSessionResult, hostId)
    } catch (error) {
      if (reference) throw new SessionOutcomeUnknown(reference, error)
      throw error
    }
    if (!reply.ok) throw new SessionOwnerError(reply.error.code, reference)
    return reply.result as RuntimeSessionResult
  }, async human(hostId, operation, signal) {
    const owner = await identity(hostId, signal)
    if (operation.op === "agent_permission_decide" && (operation.ref.hostId !== hostId || operation.ref.target.handlerGeneration !== owner.handlerGeneration)) throw new AgentError("STALE_HANDLER")
    const request: AgentRequest = { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: owner.handlerGeneration, ...operation }
    let reply: AgentReply
    try {
      reply = parseAgentReply(await input.route({ hostId, channel: operation.op === "agent_permission_decide" ? "runtime-write" : "runtime-read", payload: request }, signal))
      validateAgentReply(reply, request)
      if (reply.ok && reply.result.state === "permissions" && reply.result.snapshot.hostId !== hostId) throw new AgentError("INVALID_PROTOCOL")
      if (reply.ok && reply.result.state === "page" && reply.result.agents.some(row => row.record.version !== 3 || row.record.definition.hostId !== hostId)) throw new AgentError("INVALID_PROTOCOL")
      if (reply.ok && reply.result.state === "permission" && reply.result.receipt && reply.result.receipt.ref.hostId !== hostId) throw new AgentError("INVALID_PROTOCOL")
    } catch (error) {
      if (operation.op === "agent_permission_decide") throw new RuntimeOutcomeUnknown({ hostId, commandId: operation.commandId }, error)
      throw error
    }
    if (!reply.ok) throw new AgentError(reply.error.code)
    return reply.result as import("../agent/human-controls.js").RuntimeHumanResult
  } }
}