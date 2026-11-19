import { execFile } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_ROOTS = ["/pay/src", "/pay/src/*", "$HOME/stripe/*", "$HOME/.dotfiles"]

export function gitEnvironment(): NodeJS.ProcessEnv { return { ...process.env, GIT_TERMINAL_PROMPT: "0" } }

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, env: gitEnvironment(), timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr).trim().split("\n").at(-1) || error.message)); else resolve(String(stdout).trim())
  }))
}

export function normalizeRemote(url: string): string {
  let value = url.trim().replace(/\/+$/, "").replace(/\.git$/, "")
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(value)
  if (scp) return scp[1] + "/" + scp[2]
  value = value.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "")
  return value
}

export async function findCheckout(remote: string, roots: string[]): Promise<string | null> {
  const expand = (root: string) => root.replace("$HOME", homedir())
  const candidates: string[] = []
  for (const root of roots.map(expand)) {
    if (!root.endsWith("/*")) { candidates.push(root); continue }
    const parent = root.slice(0, -2)
    try { for (const name of (await readdir(parent)).sort()) candidates.push(join(parent, name)) } catch {}
  }
  for (const dir of candidates) {
    if (!await stat(join(dir, ".git")).then(() => true, () => false)) continue
    const url = await git(dir, ["remote", "get-url", "origin"]).catch(() => null)
    if (url && normalizeRemote(url) === remote) return dir
  }
  return null
}

export async function prepareCheckout(dir: string, ref: string, label: string): Promise<{ stashed: boolean }> {
  if (!ref || ref.startsWith("-") || ref.includes("..") || !/^[A-Za-z0-9._\/@^~{}-]+$/.test(ref)) throw new Error("invalid ref: " + ref)
  try { await git(dir, ["fetch", "--quiet", "origin", ref]) } catch (error) { throw new Error("fetch failed: " + (error as Error).message) }
  let stashed = false
  try {
    if (await git(dir, ["status", "--porcelain"])) { await git(dir, ["stash", "push", "--include-untracked", "--message", label]); stashed = true }
    await git(dir, ["checkout", "--quiet", "--detach", "FETCH_HEAD"])
  } catch (error) { throw new Error("checkout failed: " + (error as Error).message + (stashed ? " (local changes were stashed as \"" + label + "\")" : "")) }
  return { stashed }
}