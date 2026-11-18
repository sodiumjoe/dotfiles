import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteRosters } from "../src/hosts/remote-rosters.js"
import { until } from "./control-support.js"

const hostA = { hostId: "a".repeat(64), hostname: "alpha" }, hostB = { hostId: "b".repeat(64), hostname: "beta" }
const row = (agentId: string) => ({ agentId, backendId: "codex-acp" as const, cwd: "/w", createdAt: "2026-11-17T00:00:00.000Z", title: null, lastActivityAt: null, live: null })
const timing = { intervalMs: 10, waitMs: 20, refreshMs: 200, backoffMs: 10, maxBackoffMs: 40 }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("a host is read at once, re-read on a new revision, and not re-read while unchanged", async t => {
  let revision = "r1", reads = 0
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA], wait: async () => { await pause(5); return revision }, read: async () => { reads++; return { handlerGeneration: "g1", agents: [row("one")] } } })
  t.after(() => rosters.close())
  const online = await until(async () => rosters.hosts()[0]?.state === "online" ? rosters.hosts()[0] : undefined)
  assert.deepEqual([online.handlerGeneration, online.agents.map(value => value.agentId), online.since, online.error], ["g1", ["one"], null, null])
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
  const rosters = createRemoteRosters({ ...timing, list: async () => [hostA], wait: async () => { if (failing) { calls.push(Date.now()); throw new Error("BRIDGE_EOF") } await pause(5); return "r1" }, read: async () => ({ handlerGeneration: "g1", agents: [row("one")] }) })
  t.after(() => rosters.close())
  await until(async () => rosters.hosts()[0]?.state === "online" ? true : undefined)
  failing = true
  const offline = await until(async () => rosters.hosts()[0]?.state === "offline" ? rosters.hosts()[0] : undefined)
  assert.deepEqual([offline.error, offline.agents.map(value => value.agentId)], ["BRIDGE_EOF", ["one"]])
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