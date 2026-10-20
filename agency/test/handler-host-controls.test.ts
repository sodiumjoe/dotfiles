import { fixtureBridgeSpawner } from "./fixtures/fixture-bridge.js"
import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { acpFixture } from "./acp-support.js"
import { fileExists, until } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { parseHostReply, type HostResult } from "../src/hosts/protocol.js"

for (const tasks of ["reject", "hold"] as const) test(`remote ordinary controls work while task startup ${tasks}s`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks }), acp = await f.connect()
  if (tasks === "hold") await until(async () => await fileExists(join(f.root, "tasks-entered")) ? true : undefined)
  const record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const enrollment = { inventoryId: randomUUID(), hostId: f.paths.hostKey, hostname: "fixture", agyPath: "/opt/agy", loginShell: "/bin/sh" }
  const spawnBridge = await fixtureBridgeSpawner()
  const transport = await connectBridge(enrollment, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "runtime-write"], processFactory: () => spawnBridge(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId: f.paths.hostKey, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const call = async (argv: string[]): Promise<HostResult> => {
    const output: string[] = []
    assert.equal(await runControl([...argv, "--host", f.paths.hostKey, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), hostRoute: (_env, route) => transport.request(route.channel, route.payload), start: async () => { throw new Error("start forbidden") }, stdout: value => output.push(value) }), 0)
    const reply = parseHostReply(JSON.parse(output.join(""))); assert.ok(reply.ok); return reply.result
  }
  await acp.request("initialize", { protocolVersion: 1 })
  const session = await acp.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const roster = await call(["roster", "list"]); assert.ok(roster.state === "page" && roster.agents.length === 1)
  const prompt = acp.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  await acp.next("session/request_permission")
  const pending = await call(["permission", "list"]); assert.ok(pending.state === "permissions" && "snapshot" in pending)
  const offer = pending.snapshot.pending[0]!, commandId = randomUUID()
  const answer = await call(["permission", "decide", "--input-json", JSON.stringify({ commandId, ref: offer.ref, optionId: offer.options[0]!.optionId })])
  assert.deepEqual(await call(["permission", "inspect", commandId]), answer)
  assert.ok(answer.state === "permission" && answer.receipt?.state === "applied")
  assert.equal((await prompt).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
  transport.close(); await transport.closed
  assert.equal((await f.choices()).state, "choices")
  await f.stopSession(String(session.sessionId)); acp.close(); await f.verifyZeroSurvivors()
})
import { readFile, writeFile } from "node:fs/promises"
import { runRuntimeEntryHelper } from "../src/entry/cli.js"

for (const tasks of ["reject", "hold"] as const) test(`independent editor entry works with task startup ${tasks} and never blocks owner reads`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks, entry: "synthetic" }), acp = await f.connect()
  await acp.request("initialize", { protocolVersion: 1 })
  const session = await acp.request("session/new", { cwd: f.workspace, mcpServers: [] }), target = await f.tuple(String(session.sessionId)), commandId = randomUUID(), ref = { hostId: f.paths.hostKey, target }
  const spawnBridge = await fixtureBridgeSpawner()
  const transport = await connectBridge({ inventoryId: randomUUID(), hostId: ref.hostId, hostname: "fixture", agyPath: "/opt/agy", loginShell: "/bin/sh" }, { action: "internal-runtime-bridge", requiredCapabilities: ["entry-open", "runtime-entry-inspect"], processFactory: () => spawnBridge(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId: ref.hostId, handlerGeneration: target.handlerGeneration })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const deps = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), hostRoute: (_env: unknown, route: import("../src/hosts/router.js").HostRoute) => transport.request(route.channel, route.payload), start: async () => { throw new Error("start forbidden") }, stderr() {} }
  const call = async (argv: string[]) => {
    const output: string[] = [], code = await runControl(argv, { ...deps, stdout: value => output.push(value) })
    const reply = parseHostReply(JSON.parse(output.join(""))); assert.ok(reply.ok); return { code, result: reply.result }
  }
  const first = call(["entry", "open", "--input-json", JSON.stringify({ commandId, ...ref })]), second = call(["entry", "open", "--input-json", JSON.stringify({ commandId, ...ref })])
  await until(async () => await fileExists(join(f.root, "entry-activations")) ? true : undefined)
  const roster = await call(["roster", "list", "--host", ref.hostId]), permissions = await call(["permission", "list", "--host", ref.hostId])
  assert.equal(roster.result.state, "page"); assert.equal(permissions.result.state, "permissions")
  await writeFile(join(f.root, "entry-release"), "release")
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(a.code, 0)
  const attached: string[][] = []
  assert.equal(await runRuntimeEntryHelper([commandId, "--target-json", JSON.stringify(ref)], deps, async (file, argv) => { attached.push([file, ...argv]); return 0 }), 0)
  assert.deepEqual(attached, [["tmux", "-S", join(f.paths.runtimeRoot, "entry-tmux.sock"), "attach-session", "-t", "=synthetic-entry"]])
  assert.equal(await readFile(join(f.root, "entry-creations"), "utf8"), "1"); assert.equal(await readFile(join(f.root, "entry-activations"), "utf8"), "1")
  const unknown = await call(["entry", "open", "--input-json", JSON.stringify({ commandId: randomUUID(), hostId: ref.hostId, target: { ...target, agentId: randomUUID() } })])
  assert.ok(unknown.result.state === "entry" && unknown.result.receipt?.state === "stale")
  await f.stopSession(String(session.sessionId))
  const retired = await call(["entry", "inspect", commandId, "--host", ref.hostId])
  assert.ok(retired.result.state === "entry" && retired.result.receipt?.state === "stale")
  assert.equal(await runRuntimeEntryHelper([commandId, "--target-json", JSON.stringify(ref)], deps, async () => { throw new Error("retired terminal forbidden") }), 75)
  assert.equal(await readFile(join(f.root, "entry-creations"), "utf8"), "1")
  transport.close(); await transport.closed; acp.close(); await f.verifyZeroSurvivors()
})

