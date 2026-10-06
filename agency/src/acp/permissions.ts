import { randomUUID } from "node:crypto"
import type { JsonObject } from "../agent/session-config.js"
import { AgentError, type AgentTuple } from "../agent/types.js"

export type PermissionClient = { connectionId: string; send(frame: JsonObject): void }
export type PermissionBroker = {
  open(target: AgentTuple, providerId: string | number, params: JsonObject): string
  attach(target: AgentTuple, client: PermissionClient): void
  decision(connectionId: string, requestId: string | number, result: JsonObject): Promise<boolean>
  detach(connectionId: string, target?: AgentTuple): void
  invalidate(target: AgentTuple): void
}
type Request = { key: string; target: AgentTuple; providerId: string | number; params: JsonObject; options: Set<string>; offers: Map<string, string> }
const tupleKey = (target: AgentTuple): string => JSON.stringify([target.agentId, target.handlerGeneration, target.providerGeneration])

export function createPermissionBroker(input: { respond(target: AgentTuple, id: string | number, result: JsonObject): void }): PermissionBroker {
  const requests = new Map<string, Request>(), clients = new Map<string, { client: PermissionClient; targets: Set<string>; offers: Map<string, Request> }>()
  const send = (client: PermissionClient, frame: JsonObject): void => { try { client.send(frame) } catch { detach(client.connectionId) } }
  function offer(request: Request, connectionId: string): void {
    const attached = clients.get(connectionId)
    if (!attached?.targets.has(tupleKey(request.target)) || request.offers.has(connectionId)) return
    const id = "agency-permission:" + randomUUID()
    request.offers.set(connectionId, id); attached.offers.set(id, request)
    const meta = request.params._meta as JsonObject | undefined
    send(attached.client, { jsonrpc: "2.0", id, method: "session/request_permission", params: { ...structuredClone(request.params), sessionId: "agency:" + request.target.agentId, _meta: { ...meta, agency: { version: 1, binding: { ...request.target }, requestId: id } } } })
  }
  function remove(request: Request, winner?: string): void {
    requests.delete(request.key)
    const offers = [...request.offers]
    request.offers.clear()
    for (const [connectionId, id] of offers) {
      const attached = clients.get(connectionId)
      attached?.offers.delete(id)
      if (attached && connectionId !== winner) send(attached.client, { jsonrpc: "2.0", method: "agency/permission_withdrawn", params: { sessionId: "agency:" + request.target.agentId, binding: { ...request.target }, requestId: id, toolCallId: (request.params.toolCall as JsonObject).toolCallId! } })
    }
  }
  function detach(connectionId: string, target?: AgentTuple): void {
    const attached = clients.get(connectionId)
    if (!attached) return
    const key = target && tupleKey(target)
    for (const [id, request] of attached.offers) if (!key || tupleKey(request.target) === key) { attached.offers.delete(id); request.offers.delete(connectionId) }
    if (key) attached.targets.delete(key)
    else clients.delete(connectionId)
  }
  return {
    open(target, providerId, params) {
      const key = JSON.stringify([tupleKey(target), providerId])
      if (requests.has(key)) throw new AgentError("INVALID_PROTOCOL")
      const request: Request = { key, target: { ...target }, providerId, params: structuredClone(params), options: new Set((params.options as JsonObject[]).map(option => String(option.optionId))), offers: new Map() }
      requests.set(key, request)
      for (const connectionId of clients.keys()) offer(request, connectionId)
      return key
    },
    attach(target, client) {
      const attached = clients.get(client.connectionId) ?? { client, targets: new Set<string>(), offers: new Map<string, Request>() }
      attached.client = client; attached.targets.add(tupleKey(target)); clients.set(client.connectionId, attached)
      for (const request of requests.values()) if (tupleKey(request.target) === tupleKey(target)) offer(request, client.connectionId)
    },
    async decision(connectionId, requestId, result) {
      const attached = clients.get(connectionId), request = attached?.offers.get(String(requestId))
      if (!attached || !request || requests.get(request.key) !== request) return false
      const outcome = result?.outcome
      if (outcome && !Array.isArray(outcome) && typeof outcome === "object" && outcome.outcome === "selected" && typeof outcome.optionId === "string" && request.options.has(outcome.optionId)) {
        remove(request, connectionId)
        input.respond(request.target, request.providerId, { outcome: { outcome: "selected", optionId: outcome.optionId } })
        return true
      }
      attached.offers.delete(String(requestId)); request.offers.delete(connectionId)
      if (outcome && !Array.isArray(outcome) && typeof outcome === "object" && outcome.outcome === "selected") offer(request, connectionId)
      return false
    },
    detach,
    invalidate(target) { for (const request of [...requests.values()]) if (tupleKey(request.target) === tupleKey(target)) remove(request) },
  }
}