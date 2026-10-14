import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { runEntryHelper } from "../src/bureau/entry-cli.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import type { ControlDependencies } from "../src/cli/control.js"
import { runBureauClient } from "../src/bureau/cli.js"

function fixture(state = "consumed") {
  const commandId = randomUUID(), generation = randomUUID(), hostId = "b".repeat(64), inventoryId = randomUUID(), ref = { hostId, inventoryId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() } }
  const digest = canonicalDigest({ commandId, ref }), calls: any[] = [], entered: any[] = []
  const deps = { environment: async () => ({ paths: { hostKey: hostId, runtimeRoot: "/fixture" } }), inspect: async () => ({ disposition: "live", record: { generation, phase: "ready" } }),
    callBureau: async (_env: unknown, request: any) => { calls.push(request); return { protocol: request.protocol, requestId: request.requestId, handlerGeneration: generation, ok: true,
      result: { commandId, ref, digest, expiresAt: 1000, state, editor: { editorId: randomUUID(), session: "owned-entry", pane: "%2" } } } },
    stdout() {}, stderr() {}, cwd: () => "/fixture" } as unknown as ControlDependencies
  const argv = [commandId, "--digest", digest, "--host-id", hostId, "--inventory-id", inventoryId, "--handler-generation", generation]
  return { deps, argv, calls, entered, enter: async (file: string, args: string[]) => { entered.push([file, ...args]); return 0 } }
}
test("remote helper consumes the local exact intent before attaching the owned tmux target", async () => {
  const f = fixture(); assert.equal(await runEntryHelper(f.argv, f.deps, f.enter), 0)
  assert.equal(f.calls[0].op, "entry_consume"); assert.equal(f.entered.length, 1)
  assert.deepEqual(f.entered[0], ["tmux", "-S", "/fixture/entry-tmux.sock", "attach-session", "-t", "=owned-entry"])
})
test("uncertain entry never attaches a terminal or stops a provider", async () => {
  const f = fixture("uncertain"); assert.equal(await runEntryHelper(f.argv, f.deps, f.enter), 75)
  assert.equal(f.entered.length, 0); assert.equal(f.calls.length, 1)
})
for (const argv of [["roster", "--json"], ["roster", "list", "--json"]]) test(argv.join(" ") + " reads one roster snapshot", async () => {
  const f = fixture(); assert.equal(await runBureauClient(argv, f.deps), 0); assert.equal(f.calls[0].op, "roster_snapshot")
})
import { runControl } from "../src/cli/control.js"
import { runRuntimeEntryHelper } from "../src/entry/cli.js"
import { parseHostReply } from "../src/hosts/protocol.js"
import { unavailableControlDependencies } from "./control-support.js"

