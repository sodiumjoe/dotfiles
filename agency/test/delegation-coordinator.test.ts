import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { until } from "./control-support.js"
import type { JsonObject } from "../src/agent/session-config.js"
import { acceptUpward, createCoordinator } from "../src/delegation/coordinator.js"
import type { ChildView } from "../src/delegation/box.js"
import type { OutboxEntry, ParentLink } from "../src/delegation/outbox.js"
import { unwrapReply } from "../src/delegation/reply.js"
import { createHostRouter } from "../src/hosts/router.js"
import type { RemoteHost } from "../src/hosts/remote-rosters.js"
import type { RosterRow } from "../src/live/roster.js"
import { RequestError } from "../src/live/errors.js"
import { REQUEST_PROTOCOL } from "../src/live/protocol.js"

const own = "f".repeat(64), devbox = "c".repeat(64)
const boxId = (n: number) => String(n).repeat(64)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const agent = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const parentA: ParentLink = { hostId: devbox, agentId: agent(1) }, parentB: ParentLink = { hostId: devbox, agentId: agent(2) }
const host = (hostId: string, name: string | null, agents: RosterRow[] = []): RemoteHost => ({ hostId, hostname: (name ?? "box") + ".example", name, state: "online", since: null, handlerGeneration: null, agents, error: null })
const row = (agentId: string, activity: "idle" | "working", editors = 0, lastActivityAt: string | null = null): RosterRow => ({ agentId, backendId: "codex-acp", cwd: "/w", createdAt: "2026-11-19T00:00:00.000Z", title: null, lastActivityAt,
  live: { activity, handlerGeneration: agent(90), providerGeneration: agent(91), model: null, mode: null, pendingApprovals: 0, editors } })
const entry = (text: string, delivered = false): OutboxEntry => ({ submissionId: randomUUID(), state: "answer", stopReason: "end_turn", failure: null, text, delivered, at: "2026-11-19T00:00:00.000Z" })
const view = (childId: string, parent: ParentLink, entries: OutboxEntry[] = [], extra: Partial<ChildView> = {}): ChildView => ({ version: 1, childId, parent, depth: 1, ref: "master", createdAt: "2026-11-19T00:00:00.000Z", open: null, stopped: false, dropped: 0, entries, live: null, title: null, moved: false, ...extra })
const start = (parent: ParentLink) => ({ op: "start" as const, parent, parentName: "", depth: 1, task: "do it", ref: "master", remote: "github.com/stripe/mint", path: "." })

function world(hosts: RemoteHost[], options: { deliver?(payload: JsonObject): Promise<JsonObject>; local?(hostId: string, payload: JsonObject): Promise<JsonObject> | undefined; now?: () => number } = {}) {
  const boxes = new Map<string, ChildView[]>(), calls: Array<{ hostId: string; payload: JsonObject }> = []
  const answer = async (hostId: string, payload: JsonObject): Promise<JsonObject> => {
    const views = boxes.get(hostId) ?? []
    if (payload.op === "children") return { state: "children", children: structuredClone(views) as never }
    if (payload.op === "child-start") { boxes.set(hostId, [...views, view(String(payload.childId), payload.parent as ParentLink)]); return { state: "accepted", childId: payload.childId! } }
    if (payload.op === "child-mark") {
      const value = views.find(item => item.childId === payload.childId)!
      for (const item of value.entries) if ((payload.submissionIds as string[]).includes(item.submissionId)) item.delivered = true
      value.dropped = 0
      return { state: "marked" }
    }
    if (payload.op === "child-stop") return { state: "stopped" }
    if (payload.op === "child-ask") return { state: "accepted" }
    if (payload.op === "deliver") return options.deliver ? options.deliver(payload) : { state: "delivered" }
    throw new Error("unexpected " + String(payload.op))
  }
  const coordinator = createCoordinator({ hostId: own, hosts: () => structuredClone(hosts), ...(options.now ? { now: options.now } : {}), request: async (hostId, payload) => {
    calls.push({ hostId, payload: structuredClone(payload) })
    return options.local?.(hostId, payload) ?? answer(hostId, payload)
  } })
  const sent = (op: string) => calls.filter(call => call.payload.op === op)
  return { boxes, calls, coordinator, sent }
}

