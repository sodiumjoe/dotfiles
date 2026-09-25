import { execFile, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"

export type DirectoryIdentity = { path: string; device: string; inode: string }
export type CheckoutIdentity = { version: 1; checkoutId: string; hostId: string; root: DirectoryIdentity; commonDirectory: DirectoryIdentity; gitDirectory: DirectoryIdentity; ancestors: DirectoryIdentity[] }
export type IdentityOptions = { gitExecutable?: string; env?: NodeJS.ProcessEnv }
type ChildEvidence = { pid: number | null; exited: boolean; closed: boolean; signal: NodeJS.Signals | null }
type GitObservation = { evidence: ChildEvidence; terminal: Promise<void> }

export class CheckoutResolutionError extends Error {
  constructor(readonly code: "NOT_CHECKOUT" | "UNSUPPORTED_CHECKOUT" | "IDENTITY_UNAVAILABLE" | "IDENTITY_CHANGED", message: string, readonly child?: ChildEvidence) { super(message) }
}

export function observeGitChild(child: ChildProcess): GitObservation {
  const evidence: ChildEvidence = { pid: child.pid ?? null, exited: false, closed: false, signal: null }
  let failedSpawn = false
  const terminal = new Promise<void>(resolve => {
    child.once("error", () => { failedSpawn = child.pid === undefined })
    child.once("exit", (_code, signal) => { evidence.exited = true; evidence.signal = signal })
    child.once("close", () => { evidence.closed = evidence.exited || failedSpawn; resolve() })
  })
  const observation = { evidence, terminal }
  uncertainChildren.add(observation)
  return observation
}

export async function verifyGitExit(observation: GitObservation, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([observation.terminal, new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "Git cleanup unverified", { ...observation.evidence })), timeoutMs)
    })])
    if (!observation.evidence.closed) throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "Git cleanup unverified", { ...observation.evidence })
    uncertainChildren.delete(observation)
  } finally { clearTimeout(timer) }
}

const uncertainChildren = new Set<GitObservation>()

export function assertGitChildrenClosed(): void {
  const pending = uncertainChildren.values().next().value
  if (pending !== undefined) throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "previous Git cleanup unverified", { ...pending.evidence })
}

function cleanEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith("GIT_")))
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" }
}

function checkPath(path: string): void {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new CheckoutResolutionError("UNSUPPORTED_CHECKOUT", "unsupported checkout path")
}

async function gitValue(cwd: string, args: string[], options: IdentityOptions, deadline: number): Promise<string> {
  assertGitChildrenClosed()
  const timeout = Math.min(2000, deadline - Date.now() - 1000)
  if (timeout <= 0) throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "checkout resolution deadline exceeded")
  const executable = options.gitExecutable ?? "/usr/bin/git"
  checkPath(executable)
  let result: { error: Error | null; stdout: Buffer; stderr: Buffer } | undefined
  const child = execFile(executable, ["rev-parse", ...args], { cwd, env: cleanEnvironment(options.env ?? process.env), encoding: "buffer", timeout, killSignal: "SIGKILL", maxBuffer: 65536 }, (error, stdout, stderr) => { result = { error, stdout, stderr } })
  const observation = observeGitChild(child)
  await verifyGitExit(observation, timeout + 1000)
  if (result === undefined) throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "Git result unavailable", { ...observation.evidence })
  if (result.error !== null) {
    const notGit = result.stderr.toString("utf8").includes("not a git repository")
    throw new CheckoutResolutionError(notGit ? "NOT_CHECKOUT" : "IDENTITY_UNAVAILABLE", notGit ? "cwd is not a Git checkout" : "Git identity command failed", { ...observation.evidence })
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
    if (!text.endsWith("\n")) throw new Error("missing output terminator")
    const value = text.slice(0, -1)
    if (value.length === 0 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid Git output")
    return value
  } catch { throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "invalid Git identity output", { ...observation.evidence }) }
}

async function directory(path: string): Promise<DirectoryIdentity> {
  checkPath(path)
  const canonical = await realpath(path)
  checkPath(canonical)
  const metadata = await stat(canonical, { bigint: true })
  if (!metadata.isDirectory()) throw new CheckoutResolutionError("UNSUPPORTED_CHECKOUT", "checkout identity is not a directory")
  return { path: canonical, device: metadata.dev.toString(), inode: metadata.ino.toString() }
}

export function checkoutIdFor(hostId: string, root: DirectoryIdentity, gitDirectory: DirectoryIdentity): string {
  const tuple = [1, hostId, root.device, root.inode, gitDirectory.device, gitDirectory.inode]
  return "checkout-v1:" + createHash("sha256").update(JSON.stringify(tuple)).digest("hex")
}

export async function resolveCheckout(cwd: string, hostId: string, options: IdentityOptions = {}): Promise<CheckoutIdentity> {
  if (!/^[0-9a-f]{64}$/.test(hostId)) throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "invalid host identity")
  checkPath(cwd)
  const deadline = Date.now() + 5000
  try {
    const canonical = await directory(cwd)
    const snapshot = async (): Promise<CheckoutIdentity> => {
      const bare = await gitValue(canonical.path, ["--is-bare-repository"], options, deadline)
      if (bare === "true") throw new CheckoutResolutionError("UNSUPPORTED_CHECKOUT", "bare repositories cannot be leased")
      if (bare !== "false") throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "invalid bare-repository observation")
      const root = await directory(await gitValue(canonical.path, ["--show-toplevel"], options, deadline))
      const gitDirectory = await directory(await gitValue(canonical.path, ["--absolute-git-dir"], options, deadline))
      const commonDirectory = await directory(await gitValue(canonical.path, ["--path-format=absolute", "--git-common-dir"], options, deadline))
      const ancestors: DirectoryIdentity[] = []
      let parent = dirname(root.path)
      if (parent !== root.path) {
        while (true) {
          if (ancestors.length >= 256) throw new CheckoutResolutionError("UNSUPPORTED_CHECKOUT", "checkout ancestry exceeds limit")
          ancestors.push(await directory(parent))
          if (parent === dirname(parent)) break
          parent = dirname(parent)
        }
      }
      return { version: 1, checkoutId: checkoutIdFor(hostId, root, gitDirectory), hostId, root, commonDirectory, gitDirectory, ancestors }
    }
    const first = await snapshot(), second = await snapshot()
    if (!isDeepStrictEqual(first, second) || !isDeepStrictEqual(canonical, await directory(cwd))) throw new CheckoutResolutionError("IDENTITY_CHANGED", "checkout identity changed during observation")
    if (Date.now() > deadline) throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "checkout resolution deadline exceeded")
    return first
  } catch (error) {
    if (error instanceof CheckoutResolutionError) throw error
    throw new CheckoutResolutionError("IDENTITY_UNAVAILABLE", "checkout filesystem identity unavailable")
  }
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode }
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
}

export function checkoutsOverlap(left: CheckoutIdentity, right: CheckoutIdentity): boolean {
  return left.hostId === right.hostId && (
    sameDirectory(left.root, right.root) || sameDirectory(left.gitDirectory, right.gitDirectory)
    || left.gitDirectory.path === right.gitDirectory.path
    || contains(left.root.path, right.root.path) || contains(right.root.path, left.root.path)
    || left.ancestors.some(parent => sameDirectory(parent, right.root))
    || right.ancestors.some(parent => sameDirectory(parent, left.root))
  )
}