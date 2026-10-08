import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createPublicationController, grantPublication } from "../src/orchestration/git-publication.js"
import { git, gitFixture } from "./git-support.js"

for (const format of ["sha1", "sha256"]) test("publication binds exact attempt and immutable OID in " + format, async t => {
  const f = await gitFixture(t, format), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git })
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  const oid = await f.commit("result"), commandId = randomUUID(), receipt = await api.publish(commandId, f.execution, oid, null)
  assert.equal(receipt.state, "published"); assert.equal(receipt.remoteOid, oid)
  assert.deepEqual(await api.publish(commandId, f.execution, oid, null), receipt)
  await assert.rejects(api.publish(commandId, f.execution, f.baseOid, null), /COMMAND_CONFLICT/)
  assert.equal((await git(["ls-remote", f.remote, "refs/heads/" + f.exchange.branch], f.repository)).split(/\s/)[0], oid)
})
test("unconfigured publication and substituted source execution have no push authority", async t => {
  const f = await gitFixture(t), oid = await f.commit("result")
  const api = createPublicationController({ root: f.root, capability: async () => null, validate: async () => true, git })
  await assert.rejects(api.publish(randomUUID(), f.execution, oid, null), /GIT_PUBLICATION_UNAUTHORIZED/)
  assert.equal(await git(["ls-remote", f.remote, "refs/heads/" + f.exchange.branch], f.repository), "")
})
test("unexpected remote ref replacement is rejected without overwriting it", async t => {
  const f = await gitFixture(t), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git }), oid = await f.commit("result")
  await git(["push", f.remote, f.baseOid + ":refs/heads/" + f.exchange.branch], f.repository)
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  assert.equal((await api.publish(randomUUID(), f.execution, oid, null)).state, "rejected")
  assert.equal((await git(["ls-remote", f.remote, "refs/heads/" + f.exchange.branch], f.repository)).split(/\s/)[0], f.baseOid)
})
test("lost push reply reconciles by ref and OID without another push", async t => {
  const f = await gitFixture(t), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git }), oid = await f.commit("result")
  let pushes = 0
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git: async (args, cwd) => { const result = await git(args, cwd); if (args[0] === "push") { pushes++; throw new Error("lost reply") }; return result } })
  const commandId = randomUUID(); assert.equal((await api.publish(commandId, f.execution, oid, null)).state, "uncertain")
  assert.equal((await api.publish(commandId, f.execution, oid, null)).state, "published"); assert.equal(pushes, 1)
})

test("publication rejects remote configuration changes after grant", async t => {
  const f = await gitFixture(t)
  await git(["remote", "add", "named", f.remote], f.repository)
  const preparation = { ...f.preparation, exchange: { ...f.preparation.exchange, remote: "named" } }
  const capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation, git })
  await git(["remote", "set-url", "named", f.repository], f.repository)
  const oid = await f.commit("result"), api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  assert.equal((await api.publish(randomUUID(), f.execution, oid, null)).state, "rejected")
  assert.equal(await git(["ls-remote", f.remote, "refs/heads/" + f.exchange.branch], f.repository), "")
})
test("publication lease rejects a concurrent ref creation without overwriting it", async t => {
  const f = await gitFixture(t), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git }), oid = await f.commit("result")
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git: async (args, cwd) => {
    if (args[0] === "push") await git(["push", f.remote, f.baseOid + ":refs/heads/" + f.exchange.branch], f.repository)
    return git(args, cwd)
  } })
  assert.notEqual((await api.publish(randomUUID(), f.execution, oid, null)).state, "published")
  assert.equal((await git(["ls-remote", f.remote, "refs/heads/" + f.exchange.branch], f.repository)).split(/\s/)[0], f.baseOid)
})

test("publication rejects a substituted execution even when a capability is returned", async t => {
  const f = await gitFixture(t), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git }), oid = await f.commit("result")
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  await assert.rejects(api.publish(randomUUID(), { ...f.execution, providerGeneration: randomUUID() }, oid, null), /GIT_PUBLICATION_UNAUTHORIZED/)
})
test("publication refuses a non-fast-forward replacement even with the expected remote OID", async t => {
  const f = await gitFixture(t), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git }), first = await f.commit("first")
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  assert.equal((await api.publish(randomUUID(), f.execution, first, null)).state, "published")
  await git(["reset", "--hard", f.baseOid], f.worker); const replacement = await f.commit("replacement")
  assert.equal((await api.publish(randomUUID(), f.execution, replacement, first)).state, "rejected")
  assert.equal((await git(["ls-remote", f.remote, "refs/heads/" + f.exchange.branch], f.repository)).split(/\s/)[0], first)
})
test("source repository filesystem replacement fences publication", async t => {
  const f = await gitFixture(t), capability = await grantPublication({ attempt: f.attempt, execution: f.execution, preparation: f.preparation, git }), oid = await f.commit("result")
  const { rename } = await import("node:fs/promises")
  await rename(f.repository, f.repository + "-old"); await git(["clone", f.remote, f.repository], f.root)
  const api = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  assert.equal((await api.publish(randomUUID(), f.execution, oid, null)).state, "rejected")
})