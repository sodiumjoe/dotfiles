import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createPermissionArbiter } from "../src/agent/permission-arbiter.js"
import { parsePermissionRef, parsePermissionOffer, parsePermissionReceipt, parsePermissionSnapshot } from "../src/agent/permission-types.js"
import { createPermissionBroker } from "../src/acp/permissions.js"
import type { JsonObject } from "../src/agent/session-config.js"

function fixture() {
  const hostId = "a".repeat(64), handlerGeneration = randomUUID()
  const target = { agentId: randomUUID(), handlerGeneration, providerGeneration: randomUUID() }
  const params = { toolCall: { toolCallId: "tool-1", title: "Execute" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }
  return { hostId, handlerGeneration, target, params, arbiter: createPermissionArbiter({ hostId, handlerGeneration }) }
}

test("one callback wins while inspection remains available and claimed metadata survives settlement", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  let callbacks = 0
  const ref = await f.arbiter.open(f.target, f.params, "/tmp", async () => { callbacks++; await gate.promise })
  const commandId = randomUUID(), first = f.arbiter.decide(commandId, ref, "allow"), duplicate = f.arbiter.decide(commandId, ref, "allow")
  try {
    assert.equal((await f.arbiter.decide(randomUUID(), ref, "deny")).state, "withdrawn")
    assert.equal((await f.arbiter.inspect(commandId))?.state, "claimed")
    assert.equal((await f.arbiter.snapshot()).pending.length, 0)
    assert.equal(callbacks, 1)
    await assert.rejects(f.arbiter.decide(randomUUID(), ref, "invalid"), { code: "USAGE" })
  } finally { gate.resolve() }
  assert.equal((await first).state, "applied"); assert.deepEqual(await duplicate, await first)
  assert.equal((await f.arbiter.decide(randomUUID(), ref, "deny")).state, "withdrawn")
  await f.arbiter.invalidate(f.target)
  assert.equal((await f.arbiter.decide(randomUUID(), ref, "allow")).state, "stale")
  assert.equal(callbacks, 1); f.arbiter.close()
})

test("validation preserves pending offers and command identity across host boundaries", async () => {
  const f = fixture(); let calls = 0
  const ref = await f.arbiter.open(f.target, { ...f.params, options: [{ ...f.params.options[0]!, name: "x".repeat(20000) }] }, "/tmp", async () => { calls++ })
  await assert.rejects(f.arbiter.decide(randomUUID(), ref, "bad"), { code: "USAGE" })
  assert.equal((await f.arbiter.snapshot()).pending.length, 1)
  const commandId = randomUUID(), receipt = await f.arbiter.decide(commandId, ref, "allow")
  assert.equal(receipt.state, "applied"); assert.equal(calls, 1)
  for (const other of [{ ...ref, hostId: "b".repeat(64) }, { ...ref, target: { ...ref.target, providerGeneration: randomUUID() } }]) await assert.rejects(f.arbiter.decide(commandId, other, "allow"), { code: "COMMAND_CONFLICT" })
  const foreignId = randomUUID()
  assert.equal((await f.arbiter.decide(foreignId, { ...ref, hostId: "b".repeat(64) }, "allow")).state, "stale")
  assert.equal(await f.arbiter.inspect(foreignId), null)
  assert.throws(() => parsePermissionReceipt({ ...receipt, digest: "f".repeat(64) }), { code: "INVALID_PROTOCOL" })
  for (const value of [{ ...ref, revision: 0 }, { ...ref, target: { ...ref.target, agentId: "bad" } }, { ...ref, extra: true }]) assert.throws(() => parsePermissionRef(value), { code: "INVALID_PROTOCOL" })
  for (const options of [[], [f.params.options[0], f.params.options[0]], [{ ...f.params.options[0], kind: "invalid" }]]) assert.throws(() => parsePermissionOffer({ ref, title: "Execute", subject: f.params.toolCall, options, originCwd: "/tmp", toolCallId: "tool-1" }), { code: "INVALID_PROTOCOL" })
  f.arbiter.close()
})

for (const asynchronous of [false, true]) test(`callback ${asynchronous ? "rejection" : "throw"} is uncertain and never retried`, async () => {
  const f = fixture(); let calls = 0
  const ref = await f.arbiter.open(f.target, f.params, "/tmp", () => { calls++; if (asynchronous) return Promise.reject(new Error("write failed")); throw new Error("write failed") })
  const commandId = randomUUID(), receipt = await f.arbiter.decide(commandId, ref, "allow")
  assert.equal(receipt.state, "uncertain"); assert.deepEqual(await f.arbiter.decide(commandId, ref, "allow"), receipt)
  assert.equal((await f.arbiter.decide(randomUUID(), ref, "deny")).state, "withdrawn"); assert.equal(calls, 1)
  f.arbiter.close()
})

