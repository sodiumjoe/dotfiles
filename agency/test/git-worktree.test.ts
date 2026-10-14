import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, realpath, rm, writeFile, readdir, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { git } from "./git-support.js"
import { prepareWorktree } from "../src/git/worktree.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

async function fixture(t: test.TestContext, format = "sha1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-ordinary-git-"))); t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, "repo"), cwd = join(root, "work", "destination")
  await git(["init", "--object-format=" + format, repository], root); await writeFile(join(repository, "base"), "base")
  await git(["add", "."], repository); await git(["commit", "-m", "base"], repository)
  const baseOid = await git(["rev-parse", "HEAD"], repository), remote = join(root, "remote.git")
  await git(["clone", "--bare", repository, remote], root)
  return { root, input: { repository, cwd, branch: "moon/custom", baseOid, remote } }
}
for (const format of ["sha1", "sha256"]) test(`ordinary ${format} worktree preparation returns an immutable cwd without Agency state`, async t => {
  const f = await fixture(t, format), result = await prepareWorktree(f.input)
  assert.deepEqual(result, { cwd: f.input.cwd, branch: "moon/custom", baseOid: f.input.baseOid })
  assert.equal(await git(["rev-parse", "HEAD"], result.cwd), f.input.baseOid)
  assert.equal(await git(["symbolic-ref", "--short", "HEAD"], result.cwd), "moon/custom")
  assert.deepEqual((await readdir(f.root)).sort(), ["remote.git", "repo", "work"])
})
test("occupied destinations and branches are refused without touching untracked files", async t => {
  const f = await fixture(t); await mkdir(f.input.cwd, { recursive: true }); await writeFile(join(f.input.cwd, "keep"), "keep")
  await assert.rejects(prepareWorktree(f.input), /GIT_DESTINATION_OCCUPIED/)
  assert.deepEqual(await readdir(f.input.cwd), ["keep"])
  await git(["branch", f.input.branch], f.input.repository)
  await assert.rejects(prepareWorktree({ ...f.input, cwd: join(f.root, "other") }), /GIT_BRANCH_OCCUPIED/)
})
test("invalid paths, branches and noncommit bases cause no worktree creation", async t => {
  const f = await fixture(t), blob = await git(["rev-parse", "HEAD:base"], f.input.repository)
  for (const change of [{ baseOid: "HEAD" }, { baseOid: blob }, { branch: "main" }, { branch: "moon/bad..name" }, { cwd: f.root + "/../destination" }, { repository: "relative" }]) await assert.rejects(prepareWorktree({ ...f.input, ...change }))
  assert.deepEqual((await readdir(f.root)).sort(), ["remote.git", "repo"])
})
test("an interrupted Git operation leaves inspectable state and triggers no repair", async t => {
  const f = await fixture(t), calls: string[][] = []
  await assert.rejects(prepareWorktree(f.input, { git: async (args, cwd) => { calls.push(args); if (args[0] === "worktree") { await mkdir(f.input.cwd); await writeFile(join(f.input.cwd, "partial"), "keep"); throw new Error("interrupted") }; return git(args, cwd) } }), /interrupted/)
  assert.deepEqual(await readdir(f.input.cwd), ["partial"])
  assert.equal(calls.filter(args => ["reset", "clean", "merge", "push"].includes(args[0]!)).length, 0)
})
test("prepared cwd starts an ordinary runtime session without task hooks", async t => {
  const f = await fixture(t), prepared = await prepareWorktree(f.input), runtime = await agentServiceFixture(t)
  const command = await runtime.service.start({ ...runtime.input, cwd: prepared.cwd })
  await until(async () => (await runtime.service.command(command.command.commandId, command.command.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await runtime.service.roster({ limit: 100 })).agents[0]?.record.version, 3)
  assert.equal((await runtime.service.current(prepared.cwd)).agents.length, 1)
})

import { runControl } from "../src/cli/control.js"
import { parseHostReply } from "../src/hosts/protocol.js"
import { unavailableControlDependencies } from "./control-support.js"

test("ordinary git prepare returns Host protocol without inspecting or starting Agency", async t => {
  const f = await fixture(t), output: string[] = []
  const code = await runControl(["git", "prepare", "--input-json", JSON.stringify(f.input), "--json"], { ...unavailableControlDependencies(), environment: async () => { throw new Error("Agency environment forbidden") }, start: async () => { throw new Error("Agency start forbidden") }, callBureau: async () => { throw new Error("Bureau forbidden") }, stdout: value => output.push(value) })
  assert.equal(code, 0)
  const reply = parseHostReply(JSON.parse(output.join(""))); assert.ok(reply.ok && reply.result.state === "worktree")
  assert.equal(reply.hostId, null); assert.equal(reply.result.worktree.cwd, f.input.cwd)
})