test("fixture bridge close waits for observation and coalesces validated signals", async () => {
  const { fixtureBridgeProcess } = await import("./fixtures/fixture-bridge.js")
  const { createSyntheticFixtureScope } = await import("./fixtures/run-scope.js")
  const { EventEmitter } = await import("node:events")
  const { PassThrough } = await import("node:stream")
  let release!: () => void, reads = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const signals: number[] = []
  const identity = { bootId: "b", pid: 123, parentPid: process.pid, processGroupId: 123, sessionId: 123, uid: 1, gid: 1, birth: "1:fixture" }
  let current: typeof identity | null = identity
  const scope = createSyntheticFixtureScope({ runId: "bridge", workerFile: "bridge", deadlineMs: 1000, adapter: { platform: "darwin", bootId: async () => "b", readProcess: async () => { if (++reads === 1) await gate; return current }, readGroup: async () => [], signalGroup: async () => {} }, signal: pid => { signals.push(pid) } })
  const ref = scope.intent("bridge")
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [], exitCode: null, signalCode: null, kill() { assert.fail("raw kill") } }) as unknown as import("node:child_process").ChildProcess
  scope.spawn(ref, () => child, { closeAdmission() {} })
  const bridge = fixtureBridgeProcess(scope, ref, child)
  assert.equal(bridge.stdin, child.stdin)
  assert.equal(bridge.stdout, child.stdout)
  assert.equal(bridge.kill(), true)
  assert.equal(bridge.kill(), true)
  assert.deepEqual(signals, [])
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(signals, [123])
  current = null
  child.emit("exit", 0, null); child.emit("close", 0, null)
  assert.equal((await scope.finish()).state, "settled")
})

test("control cleanup retains its root and ignores forged historical targets", async t => {
  const { controlFixture } = await import("./control-support.js")
  const { writeFile, lstat } = await import("node:fs/promises")
  const f = await controlFixture(t)
  const forged = JSON.stringify({ pid: process.pid, identity: await f.observe(process.pid) })
  for (const name of ["owned-fake.json", "tools-helpers.jsonl", "owned-probe-00000000-0000-4000-8000-000000000000.json"]) await writeFile(join(f.root, name), forged)
  await f.start()
  await f.cleanup()
  assert.equal((await lstat(f.root)).isDirectory(), true)
})

for (const mode of ["changed", "closed"] as const) test("fixture bridge refuses delivery after " + mode + " observation", async () => {
  const { fixtureBridgeProcess } = await import("./fixtures/fixture-bridge.js")
  const { createSyntheticFixtureScope } = await import("./fixtures/run-scope.js")
  const { EventEmitter } = await import("node:events")
  const { PassThrough } = await import("node:stream")
  const identity = { bootId: "b", pid: 321, parentPid: process.pid, processGroupId: 321, sessionId: 321, uid: 1, gid: 1, birth: "1:fixture" }
  let current: typeof identity | null = identity
  const signals: number[] = []
  const scope = createSyntheticFixtureScope({ runId: mode, workerFile: "bridge", deadlineMs: 1000, adapter: { platform: "darwin", bootId: async () => "b", readProcess: async () => current, readGroup: async () => [], signalGroup: async () => {} }, signal: pid => { signals.push(pid) } })
  const ref = scope.intent("bridge")
  const child = Object.assign(new EventEmitter(), { pid: 321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [], exitCode: null, signalCode: null }) as unknown as import("node:child_process").ChildProcess
  scope.spawn(ref, () => child, { closeAdmission() {} })
  if (mode === "changed") { await scope.observe(ref); current = { ...identity, birth: "2:replacement" } }
  else { Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); child.emit("close", 0, null); current = null }
  const bridge = fixtureBridgeProcess(scope, ref, child)
  bridge.kill()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(signals, [])
  current = null
  if (mode === "changed") { child.emit("exit", 0, null); child.emit("close", 0, null) }
  const result = await scope.finish()
  assert.equal(result.state, mode === "changed" ? "incomplete" : "settled")
  if (mode === "changed") assert.match(result.failures.join(";"), /identity/)
})