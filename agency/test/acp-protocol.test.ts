import assert from "node:assert/strict"
import test from "node:test"
import { AgentError } from "../src/agent/types.js"
import { acpError, createAcpDecoder, parseAcpFrame, parseAgencyMeta, parseLogicalSessionId } from "../src/acp/protocol.js"

test("ACP framing retains fragmented UTF-8 content and independent string/numeric IDs", () => {
  const frames: unknown[] = [], errors: unknown[] = []
  const decoder = createAcpDecoder(value => frames.push(value), error => errors.push(error))
  const bytes = Buffer.from('{"jsonrpc":"2.0","id":"one","method":"test","params":{"text":"λ"}}\n{"jsonrpc":"2.0","id":1,"result":{}}\n')
  for (const byte of bytes) decoder.feed(Buffer.from([byte]))
  decoder.end()
  assert.equal(errors.length, 0)
  assert.equal(frames.length, 2)
  assert.equal(parseAcpFrame(frames[0]).id, "one")
  assert.equal(parseAcpFrame(frames[1]).id, 1)
  assert.equal((parseAcpFrame(frames[0]).params as { text: string }).text, "λ")
})

test("ACP rejects malformed IDs, envelopes, UTF-8, oversized frames and incomplete EOF", () => {
  for (const frame of [null, [], { jsonrpc: "1.0", method: "test" }, { jsonrpc: "2.0", id: null, method: "test" }, { jsonrpc: "2.0", id: 0.5, method: "test" }, { jsonrpc: "2.0", id: 1, result: {}, error: {} }]) assert.throws(() => parseAcpFrame(frame))
  for (const bytes of [Buffer.from([0xff, 10]), Buffer.alloc(1048577, 32), Buffer.from('{"jsonrpc":"2.0"')]) {
    const errors: unknown[] = [], decoder = createAcpDecoder(() => assert.fail("invalid frame dispatched"), error => errors.push(error))
    decoder.feed(bytes); decoder.end()
    assert.equal(errors.length, 1)
  }
})

test("logical IDs and namespaced metadata reject ambiguous selection without rejecting foreign metadata", () => {
  assert.equal(parseLogicalSessionId("agency:00000000-0000-4000-8000-000000000001"), "00000000-0000-4000-8000-000000000001")
  assert.throws(() => parseLogicalSessionId("native-session"))
  assert.deepEqual(parseAgencyMeta({ _meta: { foreign: true } }, ["submissionId"]), {})
  assert.throws(() => parseAgencyMeta({ _meta: { agency: { version: 2 } } }, []))
  assert.throws(() => parseAgencyMeta({ _meta: { agency: { version: 1, extra: true } } }, []))
})

test("ACP errors retain namespaced service failure codes", () => {
  assert.equal(acpError(1, new AgentError("STALE_ATTACHMENT")).error.code, -32000)
  assert.deepEqual(acpError("a", new AgentError("BUSY")).error.data, { agency: { code: "BUSY" } })
})