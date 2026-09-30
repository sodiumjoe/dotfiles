import assert from "node:assert/strict"
import { test } from "node:test"
import { observeQualificationDescriptors, verifyQualificationAbsence, type DescriptorCommand } from "../scripts/qualification-observation.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const handler: ProcessIdentity = { bootId: "boot", pid: 100, birth: "1:handler", parentPid: 90, processGroupId: 100, sessionId: 100, uid: 501, gid: 20 }
const leader: ProcessIdentity = { ...handler, pid: 200, birth: "2:provider", parentPid: 100, processGroupId: 200, sessionId: 200 }
const child: ProcessIdentity = { ...leader, pid: 201, birth: "3:child", parentPid: 200 }
const group = { leader, observed: [leader] }
const processes = [handler, leader, child]
const live: PlatformAdapter = { platform: "darwin", async bootId() { return "boot" }, async readProcess(pid) { return processes.find(p => p.pid === pid) ?? null }, async readGroup(pid) { return processes.filter(p => p.processGroupId === pid) }, async signalGroup() { throw new Error("no signals authorized") } }
const output = (pid: number, extra = ""): string => `p${pid}\0\nf0\0tPIPE\0npipe0\0\nf1\0tPIPE\0npipe1\0\nf2\0tPIPE\0npipe2\0\n${pid === handler.pid ? "f3\0tunix\0n->0xabcd\0\nf4\0tunix\0n->0xdcba\0\n" : ""}${extra}`
const command: DescriptorCommand = async (file, args, options) => {
  assert.equal(file, "/usr/sbin/lsof")
  assert.deepEqual(args.slice(0, 3), ["-nP", "-a", "-p"])
  assert.equal(args[4], "-F0pftndGPT")
  assert.ok(options.timeout > 0 && options.timeout <= 2000)
  assert.equal(options.maxBuffer, 65536)
  return { stdout: output(Number(args[3])), stderr: "" }
}

const runtime = (pid: number, extra = ""): string => {
  const prefix = pid === handler.pid ? "100" : pid === leader.pid ? "200" : "300"
  const stdio = [0, 1, 2].map(fd => `f${fd}\0tunix\0d0x${prefix}${fd}\0n->0x${pid === child.pid ? "200" : "100"}${fd + 4}\0\n`).join("")
  const pipes = `f10\0tPIPE\0d0x${prefix}a\0n->0x${prefix}b\0\nf11\0tPIPE\0d0x${prefix}b\0n->0x${prefix}a\0\n`
  const local = `f12\0tKQUEUE\0G0x3;0x2\0ncount=0, state=0x8\0\nf13\0tDIR\0G0x1;0x2\0n/\0\nf14\0tCHR\0G0x1;0x2\0n/dev/null\0\n`
  const childPipes = pid === handler.pid || pid === leader.pid ? [0, 1, 2].map(fd => `f${fd + 4}\0tunix\0d0x${prefix}${fd + 4}\0n->0x${pid === handler.pid ? "200" : "300"}${fd}\0\n`).join("") : ""
  const socket = pid === handler.pid ? "f15\0tunix\0n/private/tmp/agyq-fixture/runtime/handler.sock\0\n" : ""
  return `p${pid}\0\n${stdio}${pipes}${local}${childPipes}${socket}${extra}`
}

test("descriptor policy accepts owned runtime handles and connected provider stdio", async () => {
  const result = await observeQualificationDescriptors(live, [handler], group, 2000, async (_file, args) => ({ stdout: runtime(Number(args[3])), stderr: "" }), { handlerSocketPath: "/private/tmp/agyq-fixture/runtime/handler.sock", providerStateRoot: "/private/tmp/agyq-fixture/state/agents/provider-state/attempt" })
  assert.equal(result.outcome, "verified")
  assert.ok(!JSON.stringify(result).includes("0x"))
  assert.ok(!JSON.stringify(result).includes("handler.sock"))
})

