import { createJournal } from "../src/orchestration/journal.js"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { createPermissionHistory, createPermissionRouting, parsePermissionEvent, parsePermissionOffer, parsePermissionSnapshot } from "../src/orchestration/permission-routing.js"
import { createPermissionBroker } from "../src/acp/permissions.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { JsonObject } from "../src/agent/session-config.js"

const params: JsonObject = { sessionId: "native", toolCall: { toolCallId: "same-tool", title: "Edit", kind: "future-subject", locations: [{ path: "/workspace/file" }], opaque: { future: true } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject once", kind: "reject_once" }] }
async function fixture(t: TestContext, hostId = "a".repeat(64)) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-permissions-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const queue = new MutationQueue(), generation = randomUUID(), target = { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }
  const origin = createPermissionRouting({ root, hostId, handlerGeneration: generation, queue })
  let replies = 0
  const broker = createPermissionBroker({ routing: origin, cwd: () => "/workspace", async respond(_target, nativeId, result) { assert.equal(nativeId, 1); assert.equal((result.outcome as JsonObject).outcome, "selected"); replies++ } })
  await origin.initialize()
  return { root, hostId, queue, generation, target, origin, broker, replies: () => replies }
}

test("local and routed humans share one durable origin claim", async t => {
  const f = await fixture(t), frames: JsonObject[] = []
  f.broker.attach(f.target, { connectionId: "editor", send: frame => { frames.push(frame) } })
  await f.broker.open(f.target, 1, params)
  const [offer] = (await f.origin.snapshot()).pending
  assert.ok(offer)
  const [local, remote] = await Promise.all([
    f.broker.decision("editor", frames[0]!.id as string, { outcome: { outcome: "selected", optionId: "allow" } }),
    f.origin.decide(randomUUID(), offer.ref, "deny")
  ])
  assert.equal(local, true); assert.equal(remote.state, "withdrawn"); assert.equal(f.replies(), 1)
  assert.equal((await f.origin.snapshot()).pending.length, 0)
})

test("identical native and tool IDs on different origins preserve opaque offers", async t => {
  const a = await fixture(t), b = await fixture(t, "b".repeat(64))
  await Promise.all([a.broker.open(a.target, 1, params), b.broker.open(b.target, 1, params)])
  const [oa] = (await a.origin.snapshot()).pending, [ob] = (await b.origin.snapshot()).pending
  assert.ok(oa && ob); assert.notDeepEqual(oa.ref, ob.ref)
  assert.deepEqual(oa.subject, params.toolCall)
  assert.deepEqual(oa.options, params.options)
  assert.equal(oa.originCwd, "/workspace")
  assert.equal((await a.origin.decide(randomUUID(), ob.ref, "allow")).state, "stale")
  assert.equal((await b.origin.decide(randomUUID(), ob.ref, "deny")).state, "applied")
  assert.equal(a.replies(), 0); assert.equal(b.replies(), 1)
})

test("invalid option never claims and no observer is required", async t => {
  const f = await fixture(t)
  await f.broker.open(f.target, 1, params)
  const [offer] = (await f.origin.snapshot()).pending; assert.ok(offer)
  const commandId = randomUUID()
  await assert.rejects(f.origin.decide(commandId, offer.ref, "invented"), /INVALID_OPTION/)
  assert.equal(await f.origin.inspect(commandId), null)
  assert.equal((await f.origin.decide(commandId, offer.ref, "allow")).state, "applied")
  assert.equal(f.replies(), 1)
})

test("a delayed write cannot report applied or block Handler mutation", async t => {
  const f = await fixture(t)
  let complete!: () => void, initiated!: () => void
  const started = new Promise<void>(resolve => { initiated = resolve })
  const ref = await f.origin.open(f.target, params, "/workspace", () => { initiated(); return new Promise<void>(resolve => { complete = resolve }) })
  const commandId = randomUUID(), pending = f.origin.decide(commandId, ref, "allow")
  await started
  assert.equal((await f.origin.inspect(commandId))!.state, "claimed")
  assert.equal(await f.queue.run(async () => "available"), "available")
  const duplicate = f.origin.decide(commandId, ref, "allow")
  assert.equal((await f.origin.decide(randomUUID(), ref, "deny")).state, "withdrawn")
  await assert.rejects(f.origin.decide(commandId, ref, "deny"), /COMMAND_CONFLICT/)
  complete()
  assert.equal((await pending).state, "applied"); assert.deepEqual(await duplicate, await pending)
})

test("failed write consumes the request and replay cannot resend", async t => {
  const f = await fixture(t)
  let writes = 0
  const ref = await f.origin.open(f.target, params, "/workspace", async () => { writes++; throw new Error("write failed") })
  const commandId = randomUUID(), receipt = await f.origin.decide(commandId, ref, "allow")
  assert.equal(receipt.state, "uncertain")
  assert.deepEqual(await f.origin.decide(commandId, ref, "allow"), receipt)
  assert.equal((await f.origin.decide(randomUUID(), ref, "deny")).state, "withdrawn")
  assert.equal(writes, 1); assert.equal((await f.origin.snapshot()).pending.length, 0)
})

test("generation retirement withdraws only exact references", async t => {
  const f = await fixture(t)
  await f.broker.open(f.target, 1, params)
  const [old] = (await f.origin.snapshot()).pending; assert.ok(old)
  await f.origin.invalidate(f.target)
  const current = { ...f.target, providerGeneration: randomUUID() }
  await f.broker.open(current, 1, params)
  assert.equal((await f.origin.decide(randomUUID(), old.ref, "allow")).state, "stale")
  assert.deepEqual((await f.origin.snapshot()).pending[0]!.ref.target, current)
  assert.equal(f.replies(), 0)
})

test("permission stream contains no native session or request handles", async t => {
  const f = await fixture(t)
  const ref = await f.origin.open(f.target, params, "/workspace", async () => {})
  await f.origin.decide(randomUUID(), ref, "allow")
  const walk = async (path: string): Promise<string[]> => {
    const result: string[] = []
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) result.push(...await walk(child))
      else result.push(await readFile(child, "utf8"))
    }
    return result
  }
  const saved = (await walk(f.root)).join(" ")
  assert.equal(saved.includes('"sessionId"'), false)
  assert.equal(saved.includes('"providerId"'), false)
  assert.equal(saved.includes('"native"'), false)
})

