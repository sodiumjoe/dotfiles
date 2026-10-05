import assert from "node:assert/strict"
import test from "node:test"
import { normalizeClaude, normalizeCodex } from "../src/catalog/normalize.js"
import { isFresh, parseProbeMeta, parseRetainedProbeMeta } from "../src/catalog/types.js"

test("native model evidence preserves reasoning, aliases and unknown session modes", () => {
  assert.deepEqual(normalizeClaude([{ value: "alias", resolvedModel: "canonical", displayName: "Model", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true }]), [
    { providerId: "claude-agent-acp", modelId: "alias", resolvedModelId: "canonical", displayName: "Model", reasoning: { state: "values", values: ["high", "low"] }, modes: { state: "unknown" }, availability: "advertised" },
  ])
  assert.deepEqual(normalizeClaude([{ value: "b", displayName: "B", supportsEffort: false }, { value: "a", displayName: "A" }]).map(value => value.reasoning), [{ state: "unknown" }, { state: "none" }])
  assert.deepEqual(normalizeCodex([{ id: "model", displayName: "Model", supportedReasoningEfforts: [{ reasoningEffort: "none", description: "No reasoning" }, { reasoningEffort: "high", description: "More reasoning" }] }])[0]!.reasoning, { state: "values", values: ["high", "none"] })
  assert.deepEqual(normalizeCodex([{ id: "model", displayName: "Model" }])[0]!.reasoning, { state: "unknown" })
})

test("invalid or contradictory native evidence rejects the entire provider result", () => {
  const good = { value: "m", displayName: "Model" }
  for (const input of [null, {}, [good, good], [{ ...good, value: "" }], [{ ...good, value: "a\n" }], [{ ...good, value: "\ud800" }], [{ ...good, value: "m".repeat(257) }], [{ ...good, displayName: "N".repeat(513) }], [{ ...good, supportsEffort: false, supportedEffortLevels: ["high"] }], [{ ...good, supportedEffortLevels: ["high", "high"] }], [{ ...good, supportedEffortLevels: Array.from({ length: 33 }, (_, i) => String(i)) }], Array.from({ length: 513 }, (_, i) => ({ value: String(i), displayName: "M" }))]) {
    assert.throws(() => normalizeClaude(input), { code: "INVALID_CATALOG" })
  }
  for (const input of [[{ id: "a", displayName: "A", supportedReasoningEfforts: [{}] }], [{ id: "a", displayName: "A", supportedReasoningEfforts: "high" }]]) assert.throws(() => normalizeCodex(input), { code: "INVALID_CATALOG" })
})

test("freshness expires at its bound and refuses absent or future verification", () => {
  assert.equal(isFresh(null, 100), false)
  assert.equal(isFresh(100, 99), false)
  assert.equal(isFresh(100, 100), true)
  assert.equal(isFresh(100, 600099), true)
  assert.equal(isFresh(100, 600100), false)
})

test("probe metadata has only version-two process ownership fields", () => {
  const attemptId = crypto.randomUUID()
  const meta = { version: 2, hostId: "a".repeat(64), handlerGeneration: crypto.randomUUID(), commandId: crypto.randomUUID(), providerId: "codex-acp", attemptId, fingerprint: "b".repeat(64), workPath: `/tmp/catalog/work/${attemptId}` }
  assert.deepEqual(parseProbeMeta(meta), meta)
  for (const invalid of [{ ...meta, version: 1 }, { ...meta, leaseId: crypto.randomUUID() }, { ...meta, agentId: crypto.randomUUID() }]) assert.throws(() => parseProbeMeta(invalid), { code: "INVALID_CATALOG" })
})

test("probe origin is strict and legacy metadata remains readable", () => {
  const attemptId = crypto.randomUUID(), base = { version: 2, hostId: "a".repeat(64), handlerGeneration: crypto.randomUUID(), commandId: crypto.randomUUID(), providerId: "codex-acp", attemptId, fingerprint: "b".repeat(64), workPath: `/tmp/catalog/work/${attemptId}` }
  for (const receiptKind of ["explicit", "automatic"]) { const value = { ...base, version: 3, receiptKind }; assert.deepEqual(parseProbeMeta(value), value); assert.deepEqual(parseRetainedProbeMeta(value), value) }
  const legacy = { ...base, version: 1, agentId: crypto.randomUUID(), leaseId: crypto.randomUUID() }
  assert.deepEqual(parseRetainedProbeMeta(legacy), legacy)
  for (const value of [{ ...base, receiptKind: "automatic" }, { ...base, version: 3 }, { ...base, version: 3, receiptKind: "other" }, { ...base, version: 3, receiptKind: "explicit", extra: true }]) assert.throws(() => parseRetainedProbeMeta(value))
})