test("a start picks a same-origin free box first, then borrows, and fails clearly when none is free", async () => {
  const hosts = [host(devbox, "climate"), host(boxId(1), "climate-agency-0001", [row(agent(50), "working")]), host(boxId(3), "other-agency-0003"), host(boxId(2), "climate-agency-0002")]
  const { coordinator, sent } = world(hosts)
  const first = await coordinator.handle(start(parentA))
  assert.equal(first.state, "starting"); assert.equal(first.box, "climate-agency-0002")
  assert.deepEqual(sent("child-start").map(call => call.hostId), [boxId(2)])
  assert.deepEqual(sent("child-start")[0]!.payload, { op: "child-start", childId: first.childId!, parent: parentA, depth: 1, task: "do it", ref: "master", remote: "github.com/stripe/mint", path: "." })
  const second = await coordinator.handle(start(parentA))
  assert.equal(second.box, "other-agency-0003")
  assert.deepEqual(sent("child-start").map(call => call.hostId), [boxId(2), boxId(3)])
  const third = await coordinator.handle(start(parentA))
  assert.equal(third.state, "starting"); assert.equal(third.box, null); assert.match(String(third.childId), /^[0-9a-f-]{36}$/)
  assert.equal(sent("child-start").length, 2)
  coordinator.tick()
  const [failure] = await until(async () => sent("deliver").length ? sent("deliver") : undefined)
  assert.equal(failure!.hostId, devbox)
  assert.equal(failure!.payload.parentAgentId, parentA.agentId)
  assert.equal(failure!.payload.childId, third.childId)
  assert.match(String(failure!.payload.label), / · failed\]$/)
  assert.match(String(failure!.payload.text), /no free pool box/)
  await pause(50)
  coordinator.tick()
  await pause(50)
  assert.equal(sent("deliver").length, 1)
})

test("answers are delivered in order with labels, a busy parent pauses delivery, and delivered answers are marked", async () => {
  const child = agent(10), first = entry("one"), second = entry("two")
  let refusals = 1
  const { boxes, coordinator, sent } = world([host(devbox, "climate"), host(boxId(2), "climate-agency-0002")], { deliver: async () => { if (refusals-- > 0) throw new RequestError("BUSY", "parent is busy"); return { state: "delivered" } } })
  boxes.set(boxId(2), [view(child, parentA, [entry("old", true), first, second])])
  coordinator.changed(boxId(2))
  await until(async () => sent("deliver").length ? true : undefined)
  await pause(50)
  assert.equal(sent("deliver").length, 1)
  assert.equal(sent("child-mark").length, 0)
  coordinator.changed(devbox)
  await until(async () => sent("child-mark").length ? true : undefined)
  const label = "[Agency child " + child.slice(0, 8) + " · climate-agency-0002 · answer]"
  assert.deepEqual(sent("deliver").map(call => [call.hostId, call.payload.parentAgentId, call.payload.submissionId, call.payload.label, call.payload.text]), [
    [devbox, parentA.agentId, first.submissionId, label, "one"], [devbox, parentA.agentId, first.submissionId, label, "one"], [devbox, parentA.agentId, second.submissionId, label, "two"]])
  assert.deepEqual(sent("child-mark").map(call => [call.hostId, call.payload]), [[boxId(2), { op: "child-mark", childId: child, submissionIds: [first.submissionId, second.submissionId] }]])
  coordinator.changed(devbox)
  await pause(50)
  assert.equal(sent("deliver").length, 3)
})

