import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { EventEmitter, once } from "node:events"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { ChildProcess } from "node:child_process"
import { createNativeFixtureScope, createSyntheticFixtureScope, nativeFixtureAccess } from "./fixtures/run-scope.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { connectFixture, startFixtureReceiver } from "./fixtures/fixture-channel.js"

const rawModes = ["foreign-run", "foreign-ref", "wrong-pid", "replay", "unknown-field", "conflict", "omitted", "open-pipe", "outstanding", "unknown-message", "oversized", "sealed-late", "bad-observation", "bad-late-observation", "seal-eof"]

async function fixture(mode: string, t: test.TestContext) {
  const root = await mkdtemp("/tmp/agv-")
  await chmod(root, 0o700)
  const scope = createNativeFixtureScope({ runId: root, workerFile: "channel-test", deadlineMs: 5000 })
  scope.artifact(root)
  const receiver = await startFixtureReceiver(scope, join(root, "r.sock"))
  const ref = scope.intent(mode === "seal-complete" || mode === "sealed" || mode === "sealed-late" || mode === "seal-eof" ? "channel-prepared" : mode === "singleton" ? "singleton-contender" : mode.startsWith("editor-") ? "editor" : "channel-source")
  const connection = receiver.connection(ref)
  const child = scope.spawn(ref, () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/run-scope/" + ((mode === "seal-complete" || rawModes.includes(mode) || mode.startsWith("editor-")) ? "channel-raw.js" : "channel-source.js"), import.meta.url)), mode], {
    env: { ...process.env, AGENCY_TEST_CONNECTION: JSON.stringify(connection), AGENCY_TEST_RELEASE: join(root, "release") }, stdio: mode === "ipc" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  }), { closeAdmission() {} })
  t.after(async () => {
    if (child.connected) child.disconnect()
    const result = await scope.finish()
    const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
    for (const launch of result.launches) {
      if (launch.pid === null) continue
      const until = Date.now() + 5000
      while (true) {
        try { if (await adapter.readProcess(launch.pid) === null) break } catch {}
        assert.ok(Date.now() < until, "Miniature fixture still physically present: " + launch.role)
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
    }
  })
  let output = "", errors = ""
  child.stdout!.on("data", chunk => { output += chunk }); child.stderr!.on("data", chunk => { errors += chunk })
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  return { root, scope, receiver, ref, child, closed, output: () => output, errors: () => errors }
}

test("source snapshots retain actual child terminal and close without leaf reporters", async t => {
  const f = await fixture("normal", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors() + JSON.stringify(f.scope.snapshot().failures))
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  const leaf = result.launches.find(value => value.role === "channel-leaf")!
  assert.deepEqual(leaf.exit, { code: 0, signal: null })
  assert.equal(leaf.close, true)
  assert.equal(leaf.absent, true)
  assert.match(f.output(), /application-started/)
})

test("unreported source death remains incomplete after its finite child exits", async t => {
  const f = await fixture("lost", t)
  await f.closed
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.match(result.failures.join(" "), /source|complete|lost/)
})

test("connection refusal does not gate application entry or become successful reporting", async t => {
  const f = await fixture("wrong-token", t)
  await f.closed
  assert.match(f.output(), /application-started/)
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.match(result.failures.join(" "), /token|source|report/)
})

test("dynamic inventory seal does not wait for a pending application operation", async t => {
  const f = await fixture("sealed", t)
  await new Promise<void>(resolve => {
    const poll = () => f.output().includes("ready") ? resolve() : setTimeout(poll, 10)
    poll()
  })
  await f.receiver.prepareExit(f.ref)
  await f.receiver.prepareExit(f.ref)
  await f.scope.signal(f.ref, "SIGTERM")
  await f.closed
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  const leaf = result.launches.find(value => value.role === "channel-leaf")!
  assert.equal(leaf.unavailable, "prepared-owner-exit")
  assert.equal(leaf.exit, null)
  assert.equal(leaf.absent, true)
})

