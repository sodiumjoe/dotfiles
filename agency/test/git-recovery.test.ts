import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGitIntegration } from "../src/bureau/git-integration.js"
import { createStorage } from "../src/orchestration/storage.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import { resultFixture, git } from "./git-support.js"

async function fixture(t: test.TestContext) {
  const f = await resultFixture(t), create = () => createGitIntegration({ root: f.root, results: f.api, git }), storage = createStorage(f.root, "bureau")
  return { ...f, create, integration: create(), active: (cwd: string) => "git-active/" + canonicalDigest(cwd) + ".json", storage, peek: (key: string) => createStorage(f.root, "bureau").read(key) }
}
for (const state of ["integrated", "rejected"]) for (const retry of [true, false]) test("terminal " + state + " fence is recovered on " + (retry ? "exact retry" : "new command"), async t => {
  const f = await fixture(t), proposal = await f.verify(), commandId = randomUUID()
  let checks = 0
  const api = state === "integrated" ? f.integration : createGitIntegration({ root: f.root, results: f.api, git: async (args, cwd) => {
    if (args[0] === "status" && ++checks === 2) throw new Error("recheck failed")
    return git(args, cwd)
  } })
  const receipt = await api.integrate(commandId, proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, state)
  await f.storage.publish(f.active(f.destination), { commandId, proposalId: proposal.proposalId }, null, true)
  const restored = f.create()
  await restored.integrate(retry ? commandId : randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(await f.peek(f.active(f.destination)), null)
})
test("an exact terminal retry never removes another command's active fence", async t => {
  const f = await fixture(t), proposal = await f.verify(), commandId = randomUUID()
  assert.equal((await f.integration.integrate(commandId, proposal.proposalId, proposal.destination.head, "merge")).state, "integrated")
  const other = { commandId: randomUUID(), proposalId: proposal.proposalId }
  await f.storage.publish(f.active(f.destination), other, null, true)
  await f.create().integrate(commandId, proposal.proposalId, proposal.destination.head, "merge")
  assert.deepEqual(await f.peek(f.active(f.destination)), other)
})
for (const strategy of ["merge", "cherry-pick"] as const) test("human abandonment releases an inspected aborted " + strategy + " without applying Git", async t => {
  const f = await fixture(t); await f.commit("first", "conflict", f.destination)
  const proposal = await f.verify(), commandId = randomUUID()
  assert.equal((await f.integration.integrate(commandId, proposal.proposalId, proposal.destination.head, strategy)).state, "conflict")
  await git([strategy, "--abort"], f.destination)
  const head = await git(["rev-parse", "HEAD"], f.destination), restored = f.create(), receipt = await restored.abandon(commandId, proposal.proposalId, head)
  assert.equal(receipt.state, "abandoned"); assert.equal(receipt.resultingHead, head)
  assert.equal(await git(["rev-parse", "HEAD"], f.destination), head)
  assert.equal(await f.peek(f.active(f.destination)), null)
  assert.deepEqual(await restored.abandon(commandId, proposal.proposalId, head), receipt)
  assert.equal((await restored.integrate(commandId, proposal.proposalId, proposal.destination.head, strategy)).state, "abandoned")
  assert.equal((await restored.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, strategy)).state, "conflict")
})
for (const change of ["operation", "head", "branch", "dirty", "owner", "proposal"]) test("human abandonment refuses changed " + change, async t => {
  const f = await fixture(t); await f.commit("first", "conflict", f.destination)
  const proposal = await f.verify(), commandId = randomUUID()
  assert.equal((await f.integration.integrate(commandId, proposal.proposalId, proposal.destination.head, "merge")).state, "conflict")
  if (change !== "operation") await git(["merge", "--abort"], f.destination)
  if (change === "branch") await git(["checkout", "-b", "foreign"], f.destination)
  if (change === "dirty") await writeFile(join(f.destination, "dirty.txt"), "dirty")
  if (change === "owner") await f.storage.publish(f.active(f.destination), { commandId: randomUUID(), proposalId: proposal.proposalId }, { commandId, proposalId: proposal.proposalId })
  const restored = f.create()
  await assert.rejects(restored.abandon(commandId, change === "proposal" ? "f".repeat(64) : proposal.proposalId, change === "head" ? "f".repeat(40) : proposal.destination.head))
  assert.ok(await f.peek(f.active(f.destination)))
})