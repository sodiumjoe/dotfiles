import assert from "node:assert/strict"
import test from "node:test"
import { FAILED_START_TTL_MS, expiredFailure, reclaimable, type RetentionNode } from "../src/retention/policy.js"

test("failed start expiry is conservative about missing and future times", () => {
  const ttl = FAILED_START_TTL_MS
  assert.equal(expiredFailure(ttl, [0]), true)
  assert.equal(expiredFailure(ttl - 1, [0]), false)
  for (const times of [[], [Number.NaN], [ttl + 1], [0, 1], [-1]]) assert.equal(expiredFailure(ttl, times), false)
  assert.equal(expiredFailure(Number.NaN, [0]), false)
  assert.equal(expiredFailure(-1, [0]), false)
  assert.equal(expiredFailure(ttl, Array.from({ length: 100000 }, () => 0)), true)
})

test("session roots preserve creation and latest launch but not an intermediate restore", () => {
  const nodes: RetentionNode[] = [
    { path: "agent", references: ["create", "latest"], retained: true, removable: false },
    { path: "create", references: ["original-launch"], retained: false, removable: true },
    { path: "latest", references: ["latest-launch"], retained: false, removable: true },
    { path: "middle", references: ["middle-launch"], retained: false, removable: true },
    { path: "original-launch", references: [], retained: false, removable: true },
    { path: "latest-launch", references: [], retained: false, removable: true },
    { path: "middle-launch", references: [], retained: false, removable: true },
  ]
  assert.deepEqual(reclaimable(nodes, []), ["middle", "middle-launch"])
  assert.deepEqual(reclaimable(nodes, ["middle"]), [])
  assert.deepEqual(reclaimable(nodes.map(n => n.path === "middle-launch" ? { ...n, retained: true } : n), []), ["middle"])
})

test("unknown references, duplicate paths and unsafe nodes do not authorize deletion", () => {
  assert.throws(() => reclaimable([{ path: "agent", references: ["missing"], retained: true, removable: false }], []))
  assert.throws(() => reclaimable([], ["missing"]))
  const node = { path: "duplicate", references: [], retained: false, removable: true }
  assert.throws(() => reclaimable([node, node], []))
  assert.deepEqual(reclaimable([
    { path: "launch", references: ["receipt"], retained: false, removable: false },
    { path: "receipt", references: [], retained: false, removable: true },
  ], []), [])
})

test("shared snapshots, cycles and explicit receipt pins retain reference closure", () => {
  const nodes: RetentionNode[] = [
    { path: "live", references: ["snapshot", "expired-agent"], retained: true, removable: true },
    { path: "old", references: ["snapshot"], retained: false, removable: true },
    { path: "snapshot", references: [], retained: false, removable: true },
    { path: "expired-agent", references: [], retained: false, removable: true },
    { path: "a", references: ["b"], retained: false, removable: true },
    { path: "b", references: ["a"], retained: false, removable: true },
  ]
  assert.deepEqual(reclaimable(nodes, []), ["a", "b", "old"])
  assert.deepEqual(reclaimable(nodes, ["a"]), ["old"])
})