test("synthetic scopes cannot connect to native reporting infrastructure", async () => {
  const scope = createSyntheticFixtureScope({ runId: "fake", workerFile: "fake", deadlineMs: 20,
    adapter: { platform: "linux", bootId: async () => "fake", readProcess: async () => null, readGroup: async () => [], signalGroup: async () => {} }, signal: () => {} })
  await assert.rejects(startFixtureReceiver(scope, "/unused"), /native|synthetic/)
  assert.throws(() => connectFixture({ socketPath: "/unused", runId: "fake", ownerRef: { runId: "fake", launchId: "fake" }, ownerToken: "fake" }, scope), /native|synthetic/)
})

for (const mode of ["launcher", "early-launcher"]) test("a detached owning source reports after launcher close: " + mode, async t => {
  const f = await fixture(mode, t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors() + JSON.stringify(f.scope.snapshot().failures))
  if (mode === "early-launcher") assert.match(f.output(), /child-application-before-report/)
  await writeFile(join(f.root, "release"), "go")
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  const handler = result.launches.find(value => value.role === "channel-handler")!
  assert.equal(handler.unavailable, "launcher-finished")
  assert.equal(handler.exit, null)
  assert.equal(handler.absent, true)
  assert.ok(result.launches.some(value => value.role === "channel-leaf" && value.close === true && value.absent === true))
})

test("ordinary singleton launcher completion binds its no-reporter leaf before exit", async t => {
  const f = await fixture("singleton", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors() + JSON.stringify(f.scope.snapshot().failures))
  const leaf = f.scope.snapshot().launches.find(value => value.role === "singleton-handler")!
  assert.ok(leaf.identity)
  await f.scope.signal(leaf.ref, "SIGTERM")
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  const settled = result.launches.find(value => value.ref.launchId === leaf.ref.launchId)!
  assert.equal(settled.unavailable, "launcher-finished")
  assert.equal(settled.exit, null)
  assert.equal(settled.absent, true)
})

