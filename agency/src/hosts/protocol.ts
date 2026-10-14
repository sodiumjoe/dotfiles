import { isDeepStrictEqual } from "node:util"
import { hash, id, keys, object, text } from "../catalog/types.js"
import { AGENT_PROTOCOL, parseAgentReply } from "../agent/protocol.js"
import type { AgentPage } from "../agent/queries.js"
import type { RuntimeHumanResult } from "../agent/human-controls.js"
import { parsePermissionOffer, parsePermissionSnapshot, type PermissionOffer, type PermissionSnapshot } from "../orchestration/permission-routing.js"
import { parseHostEnrollment, type HostEnrollment } from "./inventory.js"

export type HostObservation<T> = { hostId: string; hostname: string; state: "available"; value: T } | { hostId: string; hostname: string; state: "unavailable"; code: string }
export type OwnerRoster = { handlerGeneration: string; agents: AgentPage["agents"]; issues: AgentPage["issues"] }
export type RosterView = { state: "roster"; localHostId: string; hosts: HostObservation<OwnerRoster>[] }
export type PermissionView = { state: "permissions"; hosts: HostObservation<PermissionSnapshot>[]; pending: PermissionOffer[] }
export const HOST_PROTOCOL = "agency-host/1" as const
export type HostResult = RosterView | PermissionView | RuntimeHumanResult | { state: "hosts"; hosts: HostEnrollment[] } | { state: "enrolled"; enrollment: HostEnrollment }
export type HostReply = { protocol: typeof HOST_PROTOCOL; requestId: string; hostId: string | null; handlerGeneration: string | null; commandId?: string } & ({ ok: true; result: HostResult } | { ok: false; error: { code: string; message: string; reference?: { hostId: string; commandId: string } } })
export function parseHostReply(raw: unknown): HostReply {
  const value = object(raw)
  if (value.protocol !== HOST_PROTOCOL || typeof value.ok !== "boolean") throw new Error("INVALID_PROTOCOL")
  const common = { protocol: HOST_PROTOCOL, requestId: id(value.requestId), hostId: value.hostId === null ? null : hash(value.hostId), handlerGeneration: value.handlerGeneration === null ? null : id(value.handlerGeneration), ...(value.commandId === undefined ? {} : { commandId: id(value.commandId) }) }
  if (value.ok && (common.hostId === null) !== (common.handlerGeneration === null)) throw new Error("INVALID_PROTOCOL")
  keys(value, ["protocol", "requestId", "hostId", "handlerGeneration", ...(common.commandId ? ["commandId"] : []), "ok", value.ok ? "result" : "error"])
  if (!value.ok) {
    const error = object(value.error); keys(error, ["code", "message", ...(error.reference === undefined ? [] : ["reference"])])
    const ref = error.reference === undefined ? undefined : object(error.reference)
    if (ref) keys(ref, ["hostId", "commandId"])
    return { ...common, ok: false, error: { code: text(error.code), message: text(error.message), ...(ref ? { reference: { hostId: hash(ref.hostId), commandId: id(ref.commandId) } } : {}) } }
  }
  const r = object(value.result)
  const ownerReply = (result: unknown, generation = common.handlerGeneration) => {
    const reply = parseAgentReply({ protocol: AGENT_PROTOCOL, requestId: common.requestId, handlerGeneration: generation, ok: true, result })
    if (!reply.ok) throw new Error("INVALID_PROTOCOL")
    return reply.result
  }
  let result: HostResult
  if (r.state === "roster" || r.state === "permissions" && Object.hasOwn(r, "hosts")) {
    keys(r, r.state === "roster" ? ["state", "localHostId", "hosts"] : ["state", "hosts", "pending"])
    if (common.hostId !== null || !Array.isArray(r.hosts)) throw new Error("INVALID_PROTOCOL")
    const hosts = r.hosts.map(raw => {
      const host = object(raw), hostId = hash(host.hostId), hostname = text(host.hostname)
      keys(host, ["hostId", "hostname", "state", host.state === "available" ? "value" : "code"])
      if (host.state === "unavailable") return { hostId, hostname, state: "unavailable" as const, code: text(host.code) }
      if (host.state !== "available") throw new Error("INVALID_PROTOCOL")
      if (r.state === "permissions") { const snapshot = parsePermissionSnapshot(host.value); if (snapshot.hostId !== hostId) throw new Error("INVALID_PROTOCOL"); return { hostId, hostname, state: "available" as const, value: snapshot } }
      const roster = object(host.value); keys(roster, ["handlerGeneration", "agents", "issues"])
      const generation = id(roster.handlerGeneration)
      if (!Array.isArray(roster.agents) || !Array.isArray(roster.issues)) throw new Error("INVALID_PROTOCOL")
      const agents: AgentPage["agents"] = [], issues: AgentPage["issues"] = []
      for (const [field, destination] of [["agents", agents], ["issues", issues]] as const) for (let index = 0; index < (roster[field] as unknown[]).length; index += 100) {
        const parsed = ownerReply({ state: "page", revision: common.requestId, agents: field === "agents" ? roster.agents.slice(index, index + 100) : [], issues: field === "issues" ? roster.issues.slice(index, index + 100) : [], nextCursor: null }, generation) as AgentPage
        ;(destination as unknown[]).push(...parsed[field])
      }
      if (agents.some(row => row.record.version !== 3 || row.record.definition.hostId !== hostId)) throw new Error("INVALID_PROTOCOL")
      return { hostId, hostname, state: "available" as const, value: { handlerGeneration: generation, agents, issues } }
    })
    if (new Set(hosts.map(host => host.hostId)).size !== hosts.length) throw new Error("INVALID_PROTOCOL")
    if (r.state === "roster") result = { state: "roster", localHostId: hash(r.localHostId), hosts: hosts as HostObservation<OwnerRoster>[] }
    else {
      if (!Array.isArray(r.pending)) throw new Error("INVALID_PROTOCOL")
      const pending = r.pending.map(parsePermissionOffer), owners = hosts as HostObservation<PermissionSnapshot>[]
      if (!isDeepStrictEqual(pending, owners.flatMap(host => host.state === "available" ? host.value.pending : []))) throw new Error("INVALID_PROTOCOL")
      result = { state: "permissions", hosts: owners, pending }
    }
  } else if (r.state === "hosts") { keys(r, ["state", "hosts"]); if (!Array.isArray(r.hosts) || common.hostId !== null) throw new Error("INVALID_PROTOCOL"); result = { state: "hosts", hosts: r.hosts.map(parseHostEnrollment) } }
  else if (r.state === "enrolled") { keys(r, ["state", "enrollment"]); if (common.hostId !== null) throw new Error("INVALID_PROTOCOL"); result = { state: "enrolled", enrollment: parseHostEnrollment(r.enrollment) } }
  else {
    if (common.hostId === null) throw new Error("INVALID_PROTOCOL")
    result = ownerReply(r) as RuntimeHumanResult
    if (!["page", "permissions", "permission"].includes(result.state)) throw new Error("INVALID_PROTOCOL")
    if (result.state === "permissions" && result.snapshot.hostId !== common.hostId || result.state === "permission" && result.receipt && (result.receipt.commandId !== common.commandId || result.receipt.ref.hostId !== common.hostId)) throw new Error("INVALID_PROTOCOL")
  }
  return { ...common, ok: true, result }
}