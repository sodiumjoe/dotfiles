import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGitIntegration } from "../src/bureau/git-integration.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import { resultFixture, git } from "./git-support.js"

async function integrationFixture(t: test.TestContext) {
  const f = await resultFixture(t)
  const create = (runner = git) => createGitIntegration({ root: f.root, results: f.api, git: runner })
  async function refresh() {
    const oid = await git(["rev-parse", "HEAD"], f.worker), old = f.report.input.report.git.resultOid
    f.report.input.report.git.resultOid = oid
    f.report.input.report.git.publication = await f.publication.publish(randomUUID(), f.execution, oid, old)
    f.report.receipt.digest = canonicalDigest(f.report.input.report)
    return f.verify()
  }
  return { ...f, results: f.api, api: create(), create, refresh }
}
test("merge integrates the reported immutable OID after the worker branch moves", async t => {
  const f = await integrationFixture(t), proposal = await f.verify(), newer = await f.commit("later")
  await f.publication.publish(randomUUID(), f.execution, newer, f.resultOid)
  const receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, "integrated")
  await git(["merge-base", "--is-ancestor", f.resultOid, "HEAD"], f.destination)
  await assert.rejects(git(["merge-base", "--is-ancestor", newer, "HEAD"], f.destination))
})
test("cherry-pick replays all three linear result commits oldest first", async t => {
  const f = await integrationFixture(t); await f.commit("second"); await f.commit("third")
  await f.commit("destination", "local", f.destination)
  const proposal = await f.refresh(), receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "cherry-pick")
  assert.equal(receipt.state, "integrated"); assert.equal(receipt.results.length, 3)
  assert.deepEqual(receipt.results.map(value => value.sourceOid), proposal.sourceOids)
  assert.equal((await git(["log", "--format=%s", "-3"], f.destination)).split("\n").reverse().join(","), "first,second,third")
})
for (const change of ["worktree", "index", "head", "branch", "operation"]) test("integration rejects changed destination " + change + " before mutation", async t => {
  const f = await integrationFixture(t), proposal = await f.verify()
  if (change === "worktree" || change === "index") { await writeFile(join(f.destination, "dirty.txt"), "dirty"); if (change === "index") await git(["add", "."], f.destination) }
  if (change === "head") await f.commit("local", "local", f.destination)
  if (change === "branch") await git(["checkout", "-b", "alternate"], f.destination)
  if (change === "operation") await writeFile(join(proposal.destination.gitDir, "MERGE_HEAD"), f.resultOid + "\n")
  const before = await git(["rev-parse", "HEAD"], f.destination)
  const receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, "rejected"); assert.equal(await git(["rev-parse", "HEAD"], f.destination), before)
})
test("merge commits inside the result reject cherry-pick with a merge recommendation", async t => {
  const f = await integrationFixture(t)
  await git(["checkout", "-b", "side"], f.worker); await f.commit("side")
  await git(["checkout", f.exchange.branch], f.worker); await f.commit("second")
  await git(["merge", "--no-ff", "--no-edit", "side"], f.worker)
  const proposal = await f.refresh(), receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "cherry-pick")
  assert.equal(proposal.linear, false); assert.equal(receipt.state, "rejected"); assert.match(receipt.issue!, /MERGE_REQUIRED/)
})
test("merge conflict remains in the destination without reset or resolution", async t => {
  const f = await integrationFixture(t); await f.commit("first", "conflicting", f.destination)
  const proposal = await f.verify(), receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, "conflict"); assert.match(await git(["status", "--porcelain"], f.destination), /AA first.txt/)
})
test("cherry-pick conflict preserves partial ordered progress", async t => {
  const f = await integrationFixture(t); await f.commit("second"); await f.commit("third"); await f.commit("second", "conflicting", f.destination)
  const proposal = await f.refresh(), receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "cherry-pick")
  assert.equal(receipt.state, "conflict"); assert.equal(receipt.results.length, 1)
  assert.equal(receipt.results[0]!.sourceOid, proposal.sourceOids[0]); assert.equal(await git(["rev-parse", "CHERRY_PICK_HEAD"], f.destination), proposal.sourceOids[1])
})
test("lost merge reply reconciles exact parents without repeating Git mutation", async t => {
  const f = await integrationFixture(t), proposal = await f.verify(); let merges = 0
  const api = f.create(async (args, cwd) => { const output = await git(args, cwd); if (args[0] === "merge") { merges++; throw new Error("lost reply") }; return output })
  const commandId = randomUUID(); assert.equal((await api.integrate(commandId, proposal.proposalId, proposal.destination.head, "merge")).state, "uncertain")
  const recovered = await api.integrate(commandId, proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(recovered.state, "integrated"); assert.equal(merges, 1)
})
test("concurrent integration commands serialize at one destination and fence the second HEAD", async t => {
  const f = await integrationFixture(t), proposal = await f.verify()
  const results = await Promise.all([f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge"), f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")])
  assert.deepEqual(results.map(receipt => receipt.state).sort(), ["integrated", "rejected"])
})

