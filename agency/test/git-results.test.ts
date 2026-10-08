import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGitResults } from "../src/bureau/git-results.js"
import { createPublicationController, grantPublication } from "../src/orchestration/git-publication.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import { git, gitFixture } from "./git-support.js"

import { resultFixture } from "./git-support.js"

for (const format of ["sha1", "sha256"]) test("immutable verification fetches published result and runs configured argv at exact revision in " + format, async t => {
  const f = await resultFixture(t, format), proposal = await f.verify()
  assert.deepEqual(proposal.issues, []); assert.equal(proposal.resultOid, f.resultOid); assert.equal(proposal.tree, await git(["rev-parse", f.resultOid + "^{tree}"], f.worker))
  assert.equal(proposal.validations[0]!.exitCode, 0); assert.equal(proposal.validations[0]!.result, "first")
  assert.notEqual(proposal.validations[0]!.cwd, f.destination); assert.deepEqual(proposal.claimedValidations, f.report.input.report.validation)
  await assert.rejects(readFile(join(f.destination, "should-not-run")))
  assert.deepEqual(await f.api.proposal(proposal.proposalId), proposal)
})
test("unpublished and forged publication evidence cannot become integration proposals", async t => {
  const f = await resultFixture(t); f.report.input.report.git.publication.state = "uncertain"; f.report.receipt.digest = canonicalDigest(f.report.input.report)
  await assert.rejects(f.verify(), /INVALID_PUBLICATION|GIT_PUBLICATION_REQUIRED/)
})
test("different configured remote and non-ancestor result reject verification", async t => {
  const f = await resultFixture(t)
  await f.api.configure({ destinationCwd: f.destination, remote: f.repository, validations: [] })
  await assert.rejects(f.verify(), /GIT_REMOTE_MISMATCH/)
})
test("unfetchable immutable result retains an actionable rejected proposal", async t => {
  const f = await resultFixture(t), oid = "c".repeat(f.resultOid.length), p = f.report.input.report.git.publication
  f.report.input.report.git.resultOid = oid; p.resultOid = oid; p.remoteOid = oid; p.digest = canonicalDigest({ commandId: p.commandId, capability: p.capability, resultOid: oid, expectedRemoteOid: p.expectedRemoteOid }); f.report.receipt.digest = canonicalDigest(f.report.input.report)
  const proposal = await f.verify(); assert.equal(proposal.issues.includes("GIT_FETCH_FAILED"), true)
})

test("an unrelated destination base rejects verification despite a shared remote URL", async t => {
  const f = await resultFixture(t)
  await git(["checkout", "--orphan", "unrelated"], f.destination)
  await git(["rm", "-rf", "."], f.destination); await writeFile(join(f.destination, "other.txt"), "other"); await git(["add", "."], f.destination); await git(["commit", "-m", "unrelated base"], f.destination)
  await f.api.configure({ destinationCwd: f.destination, remote: f.remote, validations: [] })
  assert.deepEqual((await f.verify()).issues, ["GIT_ANCESTRY_OR_OBJECT_INVALID"])
})
test("a configured validation changing revision invalidates its result evidence", async t => {
  const f = await resultFixture(t)
  await f.api.configure({ destinationCwd: f.destination, remote: f.remote, validations: [["git", "checkout", "--detach", f.baseOid]] })
  assert.ok((await f.verify()).issues.includes("GIT_VALIDATION_REVISION_CHANGED"))
})