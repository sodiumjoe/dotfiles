import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteRosters } from "../src/hosts/remote-rosters.js"
import { until } from "./control-support.js"
import type { RemoteListing } from "../src/hosts/remote-listing.js"

const hostA = { hostId: "a".repeat(64), hostname: "alpha" }, hostB = { hostId: "b".repeat(64), hostname: "beta" }
const row = (agentId: string) => ({ agentId, backendId: "codex-acp" as const, cwd: "/w", createdAt: "2026-11-17T00:00:00.000Z", title: null, lastActivityAt: null, live: null })
const one = "00000000-0000-4000-8000-000000000011"
const timing = { intervalMs: 10, waitMs: 20, refreshMs: 200, backoffMs: 10, maxBackoffMs: 40 }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("a host is read at once, re-read on a new revision, and not re-read while unchanged", async t => {
  let revision = "r1", reads = 0
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA], wait: async () => { await pause(5); return revision }, read: async () => { reads++; return { handlerGeneration: "g1", agents: [row(one)] } } })
  t.after(() => rosters.close())
  const online = await until(async () => rosters.hosts()[0]?.state === "online" ? rosters.hosts()[0] : undefined)
  assert.deepEqual([online.handlerGeneration, online.agents.map(value => value.agentId), online.since, online.error], ["g1", [one], null, null])
  await pause(80)
  assert.equal(reads, 1)
  revision = "r2"
  await until(async () => reads === 2 ? true : undefined)
})

test("an unchanged host is re-read once the refresh interval passes", async t => {
  let reads = 0
  const rosters = createRemoteRosters({ ...timing, refreshMs: 60, list: async () => [hostA], wait: async () => { await pause(5); return "r1" }, read: async () => { reads++; return { handlerGeneration: "g1", agents: [] } } })
  t.after(() => rosters.close())
  await until(async () => reads >= 2 ? true : undefined)
})

test("a failing host goes offline, keeps its agents and backs off, then comes back", async t => {
  let failing = false
  const calls: number[] = []
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA], wait: async () => { if (failing) { calls.push(Date.now()); throw new Error("BRIDGE_EOF") } await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [row(one)] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts()[0]?.state === "online" ? true : undefined)
  failing = true
  const offline = await until(async () => rosters.hosts()[0]?.state === "offline" ? rosters.hosts()[0] : undefined)
  assert.deepEqual([offline.error, offline.agents.map(value => value.agentId)], ["BRIDGE_EOF", [one]])
  await until(async () => calls.length >= 6 ? true : undefined, 5000)
  const gaps = calls.slice(1).map((at, index) => at - calls[index]!)
  for (let index = 1; index < gaps.length; index++) assert.ok(gaps[index]! >= gaps[index - 1]! - 5, String(gaps))
  assert.ok(gaps.at(-1)! >= timing.maxBackoffMs - 5, String(gaps))
  assert.equal(rosters.hosts()[0]!.since, offline.since)
  failing = false
  const back = await until(async () => rosters.hosts()[0]?.state === "online" ? rosters.hosts()[0] : undefined, 5000)
  assert.equal(back.since, null)
})

test("an older devbox is marked outdated and retried only after the longest backoff", async t => {
  const calls: number[] = []
  const rosters = createRemoteRosters({ ...timing, maxBackoffMs: 150, list: async () => [hostA], wait: async () => { calls.push(Date.now()); throw new Error("UNSUPPORTED_CAPABILITY") }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts()[0]?.state === "outdated" ? true : undefined)
  await until(async () => calls.length >= 2 ? true : undefined, 5000)
  assert.ok(calls[1]! - calls[0]! >= 145, String(calls[1]! - calls[0]!))
})

test("one stuck host does not hold up another, and its own requests never overlap", async t => {
  let stuck = 0, reads = 0
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA, hostB], wait: async hostId => { if (hostId === hostA.hostId) { stuck++; return new Promise<string>(() => {}) } await pause(5); return "r" + Date.now() }, read: async () => { reads++; return { handlerGeneration: "g1", agents: [] } } })
  t.after(() => rosters.close())
  await until(async () => reads >= 3 ? true : undefined)
  assert.equal(stuck, 1)
  assert.deepEqual(rosters.hosts().map(host => [host.hostname, host.state]), [["alpha", "connecting"], ["beta", "online"]])
})