test("two children of one parent never deliver at the same time", async () => {
  const releases: Array<() => void> = []
  const { boxes, coordinator, sent } = world([host(devbox, "climate"), host(boxId(1), "climate-agency-0001"), host(boxId(2), "climate-agency-0002")], { deliver: () => new Promise(resolve => releases.push(() => resolve({ state: "delivered" }))) })
  boxes.set(boxId(1), [view(agent(11), parentA, [entry("from one")])])
  boxes.set(boxId(2), [view(agent(12), parentA, [entry("from two")])])
  coordinator.changed(boxId(1)); coordinator.changed(boxId(2))
  await until(async () => sent("deliver").length ? true : undefined)
  await pause(50)
  assert.equal(sent("deliver").length, 1)
  releases.shift()!()
  await until(async () => sent("deliver").length === 2 ? true : undefined)
  await pause(50)
  assert.equal(sent("deliver").length, 2)
  releases.shift()!()
  await until(async () => sent("child-mark").length === 2 ? true : undefined)
  assert.deepEqual(sent("deliver").map(call => call.payload.text).sort(), ["from one", "from two"])
})

test("a dropped count is reported once in the next label, and a parent on the laptop is delivered through the same request path", async () => {
  const child = agent(13), laptopParent = { hostId: own, agentId: agent(3) }, local: Array<{ channel: string; payload: unknown }> = []
  const router = createHostRouter({ hostId: own, inventory: { list: async () => [] }, connect: async () => { throw new Error("no connections in this test") },
    local: async (channel, payload) => { local.push({ channel, payload }); return { protocol: REQUEST_PROTOCOL, requestId: randomUUID(), ok: true, result: { state: "delivered" } } } })
  const { boxes, coordinator, sent } = world([host(boxId(2), "laptop-agency-0002")], { local: (hostId, payload) => hostId === own ? router.request({ hostId, channel: "live-request", payload }, AbortSignal.timeout(10000)).then(unwrapReply) : undefined })
  boxes.set(boxId(2), [view(child, laptopParent, [entry("after a gap")], { dropped: 2 })])
  coordinator.changed(boxId(2))
  await until(async () => sent("child-mark").length ? true : undefined)
  boxes.get(boxId(2))![0]!.entries.push(entry("next"))
  coordinator.changed(boxId(2))
  await until(async () => sent("child-mark").length === 2 ? true : undefined)
  const prefix = "[Agency child " + child.slice(0, 8) + " · laptop-agency-0002 · answer"
  assert.deepEqual(sent("deliver").map(call => [call.hostId, call.payload.label, call.payload.text]), [[own, prefix + " · 2 earlier answers were dropped]", "after a gap"], [own, prefix + "]", "next"]])
  assert.deepEqual(local.map(value => [value.channel, (value.payload as JsonObject).op, (value.payload as JsonObject).parentAgentId]), [["live-request", "deliver", laptopParent.agentId], ["live-request", "deliver", laptopParent.agentId]])
  router.close()
})

test("an idle child with no editor is stopped after the idle hour, and a working or watched one is not", async () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z"), old = new Date(now - 3600000 - 1000).toISOString(), recent = new Date(now - 600000).toISOString()
  const [idle, working, watched, fresh] = [agent(21), agent(22), agent(23), agent(24)]
  const hosts = [host(devbox, "climate"), host(boxId(1), "climate-agency-0001", [row(idle, "idle", 0, old)]), host(boxId(2), "climate-agency-0002", [row(working, "working", 0, old)]),
    host(boxId(3), "climate-agency-0003", [row(watched, "idle", 1, old)]), host(boxId(4), "climate-agency-0004", [row(fresh, "idle", 0, recent)])]
  const { boxes, coordinator, sent } = world(hosts, { now: () => now })
  for (const [n, child] of [[1, idle], [2, working], [3, watched], [4, fresh]] as const) boxes.set(boxId(n), [view(child, parentA)])
  for (const n of [1, 2, 3, 4]) coordinator.changed(boxId(n))
  await until(async () => sent("children").length === 4 ? true : undefined)
  await pause(20)
  coordinator.tick()
  await until(async () => sent("child-stop").length ? true : undefined)
  coordinator.tick()
  await pause(50)
  assert.deepEqual(sent("child-stop").map(call => [call.hostId, call.payload]), [[boxId(1), { op: "child-stop", childId: idle }]])
})

