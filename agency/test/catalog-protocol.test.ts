import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import test from "node:test"
import { CATALOG_PROTOCOL, exchangeCatalog, parseCatalogReply, parseCatalogRequest, validateCatalogReply, type CatalogReply, type CatalogRequest } from "../src/catalog/protocol.js"
import { parseRequest, parseReply, type ControlReply } from "../src/control/protocol.js"
import { exchange, serveProtocols } from "../src/control/wire.js"
import { privateRoot, controlFixture } from "./control-support.js"

const generation = randomUUID()
const request = (): CatalogRequest => ({ protocol: CATALOG_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "model_refresh", commandId: randomUUID() })
const response = (r: CatalogRequest): CatalogReply => ({ protocol: CATALOG_PROTOCOL, requestId: r.requestId, handlerGeneration: generation, ok: true, result: { state: "refresh", command: { commandId: r.op === "model_refresh" ? r.commandId : randomUUID(), handlerGeneration: generation, state: "pending", snapshotId: null }, snapshot: null } })

test("catalog and legacy control schemas remain strictly separate", () => {
  const r = request(), reply = response(r)
  assert.deepEqual(parseCatalogRequest(r), r)
  assert.deepEqual(parseCatalogReply(reply), reply)
  assert.throws(() => parseRequest(r))
  assert.throws(() => parseReply(reply))
  for (const value of [{ ...r, protocol: "agency-catalog/2" }, { ...r, executable: "/bin/sh" }, { ...r, op: "model_start" }, { ...r, commandId: "bad" }, { ...r, handlerGeneration: "bad" }]) assert.throws(() => parseCatalogRequest(value), { code: "INVALID_PROTOCOL" })
  for (const value of [{ ...reply, extra: 1 }, { ...reply, ok: true, result: { state: "refresh", command: { commandId: randomUUID(), handlerGeneration: generation, state: "completed", snapshotId: randomUUID() }, snapshot: null } }]) assert.throws(() => parseCatalogReply(value), { code: "INVALID_PROTOCOL" })
  assert.throws(() => validateCatalogReply({ ...reply, requestId: randomUUID() }, r), { code: "INVALID_PROTOCOL" })
  assert.throws(() => validateCatalogReply({ ...reply, handlerGeneration: randomUUID() }, r), { code: "STALE_HANDLER" })
  assert.throws(() => validateCatalogReply(reply, { ...r, op: "model_list" }), { code: "INVALID_PROTOCOL" })
})

test("one private socket dispatches catalog and unchanged control frames", async t => {
  const root = await privateRoot(t), socketPath = join(root, "socket")
  const server = createServer({ allowHalfOpen: true }, socket => { void serveProtocols(socket, async r => ({ protocol: r.protocol, requestId: r.requestId, handlerGeneration: generation, ok: true, result: { hostId: "a".repeat(64), handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] } }), async r => response(r)) })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const r = request()
  assert.deepEqual(await exchangeCatalog(createConnection(socketPath), r), response(r))
  const old = await exchange(createConnection(socketPath), { protocol: "agency-control/1", requestId: randomUUID(), handlerGeneration: generation, op: "status" })
  assert.ok(old.ok)
  assert.deepEqual((old as ControlReply & { ok: true }).result, { hostId: "a".repeat(64), handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] })
})

for (const corrupt of [false, true]) test(`real Handler keeps legacy status healthy with catalog corruption=${corrupt}`, { timeout: 60000 }, async t => {
  const f = await controlFixture(t)
  if (corrupt) {
    await mkdir(join(f.paths.persistentRoot, "catalog"), { mode: 0o700 })
    await mkdir(join(f.paths.persistentRoot, "catalog/commands"), { mode: 0o700 })
    await writeFile(join(f.paths.persistentRoot, "catalog/commands", randomUUID() + ".json"), "malformed", { mode: 0o600 })
  }
  const handler = await f.start()
  const reply = await exchangeCatalog(createConnection(f.paths.handlerSocketPath), { protocol: CATALOG_PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.record.generation, op: "model_list" })
  assert.ok(reply.ok && reply.result.state === "catalog")
  if (reply.ok && reply.result.state === "catalog") {
    assert.equal(reply.result.discovery.state, corrupt ? "blocked" : "idle")
    assert.deepEqual(reply.result.providers.map(p => p.state), ["unconfigured", "unconfigured"])
  }
  const status = await f.call()
  assert.ok(status.ok && "phase" in status.result && status.result.phase === "ready")
  if (!corrupt) assert.equal((await readdir(f.paths.persistentRoot)).includes("catalog"), false)
  else {
    const refused = await f.call({ protocol: "agency-control/1", requestId: randomUUID(), handlerGeneration: handler.record.generation, op: "shutdown", commandId: randomUUID(), stopAgents: false })
    assert.ok(!refused.ok && refused.error.code === "INCOMPLETE")
  }
})