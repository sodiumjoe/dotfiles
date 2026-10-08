import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { join } from "node:path"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { encodeFrame, receiveFrame } from "../src/control/wire.js"
import { dispatchBureau } from "../src/bureau/client.js"
import { BUREAU_PROTOCOL, exchangeBureau, parseBureauRequest, type BureauRequest } from "../src/bureau/protocol.js"
import { bureauFixture } from "./bureau-support.js"

test("private Bureau socket returns retained run identity and rejects stale Handler authority", async t => {
  const f = await bureauFixture(t), generation = (await f.host.raw.snapshot()).handlerGeneration
  const server = await bindPrivateSocket(f.root, "bureau.sock", socket => {
    socket.allowHalfOpen = true; socket.on("error", () => undefined)
    void (async () => {
      try { const request = parseBureauRequest(await receiveFrame(socket)); socket.end(encodeFrame(await dispatchBureau(f.core, generation, request))) }
      catch { socket.destroy() }
    })()
  })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const request: BureauRequest = { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "run_inspect" as const, runId: f.input.runId }
  const reply = await exchangeBureau(createConnection(join(f.root, "bureau.sock")), request)
  assert.equal(reply.ok, true)
  if (reply.ok) assert.equal((reply.result as { runId: string }).runId, f.input.runId)
  const before = f.host.launchCalls
  const stale = await dispatchBureau(f.core, generation, { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: randomUUID(), op: "assignment_create", commandId: randomUUID(), runId: f.input.runId, input: f.input.assignment, invocation: f.invocation })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, "STALE_HANDLER")
  assert.equal(f.host.launchCalls, before)
})

test("invalid Bureau request closes its transport without an orphan receiver", async t => {
  const f = await bureauFixture(t)
  const server = await bindPrivateSocket(f.root, "invalid.sock", socket => { socket.on("error", () => undefined); socket.end() })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const socket = createConnection(join(f.root, "invalid.sock"))
  socket.on("error", () => undefined)
  await assert.rejects(exchangeBureau(socket, { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: randomUUID(), op: "unknown" } as unknown as BureauRequest), /INVALID_PROTOCOL/)
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.equal(socket.destroyed, true)
})