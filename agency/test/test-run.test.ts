import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runTests } from "../scripts/test-run.js"
import { createNativeFixtureScope } from "./fixtures/run-scope.js"

const bootstrap = new URL("./fixtures/run-boundary.js", import.meta.url).href
const selected = fileURLToPath(new URL("../../test/fixtures/run-boundary/empty.test.mjs", import.meta.url))
const empty = `const result={version:1,runId:m.runId,workerFile:m.workerFiles[0],state:'settled',launches:[],operations:[],failures:[],artifacts:[]};const b={version:1,runId:m.runId,revision:m.revision,workerFile:m.workerFiles[0],pid:process.pid,result};`
const head = `const fs=require('node:fs'),p=require('node:path');const m=JSON.parse(process.env.AGENCY_TEST_WORKER_RUN);fs.mkdirSync(p.join(m.runRoot,'workers'),{recursive:true});`
const save = `fs.writeFileSync(p.join(m.runRoot,'workers',process.pid+'.json'),JSON.stringify(b));`
async function run(source: string, options: Partial<Parameters<typeof runTests>[0]> = {}) {
  return runTests({ group: "native", command: [process.execPath, "-e", head + empty + source], workerFiles: [selected], cwd: process.cwd(), revision: "runner-test", stdio: "ignore", timeoutMs: 10000, closeMs: 1000, ...options })
}

test("a failed body preserves exit 7 while settled cleanup remains available", async () => {
  const r = await run(save + "process.exitCode=7")
  assert.equal(r.code, 7)
  assert.equal(r.result.exitCode, 7)
  assert.equal(r.result.state, "failed")
  assert.equal(r.result.workers[0]!.state, "settled")
  assert.match(r.result.failures.join(";"), /7/)
  assert.deepEqual(JSON.parse(await readFile(join(r.root, "result.json"), "utf8")), r.result)
})

test("running evidence exists before spawn and consecutive runs use unique roots", async () => {
  const parent = await mkdtemp("/tmp/agv-")
  const source = `const initial=JSON.parse(fs.readFileSync(p.join(m.runRoot,'result.json'),'utf8'));if(initial.state!=='running'||initial.runId!==m.runId)throw Error('missing running evidence');` + save
  const a = await run(source, { evidenceParent: parent }), b = await run(source, { evidenceParent: parent })
  assert.equal(a.code, 0); assert.equal(b.code, 0)
  assert.notEqual(a.root, b.root); assert.notEqual(a.result.runId, b.result.runId)
  assert.equal((await readdir(parent)).length, 2)
})

for (const mode of ["missing", "foreign", "corrupt", "duplicate", "wrong-file", "wrong-revision", "unsettled", "malformed-result"]) test("worker boundary cannot pass with " + mode, async () => {
  const sources: Record<string, string> = {
    missing: "",
    foreign: "b.runId='old-run';" + save,
    corrupt: "fs.writeFileSync(p.join(m.runRoot,'workers','bad.json'),'{')",
    duplicate: save + "b.pid++;" + save,
    "wrong-file": "b.workerFile='/foreign/file';" + save,
    "wrong-revision": "b.revision='old';" + save,
    unsettled: "b.result.state='incomplete';b.result.failures=['missing child report'];" + save,
    "malformed-result": "b.result={state:'settled'};" + save,
  }
  const r = await run(sources[mode]!)
  assert.equal(r.code, 1); assert.equal(r.result.state, "incomplete")
  assert.ok(r.result.unresolved.length)
})

test("body failure and missing worker evidence are both retained", async () => {
  const r = await run("process.exitCode=7")
  assert.equal(r.code, 7); assert.equal(r.result.state, "incomplete")
  assert.ok(r.result.failures.length); assert.ok(r.result.unresolved.length)
})

