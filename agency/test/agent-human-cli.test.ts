import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { runControl, type ControlDependencies } from "../src/cli/control.js"
import { ControlError } from "../src/control/protocol.js"
import { AGENT_PROTOCOL, agentErrorReply, type AgentRequest, type AgentReply } from "../src/agent/protocol.js"
import { AgentError } from "../src/agent/types.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import type { PermissionReceipt } from "../src/orchestration/permission-routing.js"
import type { HandlerInspection } from "../src/platform/types.js"
import { unavailableControlDependencies } from "./control-support.js"

function fixture() {
  const hostId = "a".repeat(64), generation = randomUUID(), out: string[] = [], calls: AgentRequest[] = []
  const decision = { commandId: randomUUID(), ref: { hostId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }, optionId: "allow-once" }
  const receipt: PermissionReceipt = { ...decision, digest: canonicalDigest(decision), state: "applied" }
  const inspection: HandlerInspection = { disposition: "live", record: { version: 1, hostId, generation, launchBootId: "boot-a", launchAttemptId: randomUUID(), launchAttempted: true, phase: "ready", process: { bootId: "boot-a", pid: 100, birth: "fixture", parentPid: 1, processGroupId: 100, sessionId: 100, uid: 1, gid: 1 }, socketPath: "/fixture/handler.sock", writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null } }
  const unavailable = async (): Promise<never> => { throw new Error("unexpected dependency") }
  const reply = (request: AgentRequest): AgentReply => {
    const base = { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: true as const }
    switch (request.op) {
      case "agent_roster": return { ...base, result: { state: "page", revision: randomUUID(), agents: [], issues: [], nextCursor: null } }
      case "agent_permissions": return { ...base, result: { state: "permissions", snapshot: { hostId, handlerGeneration: generation, throughSeq: 0, pending: [], receipts: [] } } }
      case "agent_permission_decide": return { ...base, result: { state: "permission", receipt } }
      case "agent_permission_inspect": return { ...base, result: { state: "permission", receipt: null } }
      default: throw new Error("unexpected agent operation")
    }
  }
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: hostId, persistentRoot: "/fixture", runtimeRoot: "/fixture", handlerSocketPath: "/fixture/handler.sock" }, adapter: { platform: "darwin", bootId: unavailable, readProcess: unavailable, readGroup: unavailable, signalGroup: unavailable } }), inspect: async () => inspection, start: unavailable, callBureau: unavailable, callAgent: async (_env, request) => { calls.push(request); return reply(request) }, stdout: text => out.push(text) }
  return { deps, decision, receipt, inspection, calls, reply, output: () => JSON.parse(out.join("")), decide: ["permission", "decide", "--local", "--input-json", JSON.stringify(decision), "--json"] }
}

for (const [argv, op] of [
  [["roster", "list", "--local", "--json"], "agent_roster"],
  [["permission", "list", "--local", "--json"], "agent_permissions"],
  [["permission", "inspect", "00000000-0000-0000-0000-000000000001", "--local", "--json"], "agent_permission_inspect"]
] as const) test(`local ${op} uses the inspected Handler once`, async () => {
  const f = fixture()
  assert.equal(await runControl(argv, f.deps), 0)
  assert.deepEqual(f.calls.map(call => call.op), [op])
  assert.equal(f.output().ok, true)
})

test("local roster forwards explicit filters without sampling cwd", async () => {
  const f = fixture()
  assert.equal(await runControl(["roster", "list", "--local", "--limit", "7", "--cursor", "cursor_1", "--cwd", "/explicit", "--json"], f.deps), 0)
  assert.deepEqual(f.calls[0]!.op === "agent_roster" && f.calls[0]!.input, { limit: 7, cursor: "cursor_1", cwd: "/explicit" })
})

test("local decision submits its caller-selected identity", async () => {
  const f = fixture()
  assert.equal(await runControl(f.decide, f.deps), 0)
  const request = f.calls[0]!
  assert.ok(request.op === "agent_permission_decide")
  assert.equal(request.commandId, f.decision.commandId)
  assert.deepEqual(request.ref, f.decision.ref)
  assert.deepEqual(f.output().result.receipt, f.receipt)
})

for (const state of ["claimed", "uncertain", "stale", "withdrawn"] as const) test(`local ${state} receipt remains explicit and incomplete`, async () => {
  const f = fixture()
  f.receipt.state = state
  assert.equal(await runControl(f.decide, f.deps), 75)
  assert.equal(f.output().result.receipt.state, state)
  assert.equal(f.calls.length, 1)
})