test("list shows only the caller's children, and ask or stop for another parent's child is refused", async () => {
  const mine = agent(31), theirs = agent(32)
  const { boxes, coordinator, sent } = world([host(devbox, "climate"), host(boxId(1), "climate-agency-0001"), host(boxId(2), "climate-agency-0002")], { deliver: async () => { throw new RequestError("BUSY", "parent is busy") } })
  boxes.set(boxId(1), [view(mine, parentA, [entry("seen", true), entry("a"), entry("b")], { live: row(mine, "idle").live, title: "Fix the build" })])
  boxes.set(boxId(2), [view(theirs, parentB, [entry("c")], { stopped: true })])
  coordinator.changed(boxId(1)); coordinator.changed(boxId(2))
  await until(async () => sent("children").length === 2 ? true : undefined)
  await pause(20)
  assert.deepEqual(await coordinator.handle({ op: "list", parent: parentA }), { state: "children", children: [{ childId: mine, box: "climate-agency-0001", state: "idle", answers: { delivered: 1, undelivered: 2 }, moved: false, title: "Fix the build" }] })
  assert.deepEqual(await coordinator.handle({ op: "list", parent: parentB }), { state: "children", children: [{ childId: theirs, box: "climate-agency-0002", state: "stopped", answers: { delivered: 0, undelivered: 1 }, moved: false, title: null }] })
  const refused = (error: unknown) => error instanceof RequestError && error.code === "NOT_FOUND"
  await assert.rejects(coordinator.handle({ op: "ask", parent: parentA, childId: theirs, text: "more" }), refused)
  await assert.rejects(coordinator.handle({ op: "stop", parent: parentA, childId: theirs }), refused)
  await assert.rejects(coordinator.handle({ op: "ask", parent: parentA, childId: agent(99), text: "more" }), refused)
  assert.equal(sent("child-ask").length + sent("child-stop").length, 0)
  assert.deepEqual(await coordinator.handle({ op: "ask", parent: parentA, childId: mine, text: "more" }), { state: "accepted", childId: mine })
  assert.deepEqual(sent("child-ask").map(call => [call.hostId, call.payload]), [[boxId(1), { op: "child-ask", childId: mine, text: "more" }]])
})

test("a devbox may delegate only for its own agents", async () => {
  const other = "d".repeat(64)
  const { coordinator, calls } = world([host(devbox, "climate"), host(other, "other"), host(boxId(2), "climate-agency-0002")])
  for (const payload of [start(parentA), { op: "list", parent: parentA }, { op: "ask", parent: parentA, childId: agent(40), text: "more" }, { op: "stop", parent: parentA, childId: agent(40) }]) {
    const reply = await acceptUpward(payload, other, coordinator) as { ok: boolean; error?: { code: string; message: string } }
    assert.equal(reply.ok, false)
    assert.deepEqual(reply.error, { code: "INVALID", message: "a devbox may only delegate for its own agents" })
  }
  assert.equal(calls.length, 0)
  const malformed = await acceptUpward({ op: "list" }, devbox, coordinator) as { ok: boolean; error?: { code: string } }
  assert.equal(malformed.ok, false); assert.equal(malformed.error?.code, "INVALID")
  const unready = await acceptUpward({ op: "list", parent: parentA }, devbox, undefined) as { ok: boolean; error?: { code: string } }
  assert.equal(unready.error?.code, "UNAVAILABLE")
  const accepted = await acceptUpward({ op: "list", parent: parentA }, devbox, coordinator) as { protocol: string; ok: boolean; result: JsonObject }
  assert.deepEqual([accepted.protocol, accepted.ok, accepted.result], [REQUEST_PROTOCOL, true, { state: "children", children: [] }])
})

