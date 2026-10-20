import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { FixtureResult } from "./fixtures/run-scope.js"

type Boundary = { version: 1; runId: string; workerFile: string; revision: string; pid: number; result: FixtureResult }
const bootstrap = new URL("./fixtures/run-boundary.js", import.meta.url).href
const fixturePath = (name: string) => fileURLToPath(new URL("../../test/fixtures/run-boundary/" + name + ".test.mjs", import.meta.url))
async function run(names: string[], input: { mode?: string; filter?: string; brokenWrite?: boolean; standalone?: boolean } = {}) {
  const root = await mkdtemp("/tmp/agv-")
  const runRoot = input.brokenWrite ? join(root, "blocked") : root
  if (input.brokenWrite) await writeFile(runRoot, "blocked")
  const workerFiles = names.map(fixturePath), runId = crypto.randomUUID()
  const env = { ...process.env, AGENCY_TEST_BOUNDARY_MODULE: bootstrap, AGENCY_BOUNDARY_CASE: input.mode ?? "pass" }
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT
  delete (env as NodeJS.ProcessEnv).AGENCY_TEST_WORKER_RUN
  if (!input.standalone) Object.assign(env, { AGENCY_TEST_WORKER_RUN: JSON.stringify({ runId, workerFiles, runRoot, revision: "boundary-candidate" }) })
  const args = [...(input.standalone ? [] : ["--import=" + bootstrap]), "--test", "--test-concurrency=1", ...(input.filter ? ["--test-name-pattern=" + input.filter] : []), ...workerFiles]
  const execution = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => execFile(process.execPath, args, { env, timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed || error.signal)) reject(error)
    else resolve({ code: error?.code as number | undefined ?? 0, stdout, stderr })
  }))
  const actualRoot = input.standalone ? /scope-root=(\/[^\s]+)/.exec(execution.stdout)?.[1] ?? root : runRoot
  const files = await readdir(join(actualRoot, "workers")).catch(error => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
    throw error
  })
  const boundaries = await Promise.all(files.map(async file => JSON.parse(await readFile(join(actualRoot, "workers", file), "utf8")) as Boundary))
  return { root: actualRoot, runId, workerFiles, boundaries, ...execution }
}

test("real workers finalize once after per-test teardown and every scope finalizer", async () => {
  const r = await run(["lifecycle", "empty", "nested"])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.boundaries.length, 3)
  assert.deepEqual(r.boundaries.map(b => b.workerFile).sort(), [...r.workerFiles].sort())
  assert.ok(r.boundaries.every(b => b.runId === r.runId && b.result.state === "settled" && b.revision === "boundary-candidate"))
  assert.deepEqual(JSON.parse(await readFile(join(r.root, "sequence.json"), "utf8")), ["body", "teardown", "first", "second"])
  assert.ok(r.boundaries.find(b => b.workerFile === fixturePath("lifecycle"))!.result.artifacts.includes(join(r.root, "sequence.json")))
})

test("skipped test bodies and wholly filtered files still emit worker boundaries", async () => {
  const r = await run(["lifecycle", "empty"], { filter: "does not match" })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.boundaries.length, 2)
  assert.deepEqual(JSON.parse(await readFile(join(r.root, "sequence.json"), "utf8")), ["first", "second"])
})

for (const mode of ["body", "teardown", "finalizer"]) test("worker cleanup preserves " + mode + " failure status and retained artifacts", async () => {
  const r = await run(["lifecycle"], { mode })
  assert.notEqual(r.code, 0)
  assert.equal(r.boundaries.length, 1, r.stdout + r.stderr)
  assert.equal(r.boundaries[0]!.result.state, mode === "finalizer" ? "incomplete" : "settled")
  assert.deepEqual(JSON.parse(await readFile(join(r.root, "sequence.json"), "utf8")), ["body", "teardown", "first", "second"])
})

for (const name of ["import-error", "abrupt"]) test("a worker that cannot finalize leaves an incomplete selection: " + name, async () => {
  const r = await run(["empty", name])
  assert.notEqual(r.code, 0)
  assert.ok(r.boundaries.some(b => b.workerFile === fixturePath("empty")))
  assert.ok(!r.boundaries.some(b => b.workerFile === fixturePath(name)))
})

test("failed boundary persistence cannot appear successful", async () => {
  const r = await run(["empty"], { brokenWrite: true })
  assert.notEqual(r.code, 0)
  assert.equal(r.boundaries.length, 0)
})

test("standalone top-level import registers one equivalent worker boundary", async () => {
  const r = await run(["standalone"], { standalone: true })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.boundaries.length, 1)
  assert.equal(r.boundaries[0]!.workerFile, fixturePath("standalone"))
  assert.equal(r.boundaries[0]!.result.state, "settled")
})

test("a first import from an active test cannot masquerade as a root worker boundary", async () => {
  const r = await run(["late"], { standalone: true })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.boundaries.length, 0)
})