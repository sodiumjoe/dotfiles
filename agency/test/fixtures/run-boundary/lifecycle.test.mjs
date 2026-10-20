import assert from "node:assert/strict"
import test from "node:test"
import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"
const { workerScope, registerWorkerFinalizer } = await import(process.env.AGENCY_TEST_BOUNDARY_MODULE)
const root = JSON.parse(process.env.AGENCY_TEST_WORKER_RUN).runRoot
const sequence = []
registerWorkerFinalizer("first", async () => {
  sequence.push("first")
  if (process.env.AGENCY_BOUNDARY_CASE === "finalizer") throw new Error("first finalizer failure")
})
registerWorkerFinalizer("second", async () => {
  sequence.push("second")
  ;(await workerScope()).artifact(join(root, "sequence.json"))
  await assert.rejects(access(join(root, "workers", process.pid + ".json")), { code: "ENOENT" })
  await writeFile(join(root, "sequence.json"), JSON.stringify(sequence))
})
test("selected body", t => {
  sequence.push("body")
  t.after(() => {
    sequence.push("teardown")
    if (process.env.AGENCY_BOUNDARY_CASE === "teardown") throw new Error("test teardown failure")
  })
  if (process.env.AGENCY_BOUNDARY_CASE === "body") throw new Error("test body failure")
})