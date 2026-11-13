import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { readDistDigest } from "../src/handler/build-digest.js"
import { PROTOCOL, parseReply } from "../src/control/protocol.js"

const digest = "a".repeat(64)
function status(extra: Record<string, unknown>) {
  const generation = randomUUID()
  return { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, ok: true,
    result: { hostId: "b".repeat(64), handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"], ...extra } }
}

test("the build digest comes from a valid manifest and is null otherwise", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-digest-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "valid.json"), JSON.stringify({ version: 1, distDigest: digest }))
  await writeFile(join(root, "short.json"), JSON.stringify({ version: 1, distDigest: "abc" }))
  await writeFile(join(root, "broken.json"), "{")
  assert.equal(readDistDigest(join(root, "valid.json")), digest)
  assert.equal(readDistDigest(join(root, "short.json")), null)
  assert.equal(readDistDigest(join(root, "broken.json")), null)
  assert.equal(readDistDigest(join(root, "missing.json")), null)
})

test("status replies parse with, without, and with a null build digest", () => {
  const parse = (extra: Record<string, unknown>) => {
    const reply = parseReply(status(extra))
    assert.ok(reply.ok && "capabilities" in reply.result)
    return reply.result
  }
  assert.equal(Object.hasOwn(parse({}), "distDigest"), false)
  assert.equal(parse({ distDigest: null }).distDigest, null)
  assert.equal(parse({ distDigest: digest }).distDigest, digest)
  assert.throws(() => parseReply(status({ distDigest: 7 })), /INVALID_PROTOCOL/)
})