for (const [name, extra] of [
  ["unpaired pipe", "f30\0tPIPE\0d0xff\0n->0xee\0\n"],
  ["unowned socket", "f30\0tunix\0d0xff\0n->0xee\0\n"],
  ["evidence directory", "f30\0tDIR\0G0x1;0x2\0n/private/evidence\0\n"],
  ["inherited root directory", "f30\0tDIR\0G0x1;0x3\0n/\0\n"],
  ["inherited queue", "f30\0tKQUEUE\0G0x3;0x3\0ncount=0, state=0x8\0\n"],
  ["inherited pipe pair", "f30\0tPIPE\0d0xff\0n->0xee\0\nf31\0tPIPE\0d0xee\0n->0xff\0\n"],
  ["other listener", "f30\0tunix\0n/private/tmp/other.sock\0\n"],
] as const) test(`descriptor policy rejects ${name} among legitimate runtime handles`, async () => {
  const result = await observeQualificationDescriptors(live, [handler], group, 2000, async (_file, args) => ({ stdout: runtime(Number(args[3]), Number(args[3]) === leader.pid ? extra : ""), stderr: "" }), { handlerSocketPath: "/private/tmp/agyq-fixture/runtime/handler.sock", providerStateRoot: "/private/tmp/agyq-fixture/state/agents/provider-state/attempt" })
  assert.equal(result.outcome, "leaked")
  assert.equal(result.processes.find(p => p.role === "adapter")!.descriptors.find(d => d.fd === 30)!.allowed, false)
})

for (const [name, extra, allowed] of [
  ["established child TLS", "f30\0tIPv4\0G0x3;0x2\0PTCP\0TST=ESTABLISHED\0n127.0.0.1:51000->127.0.0.1:443\0\n", true],
  ["inherited child socket", "f30\0tIPv4\0G0x3;0x3\0PTCP\0TST=ESTABLISHED\0n127.0.0.1:51000->127.0.0.1:443\0\n", false],
  ["TCP listener", "f30\0tIPv4\0G0x3;0x2\0PTCP\0TST=LISTEN\0n127.0.0.1:51000\0\n", false],
] as const) test(`descriptor policy classifies ${name}`, async () => {
  const result = await observeQualificationDescriptors(live, [handler], group, 2000, async (_file, args) => ({ stdout: runtime(Number(args[3]), Number(args[3]) === child.pid ? extra : ""), stderr: "" }), { handlerSocketPath: "/private/tmp/agyq-fixture/runtime/handler.sock", providerStateRoot: "/private/tmp/agyq-fixture/state/agents/provider-state/attempt" })
  assert.equal(result.outcome, allowed ? "verified" : "leaked")
  assert.equal(result.processes.find(p => p.role === "child")!.descriptors.find(d => d.fd === 30)!.allowed, allowed)
})

test("descriptor observations bind Handler, adapter, and newly observed child identities", async () => {
  const inspected: number[] = []
  const inspect: DescriptorCommand = async (...args) => { inspected.push(Number(args[1][3])); return command(...args) }
  const result = await observeQualificationDescriptors(live, [handler], group, 2000, inspect)
  assert.equal(result.outcome, "verified")
  assert.deepEqual(result.processes.map(p => [p.role, p.process.pid, p.descriptors.map(d => d.fd)]), [["handler", 100, [0, 1, 2, 3, 4]], ["adapter", 200, [0, 1, 2]], ["child", 201, [0, 1, 2]]])
  assert.deepEqual(inspected, [100, 200, 201])
  assert.ok(!JSON.stringify(result).includes("channel3"))
  assert.ok(!JSON.stringify(result).includes("pipe0"))
})

for (const [role, pid] of [["handler", 100], ["adapter", 200], ["child", 201]] as const) test(`descriptor observation detects an inherited ${role} evidence handle`, async () => {
  const result = await observeQualificationDescriptors(live, [handler], group, 2000, async (file, args, options) => {
    await command(file, args, options)
    return { stdout: output(Number(args[3]), Number(args[3]) === pid ? "f8\0tDIR\0n/private/secret-evidence\0\n" : ""), stderr: "" }
  })
  assert.equal(result.outcome, "leaked")
  assert.equal(result.processes.find(p => p.role === role)!.descriptors.find(d => d.fd === 8)!.allowed, false)
  assert.ok(!JSON.stringify(result).includes("secret-evidence"))
})

for (const raw of ["", "p999\0\nf0\0tPIPE\0np\0\n", "p100\0\nf0\0tPIPE\0np\0\n", "p100\0\nf0\0tUNKNOWN\0np\0\n", output(100) + "f0\0tPIPE\0nduplicate\0\n", "p100\0\n" + "f5\0tPIPE\0np\0\n".repeat(257)]) test(`descriptor observation refuses missing or unknown evidence ${JSON.stringify(raw).slice(0, 80)}`, async () => {
  await assert.rejects(observeQualificationDescriptors(live, [handler], group, 2000, async () => ({ stdout: raw, stderr: "" })), { code: "DESCRIPTOR_UNAVAILABLE" })
})

