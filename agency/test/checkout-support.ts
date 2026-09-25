import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { assertGitChildrenClosed, resolveCheckout } from "../src/checkout/identity.js"
import { createAdmissionController, type AdmissionContext, type ReservationRequest } from "../src/checkout/admission.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { assertFixtureBatchHealthy, privateRoot } from "./control-support.js"

export const testHostId = "a".repeat(64)

export async function gitFixture(t: TestContext) {
  assertFixtureBatchHealthy()
  assertGitChildrenClosed()
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-checkout-"))
  const children = new Set<number>()
  let calls = 0, uncertain = false, removed = false
  const cleanupBarriers: Array<() => Promise<void>> = []
  const verifyCleanup = (): void => {
    assertFixtureBatchHealthy()
    assertGitChildrenClosed()
    assert.equal(uncertain, false, `unverified Git cleanup; retained ${root}`)
    assert.equal(children.size, 0, `Git children remain; retained ${root}`)
  }
  const cleanup = async (): Promise<void> => {
    if (removed) return
    for (const barrier of cleanupBarriers) await barrier()
    verifyCleanup()
    await rm(root, { recursive: true })
    removed = true
  }
  t.after(cleanup)
  const repo = join(root, "main repo"), linked = join(root, "linked"), alias = join(root, "alias"), nested = join(repo, "nested")
  const git = async (args: string[], cwd = root): Promise<string> => {
    assertFixtureBatchHealthy()
    assertGitChildrenClosed()
    assert.ok(++calls <= 16, "fixture Git invocation budget exceeded")
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", LC_ALL: "C" })
    return new Promise((resolve, reject) => {
      let result = "", failure: Error | null = null, exited = false
      const child = execFile("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 65536 }, (error, stdout) => { failure = error; result = stdout })
      if (child.pid !== undefined) children.add(child.pid)
      const timer = setTimeout(() => { uncertain = true; reject(new Error(`Git cleanup unavailable: ${child.pid}`)) }, 3000)
      child.once("exit", () => { exited = true })
      child.once("close", () => {
        clearTimeout(timer)
        if (child.pid !== undefined && !exited) { uncertain = true; reject(new Error("Git exit not observed")); return }
        if (child.pid !== undefined) children.delete(child.pid)
        if (failure) reject(failure); else resolve(result)
      })
    })
  }
  await mkdir(repo)
  await git(["init", "-q", repo])
  await git(["commit", "-q", "--allow-empty", "-m", "fixture"], repo)
  await git(["worktree", "add", "-q", "-b", "linked", linked], repo)
  await symlink(repo, alias)
  await mkdir(nested)
  await git(["init", "-q", nested])
  const beforeCleanup = (verify: () => Promise<void>): void => { cleanupBarriers.push(verify) }
  return { root, repo, linked, alias, nested, git, cleanup, verifyCleanup, beforeCleanup }
}

export async function admissionFixture(t: TestContext) {
  const root = await privateRoot(t), git = await gitFixture(t), checkout = await resolveCheckout(git.repo, testHostId), generation = randomUUID()
  await mkdir(join(root, "launches"), { mode: 0o700 })
  await mkdir(join(root, "admissions"), { mode: 0o700 })
  const forbidden = async (): Promise<never> => { throw new Error("unauthorized process observation or signal") }
  const context: AdmissionContext = {
    paths: { hostKey: testHostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") },
    adapter: { platform: "linux", bootId: async () => "boot-a", readProcess: forbidden, readGroup: forbidden, signalGroup: forbidden },
    state: { hostId: testHostId, handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] },
    mutations: { queue: new MutationQueue(), accepted: [], unavailable: null },
    shutdownPending: () => false,
  }
  const request = (): ReservationRequest => ({ checkout: structuredClone(checkout), handlerGeneration: generation, agentId: randomUUID(), leaseId: randomUUID(), launchAttemptId: randomUUID() })
  return { root, git, context, checkout, controller: createAdmissionController(context), request }
}