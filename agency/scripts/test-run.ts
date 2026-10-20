import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createNativeFixtureScope, nativeFixtureAccess } from "../test/fixtures/run-scope.js"
import type { TestGroup } from "./test-groups.js"
import type { FixtureResult } from "../test/fixtures/run-scope.js"
export type TestRunResult = {
  version: 1; runId: string; revision: string; group: TestGroup
  command: string[]; state: "running" | "passed" | "failed" | "incomplete"
  exitCode: number | null; workers: FixtureResult[]
  failures: string[]; unresolved: string[]; artifacts: string[]
}
export type TestRunOptions = {
  group: TestGroup; command: string[]; workerFiles: string[]; cwd: string; revision: string
  evidenceParent?: string; timeoutMs?: number; closeMs?: number
  env?: NodeJS.ProcessEnv; stdio?: "inherit" | "ignore"
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function fixture(value: any, runId: string, workerFile: string): value is FixtureResult {
  return value?.version === 1 && value.runId === runId && value.workerFile === workerFile
    && ["settled", "incomplete"].includes(value.state) && Array.isArray(value.launches)
    && Array.isArray(value.operations) && Array.isArray(value.failures) && value.failures.every((s: unknown) => typeof s === "string")
    && Array.isArray(value.artifacts) && value.artifacts.every((s: unknown) => typeof s === "string")
    && new Set(value.launches.map((l: any) => l?.ref?.launchId)).size === value.launches.length
    && value.launches.every((l: any) => l?.ref?.runId === runId && typeof l.ref.launchId === "string"
      && typeof l.role === "string" && typeof l.ownerId === "string"
      && (l.pid === null || Number.isSafeInteger(l.pid) && l.pid > 0)
      && (l.error === null || typeof l.error === "string")
      && (l.identity === null || l.identity?.pid === l.pid && typeof l.identity.bootId === "string" && typeof l.identity.birth === "string")
      && (l.exit === null || (Number.isSafeInteger(l.exit?.code) && l.exit.signal === null || l.exit?.code === null && typeof l.exit.signal === "string"))
      && [null, true, false].includes(l.close) && [null, true, false].includes(l.absent)
      && ["direct", "detached-handler", "editor-endpoint", "editor-control"].includes(l.reporting)
      && [null, "launcher-finished", "prepared-owner-exit", "editor-handle-closed", "editor-api-completion"].includes(l.unavailable))
    && value.operations.every((o: any) => typeof o?.label === "string" && ["fulfilled", "rejected", "pending"].includes(o.state) && (o.error === null || typeof o.error === "string"))
}
async function collect(root: string, expected: string[], result: TestRunResult): Promise<void> {
  const seen = new Set<string>()
  const files = await readdir(join(root, "workers")).catch(error => {
    if (error.code !== "ENOENT") result.unresolved.push("worker directory: " + message(error))
    return []
  })
  for (const file of files) {
    try {
      const b = JSON.parse(await readFile(join(root, "workers", file), "utf8"))
      if (b.version !== 1 || b.runId !== result.runId || b.revision !== result.revision
        || !expected.includes(b.workerFile) || !Number.isSafeInteger(b.pid) || b.pid <= 0
        || file !== b.pid + ".json" || !fixture(b.result, result.runId, b.workerFile)) throw new Error("foreign or malformed worker boundary")
      if (seen.has(b.workerFile)) throw new Error("duplicate worker boundary")
      seen.add(b.workerFile)
      result.workers.push(b.result)
      result.artifacts.push(...b.result.artifacts)
      if (b.result.state !== "settled" || b.result.failures.length || b.result.operations.some((o: any) => o.state === "pending")
        || b.result.launches.some((l: any) => l.absent !== true || l.unavailable === null && (l.close !== true && !(l.pid === null && l.error) || l.exit === null && !(l.pid === null && l.error)))) {
        result.unresolved.push(b.workerFile + ": " + (b.result.failures.join("; ") || "unsettled fixture evidence"))
      }
    } catch (error) { result.unresolved.push(file + ": " + message(error)) }
  }
  for (const file of expected) if (!seen.has(file)) result.unresolved.push("missing worker boundary: " + file)
  result.artifacts = [...new Set(result.artifacts)]
}
export async function runTests(input: TestRunOptions): Promise<{ root: string; result: TestRunResult; code: number }> {
  const parent = resolve(input.evidenceParent ?? tmpdir())
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, "run-")), resultPath = join(root, "result.json")
  const result: TestRunResult = { version: 1, runId: randomUUID(), revision: input.revision, group: input.group,
    command: [...input.command], state: "running", exitCode: null, workers: [], failures: [], unresolved: [], artifacts: [root] }
  const persist = () => writeFile(resultPath, JSON.stringify(result), { mode: 0o600 })
  let expected: string[] = [], timedOut = false, acceptingOutcome = true
  try {
    await persist()
    expected = await Promise.all(input.workerFiles.map(file => realpath(resolve(input.cwd, file))))
    if (!expected.length || new Set(expected).size !== expected.length) throw new Error("Invalid selected workers")
    const env = { ...input.env ?? process.env, AGENCY_TEST_WORKER_RUN: JSON.stringify({ runId: result.runId, workerFiles: expected, runRoot: root, revision: result.revision }) }
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT
    delete (env as NodeJS.ProcessEnv).AGENCY_FIXTURE_CONNECTION
    const closeMs = input.closeMs ?? 15000, scope = createNativeFixtureScope({ runId: result.runId, workerFile: "test-controller", deadlineMs: closeMs })
    const ref = scope.intent("test-controller"), closed = Promise.withResolvers<boolean>()
    let timer: NodeJS.Timeout | undefined
    try {
      const watchdog = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), input.timeoutMs ?? 30 * 60 * 1000) })
      const child = scope.spawn(ref, () => spawn(input.command[0]!, input.command.slice(1), { cwd: input.cwd, env, stdio: input.stdio ?? "inherit" }), { closeAdmission() {} })
      let spawnFailed = false
      child.once("error", error => { spawnFailed = true; if (acceptingOutcome) result.failures.push("controller spawn: " + message(error)) })
      child.once("close", (code, signal) => {
        if (acceptingOutcome) {
          result.exitCode = spawnFailed ? null : code
          if (code !== 0 || signal) result.failures.push("controller exit: " + String(code) + (signal ? " " + signal : ""))
        }
        closed.resolve(true)
      })
      if (!await Promise.race([closed.promise, watchdog])) {
        timedOut = true
        result.unresolved.push("group watchdog expired")
        await nativeFixtureAccess(scope).signalPid(ref, "SIGTERM").catch(error => result.unresolved.push("controller cancellation: " + message(error)))
        let closeTimer: NodeJS.Timeout | undefined
        try {
          if (!await Promise.race([closed.promise, new Promise<false>(resolve => { closeTimer = setTimeout(() => resolve(false), closeMs) })])) {
            result.unresolved.push("controller close deadline")
            child.unref()
          }
        } finally { clearTimeout(closeTimer) }
      }
    } finally {
      clearTimeout(timer)
      const boundary = await scope.finish()
      if (boundary.state !== "settled") result.unresolved.push(...boundary.failures.map(reason => "controller: " + reason))
    }
  } catch (error) { result.unresolved.push("run setup: " + message(error)) }
  acceptingOutcome = false
  await collect(root, expected, result)
  if (result.exitCode === null && !result.failures.length) result.failures.push("controller has no exit status")
  result.state = result.unresolved.length || timedOut ? "incomplete" : result.failures.length || result.exitCode !== 0 ? "failed" : "passed"
  try { await persist() }
  catch (error) { result.state = "incomplete"; result.unresolved.push("result final write: " + message(error)) }
  const code = result.exitCode !== null && result.exitCode !== 0 ? result.exitCode : result.state === "passed" ? 0 : 1
  return { root, result, code }
}