for (const field of ["birth", "parentPid"] as const) test(`descriptor observation rejects ${field} substitution during the command`, async () => {
  let changed = false
  const adapter = { ...live, async readProcess(pid: number) { const value = await live.readProcess(pid); return changed && value ? { ...value, [field]: field === "birth" ? "99:replacement" : 999 } : value } }
  await assert.rejects(observeQualificationDescriptors(adapter, [handler], group, 2000, async (...args) => { const result = await command(...args); changed = true; return result }), { code: "DESCRIPTOR_UNAVAILABLE" })
})

test("descriptor command and identity reads share a bounded deadline", async () => {
  const start = performance.now()
  await assert.rejects(observeQualificationDescriptors(live, [handler], group, 40, () => new Promise(() => undefined)), { code: "DESCRIPTOR_UNAVAILABLE" })
  assert.ok(performance.now() - start < 300)
})

const absent = { ...live, async readProcess(_pid: number) { return null }, async readGroup(_pid: number) { return [] } }

test("parent absence verifies all exact identities in two passes under one budget", async () => {
  const calls: string[] = []
  const adapter = { ...absent, async readProcess(pid: number) { calls.push(`process:${pid}`); return null }, async readGroup(pid: number) { calls.push(`group:${pid}`); return [] } }
  const result = await verifyQualificationAbsence(adapter, [handler], { leader, observed: [leader, child] }, [], 80)
  assert.equal(result.outcome, "completed"); assert.equal(result.passes, 2)
  assert.equal(result.handler, "absent"); assert.equal(result.provider, "absent")
  for (const key of ["group:100", "group:200", "process:100", "process:200", "process:201"]) assert.equal(calls.filter(c => c === key).length, 2)
  assert.ok(result.durationMs < result.limitMs)
})

test("delayed parent absence reads cannot reset the budget between passes", async () => {
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 55))
  const adapter = { ...absent, async readProcess(_pid: number) { await pause(); return null }, async readGroup(_pid: number) { await pause(); return [] } }
  const result = await verifyQualificationAbsence(adapter, [handler], { leader, observed: [leader, child] }, [], 80)
  assert.equal(result.outcome, "timed_out"); assert.equal(result.passes, 1)
  assert.equal(result.handler, "unknown"); assert.equal(result.provider, "unknown")
  assert.ok(result.durationMs < 300)
})

test("never-settling parent absence reads remain unknown and bounded", async () => {
  const result = await verifyQualificationAbsence({ ...absent, readProcess: () => new Promise(() => undefined) }, [handler], group, [], 40)
  assert.equal(result.outcome, "timed_out"); assert.equal(result.passes, 0)
  assert.equal(result.handler, "unknown"); assert.equal(result.provider, "unknown")
  assert.ok(result.durationMs < 300)
})

test("unavailable parent absence reads do not become process absence", async () => {
  const result = await verifyQualificationAbsence({ ...absent, async readGroup() { throw new Error("unavailable") } }, [handler], group, [], 80)
  assert.equal(result.outcome, "failed")
  assert.equal(result.handler, "unknown"); assert.equal(result.provider, "unknown")
})

test("parent absence bounds concurrent process observations for large groups", async () => {
  let active = 0, peak = 0
  const members = Array.from({ length: 24 }, (_, index) => ({ ...leader, pid: 200 + index, birth: `${index + 2}:member` }))
  const adapter = { ...absent, async readProcess(_pid: number) { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return null } }
  const result = await verifyQualificationAbsence(adapter, [handler], { leader: members[0]!, observed: members }, [], 500)
  assert.equal(result.outcome, "completed")
  assert.ok(peak <= 8, `peak concurrent reads: ${peak}`)
})

test("a surviving provider does not erase independently verified Handler absence", async () => {
  const adapter = { ...absent, async readGroup(pid: number) { return pid === 200 ? [leader] : [] }, async readProcess(pid: number) { return pid === 200 ? leader : null } }
  const result = await verifyQualificationAbsence(adapter, [handler], group, [], 80)
  assert.equal(result.outcome, "failed"); assert.equal(result.passes, 2)
  assert.equal(result.handler, "absent"); assert.equal(result.provider, "present")
})