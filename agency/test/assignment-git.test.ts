import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { prepareAssignmentGit } from "../src/orchestration/git-worktree.js"
import { createBureauService } from "../src/bureau/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import { createOrchestrationService } from "../src/orchestration/service.js"
import { agentServiceFixture } from "./agent-support.js"
import { bureauFixture } from "./bureau-support.js"
import { coreFixture } from "./orchestration-support.js"

const execute = promisify(execFile)
async function fixture(t: Parameters<typeof coreFixture>[0], format = "sha1") {
  const f = await coreFixture(t), repository = join(f.root, "source"), remote = join(f.root, "remote.git"), cwd = join(f.root, "worker")
  await execute("git", ["init", "--object-format=" + format, repository])
  await writeFile(join(repository, "source.txt"), "base")
  await execute("git", ["add", "source.txt"], { cwd: repository })
  await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "base"], { cwd: repository })
  await execute("git", ["clone", "--bare", repository, remote])
  const baseOid = (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(), branch = "moon/agency/" + randomUUID()
  const exchange = { remote, repository, baseOid, branch }, options = { root: f.root, commandId: randomUUID(), filesystem: f.filesystem }
  return { ...f, exchange, cwd, options }
}

test("Git preparation fetches the exact base without changing a dirty source checkout", async t => {
  const f = await fixture(t)
  await writeFile(join(f.exchange.repository, "source.txt"), "partial source edits")
  const prepared = await prepareAssignmentGit(f.exchange, f.cwd, f.options)
  assert.equal(prepared.cwd, f.cwd); assert.equal(prepared.branch, f.exchange.branch); assert.equal(prepared.baseOid, f.exchange.baseOid)
  assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: prepared.cwd })).stdout.trim(), f.exchange.baseOid)
  assert.equal(await readFile(join(f.exchange.repository, "source.txt"), "utf8"), "partial source edits")
})

test("Git preparation refuses an existing branch and an unrelated destination path", async t => {
  const f = await fixture(t)
  await execute("git", ["branch", f.exchange.branch], { cwd: f.exchange.repository })
  await assert.rejects(prepareAssignmentGit(f.exchange, f.cwd, f.options), /GIT_BRANCH_EXISTS/)
  const other = await fixture(t)
  await writeFile(other.cwd, "unrelated data")
  await assert.rejects(prepareAssignmentGit(other.exchange, other.cwd, other.options), /GIT_PATH_EXISTS/)
  assert.equal(await readFile(other.cwd, "utf8"), "unrelated data")
})

test("Git preparation rejects an unfetchable or non-commit base before worktree creation", async t => {
  const f = await fixture(t)
  await assert.rejects(prepareAssignmentGit({ ...f.exchange, baseOid: "f".repeat(40) }, f.cwd, f.options))
  const blob = (await execute("git", ["rev-parse", "HEAD:source.txt"], { cwd: f.exchange.repository })).stdout.trim()
  await assert.rejects(prepareAssignmentGit({ ...f.exchange, baseOid: blob }, f.cwd, { ...f.options, commandId: randomUUID() }), /GIT_BASE_NOT_COMMIT/)
})

test("Git preparation intent failure produces no branch or worktree", async t => {
  const f = await fixture(t)
  f.failAt("file-sync", "git-preparations")
  await assert.rejects(prepareAssignmentGit(f.exchange, f.cwd, f.options), /ENOSPC/)
  await assert.rejects(execute("git", ["show-ref", "--verify", "refs/heads/" + f.exchange.branch], { cwd: f.exchange.repository }))
})

test("Git preparation reconciles a completed worktree after losing its result publication", async t => {
  const f = await fixture(t)
  let interrupted = false
  const git = async (argv: string[], cwd: string) => {
    const result = await execute("git", argv, { cwd })
    if (argv[0] === "worktree" && argv[1] === "add" && !interrupted) { interrupted = true; throw new Error("lost worktree result") }
    return result.stdout.trim()
  }
  await assert.rejects(prepareAssignmentGit(f.exchange, f.cwd, { ...f.options, git }), /lost worktree result/)
  const recovered = await prepareAssignmentGit(f.exchange, f.cwd, f.options)
  assert.equal(recovered.cwd, f.cwd)
  assert.equal((await execute("git", ["worktree", "list", "--porcelain"], { cwd: f.exchange.repository })).stdout.split("worktree ").length - 1, 2)
})

test("restore preparation preserves partial work and records the existing HEAD", async t => {
  const f = await fixture(t), prior = await prepareAssignmentGit(f.exchange, f.cwd, f.options)
  await writeFile(join(f.cwd, "source.txt"), "partial worker edits")
  const restored = await prepareAssignmentGit(f.exchange, f.cwd, { ...f.options, commandId: randomUUID(), restore: prior })
  assert.equal(restored.restoreHead, f.exchange.baseOid)
  assert.equal(await readFile(join(f.cwd, "source.txt"), "utf8"), "partial worker edits")
  await assert.rejects(prepareAssignmentGit({ ...f.exchange, branch: "moon/agency/other" }, f.cwd, { ...f.options, commandId: randomUUID(), restore: prior }), /GIT_RESTORE_CONFLICT/)
})

test("Git preparation supports SHA-256 repositories and rejects object-format mismatch", async t => {
  const f = await fixture(t, "sha256"), result = await prepareAssignmentGit(f.exchange, f.cwd, f.options)
  assert.equal(result.baseOid.length, 64)
  const other = await fixture(t)
  await assert.rejects(prepareAssignmentGit({ ...other.exchange, baseOid: f.exchange.baseOid }, other.cwd, other.options), /GIT_OBJECT_FORMAT/)
})

