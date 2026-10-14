import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import type { ControlDependencies } from "../src/cli/control.js"
import { runControl } from "../src/cli/control.js"
import { runRuntimeEntryHelper } from "../src/entry/cli.js"
import { parseHostReply } from "../src/hosts/protocol.js"
import { unavailableControlDependencies } from "./control-support.js"

function runtimeFixture(state: "opened" | "uncertain" | "stale" | null = "opened") {
  const hostId = "a".repeat(64), generation = randomUUID(), commandId = randomUUID(), ref = { hostId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() } }
  const receipt = state === null ? null : { commandId, ref, state, editor: { editorId: randomUUID(), session: "runtime-entry", pane: "%2", tmuxSocketPath: "/fixture/owner-tmux.sock" } }
  const calls: string[] = [], output: string[] = [], attached: string[][] = []
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: hostId, runtimeRoot: "/fixture", persistentRoot: "/fixture" } as never, adapter: {} as never }), hostInventory: () => ({ list: async () => [], enroll: async () => {} }), hostRoute: async (_env, route) => { calls.push(route.channel); return route.channel === "host-identity" ? { hostId, handlerGeneration: generation } : receipt }, start: async () => { throw new Error("start forbidden") }, stdout: value => output.push(value), stderr() {} }
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