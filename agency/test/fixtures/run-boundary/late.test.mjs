import assert from "node:assert/strict"
import test from "node:test"
test("late boundary import is a harness error", async () => {
  await assert.rejects(import(process.env.AGENCY_TEST_BOUNDARY_MODULE).then(value => value.workerScope()), /module evaluation|before tests|inactive/i)
})