for (const fault of ["lost", "malformed", "request", "generation", "command", "ref", "option"] as const) test(`local decision ${fault} reply reports unknown without retry`, async () => {
  const f = fixture()
  f.deps.callAgent = async (_env, request) => {
    f.calls.push(request)
    if (fault === "lost") throw new ControlError("UNAVAILABLE", "reply lost")
    if (fault === "malformed") return "noise" as unknown as AgentReply
    const reply = f.reply(request)
    if (fault === "request") return { ...reply, requestId: randomUUID() }
    if (fault === "generation") return { ...reply, handlerGeneration: randomUUID() }
    if (fault === "command") f.receipt.commandId = randomUUID()
    if (fault === "ref") f.receipt.ref = { ...f.receipt.ref, permissionId: randomUUID() }
    if (fault === "option") f.receipt.optionId = "reject-once"
    f.receipt.digest = canonicalDigest({ commandId: f.receipt.commandId, ref: f.receipt.ref, optionId: f.receipt.optionId })
    return reply
  }
  assert.equal(await runControl(f.decide, f.deps), 75)
  assert.deepEqual(f.calls.map(call => call.op), ["agent_permission_decide"])
  assert.equal(f.output().error.code, "INCOMPLETE")
  assert.equal(f.output().result.commandId, f.decision.commandId)
})

test("a parsed owner error is returned without relabeling it unknown", async () => {
  const f = fixture()
  f.deps.callAgent = async (_env, request) => agentErrorReply(request, new AgentError("COMMAND_CONFLICT"))
  assert.equal(await runControl(f.decide, f.deps), 75)
  assert.equal(f.output().error.code, "COMMAND_CONFLICT")
  assert.equal(f.output().result, undefined)
})

test("local reads reject permission snapshots from a different owner", async () => {
  const f = fixture()
  f.deps.callAgent = async (_env, request) => ({ protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: true, result: { state: "permissions", snapshot: { hostId: "b".repeat(64), handlerGeneration: request.handlerGeneration, throughSeq: 0, pending: [], receipts: [] } } })
  assert.equal(await runControl(["permission", "list", "--local", "--json"], f.deps), 65)
  assert.equal(f.output().ok, false)
})

test("local read transport loss reports unavailable", async () => {
  const f = fixture()
  f.deps.callAgent = async () => { throw new ControlError("UNAVAILABLE") }
  assert.equal(await runControl(["permission", "list", "--local", "--json"], f.deps), 69)
  assert.equal(f.output().error.code, "UNAVAILABLE")
})

for (const fault of ["absent", "starting", "ambiguous"] as const) test(`local ${fault} Handler cannot dispatch`, async () => {
  const f = fixture()
  if (fault === "absent") f.deps.inspect = async () => null
  if (fault === "starting") f.inspection.record.phase = "reconciling"
  if (fault === "ambiguous") f.inspection.disposition = "ambiguous"
  assert.notEqual(await runControl(f.decide, f.deps), 0)
  assert.deepEqual(f.calls, [])
})

for (const fault of ["host", "generation"] as const) test(`local decision fences a stale ${fault} before dispatch`, async () => {
  const f = fixture()
  if (fault === "host") f.decision.ref.hostId = "b".repeat(64)
  else f.decision.ref.target.handlerGeneration = randomUUID()
  assert.notEqual(await runControl(["permission", "decide", "--local", "--input-json", JSON.stringify(f.decision)], f.deps), 0)
  assert.deepEqual(f.calls, [])
})

for (const argv of [
  ["permission", "watch", "--local"], ["roster", "watch", "--local"], ["entry", "prepare", "--local"], ["git", "inspect", "--local"], ["agent", "list", "--local"],
  ["permission", "list", "--local", "--local"], ["permission", "list", "--local", "--json", "--json"], ["permission", "list", "--local", "extra"],
  ["permission", "decide", "--local", "--input-json", "{}"], ["permission", "decide", "--local", "--input-json", "{bad"], ["permission", "list", "--local", "--input-json", "{}"],
  ["roster", "list", "--local", "--cwd", "relative"], ["roster", "list", "--local", "--limit", "101"], ["roster", "list", "--local", "--limit"], ["roster", "list", "--local", "--active"],
  ["permission", "inspect", "invalid", "--local"]
]) test(`unsupported local syntax fails before environment: ${argv.join(" ")}`, async () => {
  const f = fixture()
  f.deps.environment = async () => { throw new Error("must parse first") }
  assert.equal(await runControl(argv, f.deps), 64)
  assert.deepEqual(f.calls, [])
})