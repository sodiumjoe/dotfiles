import { randomUUID } from "node:crypto"
import { id, object } from "../catalog/types.js"
import { isRuntimeHumanRequest } from "../agent/human-controls.js"
import { parseAgentRequest, agentErrorReply, type AgentRequest, type AgentReply } from "../agent/protocol.js"
import { AgentError } from "../agent/types.js"
import type { HandlerBridge } from "../bridge/server.js"

export function registerRuntimeEndpoint(bridge: HandlerBridge, dispatch: (request: AgentRequest) => Promise<AgentReply>): () => void {
  return bridge.register(["runtime-read", "runtime-write"], async ({ channel, payload }) => {
    let request: AgentRequest | undefined
    try {
      request = parseAgentRequest(payload)
      if (!isRuntimeHumanRequest(request) || (request.op === "agent_permission_decide") !== (channel === "runtime-write")) throw new AgentError("INVALID_PROTOCOL")
      return await dispatch(request)
    } catch (error) {
      if (request) return agentErrorReply(request, error)
      const requestId = (() => { try { return id(object(payload).requestId) } catch { return randomUUID() } })()
      return agentErrorReply({ requestId, handlerGeneration: null }, error)
    }
  })
}