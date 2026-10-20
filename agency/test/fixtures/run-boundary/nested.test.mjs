import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
await import(process.env.AGENCY_TEST_BOUNDARY_MODULE)
test("nested application is not a worker", async () => {
  const result = await new Promise((resolve, reject) => execFile(process.execPath, [fileURLToPath(new URL("./nested.mjs", import.meta.url))], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))))
  assert.deepEqual(result, { args: [], nodeOptions: process.env.NODE_OPTIONS ?? null })
})