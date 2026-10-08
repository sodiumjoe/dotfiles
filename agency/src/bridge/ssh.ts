import { parsePermissionSnapshot } from "../orchestration/permission-routing.js"
import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type { EventEmitter } from "node:events"
import { id, object, keys, hash, providerId, timestamp, absolutePath, text } from "../catalog/types.js"
import { parseRequestedSettings } from "../agent/session-config.js"
import { parseAgentRef, parseExecutionRef, parseLineage } from "../orchestration/types.js"
import { parseOriginReceipt } from "../orchestration/receipts.js"
import type { HostSnapshot } from "../bureau/host.js"
import { parseHostEnrollment, type HostEnrollment } from "../bureau/hosts.js"
import { createBridgePeer, type RequestOptions } from "./codec.js"
import { bridgeError, type BridgeHello } from "./protocol.js"
import { destinationShellCommand, sanitizedBootstrapEnvironment } from "./invocation.js"
import { requestBridgeRead } from "./paging.js"

export type BridgeProcess = EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill(): boolean }
export type BridgeProcessFactory = (file: string, argv: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => BridgeProcess
export function buildSshCommand(raw: HostEnrollment) {
  const enrollment = parseHostEnrollment(raw)
  return { file: "ssh", argv: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "--", enrollment.hostname, destinationShellCommand(enrollment, "internal-host-bridge")] }
}
export function parseHostSnapshot(raw: unknown, hello: BridgeHello): HostSnapshot {
  const v = object(raw); keys(v, ["hostId", "handlerGeneration", "backendChoices", "agents", "receipts", "replayFences", ...(v.permissions === undefined ? [] : ["permissions"])])
  if (hash(v.hostId) !== hello.hostId) bridgeError("HOST_IDENTITY_CHANGED")
  if (id(v.handlerGeneration) !== hello.handlerGeneration) bridgeError("STALE_HANDLER")
  if (!Array.isArray(v.backendChoices) || !Array.isArray(v.agents) || !Array.isArray(v.receipts) || !Array.isArray(v.replayFences)) bridgeError("INVALID_HOST_SNAPSHOT")
  const agents = v.agents.map(value => {
    const a = object(value); keys(a, ["agent", "execution", "phase", "toolsEnabled", "lineage", "membership", "cwd", "settings"])
    const agent = parseAgentRef(a.agent), execution = a.execution === null ? null : parseExecutionRef(a.execution), membership = a.membership === null ? null : object(a.membership)
    if (membership) keys(membership, ["runId", "bindingEpoch"])
    if (agent.hostId !== hello.hostId || execution && (execution.agentId !== agent.agentId || execution.hostId !== agent.hostId) || typeof a.toolsEnabled !== "boolean") bridgeError("INVALID_HOST_SNAPSHOT")
    return { agent, execution, phase: text(a.phase), toolsEnabled: a.toolsEnabled, lineage: a.lineage === null ? null : parseLineage(a.lineage), membership: membership === null ? null : { runId: id(membership.runId), bindingEpoch: id(membership.bindingEpoch) }, cwd: absolutePath(a.cwd), settings: parseRequestedSettings(a.settings) }
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
export async function connectHost(raw: HostEnrollment, processFactory: BridgeProcessFactory = (file, argv, options) => spawn(file, argv, options)): Promise<BridgeConnection> {
  const enrollment = parseHostEnrollment(raw), command = buildSshCommand(enrollment), child = processFactory(command.file, command.argv, { env: { ...sanitizedBootstrapEnvironment(process.env), ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) }, stdio: ["pipe", "pipe", "pipe"] })
  const peer = createBridgePeer({ input: child.stdout, output: child.stdin }), timeout = setTimeout(() => peer.close(new Error("BRIDGE_HELLO_TIMEOUT")), 15000)
  let stderr = Buffer.alloc(0)
  child.stderr.on("data", (bytes: Buffer) => { if (stderr.length < 8192) stderr = Buffer.concat([stderr, bytes.subarray(0, 8192 - stderr.length)]) })
  child.on("error", (error: Error) => peer.close(error)); child.on("close", () => peer.close(new Error("BRIDGE_EOF")))
  const close = () => { peer.close(); child.kill() }
  void peer.closed.then(() => child.kill())
  try {
    const hello = await peer.ready; clearTimeout(timeout)
    if (hello.hostId !== enrollment.hostId) bridgeError("HOST_IDENTITY_CHANGED")
    if (hello.nodeVersion !== "v24.13.0") bridgeError("UNSUPPORTED_RUNTIME")
    if (!hello.capabilities.includes("snapshot")) bridgeError("UNSUPPORTED_CAPABILITY")
    let snapshot = parseHostSnapshot(await requestBridgeRead(peer, "snapshot", {}), hello)
    return {
      hello, get snapshot() { return structuredClone(snapshot) }, get diagnostics() { return stderr.toString("utf8") },
      async request(channel, payload, options) {
        if (!hello.capabilities.includes(channel)) bridgeError("UNSUPPORTED_CAPABILITY")
        if (["snapshot", "launch", "launchRoot", "restoreRoot", "submit", "stop"].includes(channel)) snapshot = parseHostSnapshot(await requestBridgeRead(peer, "snapshot", {}, { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }), hello)
        if (channel === "snapshot") return structuredClone(snapshot)
        return requestBridgeRead(peer, channel, payload, options)
      },
      subscribe: peer.subscribe, onRequest: peer.onRequest, prepareAdmission: peer.prepareAdmission, sendEvent: peer.sendEvent, closed: peer.closed, close
    }
  } catch (error) { clearTimeout(timeout); close(); throw error }
}
export type BridgeConnection = { hello: BridgeHello; readonly snapshot: HostSnapshot; readonly diagnostics: string; request(channel: string, payload: unknown, options?: RequestOptions): Promise<unknown>; subscribe: ReturnType<typeof createBridgePeer>["subscribe"]; onRequest: ReturnType<typeof createBridgePeer>["onRequest"]; prepareAdmission: ReturnType<typeof createBridgePeer>["prepareAdmission"]; sendEvent: ReturnType<typeof createBridgePeer>["sendEvent"]; closed: Promise<Error>; close(): void }