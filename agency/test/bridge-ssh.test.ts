import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { buildSshCommand, connectBridge, type BridgeProcessFactory } from "../src/bridge/ssh.js"
import { runRuntimeBridgeCli } from "../src/bridge/runtime-remote.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { BRIDGE_PROTOCOL } from "../src/bridge/protocol.js"

function peerFactory(overrides = {}) {
  const calls: Array<{ file: string; argv: string[]; env: NodeJS.ProcessEnv }> = []
  const factory: BridgeProcessFactory = (file, argv, options) => {
    calls.push({ file, argv, env: options.env })
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() { stdin.end(); stdout.end(); return true } })
    queueMicrotask(() => stdout.write(JSON.stringify({ type: "hello", protocol: BRIDGE_PROTOCOL, connectionId: randomUUID(), hostId: "a".repeat(64), handlerGeneration: randomUUID(), sourceRevision: "a".repeat(40), nodeVersion: "v24.13.0", capabilities: ["runtime-read"], ...overrides }) + "\n"))
    return child
  }
  return { calls, factory }
}
const enrollment = () => ({ inventoryId: randomUUID(), hostId: "a".repeat(64), hostname: "worker", agyPath: "/path with 'quote/agy", loginShell: "/bin/sh" })

test("SSH bootstrap is noninteractive and retains authentication only on the local child", async () => {
  const e = enrollment(), command = buildSshCommand(e), f = peerFactory(), prior = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = "/fixture/private-auth.sock"
  try {
    const transport = await connectBridge(e, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read"], processFactory: f.factory })
    try {
      assert.equal(command.file, "ssh")
      for (const arg of ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10"]) assert.ok(command.argv.includes(arg))
      assert.equal(f.calls[0]!.env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK)
      assert.equal(command.argv.at(-1)!.includes(process.env.SSH_AUTH_SOCK!), false)
      assert.ok(command.argv.at(-1)!.includes("internal-runtime-bridge"))
      assert.throws(() => transport.request("snapshot", {}), /UNSUPPORTED_CAPABILITY/)
    } finally { transport.close() }
  } finally { if (prior === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = prior }
})
for (const [overrides, error] of [[{ hostId: "b".repeat(64) }, /HOST_IDENTITY_CHANGED/], [{ nodeVersion: "v0.0.0" }, /UNSUPPORTED_RUNTIME/], [{ protocol: "agency-bridge/1", outboxCursor: 0 }, /UNSUPPORTED_BRIDGE_PROTOCOL/]] as const) test("SSH rejects incompatible peer " + JSON.stringify(overrides), async () => {
  const f = peerFactory(overrides)
  await assert.rejects(connectBridge(enrollment(), { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read"], processFactory: f.factory }), error)
  assert.equal(f.calls.length, 1)
})

test("EOF closes only the helper connection while the destination Handler stays available", async t => {
  const f = await runtimeNetwork(t), owner = await f.add("owner", "a")
  owner.bridge.register(["runtime-read"], async () => ({ healthy: true }))
  const first = await owner.connect(owner.enrollment); first.close(); await first.closed
  const second = await owner.connect(owner.enrollment); t.after(() => second.close())
  assert.deepEqual(await second.request("runtime-read", {}), { healthy: true })
})

test("runtime helper rejects malformed arguments before connecting", async () => {
  let connections = 0
  await assert.rejects(runRuntimeBridgeCli(["--unexpected"], { input: new PassThrough(), output: new PassThrough(), connect: async () => { connections++; throw new Error("unexpected connect") } }), /INVALID_HOST_BRIDGE_ARGUMENTS/)
  assert.equal(connections, 0)
})

test("SSH request cancellation releases the destination waiter and preserves the connection", async t => {
  const f = await runtimeNetwork(t), owner = await f.add("owner", "a"), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  owner.bridge.register(["runtime-read", "runtime-write"], async ({ channel, signal }) => {
    if (channel === "runtime-read") return { healthy: true }
    entered.resolve()
    await new Promise<void>(resolve => { signal.addEventListener("abort", () => { released.resolve(); resolve() }, { once: true }) })
    return {}
  })
  const transport = await owner.connect(owner.enrollment); t.after(() => transport.close())
  const controller = new AbortController(), waiting = transport.request("runtime-write", {}, { signal: controller.signal, timeoutMs: 0 })
  await entered.promise; controller.abort(new Error("DETACHED")); await assert.rejects(waiting, /DETACHED/); await released.promise
  assert.deepEqual(await transport.request("runtime-read", {}), { healthy: true })
})