test("a failing inventory keeps the hosts, and a host that leaves the inventory leaves the list", async t => {
  let mode: "both" | "fail" | "one" = "both"
  const rosters = createRemoteRosters({ ...timing, list: async () => { if (mode === "fail") throw new Error("HOST_IDENTITY_CONFLICT"); return mode === "both" ? [hostA, hostB] : [hostB] }, wait: async () => { await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts().length === 2 ? true : undefined)
  mode = "fail"
  await pause(50)
  assert.equal(rosters.hosts().length, 2)
  mode = "one"
  await until(async () => rosters.hosts().length === 1 ? true : undefined)
  assert.equal(rosters.hosts()[0]!.hostname, "beta")
})

test("nothing is requested after close", async t => {
  let calls = 0
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA], wait: async () => { calls++; await pause(5); return "r" + calls }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  await until(async () => calls >= 2 ? true : undefined)
  rosters.close()
  await pause(30)
  const seen = calls
  await pause(80)
  assert.equal(calls, seen)
  t.diagnostic(String(seen))
})

test("a host whose reply has an invalid row goes offline without hiding the others", async t => {
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA, hostB], wait: async () => { await pause(5); return "r1" },
    read: async hostId => hostId === hostA.hostId ? { handlerGeneration: "00000000-0000-4000-8000-000000000001", agents: [{ ...row("00000000-0000-4000-8000-000000000002"), backendId: "future-acp" as never }] } : { handlerGeneration: "00000000-0000-4000-8000-000000000001", agents: [row("00000000-0000-4000-8000-000000000003")] } })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts().length === 2 && rosters.hosts().every(host => host.state !== "connecting") ? true : undefined)
  assert.deepEqual(rosters.hosts().map(host => [host.hostname, host.state, host.error, host.agents.length]), [["alpha", "offline", "INVALID_HOST_REPLY", 0], ["beta", "online", null, 1]])
})

const devA = { hostId: "d".repeat(64), hostname: "qa-a.northwest.example" }, devB = { hostId: "e".repeat(64), hostname: "qa-b.northwest.example" }
function fakeListing() {
  const state = { current: null as RemoteListing | null, attempted: null as number | null, requests: [] as number[] }
  return { state, source: { latest: () => state.current, attemptedAt: () => state.attempted, request: (ms: number) => { state.requests.push(ms) } } }
}
const listed = (at: number, names: [string, string | null][], complete = true): RemoteListing => ({ at, complete, names: new Map(names) })

