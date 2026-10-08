import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat, realpath, access } from "node:fs/promises"
import { join } from "node:path"
import { absolutePath, keys, object, text } from "../catalog/types.js"
import { canonicalDigest, fail } from "../orchestration/types.js"

export type GitRunner = (args: string[], cwd: string) => Promise<string>
const execute = promisify(execFile)
export const nativeGit: GitRunner = async (args, cwd) => (await execute("git", args, { cwd, timeout: 60000, maxBuffer: 1048576, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":" } })).stdout.trim()
export type GitIdentity = { cwd: string; commonDir: string; gitDir: string; cwdIdentity: string; commonIdentity: string; gitIdentity: string; objectFormat: "sha1" | "sha256"; ref: string | null; head: string }
export function gitOid(value: unknown): string { const oid = text(value); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) fail("GIT_OBJECT_FORMAT"); return oid }
export function parseGitIdentity(raw: unknown): GitIdentity {
  const v = object(raw); keys(v, ["cwd", "commonDir", "gitDir", "cwdIdentity", "commonIdentity", "gitIdentity", "objectFormat", "ref", "head"])
  if (v.objectFormat !== "sha1" && v.objectFormat !== "sha256") fail("GIT_OBJECT_FORMAT")
  const result: GitIdentity = { cwd: absolutePath(v.cwd), commonDir: absolutePath(v.commonDir), gitDir: absolutePath(v.gitDir), cwdIdentity: text(v.cwdIdentity), commonIdentity: text(v.commonIdentity), gitIdentity: text(v.gitIdentity), objectFormat: v.objectFormat, ref: v.ref === null ? null : text(v.ref), head: gitOid(v.head) }
  if (result.head.length !== (result.objectFormat === "sha1" ? 40 : 64)) fail("GIT_OBJECT_FORMAT")
  return result
}
async function identity(path: string) { const stat = await lstat(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("GIT_PATH_REPLACED"); return stat.dev + ":" + stat.ino }
export async function captureGitIdentity(path: string, git: GitRunner = nativeGit): Promise<GitIdentity> {
  const cwd = absolutePath(path)
  if (await realpath(cwd) !== cwd || await git(["rev-parse", "--show-toplevel"], cwd) !== cwd) fail("GIT_REPOSITORY_PATH")
  const commonDir = await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)), gitDir = await realpath(await git(["rev-parse", "--absolute-git-dir"], cwd))
  let ref: string | null = null; try { ref = await git(["symbolic-ref", "--quiet", "HEAD"], cwd) } catch {}
  return parseGitIdentity({ cwd, commonDir, gitDir, cwdIdentity: await identity(cwd), commonIdentity: await identity(commonDir), gitIdentity: await identity(gitDir), objectFormat: await git(["rev-parse", "--show-object-format"], cwd), ref, head: await git(["rev-parse", "HEAD"], cwd) })
}
export function sameGitIdentity(a: GitIdentity, b: GitIdentity, includeHead = true) {
  return canonicalDigest(includeHead ? a : { ...a, head: null }) === canonicalDigest(includeHead ? b : { ...b, head: null })
}
export async function resolveGitRemote(remote: string, cwd: string, git: GitRunner = nativeGit): Promise<string> {
  remote = text(remote, 4096)
  if (remote.startsWith("-") || /[\x00-\x1f\x7f]/u.test(remote)) fail("GIT_REMOTE_INVALID")
  let url: string
  try { url = await git(["remote", "get-url", "--", remote], cwd) } catch { if (!/[/:]/.test(remote)) fail("GIT_REMOTE_INVALID"); url = remote }
  if (url.startsWith("ext::") || url.startsWith("-") || /[\x00-\x1f\x7f]/u.test(url)) fail("GIT_REMOTE_INVALID")
  return text(url, 4096)
}
export async function gitOperation(identity: GitIdentity): Promise<boolean> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
    try { await access(join(identity.gitDir, name)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return false
}