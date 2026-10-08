import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { absolutePath, hash, keys, object, text } from "../catalog/types.js"
import { canonicalDigest, fail, boundedText, parseReport, boundedArray, type Validation } from "../orchestration/types.js"
import { parseAcceptedReport, type AcceptedReport } from "../orchestration/reports.js"
import { parsePublicationReceipt } from "../orchestration/git-publication.js"
import { createStorage, storageQueue } from "../orchestration/storage.js"
import { captureGitIdentity, gitOid, nativeGit, parseGitIdentity, resolveGitRemote, sameGitIdentity, type GitIdentity, type GitRunner } from "./git-identity.js"

export type GitResultConfiguration = { identity: GitIdentity; remote: string; remoteUrl: string; validations: string[][] }
export type ResultProposal = { proposalId: string; reportId: string; report: AcceptedReport; destination: GitIdentity; configurationDigest: string; remoteUrl: string; baseOid: string; resultOid: string; tree: string | null; sourceOids: string[]; linear: boolean; diffSummary: string; claimedValidations: Validation[]; validations: Validation[]; issues: string[]; fetchedRef: string }
const parseArgv = (value: unknown) => { const argv = boundedArray(value, arg => text(arg, 4096), 128); if (!argv.length) fail("INVALID_VALIDATION"); return argv }
function parseConfiguration(raw: unknown): GitResultConfiguration {
  const v = object(raw); keys(v, ["identity", "remote", "remoteUrl", "validations"])
  return { identity: parseGitIdentity(v.identity), remote: text(v.remote, 4096), remoteUrl: text(v.remoteUrl, 4096), validations: boundedArray(v.validations, parseArgv, 128) }
}
export function parseResultProposal(raw: unknown): ResultProposal {
  const v = object(raw), { proposalId, ...payload } = v
  keys(payload, ["reportId", "report", "destination", "configurationDigest", "remoteUrl", "baseOid", "resultOid", "tree", "sourceOids", "linear", "diffSummary", "claimedValidations", "validations", "issues", "fetchedRef"])
  if (hash(proposalId) !== canonicalDigest(payload) || typeof payload.linear !== "boolean") fail("INVALID_PROPOSAL")
  const report = parseAcceptedReport(payload.report), destination = parseGitIdentity(payload.destination)
  if (payload.reportId !== report.input.attemptId || payload.baseOid !== report.input.report.git?.baseOid || payload.resultOid !== report.input.report.git?.resultOid) fail("INVALID_PROPOSAL")
  const validations = parseReport({ status: "blocked", summary: "", issues: [], git: null, validation: payload.validations }).validation
  const claimedValidations = parseReport({ status: "blocked", summary: "", issues: [], git: null, validation: payload.claimedValidations }).validation
  const remoteUrl = text(payload.remoteUrl, 4096), issues = boundedArray(payload.issues, value => text(value, 4096)), diffSummary = boundedText(payload.diffSummary), fetchedRef = text(payload.fetchedRef)
  if (!/^refs\/agency\/verified\/[a-f0-9]{64}$/.test(fetchedRef)) fail("INVALID_PROPOSAL")
  return { ...payload, remoteUrl, issues, diffSummary, fetchedRef, validations, claimedValidations, proposalId: hash(proposalId), report, destination, configurationDigest: hash(payload.configurationDigest), baseOid: gitOid(payload.baseOid), resultOid: gitOid(payload.resultOid), sourceOids: boundedArray(payload.sourceOids, gitOid, 8192), tree: payload.tree === null ? null : gitOid(payload.tree) } as ResultProposal
}
const execute = promisify(execFile)
export function createGitResults(input: { root: string; report(reportId: string): Promise<AcceptedReport | null>; git?: GitRunner; validate?(argv: string[], cwd: string): Promise<{ exitCode: number; result: string }> }) {
  const git = input.git ?? nativeGit, storage = createStorage(input.root, "bureau"), queue = storageQueue(input.root)
  const configKey = (cwd: string) => `git-configurations/${canonicalDigest(absolutePath(cwd))}.json`
  const configuration = async (cwd: string) => { const raw = await queue.run(() => storage.read(configKey(cwd))); if (!raw) fail("GIT_DESTINATION_UNCONFIGURED"); return parseConfiguration(raw) }
  async function validation(argv: string[], cwd: string): Promise<Validation> {
    if (input.validate) return { argv, cwd, ...await input.validate(argv, cwd) }
    try { const result = await execute(argv[0]!, argv.slice(1), { cwd, timeout: 60000, maxBuffer: 65536 }); return { argv, cwd, exitCode: 0, result: (result.stdout + result.stderr).slice(0, 65536) } }
    catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { argv, cwd, exitCode: typeof e.code === "number" ? e.code : -1, result: ((e.stdout ?? "") + (e.stderr ?? "") + (error instanceof Error ? error.message : "Validation failed")).slice(0, 65536) } }
  }
  return {
    configuration,
    async configure(raw: { destinationCwd: string; remote: string; validations: string[][] }): Promise<GitResultConfiguration> {
      const identity = await captureGitIdentity(raw.destinationCwd, git), config = parseConfiguration({ identity, remote: raw.remote, remoteUrl: await resolveGitRemote(raw.remote, identity.cwd, git), validations: raw.validations })
      await queue.run(async () => { const prior = await storage.read(configKey(identity.cwd)); await storage.publish(configKey(identity.cwd), config, prior) }); return config
    },
    async verifyResult(reportId: string, destinationCwd: string): Promise<ResultProposal> {
      const raw = await input.report(reportId)
      if (!raw) fail("UNKNOWN_REPORT")
      const report = parseAcceptedReport(raw), result = report.input.report.git
      if (reportId !== report.input.attemptId || report.receipt.state !== "accepted" || report.input.report.status !== "completed" || !result?.published || !result.publication) fail("GIT_PUBLICATION_REQUIRED")
      const publication = parsePublicationReceipt(result.publication), capability = publication.capability
      const { resultOid, published: _published, publication: _publication, publicationCommandId: _command, ...exchange } = result
      if (publication.state !== "published" || publication.resultOid !== resultOid || canonicalDigest(capability.preparation.exchange) !== canonicalDigest(exchange)
        || canonicalDigest(capability.execution) !== canonicalDigest(report.input.execution) || canonicalDigest(capability.attempt) !== canonicalDigest({ runId: report.input.runId, assignmentId: report.input.assignmentId, attemptId: report.input.attemptId })) fail("GIT_PUBLICATION_REQUIRED")
      const config = await configuration(destinationCwd), destination = await captureGitIdentity(destinationCwd, git)
      if (!sameGitIdentity(config.identity, destination, false)) fail("GIT_DESTINATION_CHANGED")
      if (config.remoteUrl !== capability.remoteUrl || await resolveGitRemote(config.remote, destination.cwd, git) !== config.remoteUrl) fail("GIT_REMOTE_MISMATCH")
      if (resultOid.length !== destination.head.length || result.baseOid.length !== destination.head.length) fail("GIT_OBJECT_FORMAT")
      const issues: string[] = [], sourceOids: string[] = [], validations: Validation[] = [], fetchedRef = "refs/agency/verified/" + canonicalDigest({ report, destination, config })
      let tree: string | null = null, linear = true, diffSummary = ""
      try { await git(["fetch", "--no-tags", "--", config.remoteUrl, result.baseOid, resultOid], destination.cwd) } catch { issues.push("GIT_FETCH_FAILED") }
      if (!issues.length) {
        try {
          if (await git(["cat-file", "-t", resultOid], destination.cwd) !== "commit" || await git(["cat-file", "-t", result.baseOid], destination.cwd) !== "commit") fail("GIT_RESULT_NOT_COMMIT")
          await git(["merge-base", "--is-ancestor", result.baseOid, resultOid], destination.cwd)
          await git(["merge-base", "--is-ancestor", result.baseOid, destination.head], destination.cwd)
          tree = await git(["rev-parse", resultOid + "^{tree}"], destination.cwd)
          const commits = await git(["rev-list", "--reverse", "--topo-order", "--parents", result.baseOid + ".." + resultOid], destination.cwd)
          let prior = result.baseOid
          for (const line of commits ? commits.split("\n") : []) { const [oid, ...parents] = line.split(" "); sourceOids.push(gitOid(oid)); if (parents.length !== 1 || parents[0] !== prior) linear = false; prior = oid! }
          diffSummary = (await git(["diff", "--stat", result.baseOid, resultOid, "--"], destination.cwd)).slice(0, 65536)
          await git(["update-ref", fetchedRef, resultOid], destination.cwd)
        } catch { issues.push("GIT_ANCESTRY_OR_OBJECT_INVALID") }
      }
      if (!issues.length && config.validations.length) {
        const cwd = join(input.root, "bureau", "verification-" + randomUUID())
        let created = false
        try {
          await git(["worktree", "add", "--detach", "--", cwd, resultOid], destination.cwd); created = true
          if (await git(["rev-parse", "HEAD"], cwd) !== resultOid) fail("GIT_VALIDATION_REVISION")
          for (const argv of config.validations) { const record = await validation(argv, cwd); validations.push(record); if (record.exitCode !== 0) issues.push("GIT_VALIDATION_FAILED"); if (await git(["rev-parse", "HEAD"], cwd) !== resultOid || await git(["diff", "--name-only", resultOid, "--"], cwd)) { issues.push("GIT_VALIDATION_REVISION_CHANGED"); break } }
        } catch { issues.push("GIT_VALIDATION_FAILED") }
        finally { if (created) { try { await git(["worktree", "remove", "--force", "--", cwd], destination.cwd) } catch { issues.push("GIT_VERIFICATION_CLEANUP_FAILED") } } }
      }
      const payload = { reportId, report, destination, configurationDigest: canonicalDigest(config), remoteUrl: config.remoteUrl, baseOid: result.baseOid, resultOid, tree, sourceOids, linear, diffSummary, claimedValidations: report.input.report.validation, validations, issues, fetchedRef }
      const proposal = parseResultProposal({ ...payload, proposalId: canonicalDigest(payload) })
      await queue.run(() => storage.publish(`git-proposals/${proposal.proposalId}.json`, proposal, null, true)); return proposal
    },
    async proposal(proposalId: string): Promise<ResultProposal | null> { const raw = await queue.run(() => storage.read(`git-proposals/${hash(proposalId)}.json`)); return raw === null ? null : parseResultProposal(raw) }
  }
}