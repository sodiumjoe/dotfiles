import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, id, keys, object, text } from "../catalog/types.js"
import { createStorage, defaultFileSystem, storageQueue, type StorageFileSystem } from "./storage.js"
import { canonicalDigest, fail, parseGitInput, type GitExchange } from "./types.js"

export type GitPreparation = { version: 1; commandId: string; exchange: GitExchange; digest: string; cwd: string; baseOid: string; branch: string; restoreHead: string | null; state: "preparing" | "ready" }
export function parseGitPreparation(raw: unknown): GitPreparation {
  const v = object(raw); keys(v, ["version", "commandId", "exchange", "digest", "cwd", "baseOid", "branch", "restoreHead", "state"])
  const exchange = object(v.exchange), { branch, ...input } = exchange, parsed = { ...parseGitInput(input), branch: text(branch) }
  if (v.version !== 1 || v.state !== "preparing" && v.state !== "ready" || v.branch !== parsed.branch || v.baseOid !== parsed.baseOid || typeof v.digest !== "string" || !/^[a-f0-9]{64}$/.test(v.digest) || v.restoreHead !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(v.restoreHead))) fail("INVALID_GIT_PREPARATION")
  return { version: 1, commandId: id(v.commandId), exchange: parsed, digest: v.digest, cwd: absolutePath(v.cwd), baseOid: parsed.baseOid, branch: parsed.branch, restoreHead: v.restoreHead as string | null, state: v.state }
}
const execute = promisify(execFile)
const nativeGit = async (argv: string[], cwd: string) => (await execute("git", argv, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim()
async function exists(path: string) { try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error } }
export async function prepareAssignmentGit(raw: GitExchange, worktreeRoot: string, options: { root?: string; commandId?: string; filesystem?: StorageFileSystem; git?: typeof nativeGit; restore?: GitPreparation } = {}): Promise<GitPreparation> {
  const cwd = absolutePath(worktreeRoot), { branch, ...input } = raw, exchange: GitExchange = { ...parseGitInput(input), branch: text(branch) }
  if (!branch.startsWith("moon/agency/") || /[\x00-\x1f\x7f]/u.test(branch) || exchange.remote.startsWith("-") || /[\x00-\x1f\x7f]/u.test(exchange.remote)) fail("INVALID_GIT_PREPARATION")
  const root = options.root ?? dirname(cwd), commandId = id(options.commandId ?? branch.split("/").at(-1)), git = options.git ?? nativeGit, storage = createStorage(root, "orchestration", options.filesystem ?? defaultFileSystem)
  return storageQueue(root).run(async () => {
    await git(["check-ref-format", "--branch", branch], exchange.repository)
    if (await realpath(exchange.repository) !== exchange.repository) fail("GIT_REPOSITORY_PATH")
    const format = await git(["rev-parse", "--show-object-format"], exchange.repository)
    if ((format === "sha1" ? 40 : format === "sha256" ? 64 : 0) !== exchange.baseOid.length) fail("GIT_OBJECT_FORMAT")
    const key = `git-preparations/${commandId}.json`, value = await storage.read(key), prior = value === null ? null : parseGitPreparation(value)
    const digest = canonicalDigest({ exchange, cwd, restore: options.restore ?? null })
    if (prior && prior.digest !== digest) fail("COMMAND_CONFLICT")
    const worktrees = async () => (await git(["worktree", "list", "--porcelain", "-z"], exchange.repository)).split("\0\0").map(block => Object.fromEntries(block.split("\0").filter(Boolean).map(line => { const offset = line.indexOf(" "); return [line.slice(0, offset), line.slice(offset + 1)] })))
    const matching = async () => (await worktrees()).find(tree => tree.worktree === cwd && tree.branch === "refs/heads/" + branch)
    const head = () => git(["rev-parse", "HEAD"], cwd)
    const verify = async () => {
      if (!await matching() || (await exists(cwd))?.isSymbolicLink() || await realpath(cwd) !== cwd || await git(["symbolic-ref", "--quiet", "HEAD"], cwd) !== "refs/heads/" + branch) fail("GIT_WORKTREE_CONFLICT")
      if (await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)) !== await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], exchange.repository))) fail("GIT_WORKTREE_CONFLICT")
    }
    if (options.restore) {
      const saved = parseGitPreparation(options.restore)
      const retained = await storage.read(`git-preparations/${saved.commandId}.json`)
      if (retained === null || !isDeepStrictEqual(parseGitPreparation(retained), saved)) fail("GIT_RESTORE_CONFLICT")
      if (saved.state !== "ready" || saved.cwd !== cwd || !isDeepStrictEqual(saved.exchange, exchange)) fail("GIT_RESTORE_CONFLICT")
      await verify()
      const restoreHead = await head()
      if (prior && prior.restoreHead !== restoreHead) fail("GIT_RESTORE_CONFLICT")
      const intent: GitPreparation = prior ?? { version: 1, commandId, exchange, digest, cwd, baseOid: exchange.baseOid, branch, restoreHead, state: "preparing" }
      await storage.publish(key, intent, prior)
      const ready: GitPreparation = { ...intent, state: "ready" }; await storage.publish(key, ready, intent); return ready
    }
    if (!prior) {
      if (await exists(cwd)) fail("GIT_PATH_EXISTS")
      const refs = await git(["for-each-ref", "--format=%(refname)", "refs/heads/" + branch], exchange.repository)
      if (refs.split("\n").includes("refs/heads/" + branch)) fail("GIT_BRANCH_EXISTS")
    }
    const intent: GitPreparation = prior ?? { version: 1, commandId, exchange, digest, cwd, baseOid: exchange.baseOid, branch, restoreHead: null, state: "preparing" }
    await storage.publish(key, intent, prior)
    if (await exists(cwd)) {
      await verify()
      if (await head() !== exchange.baseOid && intent.state !== "ready") fail("GIT_WORKTREE_CONFLICT")
    } else {
      if (await matching()) fail("GIT_WORKTREE_CONFLICT")
      await git(["fetch", "--no-tags", "--", exchange.remote, exchange.baseOid], exchange.repository)
      if (await git(["cat-file", "-t", exchange.baseOid], exchange.repository) !== "commit") fail("GIT_BASE_NOT_COMMIT")
      await mkdir(dirname(cwd), { recursive: true, mode: 0o700 })
      if (await realpath(dirname(cwd)) !== dirname(cwd)) fail("GIT_PATH_EXISTS")
      await git(["worktree", "add", "-b", branch, "--", cwd, exchange.baseOid], exchange.repository)
      await verify()
      if (await head() !== exchange.baseOid) fail("GIT_WORKTREE_CONFLICT")
    }
    const ready: GitPreparation = { ...intent, state: "ready" }; await storage.publish(key, ready, intent); return ready
  })
}
export const assignmentWorktreePath = (root: string, assignmentId: string, attemptId: string) => join(root, "worktrees", id(assignmentId), id(attemptId))