test("invalidation before claim prevents callback while a claimed callback is not reopened", async () => {
  const f = fixture(); let calls = 0
  const ref = await f.arbiter.open(f.target, f.params, "/tmp", async () => { calls++ })
  const invalidated = f.arbiter.invalidate(f.target), decision = f.arbiter.decide(randomUUID(), ref, "allow")
  await invalidated; assert.equal((await decision).state, "stale"); assert.equal(calls, 0)
  const next = await f.arbiter.open(f.target, f.params, "/tmp", async () => { calls++ })
  await f.arbiter.invalidate({ ...f.target, providerGeneration: randomUUID() })
  assert.equal((await f.arbiter.decide(randomUUID(), next, "allow")).state, "applied")
  f.arbiter.close()
})

test("fresh owner has no history and accepts only current-generation snapshots except new stale refusals", async () => {
  const f = fixture(); let calls = 0
  const ref = await f.arbiter.open(f.target, f.params, "/tmp", async () => { calls++ }), commandId = randomUUID()
  const old = await f.arbiter.decide(commandId, ref, "allow")
  const fresh = createPermissionArbiter({ hostId: f.hostId, handlerGeneration: randomUUID() })
  assert.equal(await fresh.inspect(commandId), null)
  assert.deepEqual((await fresh.snapshot()).receipts, [])
  const stale = await fresh.decide(randomUUID(), ref, "allow")
  assert.equal(stale.state, "stale"); assert.equal(calls, 1)
  const snapshot = await fresh.snapshot(); assert.deepEqual(parsePermissionSnapshot(snapshot), snapshot)
  for (const state of ["claimed", "applied", "uncertain", "withdrawn"]) assert.throws(() => parsePermissionSnapshot({ ...snapshot, receipts: [{ ...old, state }] }), { code: "INVALID_PROTOCOL" })
  assert.equal((await f.arbiter.decide(randomUUID(), { ...ref, target: { ...ref.target, providerGeneration: randomUUID() } }, "allow")).state, "stale")
  f.arbiter.close(); fresh.close()
})

test("broker detach preserves owner callback and close withdraws every editor offer", async () => {
  const f = fixture(), frames: JsonObject[] = []; let replies = 0
  const broker = createPermissionBroker({ routing: f.arbiter, cwd: () => "/tmp", respond: () => { replies++ } })
  const client = { connectionId: randomUUID(), send: (frame: JsonObject) => frames.push(frame) }
  broker.attach(f.target, client); await broker.open(f.target, 1, f.params)
  const first = frames.at(-1)!.id!
  broker.detach(client.connectionId); broker.attach(f.target, client)
  const second = frames.at(-1)!.id!; assert.notEqual(second, first)
  assert.equal(await broker.decision(client.connectionId, first as string, { outcome: { outcome: "selected", optionId: "allow" } }), false)
  assert.equal(await broker.decision(client.connectionId, second as string, { outcome: { outcome: "selected", optionId: "allow" } }), true)
  assert.equal(replies, 1)
  await broker.open(f.target, 2, f.params); f.arbiter.close()
  assert.equal(frames.at(-1)!.method, "agency/permission_withdrawn")
  await assert.rejects(f.arbiter.snapshot(), { code: "UNAVAILABLE" })
})

test("close does not wait for a blocked callback or retain settled receipts", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const ref = await f.arbiter.open(f.target, f.params, "/tmp", async () => { entered.resolve(); await gate.promise })
  const decision = f.arbiter.decide(randomUUID(), ref, "allow")
  await entered.promise; f.arbiter.close()
  await assert.rejects(f.arbiter.inspect(randomUUID()), { code: "UNAVAILABLE" })
  gate.resolve(); assert.equal((await decision).state, "applied")
})

test("listener failures and caller mutations cannot change owner permission state", async () => {
  const f = fixture(); let calls = 0
  f.arbiter.subscribe(() => { throw new Error("listener failed") })
  f.arbiter.subscribe(event => {
    if (event.kind === "receipt") { event.receipt.state = "uncertain"; event.receipt.ref.target.agentId = randomUUID() }
    else event.ref.target.agentId = randomUUID()
  })
  const ref = await f.arbiter.open(f.target, f.params, "/tmp", async () => { calls++ })
  f.params.options[0]!.optionId = "changed"
  const snapshot = await f.arbiter.snapshot()
  snapshot.pending[0]!.options[0]!.optionId = "changed-again"
  snapshot.pending[0]!.ref.target.agentId = randomUUID()
  const commandId = randomUUID(), receipt = await f.arbiter.decide(commandId, ref, "allow")
  assert.equal(receipt.state, "applied"); assert.equal(calls, 1)
  receipt.state = "uncertain"; receipt.ref.target.agentId = randomUUID()
  const inspected = await f.arbiter.inspect(commandId)
  assert.equal(inspected?.state, "applied"); assert.equal(inspected?.ref.target.agentId, f.target.agentId)
  assert.equal((await f.arbiter.decide(randomUUID(), ref, "deny")).state, "withdrawn")
  f.arbiter.close()
})