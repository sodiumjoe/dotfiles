import assert from "node:assert/strict"
import test from "node:test"
import { cloneWireJson, encodeWireJson, parseWireJson, wireJsonBytes } from "../src/acp/wire-json.js"

const source = '{"sessionUpdate":"tool_call_update","toolCallId":"tool","rawOutput":{"text":"' + "x".repeat(2 * 1024 * 1024) + '"},"content":[{"type":"diff","newText":"\\u03bb"}]}'

test("wire views forward opaque values without accessing their getters", t => {
  const update = parseWireJson(source)
  const parse = t.mock.method(JSON, "parse")
  assert.equal(update.sessionUpdate, "tool_call_update")
  const copied = cloneWireJson({ update })
  assert.strictEqual(copied.update, update)
  assert.equal(encodeWireJson(copied), '{"update":' + source + '}')
  assert.equal(wireJsonBytes(copied), Buffer.byteLength('{"update":' + source + '}'))
  assert.ok(parse.mock.calls.every(call => !String(call.arguments[0]).includes("rawOutput")))
})

test("wire views preserve duplicate escaped and prototype keys with fresh mutable projections", () => {
  const source = '{"a":1,"\\u0061":2,"__proto__":{"x":1},"constructor":3,"items":[{"text":"first"}]}'
  const value = parseWireJson(source)
  assert.deepEqual(value, JSON.parse(source))
  assert.equal(value.a, 2)
  assert.equal(Object.getPrototypeOf(value), Object.prototype)
  assert.equal(encodeWireJson(value), source)
  const items = value.items as { text: string }[]
  items[0]!.text = "changed"
  assert.equal((value.items as { text: string }[])[0]!.text, "first")
  assert.throws(() => { value.a = 3 }, TypeError)
})

for (const source of ['{"x":[1,]}', '{"x":{"a":}}', '{"x":"\\q"}', '{"x":01}', '{"x":true false}', '{"x":1} trailing', '{"x":1,}', '{"x":"\u0001"}']) test("wire views reject malformed JSON: " + JSON.stringify(source), () => {
  assert.throws(() => parseWireJson(source))
})

test("wire views accept nested values and preserve JSON number semantics", () => {
  const source = '{"nested":' + '['.repeat(1000) + '{"escaped":"a\\\\b\\\"c","number":-1.2e+3,"values":[null,true,false]}' + ']'.repeat(1000) + '}'
  const value = parseWireJson(source)
  assert.equal(encodeWireJson(value), source)
  assert.deepEqual(value, JSON.parse(source))
})

test("scanner releases regexp subjects after accepted and malformed large frames", () => {
  const update = parseWireJson(source)
  const acceptedInput = RegExp.input
  let rejected = false
  try { parseWireJson(source.slice(0, -1)) } catch { rejected = true }
  const rejectedInput = RegExp.input
  assert.equal(acceptedInput, "")
  assert.equal(rejectedInput, "")
  assert.equal(rejected, true)
  assert.equal(encodeWireJson(update), source)
})