test("an offline devbox missing from a complete listing taken after its outage is logged and forgotten once, and an alias is not", async t => {
  let failing = false, enrolled = [devA, devB, hostA]
  const { state, source } = fakeListing(), events: Record<string, unknown>[] = [], forgotten: string[] = []
  const rosters = createRemoteRosters({ ...timing, listing: source, log: event => events.push(event), list: async () => enrolled,
    forget: async hostId => { forgotten.push(hostId); enrolled = enrolled.filter(host => host.hostId !== hostId) },
    wait: async hostId => { if (hostId !== devB.hostId && failing) throw new Error("BRIDGE_CONNECT"); await pause(5); return "r1" },
    read: async hostId => ({ handlerGeneration: "g1", agents: hostId === devA.hostId ? [row(one)] : [] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts().length === 3 && rosters.hosts().every(host => host.state === "online") ? true : undefined)
  failing = true
  const offline = await until(async () => rosters.hosts().find(host => host.hostId === devA.hostId && host.state === "offline"))
  const alias = await until(async () => rosters.hosts().find(host => host.hostId === hostA.hostId && host.state === "offline"))
  state.current = listed(Math.max(offline.since!, alias.since!) + 1, [[devB.hostname, "beta-box"]])
  await until(async () => rosters.hosts().length === 2 ? true : undefined)
  await pause(50)
  assert.deepEqual(rosters.hosts().map(host => [host.hostname, host.state, host.name]), [["alpha", "offline", null], [devB.hostname, "online", "beta-box"]])
  assert.deepEqual(forgotten, [devA.hostId])
  assert.deepEqual(events, [{ type: "remote_host_deleted", hostId: devA.hostId, hostname: devA.hostname, name: null, since: offline.since, agents: [one] }])
})

test("a devbox stays enrolled when no listing succeeded, the listing predates its outage or is incomplete, or no enrolled host is listed", async t => {
  const { state, source } = fakeListing(), forgotten: string[] = []
  const rosters = createRemoteRosters({ ...timing, listing: source, forget: async hostId => { forgotten.push(hostId) }, list: async () => [devA, devB],
    wait: async hostId => { if (hostId === devA.hostId) throw new Error("BRIDGE_CONNECT"); await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => rosters.close())
  const offline = await until(async () => {
    const hosts = rosters.hosts()
    return hosts[0]?.state === "offline" && hosts[1]?.state === "online" ? hosts[0] : undefined
  })
  const other: [string, string | null] = [devB.hostname, "beta-box"]
  for (const listing of [null, listed(offline.since!, [other]), listed(offline.since! - 1, [other]), listed(offline.since! + 1, [other], false), listed(offline.since! + 1, [])]) {
    state.current = listing
    await pause(40)
    assert.deepEqual([rosters.hosts().map(host => host.state), forgotten], [["offline", "online"], []], JSON.stringify(listing && { ...listing, names: [...listing.names] }))
  }
})

test("a failed removal is logged once and the host stays enrolled", async t => {
  const { state, source } = fakeListing(), events: Record<string, unknown>[] = []
  let attempts = 0
  const rosters = createRemoteRosters({ ...timing, listing: source, log: event => events.push(event), forget: async () => { attempts++; throw new Error("STATE_CHANGED") }, list: async () => [devA, devB],
    wait: async hostId => { if (hostId === devA.hostId) throw new Error("BRIDGE_CONNECT"); await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => rosters.close())
  const offline = await until(async () => rosters.hosts().find(host => host.hostId === devA.hostId && host.state === "offline"))
  state.current = listed(offline.since! + 1, [[devB.hostname, null]])
  await until(async () => events.some(event => event.type === "remote_host_forget_failed") ? true : undefined)
  await pause(100)
  assert.deepEqual(events.map(event => [event.type, event.hostId]), [["remote_host_deleted", devA.hostId], ["remote_host_forget_failed", devA.hostId]])
  assert.equal(events[1]!.message, "STATE_CHANGED")
  assert.equal(attempts, 1)
  assert.ok(rosters.hosts().some(host => host.hostId === devA.hostId))
})

test("an online host carries its friendly name and keeps it when a later listing drops it", async t => {
  const { state, source } = fakeListing()
  state.current = listed(Date.now(), [[hostA.hostname, "alpha-box"]])
  const rosters = createRemoteRosters({ ...timing, listing: source, list: async () => [hostA], wait: async () => { await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts()[0]?.name === "alpha-box" ? true : undefined)
  state.current = listed(Date.now(), [])
  await pause(50)
  assert.deepEqual(rosters.hosts().map(host => [host.state, host.name]), [["online", "alpha-box"]])
})

test("the listing is requested hourly while hosts are enrolled, sooner after an outage, and never without hosts", async t => {
  const empty = fakeListing()
  const idle = createRemoteRosters({ ...timing, listing: empty.source, list: async () => [], wait: async () => "r1", read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => idle.close())
  await pause(60)
  assert.deepEqual(empty.state.requests, [])
  let failing = false
  const { state, source } = fakeListing()
  const rosters = createRemoteRosters({ ...timing, listEveryMs: 1000, listGapMs: 30, listing: source, list: async () => [hostA], wait: async () => { if (failing) throw new Error("BRIDGE_CONNECT"); await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts()[0]?.state === "online" && state.requests.length >= 2 ? true : undefined)
  assert.ok(state.requests.every(ms => ms === 1000), String(state.requests))
  state.attempted = Date.now() - 1000
  failing = true
  await until(async () => state.requests.at(-1) === 30 ? true : undefined)
  state.attempted = Date.now() + 1
  const count = state.requests.length
  await until(async () => state.requests.length >= count + 2 ? true : undefined)
  assert.equal(state.requests.at(-1), 1000)
})