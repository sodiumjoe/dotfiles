import { before, after } from "node:test"
import { realpathSync, mkdtempSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createNativeFixtureScope, nativeFixtureAccess, type FixtureScope } from "./run-scope.js"
import { startFixtureReceiver, type FixtureReceiver } from "./fixture-channel.js"

type WorkerRun = { runId: string; workerFiles: string[]; runRoot: string; revision: string }
const file = process.argv[1] ? realpathSync(process.argv[1]) : null
const raw = process.env.AGENCY_TEST_WORKER_RUN
let metadata: WorkerRun | undefined
if (process.env.NODE_TEST_CONTEXT === "child-v8" && file) {
  if (raw) {
    const candidate = JSON.parse(raw) as WorkerRun
    if (!candidate.runId || !candidate.runRoot || !candidate.revision || !Array.isArray(candidate.workerFiles)) throw new Error("Invalid worker bootstrap metadata")
    if (candidate.workerFiles.some(value => realpathSync(value) === file)) metadata = candidate
  } else if (/\.test\.(?:mjs|js)$/.test(file)) {
    metadata = { runId: randomUUID(), workerFiles: [file], runRoot: mkdtempSync("/tmp/agv-"), revision: "standalone" }
  }
}
let ready = false
if (metadata) before(context => { ready = context.name === "<root>" })
let scope: FixtureScope | undefined, receiver: FixtureReceiver | undefined
let allocating: Promise<FixtureScope> | undefined
const finalizers: Array<{ label: string; work: () => Promise<void> }> = []

export function registerWorkerFinalizer(label: string, work: () => Promise<void>): void {
  if (!metadata) throw new Error("Inactive test worker scope")
  if (scope) scope.finalizer(label, work)
  else finalizers.push({ label, work })
}
export async function workerScope(): Promise<FixtureScope> {
  if (!metadata || !file || !ready) throw new Error("Inactive test worker scope; import the boundary at test module evaluation")
  allocating ??= (async () => {
    const local = createNativeFixtureScope({ runId: metadata.runId, workerFile: file, deadlineMs: 120000 })
    local.artifact(metadata.runRoot)
    const socketRoot = await mkdtemp("/tmp/agv-")
    local.artifact(socketRoot)
    receiver = await startFixtureReceiver(local, join(socketRoot, "r.sock"))
    for (const value of finalizers) local.finalizer(value.label, value.work)
    finalizers.length = 0
    scope = local
    return local
  })()
  return allocating
}
export async function workerReceiver(): Promise<FixtureReceiver> {
  await workerScope()
  return receiver!
}
if (metadata && file) after(async () => {
  if (!ready) return
  const local = await workerScope()
  let result = local.snapshot()
  try { result = await local.finish() }
  catch (error) { nativeFixtureAccess(local).fault(error); result = local.snapshot() }
  finally {
    const root = join(metadata.runRoot, "workers")
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(join(root, process.pid + ".json"), JSON.stringify({ version: 1, runId: metadata.runId, workerFile: file, revision: metadata.revision, pid: process.pid, result }), { flag: "wx", mode: 0o600 })
  }
  if (result.state !== "settled") throw new Error("Incomplete test worker scope: " + result.failures.join("; "))
})