test("Bureau allocates and retains separate Git exchanges for replacement attempts", async t => {
  const f = await bureauFixture(t), g = await fixture(t)
  const host = { ...f.host.raw, async launch(command: Parameters<typeof f.host.raw.launch>[0], invocation: Parameters<typeof f.host.raw.launch>[1]) {
    assert.ok(command.git)
    const preparation = await prepareAssignmentGit(command.git, join(g.root, "workers", command.ref.attemptId), { root: g.root, commandId: command.commandId })
    return { ...await f.host.raw.launch(command, invocation), git: preparation }
  } }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), hosts: [host] })
  f.beforeCleanup(() => core.close()); await core.initialize(); await core.enable()
  const { branch: ignored, ...git } = g.exchange
  const child = await core.delegate(randomUUID(), f.input.runId, { ...f.input.assignment, git }, f.invocation)
  const first = (child.attempt as any).git
  assert.equal(first.baseOid, git.baseOid)
  assert.equal(first.branch, `moon/agency/${f.input.runId}/${child.assignmentId}/${child.attempt.ref.attemptId}`)
  assert.deepEqual((await f.store.readAttempt(child.attempt.ref.attemptId) as any).git, first)
  f.host.retire(); await core.reconcile()
  const replacement = await core.retry(randomUUID(), child.assignmentId, "replace", f.invocation)
  assert.notEqual((replacement.attempt as any).git.cwd, first.cwd)
  assert.notEqual((replacement.attempt as any).git.branch, first.branch)
})

test("origin launches code workers in a retained exact-base worktree and restores partial work", async t => {
  const f = await agentServiceFixture(t), repository = f.workspace, remote = join(f.root, "remote.git")
  await execute("git", ["init", repository]); await writeFile(join(repository, "code.txt"), "base")
  await execute("git", ["add", "code.txt"], { cwd: repository }); await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "base"], { cwd: repository })
  await execute("git", ["clone", "--bare", repository, remote])
  const baseOid = (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(), hostId = f.context.paths.hostKey, journals = createJournalPool(f.root, undefined, Date.now, "origin")
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage: createLineageStore(f.root), tools: { definition() { return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate() {}, revoke() {} }, relay: async () => { throw new Error("offline") } })
  const runId = randomUUID(), assignmentId = randomUUID(), attemptId = randomUUID(), parent = { hostId, agentId: randomUUID() }, git = { remote, repository, baseOid }, exchange = { ...git, branch: `moon/agency/${runId}/${assignmentId}/${attemptId}` }
  const command = { commandId: randomUUID(), runId, ref: { runId, assignmentId, attemptId }, agent: { hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), spec: { parent, description: "Code assignment", hostId, cwd: repository, backendId: "codex-acp" as const, modelId: "model-a", overrides: {}, git }, lineage: { runId, parent, assignmentId }, git: exchange, retryMode: "new" as const, savedSettings: null }
  const invocation = { environment: f.input.environment, nativeParams: {} }, receipt = await host.launch(command, invocation), preparation = (receipt as any).git
  assert.equal(receipt.state, "started")
  assert.equal((await f.service.sessionRecord(command.agent.agentId))!.record.definition.cwd, preparation.cwd)
  assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: preparation.cwd })).stdout.trim(), baseOid)
  const reportInput = { ...command.ref, commandId: randomUUID(), execution: receipt.execution!, report: { status: "completed" as const, summary: "Code changes finished", issues: [], validation: [], git: null } }
  await assert.rejects(host.report(reportInput), /GIT_PUBLICATION_REQUIRED/)
  const result = { ...exchange, resultOid: baseOid, published: false }
  await assert.rejects(host.report({ ...reportInput, report: { ...reportInput.report, status: "blocked", git: { ...result, published: true } } }), /GIT_PUBLICATION_UNAUTHORIZED/)
  await assert.rejects(host.report({ ...reportInput, report: { ...reportInput.report, status: "blocked", git: { ...result, branch: "moon/agency/unrelated" } } }), /INVALID_REPORT/)
  assert.equal((await host.report({ ...reportInput, report: { ...reportInput.report, status: "blocked", git: result } })).state, "retained")
  await writeFile(join(preparation.cwd, "code.txt"), "partial worker edits")
  await host.stop(randomUUID(), receipt.execution!)
  const restored = await host.launch({ ...command, commandId: randomUUID(), ref: { ...command.ref, attemptId: randomUUID() }, retryMode: "restore", savedSettings: receipt.effective, savedGit: preparation } as any, invocation)
  assert.equal((restored as any).git.cwd, preparation.cwd)
  assert.equal((restored as any).git.branch, preparation.branch)
  assert.equal((restored as any).git.restoreHead, baseOid)
  assert.equal(await readFile(join(preparation.cwd, "code.txt"), "utf8"), "partial worker edits")
  const retained = (await journals.forRun(runId).retainedRead(0, 256)).entries.filter(entry => entry.kind === "origin-launch")
  assert.equal((retained[1]!.payload as any).git.cwd, preparation.cwd)
})

test("Git restore requires the retained preparation's exact ownership evidence", async t => {
  const f = await fixture(t), prior = await prepareAssignmentGit(f.exchange, f.cwd, f.options)
  await assert.rejects(prepareAssignmentGit(f.exchange, f.cwd, { ...f.options, commandId: randomUUID(), restore: { ...prior, commandId: randomUUID() } }), /GIT_RESTORE_CONFLICT/)
  await assert.rejects(prepareAssignmentGit(f.exchange, f.cwd, { ...f.options, commandId: randomUUID(), restore: { ...prior, digest: "f".repeat(64) } }), /GIT_RESTORE_CONFLICT/)
})