for (const mode of rawModes) test("refuses invalid or incomplete source evidence: " + mode, async t => {
  const f = await fixture(mode, t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  if (mode !== "oversized" && mode !== "seal-eof") assert.match(f.output(), /"accepted":false/, f.output())
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.ok(result.failures.length > 0)
  if (mode === "bad-observation") assert.equal(result.launches.filter(value => value.role === "raw-leaf").length, 1)
})

for (const mode of ["failed-spawn", "largest"]) test("failed native spawn snapshots settle without invented PIDs: " + mode, async t => {
  const f = await fixture(mode, t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  const failed = result.launches.filter(value => value.role.startsWith("failed-provider-"))
  assert.equal(failed.length, mode === "largest" ? 32 : 1)
  assert.ok(failed.every(value => value.pid === null && value.close === true && value.error !== null))
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536)
})

test("application IPC rejects unknown messages and disconnects independently of reporting", async t => {
  const f = await fixture("ipc", t)
  const message = () => Promise.race([once(f.child, "message"), f.closed.then((): never => { throw new Error("IPC fixture exited: " + f.errors() + f.output()) })])
  const pong = message()
  f.child.send("ping")
  assert.equal((await pong)[0], "pong")
  const refused = message()
  f.child.send({ fixture: "seal" })
  assert.equal((await refused)[0], "application-refused")
  f.child.send("disconnect")
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  assert.equal((await f.scope.finish()).state, "settled")
})

test("synthetic PID collision cannot signal a separately registered native sentinel", async t => {
  const root = await mkdtemp("/tmp/agv-")
  const native = createNativeFixtureScope({ runId: root, workerFile: "sentinel", deadlineMs: 5000 })
  t.after(async () => { await native.finish() })
  native.artifact(root)
  const sentinel = native.intent("sentinel")
  const child = native.spawn(sentinel, () => spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 3000)"], { stdio: "ignore" }), { closeAdmission() {} })
  const closed = once(child, "close")
  const identity = await native.observe(sentinel)
  assert.ok(identity)
  const signals: number[] = []
  let present = true
  const fake = createSyntheticFixtureScope({ runId: "synthetic", workerFile: "fake", deadlineMs: 20,
    adapter: { platform: "linux", bootId: async () => identity.bootId, readProcess: async () => present ? identity : null, readGroup: async () => [], signalGroup: async () => {} },
    signal: pid => { signals.push(pid) } })
  const ref = fake.intent("collision")
  const emitter = Object.assign(new EventEmitter(), { pid: child.pid, exitCode: null, signalCode: null }) as unknown as ChildProcess
  fake.spawn(ref, () => emitter, { closeAdmission() {} })
  await fake.signal(ref, "SIGKILL")
  assert.deepEqual(signals, [child.pid])
  assert.ok(await native.observe(sentinel))
  present = false
  emitter.emit("exit", 0, null); emitter.emit("close", 0, null)
  assert.equal((await fake.finish()).state, "settled")
  await native.signal(sentinel, "SIGTERM")
  await closed
  assert.equal((await native.finish()).state, "settled")
})

test("prepared detached source termination is verified independently of unavailable launcher events", async t => {
  const f = await fixture("sealed-launcher", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  const handler = f.scope.snapshot().launches.find(value => value.role === "darwin-handler")!
  await f.receiver.prepareExit(handler.ref)
  await f.scope.signal(handler.ref, "SIGTERM")
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  assert.equal(result.launches.find(value => value.role === "darwin-handler")!.unavailable, "launcher-finished")
  assert.equal(result.launches.find(value => value.role === "channel-leaf")!.unavailable, "prepared-owner-exit")
  assert.ok(result.launches.every(value => value.absent === true))
})

test("a synchronous source spawn throw retains its original attempt without a nonexistent close event", async t => {
  const f = await fixture("throw", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  const launch = result.launches.find(value => value.role === "thrown-provider")!
  assert.equal(launch.pid, null)
  assert.equal(launch.close, null)
  assert.match(launch.error!, /synchronous spawn failure/)
})

test("source completion racing preparation satisfies its accepted finite boundary", async t => {
  const f = await fixture("seal-complete", t)
  while (!f.output().includes("ready")) await new Promise(resolve => setTimeout(resolve, 10))
  await f.receiver.prepareExit(f.ref)
  await f.closed
  assert.equal((await f.scope.finish()).state, "settled", f.errors())
})

test("declared qualification exec binds the original shell handle once", { timeout: 15000 }, async t=>{
  const root=await mkdtemp("/tmp/agv-"),scope=createNativeFixtureScope({runId:root,workerFile:"exec",deadlineMs:5000})
  const receiver=await startFixtureReceiver(scope,join(root,"r.sock")),ref=scope.intent("qualification-shell"),access=(await import("./fixtures/run-scope.js")).nativeFixtureAccess(scope)
  access.declareExec(ref,process.execPath)
  const config=receiver.connection(ref),file=join(root,"source.mjs"),quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'"
  const code=`import {connectFixture} from ${JSON.stringify(new URL("./fixtures/fixture-channel.js",import.meta.url).href)};import {createNativeFixtureScope} from ${JSON.stringify(new URL("./fixtures/run-scope.js",import.meta.url).href)};const config=JSON.parse(process.env.CONNECTION);const scope=createNativeFixtureScope({runId:config.runId,workerFile:config.ownerRef.launchId,deadlineMs:5000});const client=connectFixture(config,scope);await client.checkpoint();process.stdout.write('admitted');await new Promise(r=>process.stdin.once('data',r));await client.finish();`
  await writeFile(file,code)
  const child=scope.spawn(ref,()=>spawn("/bin/sh",["-c","read line; exec "+quote(process.execPath)+" "+quote(file)],{env:{...process.env,CONNECTION:JSON.stringify(config)},stdio:"pipe"}),{closeAdmission(){}})
  t.after(async () => { child.stdin!.end(); await scope.finish() })
  const closed=new Promise(resolve=>child.once("close",resolve)),observed=await scope.observe(ref)
  assert.equal(observed?.pid,child.pid)
  const admitted=new Promise(resolve=>child.stdout!.once("data",resolve));child.stdin!.write("go\n");await admitted
  const current=await scope.observe(ref);assert.equal(current?.pid,child.pid);assert.notEqual(current?.birth,observed?.birth)
  assert.throws(()=>access.declareExec(ref,process.execPath),/Undeclared fixture exec/)
  child.stdin!.end("finish\n");await closed
  const result=await scope.finish();assert.equal(result.state,"settled",JSON.stringify(result.failures));assert.equal(result.launches.length,1);assert.equal(result.launches[0]!.absent,true)
})

for (const mode of ["normal", "wrong-token"]) test("fixture source settlement is required before exported cleanup: " + mode, { timeout: 15000 }, async t => {
  const f = await fixture(mode, t)
  await f.closed
  const settle = () => f.receiver.settle([f.ref])
  if (mode === "normal") await settle()
  else await assert.rejects(settle(), /source|report|deadline/i)
})

test("declared exec grants no signal before source admission", { timeout: 15000 }, async () => {
  const scope = createNativeFixtureScope({ runId: "exec-refusal", workerFile: "exec-refusal", deadlineMs: 5000 })
  const access = (await import("./fixtures/run-scope.js")).nativeFixtureAccess(scope), ref = scope.intent("qualification-shell")
  access.declareExec(ref, process.execPath)
  const child = scope.spawn(ref, () => spawn("/bin/sleep", ["0.2"], { stdio: "pipe" }), { closeAdmission() {} })
  const closed = new Promise(resolve => child.once("close", resolve))
  await assert.rejects(access.signalPid(ref, "SIGTERM"), /exec source not admitted/)
  await closed
  assert.equal((await scope.finish()).state, "incomplete")
})

for (const declared of [false, true]) test("qualification exec refuses an undeclared or mismatched image: " + declared, { timeout: 15000 }, async t => {
  const scope = createNativeFixtureScope({ runId: crypto.randomUUID(), workerFile: "exec-refusal", deadlineMs: 5000 })
  const access = (await import("./fixtures/run-scope.js")).nativeFixtureAccess(scope), ref = scope.intent("qualification-shell")
  if (declared) access.declareExec(ref, "/not/the/declared/image")
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const child = scope.spawn(ref, () => spawn("/bin/sh", ["-c", "printf ready; read line; exec " + quote(process.execPath) + " -e " + quote("process.stdout.write('exec');process.stdin.resume()")], { stdio: "pipe" }), { closeAdmission() {} })
  const closed = new Promise(resolve => child.once("close", resolve))
  t.after(async () => { child.stdin!.end(); await closed; await scope.finish() })
  await once(child.stdout!, "data")
  await scope.observe(ref)
  const ready = new Promise(resolve => child.stdout!.once("data", resolve))
  child.stdin!.write("go\n"); await ready
  await assert.rejects(access.admitSource(ref), /identity mismatch/i)
  await assert.rejects(access.signalPid(ref, "SIGTERM"), /exec source not admitted|identity mismatch/i)
  child.stdin!.end(); await closed
  assert.equal((await scope.finish()).state, "incomplete")
})

test("failed client completion retains final launches and isolates later source checks", { timeout: 20000 }, async t => {
  const f = await fixture("failed-complete", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  assert.match(f.output(), /retained-original=.*original local failure/)
  const leaf = f.scope.snapshot().launches.find(value => value.role === "failed-source-leaf")
  assert.ok(leaf, JSON.stringify(f.scope.snapshot()))
  assert.equal(leaf.close, true)
  await f.receiver.settle([f.ref])
  await assert.rejects(nativeFixtureAccess(f.scope).settleChecks([f.ref, leaf.ref]), /original local failure/)
  const ref = f.scope.intent("channel-source"), connection = f.receiver.connection(ref)
  const child = f.scope.spawn(ref, () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/run-scope/channel-source.js", import.meta.url)), "normal"], {
    env: { ...process.env, AGENCY_TEST_CONNECTION: JSON.stringify(connection) }, stdio: "ignore",
  }), { closeAdmission() {} })
  await new Promise<void>(resolve => child.once("close", () => resolve()))
  await f.receiver.settle([ref])
  const closure = f.scope.snapshot().launches.filter(value => value.ref.launchId === ref.launchId || value.ownerId === ref.launchId).map(value => value.ref)
  await nativeFixtureAccess(f.scope).settleChecks(closure)
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.equal(result.failures.filter(value => value.includes("original local failure")).length, 1)
  assert.ok(result.launches.every(value => value.absent === true))
})

test("timed out owner finalization still publishes final launches and disconnects", { timeout: 15000 }, async t => {
  const f = await fixture("timed-complete", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  assert.match(f.output(), /other-cleanup-attempted/)
  assert.match(f.output(), /retained-original=.*held cleanup deadline/)
  await f.receiver.settle([f.ref])
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.ok(result.launches.some(value => value.role === "failed-source-leaf" && value.close === true && value.absent === true))
  assert.match(result.failures.join(";"), /held cleanup deadline/)
})

test("normal client completion retains a queued native check failure in its final snapshot", { timeout: 15000 }, async t => {
  const f = await fixture("queued-check-complete", t)
  await f.closed
  assert.equal(f.child.exitCode, 0, f.errors())
  assert.match(f.output(), /retained-original=.*failed-source-leaf signal/)
  await f.receiver.settle([f.ref])
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.ok(result.launches.some(value => value.role === "failed-source-leaf" && value.close === true && value.absent === true))
  assert.match(result.failures.join(";"), /failed-source-leaf signal/)
})

test("rejected initial parent identity grants neither direct nor group signal authority while the source is live", async () => {
  const scope = createNativeFixtureScope({ runId: crypto.randomUUID(), workerFile: "rejected-parent", deadlineMs: 5000 })
  const leafCode = "process.on('SIGTERM',()=>process.stdout.write('delivered-signal\\n'));process.stdout.write('ready\\n');setTimeout(()=>process.exit(0),3000)"
  const sourceCode = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>process.stdout.write('delivered-owner\\n'));const child=spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:['ignore','pipe','ignore']});child.stdout.on('data',chunk=>{process.stdout.write(chunk);if(String(chunk).includes('ready'))process.stdout.write('leaf-pid='+child.pid+'\\n')});child.once('close',()=>process.exit(0))`
  const source = scope.intent("source", { ownGroup: true }), child = scope.spawn(source, () => spawn(process.execPath, ["-e", sourceCode], { detached: true, stdio: ["ignore", "pipe", "ignore"] }), { closeAdmission() {} })
  const closed = new Promise<void>(resolve => child.once("close", resolve))
  let output = ""
  await new Promise<void>(resolve => { child.stdout!.on("data", chunk => { output += chunk; if (/leaf-pid=\d+/.test(output)) resolve() }) })
  await scope.observe(source)
  const access = nativeFixtureAccess(scope), adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const pid = Number(/leaf-pid=(\d+)/.exec(output)![1]), identity = await adapter.readProcess(pid)
  assert.ok(identity)
  const rejected = { ...access.result(source), ref: { runId: source.runId, launchId: crypto.randomUUID() }, role: "rejected-leaf", ownerId: source.launchId, pid, identity }
  await assert.rejects(access.accept(rejected, 999, false, () => access.sourceAlive(source)), /reported identity mismatch/)
  assert.equal(child.exitCode, null)
  try {
    await assert.rejects(scope.signal(rejected.ref, "SIGTERM"), /terminal|missing identity|authority/i)
    await assert.rejects(scope.signal(source, "SIGTERM"), /Unregistered fixture group member/)
  } finally { await closed }
  assert.doesNotMatch(output, /delivered-signal|delivered-owner/)
  const result = await scope.finish()
  assert.equal(result.state, "incomplete")
  assert.equal(result.launches.filter(value => value.role === "rejected-leaf").length, 1)
  assert.ok(result.launches.every(value => value.absent === true))
})