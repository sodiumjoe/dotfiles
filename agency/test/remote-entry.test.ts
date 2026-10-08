import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createEntryController } from "../src/bureau/entry.js"

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-entry-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ref = { inventoryId: randomUUID(), hostId: "b".repeat(64), target: { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() } }
  let time = 1000, ready = true, creations = 0, activations = 0, crash = false, failBefore = false, binding: any = null
  const editor = { editorId: randomUUID(), session: "owned-entry", pane: "%1" }
  const driver = {
    async ensure() { creations++; return editor },
    async activate() { activations++; if (failBefore) throw new Error("no binding"); binding = editor; if (crash) throw new Error("lost activation reply") },
    async inspect() { return binding }
  }
  const create = () => createEntryController({ root, hostId: ref.hostId, handlerGeneration: ref.target.handlerGeneration, now: () => time,
    validate: async (target: any) => ready && JSON.stringify(target) === JSON.stringify(ref.target), driver })
  return { root, entry: create(), create, ref, editor, time: (value: number) => { time = value }, retire: () => { ready = false }, crash: () => { crash = true }, failBefore: () => { failBefore = true }, creations: () => creations, activations: () => activations }
}

test("entry preserves exact origin generations and consumes one durable human handoff", async t => {
  const f = await fixture(t), commandId = randomUUID(), intent = await f.entry.prepare(commandId, f.ref)
  assert.deepEqual(intent.ref, f.ref)
  assert.equal(intent.state, "prepared")
  const consumed = await f.entry.consume(commandId, intent.digest)
  assert.equal(consumed.state, "consumed")
  assert.deepEqual(consumed.editor, f.editor)
  assert.deepEqual(await f.entry.consume(commandId, intent.digest), consumed)
  assert.equal(f.creations(), 1); assert.equal(f.activations(), 1)
  await assert.rejects(f.entry.consume(commandId, "c".repeat(64)), /COMMAND_CONFLICT/)
})

test("expiry and provider retirement invalidate entry without creating an editor", async t => {
  const f = await fixture(t), first = await f.entry.prepare(randomUUID(), f.ref)
  f.time(first.expiresAt + 1)
  assert.equal((await f.entry.consume(first.commandId, first.digest)).state, "expired")
  f.time(1000); const second = await f.entry.prepare(randomUUID(), f.ref); f.retire()
  assert.equal((await f.entry.consume(second.commandId, second.digest)).state, "stale")
  assert.equal(f.creations(), 0)
})

test("a lost reply after editor attachment reconciles retained intent without recreating the editor", async t => {
  const f = await fixture(t), intent = await f.entry.prepare(randomUUID(), f.ref); f.crash()
  assert.equal((await f.entry.consume(intent.commandId, intent.digest)).state, "uncertain")
  const recovered = await f.create().consume(intent.commandId, intent.digest)
  assert.equal(recovered.state, "consumed")
  assert.equal(f.creations(), 1); assert.equal(f.activations(), 1)
})

test("uncertain entry with no exact attached editor never retries creation or attachment", async t => {
  const f = await fixture(t), intent = await f.entry.prepare(randomUUID(), f.ref)
  f.failBefore()
  assert.equal((await f.entry.consume(intent.commandId, intent.digest)).state, "uncertain")
  assert.equal((await f.create().consume(intent.commandId, intent.digest)).state, "uncertain")
  assert.equal(f.creations(), 1); assert.equal(f.activations(), 1)
})

test("concurrent identical entry consumption shares one editor action", async t => {
  const f = await fixture(t), intent = await f.entry.prepare(randomUUID(), f.ref)
  const [a, b] = await Promise.all([f.entry.consume(intent.commandId, intent.digest), f.create().consume(intent.commandId, intent.digest)])
  assert.deepEqual(a, b); assert.equal(f.creations(), 1); assert.equal(f.activations(), 1)
})

test("host replacement and Handler restart cannot consume a prepared intent", async t => {
  const f = await fixture(t), intent = await f.entry.prepare(randomUUID(), f.ref)
  const entry = createEntryController({ root: f.root, hostId: "c".repeat(64), handlerGeneration: randomUUID(), validate: async () => true, driver: {} as any })
  await assert.rejects(f.entry.prepare(intent.commandId, { ...f.ref, inventoryId: randomUUID() }), /COMMAND_CONFLICT/)
  assert.equal((await entry.consume(intent.commandId, intent.digest)).state, "stale")
  assert.equal(f.creations(), 0)
})

test("a retained consumed receipt cannot authorize terminal entry after provider retirement", async t => {
  const f = await fixture(t), intent = await f.entry.prepare(randomUUID(), f.ref)
  await f.entry.consume(intent.commandId, intent.digest)
  assert.equal(await f.entry.verify(intent.commandId, intent.digest), true)
  f.retire()
  assert.equal(await f.entry.verify(intent.commandId, intent.digest), false)
  assert.equal((await f.entry.inspect(intent.commandId))!.state, "consumed")
})