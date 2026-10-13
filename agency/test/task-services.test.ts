import assert from "node:assert/strict"
import test from "node:test"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { join } from "node:path"
import { createHandlerBridge } from "../src/bridge/server.js"
import { startTaskServices, type CoordinationFactory } from "../src/handler/task-services.js"
import { createHostCoordination } from "../src/handler/host-coordination.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { BUREAU_PROTOCOL, exchangeBureau } from "../src/bureau/protocol.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

async function fixture(t: Parameters<typeof agentServiceFixture>[0]) {
  const f = await agentServiceFixture(t)
  const bridge = await createHandlerBridge({ root: f.root, identity: { hostId: f.context.paths.hostKey, handlerGeneration: f.service.handlerGeneration }, sourceRevision: "a".repeat(40) })
  bridge.register(["fixture-core"], async () => ({ live: true }))
  t.after(() => bridge.close())
  return { ...f, bridge }
}

function bounded<T>(value: Promise<T>): Promise<T> {
  return Promise.race([value, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("optional close blocked")), 1000); timer.unref() })])
}

test("optional construction rejection records a diagnostic", async t => {
  const f = await fixture(t), issues: unknown[] = []
  const services = startTaskServices({ root: f.root, paths: f.context.paths, generation: f.service.handlerGeneration, agents: f.service, bridge: f.bridge, issue: error => issues.push(error), coordinationFactory: async () => { throw new Error("unavailable") } })
  await until(async () => issues.length ? true : undefined)
  assert.match(String(issues[0]), /unavailable/)
  await bounded(services.close())
  assert.equal(await lstat(join(f.root, "orchestration.sock")).then(() => true, () => false), false)
})

test("close aborts a held constructor without waiting for its late result", async t => {
  const f = await fixture(t), entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>(), cleaned = Promise.withResolvers<void>()
  let closes = 0
  const coordinationFactory: CoordinationFactory = async input => {
    const value = await createHostCoordination(input)
    entered.resolve(input.signal!)
    await release.promise
    return { ...value, async close() { closes++; await value.close(); cleaned.resolve() } }
  }
  const services = startTaskServices({ root: f.root, paths: f.context.paths, generation: f.service.handlerGeneration, agents: f.service, bridge: f.bridge, coordinationFactory, issue: error => assert.fail(String(error)) })
  const signal = await entered.promise
  try {
    await bounded(services.close())
    assert.equal(signal.aborted, true)
    assert.equal(await lstat(join(f.root, "orchestration.sock")).then(() => true, () => false), false)
  } finally { release.resolve(); await cleaned.promise }
  assert.equal(closes, 1)
  await services.close()
  assert.equal(closes, 1)
})

test("partial socket acquisition closes coordination and the earlier listener", async t => {
  const f = await fixture(t), blocker = await bindPrivateSocket(f.root, "bureau.sock"), issues: unknown[] = []
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())))
  let closes = 0
  const services = startTaskServices({ root: f.root, paths: f.context.paths, generation: f.service.handlerGeneration, agents: f.service, bridge: f.bridge, issue: error => issues.push(error), coordinationFactory: async input => {
    const value = await createHostCoordination(input)
    return { ...value, async close() { closes++; await value.close() } }
  } })
  await until(async () => issues.length ? true : undefined)
  await services.close()
  assert.equal(closes, 1)
  assert.match(String(issues[0]), /bureau.sock.*already exists/)
  assert.equal(await lstat(join(f.root, "orchestration.sock")).then(() => true, () => false), false)
  assert.equal(await lstat(join(f.root, "bridge.sock")).then(() => true, () => false), true)
  assert.deepEqual(await f.bridge.dispatch("fixture-core", {}, new AbortController().signal), { live: true })
})

test("optional cleanup initiates coordination close without waiting for its queue", async t => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>()
  let closes = 0
  const services = startTaskServices({ root: f.root, paths: f.context.paths, generation: f.service.handlerGeneration, agents: f.service, bridge: f.bridge, issue: error => assert.fail(String(error)), coordinationFactory: async input => {
    const value = await createHostCoordination(input)
    return { ...value, async close() { closes++; entered.resolve(); await release.promise; await value.close(); finished.resolve() } }
  } })
  await until(async () => await lstat(join(f.root, "bureau.sock")).then(() => true, () => false) ? true : undefined)
  const socket = createConnection(join(f.root, "bureau.sock"))
  await new Promise<void>(resolve => socket.once("connect", resolve))
  try {
    await bounded(services.close())
    await entered.promise
    await until(async () => socket.destroyed ? true : undefined)
    assert.equal(closes, 1)
  } finally { socket.destroy(); release.resolve(); await finished.promise }
})

test("normal optional services eventually expose a working Bureau endpoint", async t => {
  const f = await fixture(t), issues: unknown[] = []
  const services = startTaskServices({ root: f.root, paths: f.context.paths, generation: f.service.handlerGeneration, agents: f.service, bridge: f.bridge, issue: error => issues.push(error) })
  t.after(() => services.close())
  await until(async () => await lstat(join(f.root, "bureau.sock")).then(() => true, () => false) ? true : undefined)
  const reply = await exchangeBureau(createConnection(join(f.root, "bureau.sock")), { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: f.service.handlerGeneration, op: "bureau_status" })
  assert.equal(reply.ok, true)
  assert.deepEqual(issues, [])
})

test("malformed Bureau settings report a diagnostic while the bridge remains usable", async t => {
  const f = await fixture(t), issues: unknown[] = []
  const settings = join(f.root, "bureau/settings/state.json"), content = JSON.stringify({ enabled: "invalid" })
  await mkdir(join(f.root, "bureau/settings"), { recursive: true, mode: 0o700 })
  await writeFile(settings, content, { mode: 0o600 })
  const services = startTaskServices({ root: f.root, paths: f.context.paths, generation: f.service.handlerGeneration, agents: f.service, bridge: f.bridge, issue: error => issues.push(error) })
  t.after(() => services.close())
  await until(async () => await lstat(join(f.root, "bureau.sock")).then(stat => stat.isSocket(), () => false) ? true : undefined)
  const peer = await connectHandlerBridge({ root: f.root, hostId: f.context.paths.hostKey, handlerGeneration: f.service.handlerGeneration })
  t.after(async () => { peer.close(); await peer.closed })
  await until(async () => { try { return await peer.request("snapshot", {}) } catch { return undefined } })
  const snapshot = await peer.request("snapshot", {}) as { hostId: string; handlerGeneration: string }
  assert.equal(snapshot.hostId, f.context.paths.hostKey)
  assert.equal(snapshot.handlerGeneration, f.service.handlerGeneration)
  const reply = await exchangeBureau(createConnection(join(f.root, "bureau.sock")), { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: f.service.handlerGeneration, op: "bureau_status" })
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.result, { enabled: false, ready: false, writeAvailable: false })
  assert.equal(await readFile(settings, "utf8"), content)
  assert.equal(issues.length, 1)
  assert.match(String(issues[0]), /INVALID_BUREAU/)
})