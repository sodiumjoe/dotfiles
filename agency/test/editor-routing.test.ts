import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { once } from "node:events"
import { lstat } from "node:fs/promises"
import { createServer, createConnection, Server, type Socket } from "node:net"
import { join } from "node:path"
import { startEditorRouting } from "../src/agent/editor-routing.js"
import { privateRoot, until } from "./control-support.js"

async function editor(t: TestContext, root: string, name: string) {
  const connections: Socket[] = [], server = createServer(socket => { connections.push(socket); socket.on("error", () => {}); socket.pipe(socket) })
  const path = join(root, name)
  server.listen(path); await once(server, "listening")
  t.after(() => { for (const socket of connections) socket.destroy(); server.close() })
  return { path, connections }
}
async function connect(t: TestContext, path: string): Promise<Socket> {
  const socket = createConnection(path)
  socket.on("error", () => {}); t.after(() => socket.destroy())
  await once(socket, "connect")
  return socket
}
async function exchange(socket: Socket, bytes: Buffer): Promise<void> {
  const result = once(socket, "data")
  socket.write(bytes)
  assert.deepEqual((await result)[0], bytes)
}

test("editor proxy forwards opaque bytes both ways only to the accepted origin", async t => {
  const root = await privateRoot(t), a = await editor(t, root, "a"), b = await editor(t, root, "b"), routing = await startEditorRouting(root)
  t.after(() => routing.close())
  const attachment = routing.attach("a", a.path)
  routing.attach("b", b.path)
  routing.begin("turn", { connectionId: "a", attachment })
  const socket = await connect(t, routing.path)
  await exchange(socket, Buffer.from([0x93, 0, 0xc4, 0, 0xff, 0xd4, 0x01, 0x80]))
  assert.equal(b.connections.length, 0)
  const incoming = once(socket, "data")
  a.connections[0]!.write(Buffer.from([0x92, 0x02, 0xa0]))
  assert.deepEqual((await incoming)[0], Buffer.from([0x92, 0x02, 0xa0]))
})

test("editor proxy refuses idle commands even with attached editors", async t => {
  const root = await privateRoot(t), a = await editor(t, root, "a"), routing = await startEditorRouting(root)
  t.after(() => routing.close()); routing.attach("a", a.path)
  const socket = await connect(t, routing.path)
  await until(async () => socket.destroyed ? true : undefined)
  assert.equal(a.connections.length, 0)
})

for (const action of ["detach", "replace", "end", "close"] as const) test(`editor proxy revokes established channels on ${action}`, async t => {
  const root = await privateRoot(t), a = await editor(t, root, "a"), b = await editor(t, root, "b"), routing = await startEditorRouting(root)
  t.after(() => routing.close())
  const attachment = routing.attach("a", a.path)
  routing.begin("turn", { connectionId: "a", attachment })
  const socket = await connect(t, routing.path)
  await exchange(socket, Buffer.from("before")); routing.attach("b", b.path)
  if (action === "detach") routing.detach("a", attachment)
  else if (action === "replace") routing.attach("a", a.path)
  else if (action === "end") routing.end("turn")
  else routing.close()
  await until(async () => socket.destroyed && a.connections[0]!.destroyed ? true : undefined)
  assert.equal(b.connections.length, 0)
  if (action !== "close") {
    const next = await connect(t, routing.path)
    await until(async () => next.destroyed ? true : undefined)
  }
})

test("attachment identity guards refresh, late detach and late settlement", async t => {
  const root = await privateRoot(t), a = await editor(t, root, "a"), b = await editor(t, root, "b"), routing = await startEditorRouting(root)
  t.after(() => routing.close())
  const old = routing.attach("a", a.path), attachment = routing.attach("a", a.path)
  assert.notEqual(old, attachment)
  assert.throws(() => routing.begin("stale", { connectionId: "a", attachment: old }), { code: "STALE_ATTACHMENT" })
  routing.detach("a", old)
  routing.begin("current", { connectionId: "a", attachment, address: b.path })
  routing.end("stale")
  const socket = await connect(t, routing.path)
  await exchange(socket, Buffer.from("current"))
  assert.equal(a.connections.length, 0); assert.equal(b.connections.length, 1)
})

test("private editor listener has a bounded unique path and idempotent disposal", async t => {
  const root = await privateRoot(t), routing = await startEditorRouting(root)
  t.after(() => routing.close())
  assert.ok(Buffer.byteLength(routing.path) <= 99)
  assert.equal((await lstat(routing.path)).mode & 0o777, 0o600)
  assert.throws(() => routing.attach("self", routing.path))
  routing.close(); routing.close()
  await until(async () => { try { await lstat(routing.path); return undefined } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error } })
  const next = await startEditorRouting(root)
  t.after(() => next.close()); assert.notEqual(next.path, routing.path)
})

test("editor listener failure revokes RPC channels without rejecting later turns", async t => {
  const root = await privateRoot(t), a = await editor(t, root, "a")
  let listener: Server | undefined
  const listen = Server.prototype.listen
  const capture = t.mock.method(Server.prototype, "listen", function(this: Server, ...args: Parameters<Server["listen"]>) {
    listener = this
    return listen.apply(this, args)
  })
  const routing = await startEditorRouting(root)
  capture.mock.restore(); t.after(() => routing.close())
  const attachment = routing.attach("a", a.path)
  routing.begin("first", { connectionId: "a", attachment })
  const socket = await connect(t, routing.path)
  await exchange(socket, Buffer.from("before failure"))
  listener!.emit("error", new Error("listener failed"))
  await until(async () => socket.destroyed ? true : undefined)
  assert.doesNotThrow(() => routing.begin("second", { connectionId: "a", attachment }))
  assert.doesNotThrow(() => routing.begin("shell"))
  const replacement = routing.attach("b", a.path)
  assert.doesNotThrow(() => routing.begin("third", { connectionId: "b", attachment: replacement }))
  routing.detach("a", attachment)
  assert.throws(() => routing.begin("stale", { connectionId: "a", attachment }), { code: "STALE_ATTACHMENT" })
  routing.close()
  assert.throws(() => routing.begin("closed"), { code: "STALE_ATTACHMENT" })
})