import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { runControl, type ControlDependencies } from "../src/cli/control.js"
import { AGENT_PROTOCOL, type AgentRequest } from "../src/agent/protocol.js"
import { parseHostReply } from "../src/hosts/protocol.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import { unavailableControlDependencies } from "./control-support.js"

function fixture() {
  const hostId = "a".repeat(64), remoteId = "b".repeat(64), generation = randomUUID(), output: string[] = [], calls: string[] = []
  const decision = { commandId: randomUUID(), ref: { hostId: remoteId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }, optionId: "allow" }
  const receipt = { ...decision, digest: canonicalDigest(decision), state: "applied" }
  const hosts: import("../src/hosts/inventory.js").HostEnrollment[] = [{ hostId: remoteId, inventoryId: randomUUID(), hostname: "worker", agyPath: "/opt/agy", loginShell: "/bin/sh" }]
  let drop = false
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: hostId, persistentRoot: "/fixture", runtimeRoot: "/fixture", handlerSocketPath: "/fixture/handler.sock" }, adapter: {} as never }),
    hostInventory: () => ({ list: async () => hosts, enroll: async host => { hosts.push(host) } }),
    hostRoute: async (_env, route) => {
      calls.push(route.channel)
      if (![hostId, remoteId].includes(route.hostId)) throw new Error("HOST_UNAVAILABLE")
      if (route.channel === "host-identity") return { hostId: route.hostId, handlerGeneration: generation }
      const request = route.payload as AgentRequest
      if (route.channel === "runtime-write" && drop) return null
      return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: generation, ok: true,
        result: request.op === "agent_roster" ? { state: "page", agents: [], issues: [], revision: randomUUID(), nextCursor: null } : request.op === "agent_permissions" ? { state: "permissions", snapshot: { hostId: route.hostId, handlerGeneration: generation, throughSeq: 0, pending: [], receipts: [] } } : { state: "permission", receipt: request.op === "agent_permission_inspect" ? null : receipt } }
    }, start: async () => { throw new Error("start forbidden") }, callBureau: async () => { throw new Error("Bureau forbidden") }, stdout: value => output.push(value) }
  return { deps, decision, remoteId, hosts, calls, setDrop() { drop = true }, reply: () => parseHostReply(JSON.parse(output.join(""))) }
}

for (const argv of [["host", "list"], ["roster", "list"], ["permission", "list"]]) test(`ordinary ${argv.join(" ")} works without Bureau or startup`, async () => {
  const f = fixture()
  assert.equal(await runControl([...argv, "--json"], f.deps), 0)
  assert.equal(f.reply().ok, true)
})

test("single-owner reads and decisions retain owner and command identity", async () => {
  const f = fixture()
  assert.equal(await runControl(["permission", "decide", "--input-json", JSON.stringify(f.decision), "--host", f.remoteId, "--json"], f.deps), 0)
  const reply = f.reply()
  assert.equal(reply.hostId, f.remoteId); assert.equal(reply.commandId, f.decision.commandId)
  assert.deepEqual(f.calls, ["host-identity", "runtime-write"])
})

test("malformed post-dispatch response reports unknown outcome with its inspection reference", async () => {
  const f = fixture(); f.setDrop()
  assert.equal(await runControl(["permission", "decide", "--input-json", JSON.stringify(f.decision), "--json"], f.deps), 75)
  const reply = f.reply(); assert.ok(!reply.ok)
  assert.equal(reply.error.code, "OUTCOME_UNKNOWN")
  assert.deepEqual(reply.error.reference, { hostId: f.remoteId, commandId: f.decision.commandId })
  assert.equal(f.calls.filter(channel => channel === "runtime-write").length, 1)
})

for (const argv of [["permission", "watch"], ["roster", "watch"], ["permission", "inspect", randomUUID()], ["roster", "list", "--limit", "1"], ["host", "list", "--json", "--json"]]) test(`invalid ordinary form ${argv.join(" ")} fails before host traffic`, async () => {
  const f = fixture(); assert.equal(await runControl(argv, f.deps), 64); assert.deepEqual(f.calls, [])
})

test("selectors and conflicting command IDs cannot alter a decision", async () => {
  const f = fixture()
  assert.equal(await runControl(["permission", "decide", "--input-json", JSON.stringify(f.decision), "--host", "c".repeat(64)], f.deps), 64)
  assert.equal(await runControl(["permission", "decide", "--input-json", JSON.stringify(f.decision), "--command-id", randomUUID()], f.deps), 64)
  assert.deepEqual(f.calls, [])
})

for (const action of ["roster", "permission"]) test(`single owner ${action} list and explicit permission inspection use only owner channels`, async () => {
  const f = fixture()
  assert.equal(await runControl([action, "list", "--host", f.remoteId, "--json"], f.deps), 0)
  assert.equal(f.reply().hostId, f.remoteId)
})
test("host enrollment writes configuration without Handler startup", async () => {
  const f = fixture(), enrollment = { ...f.hosts[0]!, inventoryId: randomUUID(), hostId: "c".repeat(64), hostname: "new" }
  assert.equal(await runControl(["host", "enroll", "--input-json", JSON.stringify(enrollment), "--json"], f.deps), 0)
  assert.equal(f.hosts.length, 2); assert.deepEqual(f.calls, [])
})
test("unknown owners are unavailable before mutation and command flags retain their identity", async () => {
  const f = fixture()
  assert.equal(await runControl(["roster", "list", "--host", "c".repeat(64)], f.deps), 69)
  const next = fixture(), { commandId, ...decision } = next.decision
  assert.equal(await runControl(["permission", "decide", "--input-json", JSON.stringify(decision), "--command-id", commandId], next.deps), 0)
  assert.equal(next.reply().commandId, commandId)
})

test("explicit owner inspection returns a nullable receipt with command identity", async () => {
  const f = fixture(), commandId = randomUUID()
  assert.equal(await runControl(["permission", "inspect", commandId, "--host", f.remoteId], f.deps), 0)
  const reply = f.reply(); assert.ok(reply.ok); assert.equal(reply.commandId, commandId)
  assert.deepEqual(reply.result, { state: "permission", receipt: null })
})