function runtimeFixture(state: "opened" | "uncertain" | "stale" | null = "opened") {
  const hostId = "a".repeat(64), generation = randomUUID(), commandId = randomUUID(), ref = { hostId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() } }
  const receipt = state === null ? null : { commandId, ref, state, editor: { editorId: randomUUID(), session: "runtime-entry", pane: "%2", tmuxSocketPath: "/fixture/owner-tmux.sock" } }
  const calls: string[] = [], output: string[] = [], attached: string[][] = []
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: hostId, runtimeRoot: "/fixture", persistentRoot: "/fixture" } as never, adapter: {} as never }), hostInventory: () => ({ list: async () => [], enroll: async () => {} }), hostRoute: async (_env, route) => { calls.push(route.channel); return route.channel === "host-identity" ? { hostId, handlerGeneration: generation } : receipt }, start: async () => { throw new Error("start forbidden") }, callBureau: async () => { throw new Error("Bureau forbidden") }, stdout: value => output.push(value), stderr() {} }
  return { deps, ref, commandId, receipt, calls, output, attached, attach: async (file: string, args: string[]) => { attached.push([file, ...args]); return 0 } }
}
test("ordinary entry open and explicit local inspection use the core convenience channels", async () => {
  const f = runtimeFixture()
  assert.equal(await runControl(["entry", "open", "--input-json", JSON.stringify({ commandId: f.commandId, ...f.ref }), "--local"], f.deps), 0)
  const reply = parseHostReply(JSON.parse(f.output.join(""))); assert.ok(reply.ok); assert.equal(reply.hostId, f.ref.hostId)
  assert.deepEqual(f.calls, ["host-identity", "entry-open"])
  f.output.length = 0
  assert.equal(await runControl(["entry", "inspect", f.commandId, "--local"], f.deps), 0)
  assert.deepEqual(f.calls.slice(2), ["host-identity", "runtime-entry-inspect"])
})
for (const state of ["opened", "uncertain", "stale", null] as const) test(`runtime terminal helper inspects ${state} without creating an editor`, async () => {
  const f = runtimeFixture(state)
  assert.equal(await runRuntimeEntryHelper([f.commandId, "--target-json", JSON.stringify(f.ref)], f.deps, f.attach), state === "opened" ? 0 : 75)
  assert.deepEqual(f.calls, ["host-identity", "runtime-entry-inspect"])
  assert.deepEqual(f.attached, state === "opened" ? [["tmux", "-S", "/fixture/owner-tmux.sock", "attach-session", "-t", "=runtime-entry"]] : [])
})
test("malformed open replies preserve the owner and command without automatic inspection", async () => {
  const f = runtimeFixture(); f.deps.hostRoute = async (_env, route) => { f.calls.push(route.channel); return route.channel === "host-identity" ? { hostId: f.ref.hostId, handlerGeneration: f.ref.target.handlerGeneration } : null }
  assert.equal(await runControl(["entry", "open", "--input-json", JSON.stringify({ commandId: f.commandId, ...f.ref })], f.deps), 75)
  const reply = parseHostReply(JSON.parse(f.output.join(""))); assert.ok(!reply.ok); assert.equal(reply.error.code, "OUTCOME_UNKNOWN")
  assert.deepEqual(reply.error.reference, { hostId: f.ref.hostId, commandId: f.commandId }); assert.deepEqual(f.calls, ["host-identity", "entry-open"])
})
test("ordinary legacy entry forms give usage before any owner or Bureau call", async () => {
  const f = runtimeFixture()
  for (const argv of [["entry", "prepare"], ["entry", "consume"], ["entry", "inspect", f.commandId]]) assert.equal(await runControl(argv, f.deps), 64)
  assert.deepEqual(f.calls, [])
})

test("terminal helper rejects substituted provider tuples and owner identity", async () => {
  const f = runtimeFixture()
  assert.equal(await runRuntimeEntryHelper([f.commandId, "--target-json", JSON.stringify({ ...f.ref, target: { ...f.ref.target, providerGeneration: randomUUID() } })], f.deps, f.attach), 75)
  assert.equal(await runRuntimeEntryHelper([f.commandId, "--target-json", JSON.stringify({ ...f.ref, hostId: "b".repeat(64) })], f.deps, f.attach), 69)
  assert.deepEqual(f.attached, [])
})
test("remote entry returns the configured owner enrollment and stale opens never dispatch", async () => {
  const f = runtimeFixture(), localId = "b".repeat(64)
  f.deps.environment = async () => ({ paths: { hostKey: localId, runtimeRoot: "/fixture", persistentRoot: "/fixture" } as never, adapter: {} as never })
  const enrollment = { inventoryId: randomUUID(), hostId: f.ref.hostId, hostname: "worker", agyPath: "/opt/agy", loginShell: "/bin/sh" }
  f.deps.hostInventory = () => ({ list: async () => [enrollment], enroll: async () => {} })
  assert.equal(await runControl(["entry", "open", "--input-json", JSON.stringify({ commandId: f.commandId, ...f.ref })], f.deps), 0)
  const reply = parseHostReply(JSON.parse(f.output.join(""))); assert.ok(reply.ok && reply.result.state === "entry"); assert.deepEqual(reply.result.enrollment, enrollment)
  f.calls.length = 0; f.output.length = 0
  assert.equal(await runControl(["entry", "open", "--input-json", JSON.stringify({ commandId: randomUUID(), hostId: f.ref.hostId, target: { ...f.ref.target, handlerGeneration: randomUUID() } })], f.deps), 69)
  assert.deepEqual(f.calls, ["host-identity"])
})