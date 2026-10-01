import assert from "node:assert/strict"
import test from "node:test"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { syntheticAgentProcess } from "./agent-support.js"

test("agent process publishes a managed launch and spawns in the exact caller directory and environment", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  const session = await f.owner.initialize(new AbortController().signal)
  assert.equal(session.sessionId, "fixture-session")
  const options = f.options()!
  assert.equal(options.cwd, f.spec.cwd)
  assert.deepEqual(options.env, { HOME: "/fixture-home", FIXTURE: "yes", NODE_OPTIONS: "preserved", NODE_PATH: "preserved", AGENCY_TEST: "preserved", GIT_DIR: "preserved" })
  const launch = await f.record()
  assert.equal(launch.version, 2)
  if (launch.version !== 2 || launch.owner.kind !== "agent") throw new Error("wrong launch owner")
  assert.equal(launch.owner.agentId, f.spec.agentId)
  assert.equal(launch.owner.providerGeneration, f.spec.providerGeneration)
  assert.equal(launch.phase, "readiness")
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  await assert.rejects(lstat(join(f.root, "agents/provider-state")), { code: "ENOENT" })
})

test("process identity mismatch never becomes a ready launch", async t => {
  const f = await syntheticAgentProcess(t, "identity-mismatch")
  await assert.rejects(f.owner.initialize(new AbortController().signal), { code: "STARTUP_FAILED" })
  assert.equal(f.owner.record().phase !== "active", true)
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
})

test("spawn failure retains exact launch attribution and verifies cleanup", async t => {
  const f = await syntheticAgentProcess(t, "spawn-throws")
  await assert.rejects(f.owner.initialize(new AbortController().signal))
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(f.owner.record().launchAttemptId, f.spec.launchAttemptId)
  assert.equal(f.spawnCount(), 1)
})

test("failed attempted transition prevents spawn and retains a clean launch", async t => {
  const f = await syntheticAgentProcess(t, "attempt-write")
  await assert.rejects(f.owner.initialize(new AbortController().signal))
  assert.equal(f.spawnCount(), 0)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("provider exit fails the owned process and cleanup targets its retained group", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  const result = await f.owner.cleanup()
  assert.equal(result.phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal(f.owner.record().provider?.group.leader.pid, 12345)
})