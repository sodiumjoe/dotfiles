import { isDeepStrictEqual } from "node:util"
import { hash, id, keys, object } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import { captureGitIdentity, gitOid, nativeGit, parseGitIdentity, resolveGitRemote, sameGitIdentity, type GitIdentity, type GitRunner } from "../bureau/git-identity.js"
import { parseGitPreparation, type GitPreparation } from "./git-worktree.js"
import { canonicalDigest, fail, parseAttemptRef, parseExecutionRef, type AttemptRef, type ExecutionRef } from "./types.js"
import { createStorage, storageQueue } from "./storage.js"

export type PublicationCapability = { attempt: AttemptRef; execution: ExecutionRef; preparation: GitPreparation; identity: GitIdentity; repositoryIdentity: GitIdentity; remoteUrl: string }
export type PublicationReceipt = { commandId: string; digest: string; capability: PublicationCapability; resultOid: string; expectedRemoteOid: string | null; remoteOid: string | null; state: "prepared" | "publishing" | "published" | "uncertain" | "rejected" }
export function parsePublicationCapability(raw: unknown): PublicationCapability {
  const v = object(raw); keys(v, ["attempt", "execution", "preparation", "identity", "repositoryIdentity", "remoteUrl"])
  const attempt = parseAttemptRef(v.attempt), execution = parseExecutionRef(v.execution), preparation = parseGitPreparation(v.preparation), identity = parseGitIdentity(v.identity), repositoryIdentity = parseGitIdentity(v.repositoryIdentity)
  if (repositoryIdentity.cwd !== preparation.exchange.repository || repositoryIdentity.commonDir !== identity.commonDir) fail("GIT_REPOSITORY_MISMATCH")
  if (preparation.state !== "ready" || identity.cwd !== preparation.cwd || identity.ref !== "refs/heads/" + preparation.branch || !preparation.branch.startsWith(`moon/agency/${attempt.runId}/${attempt.assignmentId}/`)) fail("GIT_PUBLICATION_UNAUTHORIZED")
  id(preparation.branch.split("/").at(-1))
  const remoteUrl = typeof v.remoteUrl === "string" ? v.remoteUrl : fail("GIT_REMOTE_INVALID")
  return { attempt, execution, preparation, identity, repositoryIdentity, remoteUrl }
}
export function parsePublicationReceipt(raw: unknown): PublicationReceipt {
  const v = object(raw); keys(v, ["commandId", "digest", "capability", "resultOid", "expectedRemoteOid", "remoteOid", "state"])
  const commandId = id(v.commandId), capability = parsePublicationCapability(v.capability), resultOid = gitOid(v.resultOid), expectedRemoteOid = v.expectedRemoteOid === null ? null : gitOid(v.expectedRemoteOid)
  const digest = hash(v.digest)
  if (digest !== canonicalDigest({ commandId, capability, resultOid, expectedRemoteOid }) || !["prepared", "publishing", "published", "uncertain", "rejected"].includes(String(v.state))) fail("INVALID_PUBLICATION")
  const remoteOid = v.remoteOid === null ? null : gitOid(v.remoteOid)
  if (v.state === "published" && remoteOid !== resultOid) fail("INVALID_PUBLICATION")
  return { commandId, digest, capability, resultOid, expectedRemoteOid, remoteOid, state: v.state as PublicationReceipt["state"] }
}
export async function grantPublication(input: { attempt: AttemptRef; execution: ExecutionRef; preparation: GitPreparation; git?: GitRunner }): Promise<PublicationCapability> {
  const git = input.git ?? nativeGit, identity = await captureGitIdentity(input.preparation.cwd, git), source = await captureGitIdentity(input.preparation.exchange.repository, git)
  if (identity.commonDir !== source.commonDir) fail("GIT_REPOSITORY_MISMATCH")
  return parsePublicationCapability({ attempt: input.attempt, execution: input.execution, preparation: input.preparation, identity, repositoryIdentity: source, remoteUrl: await resolveGitRemote(input.preparation.exchange.remote, input.preparation.exchange.repository, git) })
}
const operations = new Map<string, MutationQueue>()
export function createPublicationController(input: { root: string; capability(execution: ExecutionRef): Promise<PublicationCapability | null>; validate(execution: ExecutionRef): Promise<boolean>; git?: GitRunner }) {
  const git = input.git ?? nativeGit, storage = createStorage(input.root, "orchestration"), writes = storageQueue(input.root)
  if (!operations.has(input.root)) operations.set(input.root, new MutationQueue())
  const queue = operations.get(input.root)!, key = (commandId: string) => `publications/${id(commandId)}.json`
  const read = async (commandId: string) => { const raw = await storage.read(key(commandId)); return raw === null ? null : parsePublicationReceipt(raw) }
  const save = async (prior: PublicationReceipt, state: PublicationReceipt["state"], remoteOid = prior.remoteOid) => { const next = { ...prior, state, remoteOid }; await writes.run(() => storage.publish(key(prior.commandId), next, prior)); return next }
  async function remote(capability: PublicationCapability): Promise<string | null> {
    const ref = "refs/heads/" + capability.preparation.branch, output = await git(["ls-remote", "--refs", "--", capability.remoteUrl, ref], capability.identity.cwd)
    if (!output) return null
    const fields = output.split(/\s+/); if (fields.length !== 2 || fields[1] !== ref) fail("INVALID_REMOTE_REF")
    return gitOid(fields[0])
  }
  return {
    publish(commandId: string, execution: ExecutionRef, resultOid: string, expectedRemoteOid: string | null): Promise<PublicationReceipt> { return queue.run(async () => {
      commandId = id(commandId); execution = parseExecutionRef(execution); resultOid = gitOid(resultOid); expectedRemoteOid = expectedRemoteOid === null ? null : gitOid(expectedRemoteOid)
      let receipt = await writes.run(() => read(commandId))
      if (receipt) {
        if (!isDeepStrictEqual(receipt.capability.execution, execution) || receipt.resultOid !== resultOid || receipt.expectedRemoteOid !== expectedRemoteOid) fail("COMMAND_CONFLICT")
        if (["published", "rejected"].includes(receipt.state)) return receipt
        try { const oid = await remote(receipt.capability); return await save(receipt, oid === resultOid ? "published" : "uncertain", oid) } catch { return save(receipt, "uncertain") }
      }
      const raw = await input.capability(execution)
      if (!raw || !await input.validate(execution)) fail("GIT_PUBLICATION_UNAUTHORIZED")
      const capability = parsePublicationCapability(raw)
      if (!isDeepStrictEqual(capability.execution, execution)) fail("GIT_PUBLICATION_UNAUTHORIZED")
      receipt = { commandId, capability, resultOid, expectedRemoteOid, digest: canonicalDigest({ commandId, capability, resultOid, expectedRemoteOid }), remoteOid: null, state: "prepared" }
      await writes.run(() => storage.publish(key(commandId), receipt, null, true))
      try {
        const identity = await captureGitIdentity(capability.identity.cwd, git), repository = await captureGitIdentity(capability.repositoryIdentity.cwd, git)
        if (!sameGitIdentity(repository, capability.repositoryIdentity, false) || await resolveGitRemote(capability.preparation.exchange.remote, repository.cwd, git) !== capability.remoteUrl) fail("GIT_SOURCE_CHANGED")
        if (!sameGitIdentity(identity, capability.identity, false) || identity.head !== resultOid || resultOid.length !== capability.preparation.baseOid.length) fail("GIT_SOURCE_CHANGED")
        if (await git(["cat-file", "-t", resultOid], identity.cwd) !== "commit") fail("GIT_RESULT_NOT_COMMIT")
        await git(["merge-base", "--is-ancestor", capability.preparation.baseOid, resultOid], identity.cwd)
        const observed = await remote(capability)
        if (observed !== expectedRemoteOid) return save(receipt, "rejected", observed)
        if (observed) { await git(["fetch", "--no-tags", "--", capability.remoteUrl, observed], identity.cwd); await git(["merge-base", "--is-ancestor", capability.preparation.baseOid, observed], identity.cwd); await git(["merge-base", "--is-ancestor", observed, resultOid], identity.cwd) }
        receipt = await save(receipt, "publishing", observed)
        if (!await input.validate(execution)) return save(receipt, "rejected", observed)
        if (!sameGitIdentity(await captureGitIdentity(identity.cwd, git), identity) || await resolveGitRemote(capability.preparation.exchange.remote, repository.cwd, git) !== capability.remoteUrl) return save(receipt, "rejected", observed)
        const ref = "refs/heads/" + capability.preparation.branch
        await git(["push", "--porcelain", "--force-with-lease=" + ref + ":" + (expectedRemoteOid ?? ""), "--", capability.remoteUrl, resultOid + ":" + ref], identity.cwd)
        const published = await remote(capability)
        return save(receipt, published === resultOid ? "published" : "uncertain", published)
      } catch { return save(receipt, receipt.state === "publishing" ? "uncertain" : "rejected") }
    }) },
    inspect(commandId: string) { return writes.run(() => read(commandId)) }
  }
}