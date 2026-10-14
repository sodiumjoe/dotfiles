import { AgentError } from "../agent/types.js"
import type { HostRuntimeClient } from "./runtime.js"
import type { HostObservation, OwnerRoster, RosterView, PermissionView } from "./protocol.js"
import type { PermissionSnapshot } from "../orchestration/permission-routing.js"

type ViewInput = { client: HostRuntimeClient; localHostId: string; localHostname: string; hosts: Array<{ hostId: string; hostname: string }>; cwd?: string }
async function observe<T>(input: ViewInput, read: (hostId: string) => Promise<T>): Promise<HostObservation<T>[]> {
  const hosts = [...new Map([{ hostId: input.localHostId, hostname: input.localHostname }, ...input.hosts].map(host => [host.hostId, { hostId: host.hostId, hostname: host.hostname }])).values()]
  const results = await Promise.allSettled(hosts.map(host => read(host.hostId)))
  return results.map((result, index) => result.status === "fulfilled" ? { ...hosts[index]!, state: "available", value: result.value } : { ...hosts[index]!, state: "unavailable", code: result.reason?.code ?? result.reason?.message ?? "HOST_UNAVAILABLE" })
}
export async function rosterView(input: ViewInput): Promise<RosterView> {
  return { state: "roster", localHostId: input.localHostId, hosts: await observe(input, async hostId => {
    const owner = await input.client.identity(hostId), result: OwnerRoster = { handlerGeneration: owner.handlerGeneration, agents: [], issues: [] }, cursors = new Set<string>()
    let cursor: string | undefined, revision: string | undefined
    do {
      const page = await input.client.human(hostId, { op: "agent_roster", input: { limit: 100, ...(input.cwd ? { cwd: input.cwd } : {}), ...(cursor ? { cursor } : {}) } })
      if (page.state !== "page" || revision && page.revision !== revision) throw new AgentError("RESYNC_REQUIRED")
      if (page.agents.some(row => row.record.version !== 3 || row.record.launch?.handlerGeneration !== owner.handlerGeneration)) throw new AgentError("STALE_HANDLER")
      revision = page.revision; result.agents.push(...page.agents); result.issues.push(...page.issues)
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor)) throw new AgentError("INVALID_PROTOCOL")
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return result
  }) }
}
export async function permissionView(input: ViewInput): Promise<PermissionView> {
  const hosts = await observe<PermissionSnapshot>(input, async hostId => {
    const result = await input.client.human(hostId, { op: "agent_permissions" })
    if (result.state !== "permissions") throw new AgentError("INVALID_PROTOCOL")
    return result.snapshot
  })
  return { state: "permissions", hosts, pending: hosts.flatMap(host => host.state === "available" ? host.value.pending : []) }
}