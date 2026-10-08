import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createBureauPermissions } from "../src/bureau/permissions.js"
import { createPermissionRouting } from "../src/orchestration/permission-routing.js"
import type { OrchestrationHost } from "../src/bureau/host.js"

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-permission-bureau-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const hostId = "a".repeat(64), handlerGeneration = randomUUID(), origin = createPermissionRouting({ root, hostId, handlerGeneration })
  await origin.initialize()
  const acknowledged: number[] = []
  let writes = 0, routes = 0, lose = false, failBefore = false, ackFailure = false, enabled = true, offline = false
  let alterSnapshot: (value: any) => any = value => value
  const ref = await origin.open({ agentId: randomUUID(), handlerGeneration, providerGeneration: randomUUID() }, { toolCall: { toolCallId: "same", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, "/remote/work", async () => { writes++ })
  const host = {
    hostId, async snapshot() { if (offline) throw new Error("offline"); return { hostId, handlerGeneration, agents: [], receipts: [], backendChoices: [], replayFences: [], permissions: alterSnapshot(await origin.snapshot()) } },
    permissionRead: origin.read, async permissionAcknowledge(event) { if (ackFailure) throw new Error("lost ack"); await origin.acknowledge(event); acknowledged.push(event.seq) }, permissionInspect: origin.inspect,
    async permissionDecide(commandId, ref, optionId) { routes++; if (failBefore) throw new Error("disconnected"); const receipt = await origin.decide(commandId, ref, optionId); if (lose) { lose = false; throw new Error("lost reply") }; return receipt }
  } satisfies Partial<OrchestrationHost>
  const bureau = createBureauPermissions({ root, hosts: [host as unknown as OrchestrationHost], enabled: () => enabled })
  return { root, origin, ref, bureau, acknowledged, writes: () => writes, routes: () => routes, lose: () => { lose = true }, disconnect: () => { failBefore = true }, disable: () => { enabled = false }, ackFailure: (value: boolean) => { ackFailure = value }, offline: (value: boolean) => { offline = value }, alterSnapshot: (value: (snapshot: any) => any) => { alterSnapshot = value } }
}

test("Bureau persists exact origin offers before acknowledging their stream", async t => {
  const f = await fixture(t)
  const snapshot = await f.bureau.snapshot()
  assert.deepEqual(snapshot.pending.map(offer => offer.ref), [f.ref])
  const through = snapshot.hosts[0]!.throughSeq
  const retained = JSON.parse(await readFile(join(f.root, "bureau", "permission-hosts", f.ref.hostId + ".json"), "utf8"))
  assert.equal(retained.throughSeq, through)
  const receipt = await f.bureau.decide(randomUUID(), f.ref, "allow")
  assert.equal(receipt.state, "applied"); assert.equal(f.writes(), 1)
  assert.equal((await f.bureau.snapshot()).pending.length, 0)
})

test("lost decision replies reconcile the same origin receipt without a second response", async t => {
  const f = await fixture(t), commandId = randomUUID()
  f.lose()
  assert.equal((await f.bureau.decide(commandId, f.ref, "allow")).state, "uncertain")
  assert.equal((await f.bureau.decide(commandId, f.ref, "allow")).state, "applied")
  assert.equal(f.writes(), 1); assert.equal(f.routes(), 1)
})

test("an ambiguous route with no origin receipt cannot be blindly dispatched again", async t => {
  const f = await fixture(t), commandId = randomUUID()
  f.disconnect()
  assert.equal((await f.bureau.decide(commandId, f.ref, "allow")).state, "uncertain")
  assert.equal((await f.bureau.decide(commandId, f.ref, "allow")).state, "uncertain")
  assert.equal(f.routes(), 1); assert.equal(f.writes(), 0)
})

test("disabled Bureau cannot resolve an approval", async t => {
  const f = await fixture(t); f.disable()
  await assert.rejects(f.bureau.decide(randomUUID(), f.ref, "allow"), /BUREAU_DISABLED/)
  assert.equal(f.writes(), 0)
})

test("a lost permission acknowledgment is retried after the durable capture cursor advanced", async t => {
  const f = await fixture(t)
  f.ackFailure(true); await f.bureau.snapshot()
  assert.equal(f.acknowledged.length, 0)
  f.ackFailure(false); const current = await f.bureau.snapshot()
  assert.equal(current.pending.length, 1)
  assert.equal(f.acknowledged.at(-1), current.hosts[0]!.throughSeq)
})

test("permission snapshots expose unavailable origins instead of declaring an empty inbox", async t => {
  const f = await fixture(t)
  await f.bureau.snapshot(); f.offline(true)
  const snapshot = await f.bureau.snapshot()
  assert.deepEqual(snapshot.pending, [])
  assert.deepEqual((snapshot as any).unavailable, [{ hostId: f.ref.hostId, code: "ORIGIN_UNAVAILABLE" }])
})

test("a routed invalid option is rejected before consuming a decision command", async t => {
  const f = await fixture(t), commandId = randomUUID()
  await assert.rejects(f.bureau.decide(commandId, f.ref, "not-advertised"), /INVALID_OPTION/)
  assert.equal(await f.bureau.inspect(commandId), null)
  assert.equal(f.routes(), 0)
  assert.equal((await f.bureau.decide(commandId, f.ref, "allow")).state, "applied")
})

test("retained terminal evidence prevents a later snapshot from resurrecting an offer", async t => {
  const f = await fixture(t), first = await f.bureau.snapshot(), offer = first.pending[0]!
  await f.bureau.decide(randomUUID(), f.ref, "allow")
  f.alterSnapshot(value => ({ ...value, pending: [offer] }))
  const snapshot = await f.bureau.snapshot()
  assert.deepEqual(snapshot.pending, [])
  assert.equal(snapshot.unavailable.length, 1)
})

test("snapshot offers must preserve the opaque subject advertised in the origin journal", async t => {
  const f = await fixture(t)
  f.alterSnapshot(value => ({ ...value, pending: value.pending.map((offer: any) => ({ ...offer, subject: { ...offer.subject, title: "substituted" } })) }))
  const snapshot = await f.bureau.snapshot()
  assert.deepEqual(snapshot.pending, [])
  assert.equal(snapshot.unavailable.length, 1)
  assert.equal(f.acknowledged.length, 0)
})