import { hostname as localHostname } from "node:os"
import { RequestError } from "../live/errors.js"
import type { PermissionOffer, PermissionRef, PermissionSnapshot } from "../agent/permission-types.js"
import type { AgentTuple } from "../agent/types.js"
import type { RemoteHost } from "./remote-rosters.js"
import type { HostRoute } from "./router.js"

export type ApprovalHost = { hostId: string; state: "available"; value: PermissionSnapshot } | { hostId: string; state: "unavailable"; code: string; message: string }
export type Approvals = { state: "permissions"; hosts: ApprovalHost[]; pending: PermissionOffer[] }
export type RemoteRequests = ReturnType<typeof createRemoteRequests>

export function createRemoteRequests(input: { hostId: string; hosts(): RemoteHost[]; request(route: HostRoute, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> }) {
  const remote = (hostId: string) => input.hosts().find(host => host.hostId === hostId)
  const label = (hostId: string) => hostId === input.hostId ? "this machine" : "host " + (remote(hostId)?.hostname ?? hostId.slice(0, 12))
  const clock = (since: number) => new Date(since).toTimeString().slice(0, 5)
  function refusal(hostId: string): RequestError | null {
    if (hostId === input.hostId) return null
    const host = remote(hostId)
    if (!host) return new RequestError("UNAVAILABLE", label(hostId) + " is not enrolled")
    if (host.state === "offline") return new RequestError("UNAVAILABLE", label(hostId) + " is offline" + (host.since ? " since " + clock(host.since) : ""))
    if (host.state === "outdated") return new RequestError("UNAVAILABLE", label(hostId) + " runs an older build; update this devbox")
    if (host.state === "connecting") return new RequestError("UNAVAILABLE", "still connecting to " + label(hostId))
    return null
  }
  function translate(hostId: string, error: unknown): RequestError {
    if (error instanceof RequestError) return error
    const message = error instanceof Error ? error.message : String(error)
    if (message === "UNSUPPORTED_CAPABILITY") return new RequestError("UNAVAILABLE", label(hostId) + " runs an older build; update this devbox")
    if (/^(BRIDGE_|HOST_UNAVAILABLE$|HANDLER_UNAVAILABLE$)/.test(message)) return new RequestError("UNAVAILABLE", label(hostId) + " is unreachable (" + message + ")")
    return new RequestError("FAILED", message)
  }
  async function send(hostId: string, channel: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const refused = refusal(hostId)
    if (refused) throw refused
    try { return await input.request({ hostId, channel, payload }, undefined, timeoutMs) } catch (error) { throw translate(hostId, error) }
  }
  async function live(hostId: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const reply = await send(hostId, "live-request", payload, timeoutMs) as { ok?: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }
    if (reply?.ok === true && reply.result) return reply.result
    if (reply?.ok === false && reply.error) throw new RequestError(reply.error.code as never, reply.error.message)
    throw new RequestError("FAILED", label(hostId) + " sent an invalid reply")
  }
  const codes: Partial<Record<RemoteHost["state"], string>> = { offline: "OFFLINE", outdated: "UPDATE_REQUIRED", connecting: "CONNECTING" }
  return {
    excerpt: (hostId: string, agentId: string, turns: number) => live(hostId, { op: "excerpt", agentId, turns }, 8000),
    decide: (ref: PermissionRef, optionId: string) => live(ref.hostId, { op: "decide", ref, optionId }, 13000),
    async approvals(): Promise<Approvals> {
      const hosts = await Promise.all([input.hostId, ...input.hosts().map(host => host.hostId)].map(async (hostId): Promise<ApprovalHost> => {
        try { return { hostId, state: "available", value: (await live(hostId, { op: "permissions" }, 8000)).snapshot as PermissionSnapshot } }
        catch (error) {
          const failure = translate(hostId, error), state = remote(hostId)?.state
          return { hostId, state: "unavailable", code: (state && codes[state]) ?? failure.code, message: failure.message }
        }
      }))
      return { state: "permissions", hosts, pending: hosts.flatMap(host => host.state === "available" ? host.value.pending : []) }
    },
    async entry(commandId: string, hostId: string, target: AgentTuple) {
      const receipt = await send(hostId, "entry-open", { commandId, ref: { hostId, target } }, 13000)
      return { state: "entry" as const, receipt, enrollment: { hostId, hostname: hostId === input.hostId ? localHostname() : remote(hostId)!.hostname } }
    },
  }
}