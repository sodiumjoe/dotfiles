import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteRequests } from "../src/hosts/remote-requests.js"
import type { RemoteHost } from "../src/hosts/remote-rosters.js"
import type { HostRoute } from "../src/hosts/router.js"

const own = "a".repeat(64), devbox = "b".repeat(64)
const host = (state: RemoteHost["state"], since: number | null = null): RemoteHost => ({ hostId: devbox, hostname: "devbox.example", name: null, state, since, handlerGeneration: null, agents: [], error: null })
const snapshot = (hostId: string) => ({ hostId, handlerGeneration: "g", throughSeq: 0, pending: [{ ref: { hostId }, title: "t" }], receipts: [] })

function requests(remote: RemoteHost[], answer: (route: HostRoute, signal?: AbortSignal) => Promise<unknown>, timeouts?: { read: number; write: number }) {
  const calls: Array<{ route: HostRoute; signal?: AbortSignal; timeoutMs?: number }> = []
  const api = createRemoteRequests({ hostId: own, hosts: () => remote, ...(timeouts ? { timeouts } : {}), request: async (route, signal, timeoutMs) => { calls.push({ route, ...(signal ? { signal } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) }); return answer(route, signal) } })
  return { api, calls }
}

test("a host that is offline, outdated or still connecting fails at once", async () => {
  for (const [state, pattern] of [["offline", /offline since \d\d:\d\d/], ["outdated", /update this devbox/], ["connecting", /still connecting/]] as const) {
    const { api, calls } = requests([host(state, Date.now())], async () => { throw new Error("unexpected") })
    await assert.rejects(api.excerpt(devbox, "x", 4), (error: { code?: string; message?: string }) => error.code === "UNAVAILABLE" && pattern.test(String(error.message)))
    assert.equal(calls.length, 0)
  }
})

test("bridge failures become readable request errors", async () => {
  for (const [failure, code, pattern] of [["UNSUPPORTED_CAPABILITY", "UNAVAILABLE", /update this devbox/], ["BRIDGE_TIMEOUT", "UNAVAILABLE", /unreachable \(BRIDGE_TIMEOUT\)/], ["boom", "FAILED", /boom/]] as const) {
    const { api } = requests([host("online")], async () => { throw new Error(failure) })
    await assert.rejects(api.excerpt(devbox, "x", 4), (error: { code?: string; message?: string }) => error.code === code && pattern.test(String(error.message)))
  }
  const { api } = requests([host("online")], async () => ({ ok: false, error: { code: "NOT_FOUND", message: "agent x is not known" } }))
  await assert.rejects(api.excerpt(devbox, "x", 4), (error: { code?: string; message?: string }) => error.code === "NOT_FOUND" && error.message === "agent x is not known")
})

test("requests carry timeouts under the editor's limits, and the laptop's own host goes through the router", async () => {
  const { api, calls } = requests([host("online")], async route => {
    const op = (route.payload as { op?: string }).op
    if (op === "permissions") return { ok: true, result: { state: "permissions", snapshot: snapshot(route.hostId) } }
    if (op === "decide") return { ok: true, result: { state: "permission", receipt: { state: "applied" } } }
    if (route.channel === "entry-open") return { commandId: "c", state: "opened" }
    return { ok: true, result: { state: "excerpt", turns: [] } }
  })
  await api.excerpt(own, "x", 4)
  await api.decide({ hostId: devbox } as never, "allow")
  await api.entry("c", devbox, {} as never)
  assert.deepEqual(calls.map(call => [call.route.hostId === own ? "own" : "devbox", call.route.channel, call.timeoutMs, call.signal instanceof AbortSignal]), [["own", "live-request", undefined, true], ["devbox", "live-request", undefined, true], ["devbox", "entry-open", undefined, true]])
})

test("a host that does not answer in time is cancelled, not timed out on the bridge", async () => {
  const { api, calls } = requests([host("online")], (_route, signal) => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })), { read: 20, write: 20 })
  await assert.rejects(api.excerpt(devbox, "x", 4), (error: { code?: string; message?: string }) => error.code === "UNAVAILABLE" && /did not answer/.test(String(error.message)))
  assert.equal(calls[0]!.timeoutMs, undefined)
})

test("approvals collect every host and keep the others when one fails", async () => {
  const offline = { ...host("offline", Date.now()), hostId: "c".repeat(64), hostname: "gone.example" }
  const { api } = requests([host("online"), offline], async route => route.hostId === devbox ? Promise.reject(new Error("BRIDGE_EOF")) : { ok: true, result: { state: "permissions", snapshot: snapshot(route.hostId) } })
  const result = await api.approvals()
  assert.deepEqual(result.hosts.map(value => [value.hostId.slice(0, 1), value.state, "code" in value ? value.code : null]), [["a", "available", null], ["b", "unavailable", "UNAVAILABLE"], ["c", "unavailable", "OFFLINE"]])
  assert.deepEqual(result.pending.map(offer => offer.ref.hostId), [own])
})