import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createRuntimeEntry, type RuntimeEditor } from "../src/entry/runtime.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

function fixture() {
  const ref = { hostId: "a".repeat(64), target: { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() } }, commandId = randomUUID()
  const editor: RuntimeEditor = { editorId: randomUUID(), session: "fixture", pane: "%1", tmuxSocketPath: "/fixture/tmux.sock" }
  let current = true, attached: RuntimeEditor | null = null, creations = 0, activations = 0, fail = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const driver = { ensure: async () => { creations++; return editor }, activate: async () => { activations++; await held; if (fail) throw new Error("activation failed"); attached = editor }, inspect: async () => attached }
  const make = () => createRuntimeEntry({ hostId: ref.hostId, generation: ref.target.handlerGeneration, validate: async () => current, driver })
  return { ref, commandId, editor, entry: make(), make, release, retire: () => { current = false }, fail: () => { fail = true }, missing: () => { attached = null }, counts: () => [creations, activations] }
}
test("concurrent opens publish one flight before asynchronous validation and never repeat effects", async () => {
  const f = fixture(), first = f.entry.open(f.commandId, f.ref), second = f.entry.open(f.commandId, f.ref)
  await until(async () => f.counts()[1] === 1 ? true : undefined)
  assert.equal((await f.entry.inspect(f.commandId))?.state, "opening")
  await assert.rejects(f.entry.open(f.commandId, { ...f.ref, target: { ...f.ref.target, agentId: randomUUID() } }), { code: "COMMAND_CONFLICT" })
  f.release(); const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(a.state, "opened")
  assert.equal((await f.entry.open(f.commandId, f.ref)).state, "opened"); assert.deepEqual(f.counts(), [1, 1])
  f.retire(); assert.equal((await f.entry.inspect(f.commandId))?.state, "stale"); assert.deepEqual(f.counts(), [1, 1])
  assert.equal(await f.make().inspect(f.commandId), null)
})
test("activation failures retain the editor and inspection never retries", async () => {
  const f = fixture(); f.fail(); f.release()
  const receipt = await f.entry.open(f.commandId, f.ref); assert.equal(receipt.state, "uncertain"); assert.deepEqual(receipt.editor, f.editor)
  assert.equal((await f.entry.open(f.commandId, f.ref)).state, "uncertain"); assert.deepEqual(f.counts(), [1, 1])
})
test("stale owners and providers fail before creating an editor", async () => {
  const f = fixture(); f.retire(); f.release()
  assert.equal((await f.entry.open(f.commandId, f.ref)).state, "stale")
  assert.equal((await f.entry.open(randomUUID(), { ...f.ref, hostId: "b".repeat(64) })).state, "stale")
  assert.deepEqual(f.counts(), [0, 0])
})
test("missing editors and unexpected validation errors leave uncertain observations", async () => {
  const f = fixture(); f.release(); await f.entry.open(f.commandId, f.ref); f.missing()
  assert.equal((await f.entry.inspect(f.commandId))?.state, "uncertain")
  const entry = createRuntimeEntry({ hostId: f.ref.hostId, generation: f.ref.target.handlerGeneration, validate: async () => { throw new Error("read failed") }, driver: {} as never })
  assert.equal((await entry.open(f.commandId, f.ref)).state, "uncertain")
})
test("held editor work does not occupy the real runtime mutation queue", async t => {
  const f = await agentServiceFixture(t), started = await f.service.start(f.input)
  const ready = await until(async () => { const value = await f.service.command(started.command.commandId, started.command.handlerGeneration); return value.command.state === "completed" ? value : undefined })
  const driver = fixture(), ref = { hostId: f.context.paths.hostKey, target: ready.command.target! }
  const entry = createRuntimeEntry({ hostId: ref.hostId, generation: ref.target.handlerGeneration, validate: async target => { await f.service.sessionSnapshot(target); return true }, driver: { ensure: async () => driver.editor, activate: async () => { await new Promise<void>(resolve => { t.after(() => resolve()); setTimeout(resolve, 200) }) }, inspect: async () => driver.editor } })
  const opening = entry.open(randomUUID(), ref)
  const values = await Promise.race([Promise.all([f.service.roster({ limit: 100 }), f.service.permissions.snapshot()]), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runtime blocked")), 150))])
  assert.equal(values[0].agents.length, 1); await opening
})