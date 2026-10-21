import test from "node:test"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
const base = pathToFileURL(process.env.AGENCY_FIXTURE_DIST + "/")
const { qualificationFixture } = await import(new URL("test/qualification-support.js", base))
const { workerScope } = await import(new URL("test/fixtures/run-boundary.js", base))
const { createNativeFixtureScope, nativeFixtureAccess } = await import(new URL("test/fixtures/run-scope.js", base))
test("qualification cleanup continuation expires", async t => {
  const f = await qualificationFixture(t), scope = await workerScope(), access = nativeFixtureAccess(scope)
  await writeFile(process.env.AGENCY_DEADLINE_OUTPUT, JSON.stringify({ root: f.root }))
  if (process.env.AGENCY_DEADLINE_CASE === "signal") {
    const child = f.native("qualification-command", process.execPath, ["-e", "process.on('SIGTERM',()=>process.stdout.write('late-delivery'));process.stdout.write('ready');setTimeout(()=>process.exit(0),8500)"], { env: process.env })
    let output = ""
    await new Promise(resolve => child.stdout.on("data", chunk => { output += chunk; if (output.includes("ready")) resolve() }))
    const launch = scope.snapshot().launches.find(value => value.pid === child.pid)
    launch.identity = await scope.observe(launch.ref)
    const local = createNativeFixtureScope({ runId: crypto.randomUUID(), workerFile: "held-qualification-signal", deadlineMs: 20000 }), target = nativeFixtureAccess(local)
    const ref = { runId: local.snapshot().runId, launchId: crypto.randomUUID() }
    let release
    const held = new Promise(resolve => { release = resolve })
    await target.accept({ ...launch, ref }, process.pid, false, async () => { await held; return true })
    const signalPid = access.signalPid.bind(access)
    access.signalPid = (requested, signal, deadlineMs) => requested.launchId === launch.ref.launchId ? target.signalPid(ref, signal, deadlineMs) : signalPid(requested, signal, deadlineMs)
    const first = f.verifyCleanup(), second = f.verifyCleanup()
    assert.equal(first, second)
    const outcome = first.then(() => null, error => error)
    await new Promise(resolve => setTimeout(resolve, 6000)); release()
    const error = await outcome
    access.signalPid = signalPid
    await new Promise(resolve => setTimeout(resolve, 50))
    await target.accept({ ...launch, ref, exit: { code: 0, signal: null }, close: true }, process.pid, false, async () => false)
    const boundary = await local.finish()
    await writeFile(process.env.AGENCY_DEADLINE_OUTPUT, JSON.stringify({ root: f.root, output, error: String(error), boundary }))
  } else {
    assert.equal((await f.command(["status", "--json"])).code, 0)
    const current = await f.owner(), readProcess = f.adapter.readProcess.bind(f.adapter)
    let release, entered
    const held = new Promise(resolve => { release = resolve }), pending = new Promise(resolve => { entered = resolve })
    f.adapter.readProcess = async pid => { const observed = await readProcess(pid); if (pid === current.process.pid) { entered(); await held }; return observed }
    const first = f.verifyCleanup(), outcome = first.then(() => null, error => error)
    assert.equal(f.verifyCleanup(), first)
    await pending
    await new Promise(resolve => setTimeout(resolve, 15500))
    const before = scope.snapshot().launches.length
    f.adapter.readProcess = readProcess
    release()
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = scope.snapshot().launches.length
    if (await readProcess(current.process.pid)) assert.equal((await f.shutdown()).code, 0)
    const error = await outcome
    await writeFile(process.env.AGENCY_DEADLINE_OUTPUT, JSON.stringify({ root: f.root, before, after, error: String(error) }))
  }
})