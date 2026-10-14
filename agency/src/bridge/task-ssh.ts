import { parsePermissionSnapshot } from "../orchestration/permission-routing.js"
import { id, object, keys, hash, providerId, timestamp, absolutePath, text } from "../catalog/types.js"
import { parseRequestedSettings } from "../agent/session-config.js"
import { parseAgentRef, parseExecutionRef, parseLineage } from "../orchestration/types.js"
import { parseOriginReceipt } from "../orchestration/receipts.js"
import type { HostSnapshot } from "../bureau/host.js"
import { parseHostEnrollment, type HostEnrollment } from "../hosts/inventory.js"
import { createBridgePeer, type RequestOptions } from "./codec.js"
import { bridgeError, type BridgeHello } from "./protocol.js"

import { connectBridge, type BridgeTransport, type BridgeProcessFactory } from "./ssh.js"

export function parseHostSnapshot(raw: unknown, hello: Pick<BridgeHello, "hostId" | "handlerGeneration">): HostSnapshot {
  const v = object(raw); keys(v, ["hostId", "handlerGeneration", "backendChoices", "agents", "receipts", "replayFences", ...(v.permissions === undefined ? [] : ["permissions"])])
  if (hash(v.hostId) !== hello.hostId) bridgeError("HOST_IDENTITY_CHANGED")
  if (id(v.handlerGeneration) !== hello.handlerGeneration) bridgeError("STALE_HANDLER")
  if (!Array.isArray(v.backendChoices) || !Array.isArray(v.agents) || !Array.isArray(v.receipts) || !Array.isArray(v.replayFences)) bridgeError("INVALID_HOST_SNAPSHOT")
  const agents = v.agents.map(value => {
    const a = object(value); keys(a, ["agent", "execution", "phase", "toolsEnabled", "lineage", "membership", "cwd", "settings", ...["backendId", "title"].filter(key => Object.hasOwn(a, key))])
    const agent = parseAgentRef(a.agent), execution = a.execution === null ? null : parseExecutionRef(a.execution), membership = a.membership === null ? null : object(a.membership)
    if (membership) keys(membership, ["runId", "bindingEpoch"])
    if (agent.hostId !== hello.hostId || execution && (execution.agentId !== agent.agentId || execution.hostId !== agent.hostId) || typeof a.toolsEnabled !== "boolean") bridgeError("INVALID_HOST_SNAPSHOT")
    return { ...(a.backendId === undefined ? {} : { backendId: providerId(a.backendId) }), ...(a.title === undefined ? {} : { title: text(a.title, 65536) }), agent, execution, phase: text(a.phase), toolsEnabled: a.toolsEnabled, lineage: a.lineage === null ? null : parseLineage(a.lineage), membership: membership === null ? null : { runId: id(membership.runId), bindingEpoch: id(membership.bindingEpoch) }, cwd: absolutePath(a.cwd), settings: parseRequestedSettings(a.settings) }
  })
  const receipts = v.receipts.map(value => parseOriginReceipt({ runId: hello.handlerGeneration, receipt: value }).receipt)
  const replayFences = v.replayFences.map(value => {
    const f = object(value); keys(f, ["streamId", "runId", "throughSeq", "checkpoint"])
    const checkpoint = timestamp(f.checkpoint), throughSeq = timestamp(f.throughSeq)
    if (checkpoint > throughSeq) bridgeError("INVALID_HOST_SNAPSHOT")
    return { streamId: id(f.streamId), runId: id(f.runId), throughSeq, checkpoint }
  })
  if (new Set(agents.map(value => value.agent.agentId)).size !== agents.length) bridgeError("INVALID_HOST_SNAPSHOT")
  const permissions = v.permissions === undefined ? undefined : parsePermissionSnapshot(v.permissions)
  if (permissions && (permissions.hostId !== hello.hostId || permissions.handlerGeneration !== hello.handlerGeneration)) bridgeError("INVALID_HOST_SNAPSHOT")
  return { ...(permissions ? { permissions } : {}), hostId: hello.hostId, handlerGeneration: hello.handlerGeneration, backendChoices: v.backendChoices.map(providerId), agents, receipts, replayFences }
}
export async function connectHost(raw: HostEnrollment, processFactory?: BridgeProcessFactory): Promise<BridgeConnection> {
  const transport = await connectBridge(raw, { action: "internal-host-bridge", requiredCapabilities: ["snapshot"], ...(processFactory ? { processFactory } : {}) })
  try {
    let snapshot = parseHostSnapshot(await transport.request("snapshot", {}), transport.hello)
    return {
      ...transport, get diagnostics() { return transport.diagnostics }, get snapshot() { return structuredClone(snapshot) },
      async request(channel, payload, options) {
        if (["snapshot", "launch", "launchRoot", "restoreRoot", "submit", "stop"].includes(channel)) snapshot = parseHostSnapshot(await transport.request("snapshot", {}, { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }), transport.hello)
        if (channel === "snapshot") return structuredClone(snapshot)
        return transport.request(channel, payload, options)
      },
      subscribe: transport.peer.subscribe, onRequest: transport.peer.onRequest, prepareAdmission: transport.peer.prepareAdmission, sendEvent: transport.peer.sendEvent
    }
  } catch (error) { transport.close(); throw error }
}
export type BridgeConnection = BridgeTransport & { readonly snapshot: HostSnapshot; subscribe: ReturnType<typeof createBridgePeer>["subscribe"]; onRequest: ReturnType<typeof createBridgePeer>["onRequest"]; prepareAdmission: ReturnType<typeof createBridgePeer>["prepareAdmission"]; sendEvent: ReturnType<typeof createBridgePeer>["sendEvent"] }