test("cancellation before first write initiation withdraws a persisted claim", async t => {
  const f = await fixture(t), journal = createJournal(f.root, undefined, Date.now, { kind: "permissions", hostId: f.hostId })
  let claimed!: () => void, release!: () => void
  const storing = new Promise<void>(resolve => { claimed = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const origin = createPermissionRouting({ root: f.root, hostId: f.hostId, handlerGeneration: f.generation, queue: f.queue, journal: { ...journal, async append(eventId, kind, payload) {
    const event = payload as { kind: string; receipt?: { state: string } }
    const entry = await journal.append(eventId, kind, payload)
    if (event.kind === "receipt" && event.receipt?.state === "claimed") { claimed(); await held }
    return entry
  } } })
  await origin.initialize()
  let writes = 0
  const ref = await origin.open(f.target, params, "/workspace", async () => { writes++ })
  const deciding = origin.decide(randomUUID(), ref, "allow")
  await storing; const withdrawn = origin.invalidate(f.target); release()
  assert.equal((await deciding).state, "withdrawn"); await withdrawn
  assert.equal(writes, 0); assert.equal((await origin.snapshot()).pending.length, 0)
})

test("receipt publication failure after a successful write cannot reopen the claim", async t => {
  const f = await fixture(t), journal = createJournal(f.root, undefined, Date.now, { kind: "permissions", hostId: f.hostId })
  const origin = createPermissionRouting({ root: f.root, hostId: f.hostId, handlerGeneration: f.generation, queue: f.queue, journal: { ...journal, async append(eventId, kind, payload) {
    const event = payload as { kind: string; receipt?: { state: string } }
    if (event.kind === "receipt" && event.receipt?.state === "applied") throw new Error("ENOSPC")
    return journal.append(eventId, kind, payload)
  } } })
  await origin.initialize()
  let writes = 0
  const ref = await origin.open(f.target, params, "/workspace", async () => { writes++ })
  assert.equal((await origin.decide(randomUUID(), ref, "allow")).state, "uncertain")
  await assert.rejects(origin.decide(randomUUID(), ref, "deny"), /PERMISSIONS_UNAVAILABLE/)
  assert.deepEqual(origin.status(), { available: false, issue: "ENOSPC" })
  const recovered = createPermissionRouting({ root: f.root, hostId: f.hostId, handlerGeneration: randomUUID(), queue: new MutationQueue() }); await recovered.initialize()
  assert.equal((await recovered.snapshot()).pending.length, 0); assert.equal(writes, 1)
})

for (const expanded of [false, true]) test("long permission labels " + (expanded ? "beyond the former cap" : "from the pinned adapter synthetic fixture") + " survive replay and one native decision", async t => {
  const f = await fixture(t), request = JSON.parse(await readFile(new URL("../../test/fixtures/codex-long-permission.json", import.meta.url), "utf8"))
  assert.equal(Buffer.byteLength(request.options[2].name), 864)
  if (expanded) request.options[2].name = "é".repeat(65537)
  const frames: JsonObject[] = []
  f.broker.attach(f.target, { connectionId: "editor", send: frame => { frames.push(frame) } })
  await f.broker.open(f.target, 1, request)
  const snapshot = await f.origin.snapshot(), offer = snapshot.pending[0]!
  assert.deepEqual(parsePermissionSnapshot(snapshot), snapshot)
  assert.deepEqual(offer.options, request.options); assert.deepEqual(offer.subject, request.toolCall)
  assert.deepEqual((frames[0]!.params as JsonObject).options, request.options)
  const history = createPermissionHistory(f.hostId), journal = createJournal(f.root, undefined, Date.now, { kind: "permissions", hostId: f.hostId })
  for (const entry of (await journal.retainedRead(0, 256)).entries) history.apply(parsePermissionEvent(entry.payload))
  assert.deepEqual([...history.offers.values()][0], offer)
  const commandId = randomUUID(), receipt = await f.origin.decide(commandId, offer.ref, "allow_once")
  assert.equal(receipt.state, "applied"); assert.equal(f.replies(), 1)
  const recovered = createPermissionRouting({ root: f.root, hostId: f.hostId, handlerGeneration: randomUUID() })
  await recovered.initialize()
  assert.deepEqual(await recovered.inspect(commandId), receipt)
  assert.equal((await recovered.snapshot()).pending.length, 0); assert.equal(f.replies(), 1)
})

test("permission display labels have no field-length cap and preserve aggregate bounds with unchanged option IDs", async t => {
  const f = await fixture(t), offer = { ref: { hostId: f.hostId, target: f.target, permissionId: randomUUID(), revision: 1 }, title: "Permission", subject: {}, originCwd: "/workspace", toolCallId: "tool", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }
  for (const name of ["a".repeat(65536), "a".repeat(65537), "é".repeat(65537), "x".repeat(524288)]) {
    assert.equal(parsePermissionOffer({ ...offer, options: [{ ...offer.options[0], name }] }).options[0]!.name, name)
  }
  for (const name of [null, 42, "", "bad\u0000", "bad\n", "bad\u009f", "\ud800"]) assert.throws(() => parsePermissionOffer({ ...offer, options: [{ ...offer.options[0], name }] }), { code: "INVALID_CATALOG" })
  assert.equal(parsePermissionOffer({ ...offer, options: [{ ...offer.options[0], optionId: "x".repeat(256) }] }).options[0]!.optionId, "x".repeat(256))
  assert.throws(() => parsePermissionOffer({ ...offer, options: [{ ...offer.options[0], optionId: "x".repeat(257) }] }), { code: "INVALID_CATALOG" })
  assert.throws(() => parsePermissionOffer({ ...offer, options: [offer.options[0], offer.options[0]] }), /INVALID_PERMISSION/)
  const oversized = { ...offer, options: Array.from({ length: 17 }, (_, i) => ({ optionId: String(i), name: "x".repeat(65536), kind: "allow_once" })) }
  assert.throws(() => parsePermissionOffer(oversized), /RECORD_TOO_LARGE/)
  assert.throws(() => parsePermissionOffer({ ...offer, options: [{ ...offer.options[0], name: "x".repeat(1048576) }] }), /RECORD_TOO_LARGE/)
  assert.throws(() => parsePermissionSnapshot({ hostId: f.hostId, handlerGeneration: f.generation, throughSeq: 0, pending: Array.from({ length: 17 }, () => parsePermissionOffer({ ...offer, ref: { ...offer.ref, permissionId: randomUUID() }, options: [{ ...offer.options[0], name: "x".repeat(65536) }] })), receipts: [] }), /RECORD_TOO_LARGE/)
})