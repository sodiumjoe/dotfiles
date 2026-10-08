import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionRouting } from "../src/orchestration/permission-routing.js"
import { MutationQueue } from "../src/handler/mutations.js"

const params = { toolCall: { toolCallId: "edit", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }
test("restart never rebinds old pending handles and preserves completed receipts", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-permission-recovery-"))); t.after(() => rm(root, { recursive: true, force: true }))
  const hostId = "a".repeat(64), handlerGeneration = randomUUID(), target = { agentId: randomUUID(), handlerGeneration, providerGeneration: randomUUID() }
  const first = createPermissionRouting({ root, hostId, handlerGeneration, queue: new MutationQueue() }); await first.initialize()
  const pending = await first.open(target, params, "/work", async () => { assert.fail("retired handle") })
  const applied = await first.open({ ...target, agentId: randomUUID() }, params, "/work", async () => {})
  const commandId = randomUUID(), receipt = await first.decide(commandId, applied, "allow")
  const restarted = createPermissionRouting({ root, hostId, handlerGeneration: randomUUID(), queue: new MutationQueue() }); await restarted.initialize()
  assert.equal((await restarted.snapshot()).pending.length, 0)
  assert.deepEqual(await restarted.decide(commandId, applied, "allow"), receipt)
  assert.equal((await restarted.decide(randomUUID(), pending, "allow")).state, "stale")
  assert.equal((await restarted.decide(randomUUID(), applied, "allow")).state, "stale")
})

test("crash after claimed publication is uncertain and cannot resend", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-permission-crash-"))); t.after(() => rm(root, { recursive: true, force: true }))
  const hostId = "a".repeat(64), handlerGeneration = randomUUID(), target = { agentId: randomUUID(), handlerGeneration, providerGeneration: randomUUID() }
  const first = createPermissionRouting({ root, hostId, handlerGeneration, queue: new MutationQueue() }); await first.initialize()
  let started!: () => void, finish!: () => void
  const writing = new Promise<void>(resolve => { started = resolve })
  const ref = await first.open(target, params, "/work", () => { started(); return new Promise<void>(resolve => { finish = resolve }) })
  const commandId = randomUUID(), sent = first.decide(commandId, ref, "allow")
  await writing
  const recovered = createPermissionRouting({ root, hostId, handlerGeneration: randomUUID(), queue: new MutationQueue() }); await recovered.initialize()
  assert.equal((await recovered.decide(commandId, ref, "allow")).state, "uncertain")
  assert.equal((await recovered.snapshot()).pending.length, 0)
  finish(); await sent
})