for (const strategy of ["merge", "cherry-pick"] as const) test("interrupted " + strategy + " application remains fenced without repeating mutation", async t => {
  const f = await integrationFixture(t), proposal = await f.verify(); let mutations = 0
  const api = f.create(async (args, cwd) => { if (args[0] === strategy) { mutations++; throw new Error("interrupted before reply") }; return git(args, cwd) })
  const commandId = randomUUID(), first = await api.integrate(commandId, proposal.proposalId, proposal.destination.head, strategy)
  assert.equal(first.state, "uncertain")
  const restored = f.create(), second = await restored.integrate(commandId, proposal.proposalId, proposal.destination.head, strategy)
  assert.equal(second.state, "uncertain"); assert.equal(mutations, 1)
  const other = await restored.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, strategy)
  assert.equal(other.state, "rejected"); assert.match(other.issue!, /GIT_INTEGRATION_PENDING/)
})
test("lost final cherry-pick reply reconciles full ordered lineage and patches", async t => {
  const f = await integrationFixture(t); await f.commit("second"); await f.commit("third")
  const proposal = await f.refresh(); let picks = 0
  const api = f.create(async (args, cwd) => { const value = await git(args, cwd); if (args[0] === "cherry-pick" && ++picks === 3) throw new Error("lost final reply"); return value })
  const commandId = randomUUID(), first = await api.integrate(commandId, proposal.proposalId, proposal.destination.head, "cherry-pick")
  assert.equal(first.state, "uncertain"); assert.equal(first.results.length, 2)
  const restored = f.create(), receipt = await restored.integrate(commandId, proposal.proposalId, proposal.destination.head, "cherry-pick")
  assert.equal(receipt.state, "integrated"); assert.equal(receipt.results.length, 3); assert.equal(picks, 3)
})
test("reconfigured validation authority invalidates an earlier proposal", async t => {
  const f = await integrationFixture(t), proposal = await f.verify()
  await f.results.configure({ destinationCwd: f.destination, remote: f.remote, validations: [] })
  const receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, "rejected"); assert.match(receipt.issue!, /GIT_CONFIGURATION_CHANGED/)
})
test("destination filesystem replacement at the same path rejects integration", async t => {
  const f = await integrationFixture(t), proposal = await f.verify(), { rename } = await import("node:fs/promises")
  await rename(f.destination, f.destination + "-old"); await git(["clone", f.remote, f.destination], f.root)
  const receipt = await f.api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, "rejected"); assert.match(receipt.issue!, /GIT_DESTINATION_CHANGED/)
})

test("a surviving Git index lock after a lost reply remains uncertain rather than a conflict", async t => {
  const f = await integrationFixture(t), proposal = await f.verify()
  const api = f.create(async (args, cwd) => { const output = await git(args, cwd); if (args[0] === "merge") { await writeFile(join(proposal.destination.gitDir, "index.lock"), "running"); throw new Error("lost reply") }; return output })
  const receipt = await api.integrate(randomUUID(), proposal.proposalId, proposal.destination.head, "merge")
  assert.equal(receipt.state, "uncertain")
})