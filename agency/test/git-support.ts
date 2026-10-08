import { createGitResults } from "../src/bureau/git-results.js"
import { createPublicationController, grantPublication } from "../src/orchestration/git-publication.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { TestContext } from "node:test"
import { prepareAssignmentGit } from "../src/orchestration/git-worktree.js"

const execute = promisify(execFile)
export async function git(args: string[], cwd: string): Promise<string> {
  return (await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { cwd, timeout: 10000, maxBuffer: 1048576, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim()
}
export async function gitFixture(t: TestContext, format = "sha1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-results-")))
  t.after(() => rm(root, { force: true, recursive: true }))
  const repository = join(root, "repository"), remote = join(root, "remote.git"), destination = join(root, "destination"), worker = join(root, "worker")
  await git(["init", "--object-format=" + format, repository], root)
  await writeFile(join(repository, "base.txt"), "base")
  await git(["add", "."], repository); await git(["commit", "-m", "base"], repository)
  const baseOid = await git(["rev-parse", "HEAD"], repository)
  await git(["clone", "--bare", repository, remote], root); await git(["clone", remote, destination], root)
  const attempt = { runId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID() }, execution = { hostId: "b".repeat(64), agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() }
  const exchange = { repository, remote, baseOid, branch: `moon/agency/${attempt.runId}/${attempt.assignmentId}/${attempt.attemptId}` }
  const preparation = await prepareAssignmentGit(exchange, worker, { root, commandId: randomUUID() })
  async function commit(name: string, contents = name, cwd = worker) { await writeFile(join(cwd, name + ".txt"), contents); await git(["add", "."], cwd); await git(["commit", "-m", name], cwd); return git(["rev-parse", "HEAD"], cwd) }
  return { root, repository, remote, destination, worker, attempt, execution, exchange, preparation, baseOid, commit }
}

export async function resultFixture(t: TestContext, format = "sha1") {
  const f = await gitFixture(t, format), capability = await grantPublication({ ...f, git }), publication = createPublicationController({ root: f.root, capability: async () => capability, validate: async () => true, git })
  const resultOid = await f.commit("first"), receipt = await publication.publish(randomUUID(), f.execution, resultOid, null), commandId = randomUUID()
  const input = { ...f.attempt, commandId, execution: f.execution, report: { status: "completed" as const, summary: "Code completed", issues: [], validation: [{ argv: ["sh", "-c", "touch should-not-run"], cwd: f.worker, exitCode: 0, result: "Worker claim" }], git: { ...f.exchange, resultOid, published: true, publication: receipt } } }
  const origin = { seq: 1, eventId: randomUUID(), digest: "a".repeat(64) }, report = { input, origin, receipt: { commandId, ...f.attempt, digest: canonicalDigest(input.report), originSeq: 1, state: "accepted" as const } }
  const api = createGitResults({ root: f.root, report: async () => report, git })
  await api.configure({ destinationCwd: f.destination, remote: f.remote, validations: [[process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync('first.txt','utf8'))"]] })
  return { ...f, report, api, publication, resultOid, verify: () => api.verifyResult(f.attempt.attemptId, f.destination) }
}