test("a child's parent is pinned when it starts or is first seen, and a box reply that changes it is not delivered", async () => {
  const seen = agent(60), redirected = entry("to someone else")
  const { boxes, coordinator, sent } = world([host(devbox, "climate"), host(boxId(1), "climate-agency-0001"), host(boxId(2), "climate-agency-0002")])
  boxes.set(boxId(1), [view(seen, parentA, [entry("first")])])
  coordinator.changed(boxId(1))
  await until(async () => sent("child-mark").length ? true : undefined)
  assert.deepEqual(sent("deliver").map(call => [call.hostId, call.payload.parentAgentId, call.payload.text]), [[devbox, parentA.agentId, "first"]])
  boxes.get(boxId(1))![0]!.parent = parentB
  boxes.get(boxId(1))![0]!.entries.push(redirected)
  const started = await coordinator.handle(start(parentA))
  assert.equal(started.box, "climate-agency-0002")
  boxes.get(boxId(2))![0]!.parent = parentB
  boxes.get(boxId(2))![0]!.entries.push(entry("also redirected"))
  coordinator.changed(boxId(1)); coordinator.changed(boxId(2))
  await until(async () => sent("children").length >= 4 ? true : undefined)
  await pause(50)
  assert.equal(sent("deliver").length, 1)
  assert.deepEqual(await coordinator.handle({ op: "list", parent: parentB }), { state: "children", children: [] })
  await assert.rejects(coordinator.handle({ op: "ask", parent: parentB, childId: seen, text: "more" }), (error: unknown) => error instanceof RequestError && error.code === "NOT_FOUND")
})

test("a malformed children entry is dropped and the other children still list and deliver", async () => {
  const good = agent(61), bad = view(agent(62), parentA, [entry("bad")])
  const { boxes, coordinator, sent } = world([host(devbox, "climate"), host(boxId(1), "climate-agency-0001")])
  const malformed = [{ ...bad, parent: { hostId: "laptop", agentId: parentA.agentId } }, { ...bad, childId: "not-a-uuid" }, { ...bad, depth: 1.5 }, { ...bad, stopped: "no" }, { ...bad, entries: [{ ...bad.entries[0]!, delivered: "no" }] }, { ...bad, entries: "none" }]
  boxes.set(boxId(1), [...malformed as never[], view(good, parentA, [entry("good")]), null as never, "child" as never])
  coordinator.changed(boxId(1))
  await until(async () => sent("child-mark").length ? true : undefined)
  await pause(50)
  assert.deepEqual(sent("deliver").map(call => [call.payload.childId, call.payload.text]), [[good, "good"]])
  const listed = await coordinator.handle({ op: "list", parent: parentA })
  assert.deepEqual((listed.children as JsonObject[]).map(child => child.childId), [good])
})

test("a start failure whose parent is gone is dropped after three NOT_FOUND replies", async () => {
  const { coordinator, sent } = world([host(devbox, "climate")], { deliver: async () => { throw new RequestError("NOT_FOUND", "parent agent is not live") } })
  await coordinator.handle(start(parentA))
  for (const count of [1, 2, 3]) {
    coordinator.tick()
    await until(async () => sent("deliver").length === count ? true : undefined)
    await pause(20)
  }
  coordinator.tick()
  await pause(50)
  assert.equal(sent("deliver").length, 3)
})

test("a start failure older than an hour is dropped even when its parent is only busy", async () => {
  let clock = Date.parse("2026-11-19T12:00:00.000Z")
  const { coordinator, sent } = world([host(devbox, "climate")], { now: () => clock, deliver: async () => { throw new RequestError("BUSY", "parent is busy") } })
  await coordinator.handle(start(parentA))
  for (const count of [1, 2, 3, 4]) {
    clock += 900000 - 1000
    coordinator.tick()
    await until(async () => sent("deliver").length === count ? true : undefined)
    await pause(20)
  }
  clock += 5000
  coordinator.tick()
  coordinator.changed(devbox)
  await pause(50)
  assert.equal(sent("deliver").length, 4)
})