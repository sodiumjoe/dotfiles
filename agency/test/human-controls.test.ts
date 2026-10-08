import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { parseHumanControl } from "../src/bureau/human-controls.js"

test("human controls preserve exact origin permission identity", () => {
  const ref = { hostId: "a".repeat(64), target: { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }
  const input = { op: "permission_decide", commandId: randomUUID(), ref, optionId: "reject" }
  assert.deepEqual(parseHumanControl(input), input)
  assert.deepEqual(parseHumanControl({ op: "permission_snapshot" }), { op: "permission_snapshot" })
})

test("human control routes reject model tools and partial permission references", () => {
  for (const op of ["delegate", "report", "run_cancel", "stop", "integrate", "permission_resolve"]) assert.throws(() => parseHumanControl({ op }))
  assert.throws(() => parseHumanControl({ op: "permission_decide", commandId: randomUUID(), ref: { permissionId: randomUUID() }, optionId: "allow" }))
  assert.throws(() => parseHumanControl({ op: "permission_snapshot", providerId: "native" }))
})