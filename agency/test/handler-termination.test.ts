import assert from "node:assert/strict"
import test from "node:test"
import { createHandlerTermination, formatTerminationFailure } from "../src/handler/termination.js"

function causes(error: Error | null): unknown[] {
  assert.ok(error instanceof AggregateError)
  return error.errors
}

test("termination joins drain then close and memoizes the outcome", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const clear = t.mock.method(globalThis, "clearTimeout")
  const drained = Promise.withResolvers<void>(), held = Promise.withResolvers<void>(), calls: string[] = []
  const terminate = createHandlerTermination({ drain() { calls.push("drain"); drained.resolve(); return held.promise }, async close() { calls.push("close") } })
  const result = terminate()
  assert.equal(terminate(), result)
  await drained.promise
  assert.deepEqual(calls, ["drain"])
  held.resolve()
  assert.equal(await result, null)
  assert.deepEqual(calls, ["drain", "close"])
  assert.equal(clear.mock.callCount(), 1)
  t.mock.timers.tick(15000)
  assert.equal(await terminate(), null)
})

for (const sync of [false, true]) test(`termination retains drain failure and still closes (sync=${sync})`, async () => {
  const failure = new Error("drain"), calls: string[] = []
  const terminate = createHandlerTermination({ drain() { if (sync) throw failure; return Promise.reject(failure) }, async close() { calls.push("close") } })
  assert.deepEqual(causes(await terminate()), [failure])
  assert.deepEqual(calls, ["close"])
})

for (const drainFails of [false, true]) test(`termination retains close and preceding failure (${drainFails})`, async () => {
  const drain = new Error("drain"), close = new Error("close")
  const terminate = createHandlerTermination({ async drain() { if (drainFails) throw drain }, async close() { throw close } })
  assert.deepEqual(causes(await terminate()), drainFails ? [drain, close] : [close])
})

for (const phase of ["drain", "close"] as const) for (const late of ["resolve", "reject"] as const) test(`termination deadline during ${phase} observes late ${late} without starting another phase`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  let closes = 0
  const terminate = createHandlerTermination({ drain() { if (phase === "drain") { entered.resolve(); return held.promise }; return Promise.resolve() }, close() { closes++; entered.resolve(); return held.promise } })
  const result = terminate()
  await entered.promise
  t.mock.timers.tick(14999)
  assert.equal(terminate(), result)
  t.mock.timers.tick(1)
  const error = await result
  assert.match(String(causes(error)[0]), /deadline.*unverified/)
  if (late === "resolve") held.resolve(); else held.reject(new Error("late"))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(await terminate(), error)
  assert.equal(closes, phase === "drain" ? 0 : 1)
})

test("close deadline retains the earlier drain error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const failure = new Error("drain"), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  const terminate = createHandlerTermination({ async drain() { throw failure }, close() { entered.resolve(); return held.promise }, timeoutMs: 25 })
  const result = terminate()
  await entered.promise
  t.mock.timers.tick(25)
  const errors = causes(await result)
  assert.equal(errors[0], failure)
  assert.match(String(errors[1]), /deadline.*unverified/)
  held.resolve()
})

test("termination diagnostics expose nested aggregate causes within a byte limit", () => {
  const failure = new AggregateError([new AggregateError([new Error("original drain failure"), null], "drain"), new Error("deadline exceeded")], "termination")
  const message = formatTerminationFailure(failure).toString()
  for (const cause of ["original drain failure", "deadline exceeded", "null"]) assert.ok(message.includes(cause), cause)
  assert.ok(formatTerminationFailure(new Error("é".repeat(5000))).length <= 2048)
})