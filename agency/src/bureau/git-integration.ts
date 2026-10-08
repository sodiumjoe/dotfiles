import { hash, id, keys, object, text } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import { boundedArray, canonicalDigest, enumValue, fail } from "../orchestration/types.js"
import { createStorage, storageQueue } from "../orchestration/storage.js"
import { captureGitIdentity, gitOid, gitOperation, nativeGit, resolveGitRemote, sameGitIdentity, type GitRunner } from "./git-identity.js"
import { type createGitResults, type ResultProposal } from "./git-results.js"

export type IntegrationReceipt = { commandId: string; proposalId: string; expectedHead: string; strategy: "merge" | "cherry-pick"; digest: string; state: "prepared" | "applying" | "integrated" | "conflict" | "uncertain" | "rejected"; sourceOids: string[]; results: { sourceOid: string; resultOid: string }[]; resultingHead: string | null; issue: string | null }
export function parseIntegrationReceipt(raw: unknown): IntegrationReceipt {
  const v = object(raw); keys(v, ["commandId", "proposalId", "expectedHead", "strategy", "digest", "state", "sourceOids", "results", "resultingHead", "issue"])
  const commandId = id(v.commandId), proposalId = hash(v.proposalId), expectedHead = gitOid(v.expectedHead), strategy = enumValue(v.strategy, ["merge", "cherry-pick"])
  const sourceOids = boundedArray(v.sourceOids, gitOid, 8192), results = boundedArray(v.results, raw => { const r = object(raw); keys(r, ["sourceOid", "resultOid"]); return { sourceOid: gitOid(r.sourceOid), resultOid: gitOid(r.resultOid) } }, 8192)
  const digest = hash(v.digest), state = enumValue(v.state, ["prepared", "applying", "integrated", "conflict", "uncertain", "rejected"])
  if (digest !== canonicalDigest({ commandId, proposalId, expectedHead, strategy }) || results.some((r, i) => r.sourceOid !== sourceOids[i])) fail("INVALID_INTEGRATION")
  return { commandId, proposalId, expectedHead, strategy, digest, state, sourceOids, results, resultingHead: v.resultingHead === null ? null : gitOid(v.resultingHead), issue: v.issue === null ? null : text(v.issue, 4096) }
}
const operations = new Map<string, MutationQueue>()
export function createGitIntegration(input: { root: string; results: ReturnType<typeof createGitResults>; git?: GitRunner }) {
  const git = input.git ?? nativeGit, storage = createStorage(input.root, "bureau"), writes = storageQueue(input.root)
  const key = (commandId: string) => `git-integrations/${id(commandId)}.json`
  const read = async (commandId: string) => { const raw = await storage.read(key(commandId)); return raw === null ? null : parseIntegrationReceipt(raw) }
  const save = async (prior: IntegrationReceipt, change: Partial<IntegrationReceipt>) => { const next = parseIntegrationReceipt({ ...prior, ...change }); await writes.run(() => storage.publish(key(prior.commandId), next, prior)); return next }
  async function check(proposal: ResultProposal, expectedHead: string) {
    const config = await input.results.configuration(proposal.destination.cwd), current = await captureGitIdentity(proposal.destination.cwd, git)
    if (proposal.issues.length || !proposal.tree) fail("GIT_PROPOSAL_REJECTED")
    if (canonicalDigest(config) !== proposal.configurationDigest) fail("GIT_CONFIGURATION_CHANGED")
    if (!sameGitIdentity(current, proposal.destination) || current.head !== expectedHead) fail("GIT_DESTINATION_CHANGED")
    if (await resolveGitRemote(config.remote, current.cwd, git) !== proposal.remoteUrl) fail("GIT_REMOTE_CHANGED")
    if (await gitOperation(current)) fail("GIT_OPERATION_IN_PROGRESS")
    if (await git(["status", "--porcelain=v1", "--untracked-files=all"], current.cwd)) fail("GIT_DESTINATION_DIRTY")
    if (await git(["rev-parse", proposal.resultOid + "^{tree}"], current.cwd) !== proposal.tree) fail("GIT_RESULT_CHANGED")
  }
  async function recover(receipt: IntegrationReceipt, proposal: ResultProposal) {
    const cwd = proposal.destination.cwd
    try {
      const current = await captureGitIdentity(cwd, git)
      if (!sameGitIdentity(current, proposal.destination, false)) return save(receipt, { state: "uncertain", issue: "GIT_DESTINATION_CHANGED" })
      if (await gitOperation(current)) { const conflict = !!await git(["diff", "--name-only", "--diff-filter=U", "--"], cwd); return save(receipt, { state: conflict ? "conflict" : "uncertain", resultingHead: current.head, issue: "GIT_OPERATION_IN_PROGRESS" }) }
      if (await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)) return save(receipt, { state: "uncertain", resultingHead: current.head, issue: "GIT_DESTINATION_DIRTY" })
      if (receipt.strategy === "merge") {
        const parents = (await git(["show", "-s", "--format=%P", current.head], cwd)).split(" ")
        let proven = parents.length === 2 && parents[0] === receipt.expectedHead && parents[1] === proposal.resultOid
        if (current.head === receipt.expectedHead) { try { await git(["merge-base", "--is-ancestor", proposal.resultOid, current.head], cwd); proven = true } catch {} }
        if (proven) return save(receipt, { state: "integrated", resultingHead: current.head, issue: null })
      } else {
        const lines = (await git(["rev-list", "--reverse", "--parents", receipt.expectedHead + ".." + current.head], cwd)).split("\n").filter(Boolean)
        if (lines.length === receipt.sourceOids.length) {
          const results: IntegrationReceipt["results"] = []; let prior = receipt.expectedHead
          for (let i = 0; i < lines.length; i++) {
            const [oid, ...parents] = lines[i]!.split(" "), sourceOid = receipt.sourceOids[i]!
            if (parents.length !== 1 || parents[0] !== prior) fail("GIT_RECOVERY_AMBIGUOUS")
            const message = await git(["show", "-s", "--format=%B", oid!], cwd)
            if (!message.includes("(cherry picked from commit " + sourceOid + ")")) fail("GIT_RECOVERY_AMBIGUOUS")
            const sourcePatch = await git(["show", "--format=", "--binary", "--no-ext-diff", "--no-renames", sourceOid], cwd)
            if (sourcePatch !== await git(["show", "--format=", "--binary", "--no-ext-diff", "--no-renames", oid!], cwd)) fail("GIT_RECOVERY_AMBIGUOUS")
            results.push({ sourceOid, resultOid: gitOid(oid) }); prior = oid!
          }
          return save(receipt, { state: "integrated", results, resultingHead: current.head, issue: null })
        }
      }
      return save(receipt, { state: "uncertain", resultingHead: current.head, issue: "GIT_RECOVERY_AMBIGUOUS" })
    } catch { return save(receipt, { state: "uncertain", issue: "GIT_RECOVERY_AMBIGUOUS" }) }
  }
  return {
    inspect(commandId: string) { return writes.run(() => read(commandId)) },
    async integrate(commandId: string, proposalId: string, expectedHead: string, strategy: IntegrationReceipt["strategy"]): Promise<IntegrationReceipt> {
      commandId = id(commandId); proposalId = hash(proposalId); expectedHead = gitOid(expectedHead); strategy = enumValue(strategy, ["merge", "cherry-pick"])
      const proposal = await input.results.proposal(proposalId); if (!proposal) fail("UNKNOWN_PROPOSAL")
      const destinationKey = canonicalDigest(proposal.destination.cwd)
      if (!operations.has(proposal.destination.cwd)) operations.set(proposal.destination.cwd, new MutationQueue())
      return operations.get(proposal.destination.cwd)!.run(async () => {
        const digest = canonicalDigest({ commandId, proposalId, expectedHead, strategy }), activeKey = `git-active/${destinationKey}.json`
        let receipt = await writes.run(() => read(commandId))
        if (receipt) {
          if (receipt.digest !== digest) fail("COMMAND_CONFLICT")
          if (["integrated", "rejected"].includes(receipt.state)) return receipt
          const recovered = await recover(receipt, proposal)
          if (recovered.state === "integrated") await writes.run(() => storage.remove(activeKey))
          return recovered
        }
        receipt = { commandId, proposalId, expectedHead, strategy, digest, state: "prepared", sourceOids: proposal.sourceOids, results: [], resultingHead: null, issue: null }
        await writes.run(() => storage.publish(key(commandId), receipt, null, true))
        try {
          const active = await writes.run(() => storage.read(activeKey))
          if (active) fail("GIT_INTEGRATION_PENDING")
          await check(proposal, expectedHead)
          if (strategy === "cherry-pick" && !proposal.linear) fail("MERGE_REQUIRED")
        } catch (error) { return save(receipt, { state: "rejected", issue: error instanceof Error ? error.message : "GIT_INTEGRATION_REJECTED" }) }
        await writes.run(() => storage.publish(activeKey, { commandId, proposalId }, null, true))
        receipt = await save(receipt, { state: "applying", resultingHead: expectedHead })
        try { await check(proposal, expectedHead) } catch (error) { const rejected = await save(receipt, { state: "rejected", issue: error instanceof Error ? error.message : "GIT_DESTINATION_CHANGED" }); await writes.run(() => storage.remove(activeKey)); return rejected }
        const cwd = proposal.destination.cwd
        try {
          if (strategy === "merge") await git(["merge", "--no-ff", "--no-edit", "--", proposal.resultOid], cwd)
          else for (const sourceOid of receipt.sourceOids) {
            const current = await captureGitIdentity(cwd, git)
            if (!sameGitIdentity(current, proposal.destination, false) || current.head !== receipt.resultingHead || await gitOperation(current) || await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)) fail("GIT_DESTINATION_CHANGED")
            await git(["cherry-pick", "-x", sourceOid], cwd)
            const resultOid = gitOid(await git(["rev-parse", "HEAD"], cwd))
            receipt = await save(receipt, { results: [...receipt.results, { sourceOid, resultOid }], resultingHead: resultOid })
          }
          const recovered = await recover(receipt, proposal)
          if (recovered.state === "integrated") await writes.run(() => storage.remove(activeKey))
          return recovered
        } catch {
          let resultingHead = receipt.resultingHead, conflict = false
          try { const current = await captureGitIdentity(cwd, git); resultingHead = current.head; conflict = await gitOperation(current) && !!await git(["diff", "--name-only", "--diff-filter=U", "--"], cwd) } catch {}
          return save(receipt, { state: conflict ? "conflict" : "uncertain", resultingHead, issue: conflict ? "GIT_CONFLICT" : "GIT_REPLY_OR_APPLICATION_UNCERTAIN" })
        }
      })
    }
  }
}