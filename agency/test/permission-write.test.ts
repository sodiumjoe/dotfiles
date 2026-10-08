import assert from "node:assert/strict"
import test from "node:test"
import { scriptedAcp, sampleAgent, sampleContract } from "./agent-support.js"

async function waiting(t: Parameters<typeof scriptedAcp>[0]) {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) {
    send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "edit", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  void peer.connection.prompt("request", new AbortController().signal).catch(() => {})
  return peer
}

test("permission response exposes bounded IPC completion", async t => {
  const peer = await waiting(t)
  const completion = peer.connection.respond("permission", { outcome: { outcome: "selected", optionId: "allow" } })
  assert.equal(typeof (completion as unknown as Promise<void>)?.then, "function")
  await completion
})

test("a withheld writable callback keeps permission completion pending", async t => {
  const peer = await waiting(t), write = peer.writable.write.bind(peer.writable)
  let release!: (error?: Error | null) => void
  peer.writable.write = ((chunk: Buffer, callback: (error?: Error | null) => void) => write(chunk, () => { release = callback })) as typeof peer.writable.write
  let completed = false
  const completion = peer.connection.respond("permission", { outcome: { outcome: "selected", optionId: "allow" } })
  assert.equal(typeof (completion as unknown as Promise<void>)?.then, "function")
  void Promise.resolve(completion).then(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  release(); await completion; assert.equal(completed, true)
})

test("permission write errors reject completion and consume the transient handle", async t => {
  const peer = await waiting(t), write = peer.writable.write.bind(peer.writable)
  peer.writable.write = ((chunk: Buffer, callback: (error?: Error | null) => void) => write(chunk, () => callback(new Error("broken write")))) as typeof peer.writable.write
  const completion = peer.connection.respond("permission", { outcome: { outcome: "selected", optionId: "allow" } })
  assert.equal(typeof (completion as unknown as Promise<void>)?.then, "function")
  await assert.rejects(Promise.resolve(completion), /broken write/)
  assert.throws(() => peer.connection.respond("permission", { outcome: { outcome: "selected", optionId: "allow" } }), { code: "INVALID_PROTOCOL" })
})

test("permission write timeout stays rejected after a late callback", async t => {
  const peer = await waiting(t), write = peer.writable.write.bind(peer.writable)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let release!: (error?: Error | null) => void
  peer.writable.write = ((chunk: Buffer, callback: (error?: Error | null) => void) => write(chunk, () => { release = callback })) as typeof peer.writable.write
  const completion = peer.connection.respond("permission", { outcome: { outcome: "selected", optionId: "allow" } })
  const rejected = assert.rejects(completion, { code: "STARTUP_TIMEOUT" })
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(5001)
  await rejected; release()
  await assert.rejects(completion, { code: "STARTUP_TIMEOUT" })
})