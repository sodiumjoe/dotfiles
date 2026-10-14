import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { absolutePath, keys, object, text } from "../catalog/types.js"

export type GitRunner = (args: string[], cwd: string) => Promise<string>
const execute = promisify(execFile)
export const nativeGit: GitRunner = async (args, cwd) => (await execute("git", args, { cwd, timeout: 60000, maxBuffer: 1048576, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":" } })).stdout.trim()
export function gitOid(raw: unknown): string { const value = text(raw); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("GIT_OBJECT_FORMAT"); return value }
export type WorktreeInput = { repository: string; cwd: string; branch: string; baseOid: string; remote?: string }
export type PreparedWorktree = { cwd: string; branch: string; baseOid: string }
export function parseWorktreeInput(raw: unknown): WorktreeInput {
  const value = object(raw); keys(value, ["repository", "cwd", "branch", "baseOid", ...(value.remote === undefined ? [] : ["remote"])])
  const branch = text(value.branch, 4096), remote = value.remote === undefined ? undefined : text(value.remote, 4096)
  if (!branch.startsWith("moon/") || remote?.startsWith("-")) throw new Error("GIT_INPUT_INVALID")
  return { repository: absolutePath(value.repository), cwd: absolutePath(value.cwd), branch, baseOid: gitOid(value.baseOid), ...(remote ? { remote } : {}) }
}
export function parsePreparedWorktree(raw: unknown): PreparedWorktree {
  const value = object(raw); keys(value, ["cwd", "branch", "baseOid"])
  const parsed = parseWorktreeInput({ repository: value.cwd, ...value })
  return { cwd: parsed.cwd, branch: parsed.branch, baseOid: parsed.baseOid }
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error } }
async function canonicalDestination(path: string): Promise<string> {
  if (await exists(path)) return realpath(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(await canonicalDestination(parent), path.slice(parent.length + (parent === "/" ? 0 : 1)))
}
export async function prepareWorktree(raw: WorktreeInput, dependencies: { git?: GitRunner; exists?: (path: string) => Promise<boolean>; mkdir?: typeof mkdir } = {}): Promise<PreparedWorktree> {
  const input = parseWorktreeInput(raw), git = dependencies.git ?? nativeGit, occupied = dependencies.exists ?? exists
  if (await realpath(input.repository) !== input.repository || await canonicalDestination(input.cwd) !== input.cwd || await git(["rev-parse", "--show-toplevel"], input.repository) !== input.repository) throw new Error("GIT_REPOSITORY_PATH")
  await git(["check-ref-format", "--branch", input.branch], input.repository)
  if (await occupied(input.cwd)) throw new Error("GIT_DESTINATION_OCCUPIED")
  let branchExists = false
  try { await git(["show-ref", "--verify", "--quiet", "refs/heads/" + input.branch], input.repository); branchExists = true } catch (error) { if ((error as { code?: unknown }).code !== 1) throw error }
  if (branchExists) throw new Error("GIT_BRANCH_OCCUPIED")
  if (input.remote) await git(["fetch", "--no-tags", "--", input.remote, input.baseOid], input.repository)
  if (await git(["cat-file", "-t", input.baseOid], input.repository) !== "commit") throw new Error("GIT_BASE_NOT_COMMIT")
  await (dependencies.mkdir ?? mkdir)(dirname(input.cwd), { recursive: true })
  await git(["worktree", "add", "-b", input.branch, "--", input.cwd, input.baseOid], input.repository)
  return { cwd: input.cwd, branch: input.branch, baseOid: input.baseOid }
}