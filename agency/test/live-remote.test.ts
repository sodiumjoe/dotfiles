import { fixtureBridgeSpawner } from "./fixtures/fixture-bridge.js"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { liveHandlerFixture } from "./live-support.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { runRuntimeEntryHelper } from "../src/entry/cli.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"

async function remote(t: import("node:test").TestContext) {
  const f = await liveHandlerFixture(t), record = await f.handler(), hostId = f.paths.hostKey, spawnBridge = await fixtureBridgeSpawner()
  const transport = await connectBridge({ hostId, hostname: "fixture" }, { action: "internal-runtime-bridge", requiredCapabilities: ["live-read", "live-wait"], processFactory: () => spawnBridge(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  return { f, record, transport }
}

test("a remote serves its live agents and a change doorbell", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t), { agentId } = await f.start()
  assert.ok(transport.hello.capabilities.includes("live-read") && transport.hello.capabilities.includes("live-wait"))
  const stopped = await f.start()
  await f.prompt(stopped.agentId, "hello")
  await f.stop(stopped.agentId)
  const list = await transport.request("live-read", { op: "agents" }) as { handlerGeneration: string; agents: Array<{ agentId: string }> }
  assert.equal(list.handlerGeneration, (await f.handler()).generation)
  assert.deepEqual(list.agents.map(row => row.agentId), [agentId])
  const wait = (after: string | null, waitMs: number) => transport.request("live-wait", { after, waitMs }, { timeoutMs: waitMs + 5000 }) as Promise<{ revision: string }>
  const first = (await wait(null, 8000)).revision
  const started = Date.now()
  assert.equal((await wait(first, 500)).revision, first)
  assert.ok(Date.now() - started >= 450)
  const changing = wait(first, 8000), since = Date.now()
  await f.start()
  assert.notEqual((await changing).revision, first)
  assert.ok(Date.now() - since < 7000)
  await assert.rejects(transport.request("live-read", { op: "stop", agentId }))
  await assert.rejects(transport.request("live-wait", { after: null, waitMs: 9000 }))
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("a bridge closes when the Handler behind it stops", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t)
  await f.stopHandler()
  const closed = await Promise.race([transport.closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 10000))])
  assert.ok(closed, "the bridge stayed open after its Handler stopped")
  await f.restart()
  await f.verifyZeroSurvivors()
})

test("a remote serves excerpts, approvals and decisions on the request channel", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  assert.ok(transport.hello.capabilities.includes("live-request"))
  const excerpt = await transport.request("live-request", { op: "excerpt", agentId, turns: 4 }) as { ok: boolean; result: { turns: unknown[] } }
  assert.ok(excerpt.ok)
  assert.deepEqual(excerpt.result.turns, [{ role: "user", text: "hello" }, { role: "agent", text: "answer:hello" }])
  const permissions = await transport.request("live-request", { op: "permissions" }) as { ok: boolean; result: { state: string; snapshot: { hostId: string } } }
  assert.ok(permissions.ok)
  assert.deepEqual([permissions.result.state, permissions.result.snapshot.hostId], ["permissions", f.paths.hostKey])
  const handler = await f.handler()
  const ref = { hostId: f.paths.hostKey, target: { agentId, handlerGeneration: handler.generation, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }
  const decided = await transport.request("live-request", { op: "decide", ref, optionId: "allow" }) as { ok: boolean; result: { state: string; receipt: { state: string } } }
  assert.ok(decided.ok)
  assert.deepEqual([decided.result.state, decided.result.receipt.state], ["permission", "stale"])
  await assert.rejects(transport.request("live-request", { op: "stop", agentId }))
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("the devbox entry helper attaches through its own Handler's bridge", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t), started = await f.start(), handler = await f.handler()
  const ref = { hostId: f.paths.hostKey, target: { agentId: started.agentId, handlerGeneration: handler.generation, providerGeneration: started.live!.providerGeneration } }
  const commandId = randomUUID()
  assert.equal((await transport.request("entry-open", { commandId, ref }) as { state: string }).state, "opened")
  const attached: string[][] = []
  const deps = { environment: async () => ({ paths: f.paths, adapter: f.adapter }), inspect: (env: { paths: typeof f.paths; adapter: typeof f.adapter }) => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter), connect: connectHandlerBridge, stderr: () => {} }
  assert.equal(await runRuntimeEntryHelper([commandId, "--target-json", JSON.stringify(ref)], deps, async (file, args) => { attached.push([file, ...args]); return 0 }), 0)
  assert.equal(attached[0]?.[0], "tmux")
  const other = { ...ref, target: { ...ref.target, providerGeneration: randomUUID() } }
  assert.equal(await runRuntimeEntryHelper([commandId, "--target-json", JSON.stringify(other)], deps, async () => 0), 75)
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("closing an editor rings the doorbell, and the remote rows carry attention counts", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t)
  const a = await f.connect(), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1 }); await b.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] }), sessionId = String(s.sessionId)
  await b.request("session/load", { sessionId, cwd: f.workspace, mcpServers: [] })
  const live = async () => ((await transport.request("live-read", { op: "agents" })) as { agents: Array<{ agentId: string; live: { pendingApprovals: number; editors: number } }> }).agents.find(row => row.agentId === sessionId.slice(7))!.live
  assert.deepEqual([(await live()).pendingApprovals, (await live()).editors], [0, 2])
  const wait = (after: string | null, waitMs: number) => transport.request("live-wait", { after, waitMs }, { timeoutMs: waitMs + 5000 }) as Promise<{ revision: string }>
  const before = (await wait(null, 8000)).revision
  const changing = wait(before, 8000), since = Date.now()
  b.close()
  assert.notEqual((await changing).revision, before)
  assert.ok(Date.now() - since < 7000)
  assert.equal((await live()).editors, 1)
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})