test("signal and spawn error cannot look successful", async () => {
  const signaled = await run(save + "process.kill(process.pid,'SIGTERM')")
  assert.equal(signaled.code, 1); assert.equal(signaled.result.state, "failed")
  assert.match(signaled.result.failures.join(";"), /SIGTERM/)
  const failed = await run("", { command: ["/missing/agency-test-command"] })
  assert.equal(failed.code, 1); assert.equal(failed.result.state, "incomplete")
  assert.match(failed.result.failures.join(";"), /ENOENT/)
  assert.equal(JSON.parse(await readFile(join(failed.root, "result.json"), "utf8")).state, "incomplete")
})

test("a failed final result write returns failure", async () => {
  const r = await run(save + "fs.unlinkSync(p.join(m.runRoot,'result.json'));fs.mkdirSync(p.join(m.runRoot,'result.json'))")
  assert.equal(r.code, 1); assert.equal(r.result.state, "incomplete")
  assert.match(r.result.unresolved.join(";"), /result.*write/i)
})

test("watchdog cancellation is bounded when the direct controller ignores TERM", { timeout: 10000 }, async () => {
  const r = await run("process.on('SIGTERM',()=>{});setTimeout(()=>{},1800)", { timeoutMs: 300, closeMs: 200 })
  assert.equal(r.code, 1); assert.equal(r.result.state, "incomplete")
  assert.match(r.result.unresolved.join(";"), /watchdog/)
  assert.match(r.result.unresolved.join(";"), /controller.*close/)
  const snapshot = JSON.stringify(r.result)
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal(JSON.stringify(r.result), snapshot)
})

test("a real miniature group requires every bootstrap worker even when wholly filtered", async () => {
  const other = fileURLToPath(new URL("../../test/fixtures/run-boundary/nested.test.mjs", import.meta.url))
  const r = await runTests({ group: "native", command: [process.execPath, "--import=" + bootstrap, "--test", "--test-concurrency=1", "--test-name-pattern=unmatched", selected, other], workerFiles: [selected, other], cwd: process.cwd(), revision: "miniature", stdio: "ignore", timeoutMs: 15000, env: { ...process.env, AGENCY_TEST_BOUNDARY_MODULE: bootstrap } })
  assert.equal(r.code, 0, JSON.stringify(r.result))
  assert.equal(r.result.state, "passed"); assert.equal(r.result.workers.length, 2)
  assert.deepEqual(r.result.workers.map(w => w.workerFile).sort(), [selected, other].sort())
})

test("interrupting the runner leaves its pre-spawn result running", { timeout: 15000 }, async t => {
  const parent = await mkdtemp("/tmp/agv-"), script = join(parent, "runner.mjs")
  await writeFile(script, `import {runTests} from ${JSON.stringify(new URL("../scripts/test-run.js", import.meta.url).href)};await runTests({group:'native',command:[process.execPath,'-e',${JSON.stringify(head + "fs.writeFileSync(p.join(m.runRoot,'ready'),'yes');setTimeout(()=>{},600)")}],workerFiles:[${JSON.stringify(selected)}],cwd:process.cwd(),revision:'interrupt',evidenceParent:${JSON.stringify(parent)},stdio:'ignore',timeoutMs:5000});`)
  const scope = createNativeFixtureScope({ runId: crypto.randomUUID(), workerFile: "runner-interrupt", deadlineMs: 5000 }), ref = scope.intent("runner-interrupt")
  const child = scope.spawn(ref, () => spawn(process.execPath, [script], { stdio: "ignore" }), { closeAdmission() {} })
  const closed = new Promise(resolve => child.once("close", resolve)); t.after(() => scope.finish())
  await scope.observe(ref)
  const until = Date.now() + 5000
  let root: string | undefined
  while (Date.now() < until) {
    root = (await readdir(parent)).find(value => value.startsWith("run-"))
    if (root && await readFile(join(parent, root, "ready"), "utf8").catch(() => "") === "yes") break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(root)
  await scope.signal(ref, "SIGTERM"); await closed
  assert.equal(JSON.parse(await readFile(join(parent, root, "result.json"), "utf8")).state, "running")
  assert.equal((await scope.finish()).state, "settled")
})