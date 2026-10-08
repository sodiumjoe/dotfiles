import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { bureauFixture } from "./bureau-support.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { journalEntries } from "../src/orchestration/reports.js"
import { TERMINAL_AGE } from "../src/orchestration/types.js"

test("terminal compaction preserves exact command receipts and restart recovery", async t => {
  const f = await bureauFixture(t), createCommandId = (await f.snapshot()).createCommandId
  const original = (await f.core.command(createCommandId)).result
  await f.core.closeRun(randomUUID(), f.input.runId)
  f.clock.advance(TERMINAL_AGE + 1)
  await (f.core as unknown as { compact(runId: string, now: number): Promise<void> }).compact(f.input.runId, f.clock.now())
  const journal = createJournalPool(f.root, f.filesystem, f.clock.now).forRun(f.input.runId)
  await assert.rejects(journal.read(0, 256), /CURSOR_EXPIRED/)
  assert.ok((await journalEntries(journal)).length > 0)
  await f.restartBureau()
  assert.deepEqual((await f.core.command(createCommandId)).result, original)
  assert.deepEqual(await f.core.startRun(createCommandId, f.input.rootInput, f.invocation), original)
  assert.equal(f.host.launchCalls, 1)
})

test("active and uncertain runs cannot be compacted or forgotten", async t => {
  const f = await bureauFixture(t)
  await assert.rejects((f.core as unknown as { compact(runId: string, now: number): Promise<void> }).compact(f.input.runId, Date.now()), /UNRESOLVED/)
  await assert.rejects(f.core.forget(randomUUID(), f.input.runId), /UNRESOLVED/)
})

test("forget erases run payloads, seals identifiers and never restarts providers", async t => {
  const f = await bureauFixture(t), commandId = randomUUID(), child = await f.delegate(commandId)
  await f.core.cancel(randomUUID(), f.input.runId); await f.core.closeRun(randomUUID(), f.input.runId)
  const createCommandId = (await f.snapshot()).createCommandId
  await f.core.forget(randomUUID(), f.input.runId)
  assert.equal((await f.store.listAssignments()).length, 0)
  assert.equal((await f.store.listAttempts()).length, 0)
  assert.equal((await f.store.listCommands()).length, 0)
  assert.deepEqual(await createJournalPool(f.root).list(), [])
  const sealed = await readFile(join(f.root, "bureau", "runs", f.input.runId + ".json"), "utf8")
  assert.equal(sealed.includes(f.input.rootInput.objective), false)
  assert.equal((await readdir(join(f.root, "bureau", "forgotten"))).length > 0, true)
  await f.restartBureau()
  await assert.rejects(f.core.startRun(createCommandId, f.input.rootInput, f.invocation), /FORGOTTEN/)
  await assert.rejects(f.delegate(commandId), /FORGOTTEN/)
  await assert.rejects(f.core.retry(randomUUID(), child.assignmentId, "replace", f.invocation), /FORGOTTEN/)
  assert.equal(f.host.launchCalls, 2)
  assert.equal(f.host.stopCalls, 0)
})

test("forget cleanup resumes after its durable seal and a failed deletion", async t => {
  const f = await bureauFixture(t), child = await f.delegate()
  await f.core.cancel(randomUUID(), f.input.runId); await f.core.closeRun(randomUUID(), f.input.runId)
  f.failAt("remove", "/assignments/")
  await assert.rejects(f.core.forget(randomUUID(), f.input.runId), /ENOSPC/)
  await f.restartBureau()
  assert.equal((await f.store.listAssignments()).length, 0)
  await assert.rejects(f.core.assignment(child.assignmentId), /FORGOTTEN/)
  assert.equal(f.host.stopCalls, 0)
})

test("forget recovery confirms the sealed run before deleting its evidence", async t => {
  const f = await bureauFixture(t)
  await f.delegate(); await f.core.cancel(randomUUID(), f.input.runId); await f.core.closeRun(randomUUID(), f.input.runId)
  f.failAt("directory-sync", "/bureau/runs")
  await assert.rejects(f.core.forget(randomUUID(), f.input.runId), /ENOSPC/)
  assert.equal((await f.store.listAssignments()).length, 1)
  f.failAt("directory-sync", "/bureau/runs")
  await assert.rejects(f.restartBureau(), /ENOSPC/)
  assert.equal((await f.store.listAssignments()).length, 1)
  await f.restartBureau()
  assert.equal((await f.store.listAssignments()).length, 0)
})