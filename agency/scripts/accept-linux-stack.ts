import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, open, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { captureBuildManifest, verifyBuildManifest } from "./build-manifest.js"
import { assertPrivateDirectory } from "../src/platform/private-state.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { sameProcess, type ProcessIdentity } from "../src/platform/types.js"

export const LINUX_STACK_CASES = ["root-tools-report-wait", "notification-admission", "headless-permission", "shared-observers-detach-cancel", "handler-reconcile-restore", "editor-replacement"] as const
export type LinuxStackInput = { revision: string; nodePath: string; fixtureRoot: string; evidenceRoot: string; scenario: "deterministic" | "live" }
type Provenance = { revision: string; dirty: boolean; sourceDigest: string; distDigest: string; verified: boolean }
type Case = { name: string; passed: boolean; skipped: boolean }
type Execution = { exitCode: number; cases: Case[]; owned: ProcessIdentity[]; cleanupVerified: boolean }
export type LinuxStackDependencies = {
  platform: string
  runtime(path: string): Promise<string>
  provenance(): Promise<Provenance>
  execute(input: LinuxStackInput & { runDirectory: string }): Promise<Execution>
  observe(identity: ProcessIdentity): Promise<ProcessIdentity | null>
  group(id: number): Promise<ProcessIdentity[]>
}
export type LinuxStackReport = { protocol: "agency-linux-stack/1"; scope: LinuxStackInput["scenario"]; nodeVersion: string | null; provenance: Provenance; cases: Case[]; owned: ProcessIdentity[]; survivors: Array<{ identity: ProcessIdentity; reason: string }>; cleanupVerified: boolean; success: boolean; failure: string | null; reportPath: string }
const execute = promisify(execFile)
function path(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f]/u.test(value)) throw new Error("INVALID_ACCEPTANCE_PATH")
  return value
}
export function parseLinuxAcceptanceArgs(argv: string[]): LinuxStackInput {
  const values = new Map<string, string>(), allowed = ["--revision", "--node", "--fixtures", "--evidence", "--scenario"]
  for (let n = 0; n < argv.length; n += 2) {
    const key = argv[n]!, value = argv[n + 1]
    if (!allowed.includes(key) || values.has(key) || value === undefined) throw new Error("INVALID_ACCEPTANCE_ARGUMENT")
    values.set(key, value)
  }
  if (values.size !== allowed.length || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(values.get("--revision")!) || !["deterministic", "live"].includes(values.get("--scenario")!)) throw new Error("INVALID_ACCEPTANCE_ARGUMENT")
  return { revision: values.get("--revision")!, nodePath: path(values.get("--node")!), fixtureRoot: path(values.get("--fixtures")!), evidenceRoot: path(values.get("--evidence")!), scenario: values.get("--scenario") as LinuxStackInput["scenario"] }
}
async function publish(report: LinuxStackReport): Promise<void> {
  const handle = await open(report.reportPath, "wx", 0o600)
  try { await handle.writeFile(JSON.stringify(report)); await handle.sync() } finally { await handle.close() }
}
function processIdentity(value: unknown): value is ProcessIdentity {
  if (value === null || typeof value !== "object") return false
  const identity = value as ProcessIdentity
  return typeof identity.bootId === "string" && identity.bootId.length > 0 && typeof identity.birth === "string" && identity.birth.length > 0 && Number.isSafeInteger(identity.pid) && identity.pid > 1 && [identity.parentPid, identity.processGroupId, identity.sessionId, identity.uid, identity.gid].every(number => Number.isSafeInteger(number) && number >= 0)
}
async function ownershipEvidence(directory: string): Promise<{ exists: boolean; complete: boolean; owned: ProcessIdentity[] }> {
  const ledger = await readFile(join(directory, "ownership.jsonl"), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error })
  const owned: ProcessIdentity[] = [], launches = new Map<string, { role: string; pid?: number | null; state: string }>()
  if (ledger === null) return { exists: false, complete: false, owned }
  let malformed = false
  for (const line of ledger.split("\n").filter(Boolean)) {
    let value: any
    try { value = JSON.parse(line) } catch { malformed = true; continue }
    if (!value || typeof value !== "object" || typeof value.role !== "string") { malformed = true; continue }
    const launch = launches.get(value.launchId)
    if (value.type === "intent") {
      if (typeof value.launchId !== "string" || launches.has(value.launchId)) malformed = true
      else launches.set(value.launchId, { role: value.role, state: "intent" })
    } else if (value.type === "spawn") {
      if (!launch || launch.role !== value.role || launch.state !== "intent" || !(value.pid === null || Number.isSafeInteger(value.pid) && value.pid > 1)) malformed = true
      else { launch.pid = value.pid; launch.state = "spawn" }
    } else if (value.type === "identity" || value.type === "observed") {
      if (!processIdentity(value.identity)) { malformed = true; continue }
      if (!owned.some(previous => sameProcess(previous, value.identity))) owned.push(value.identity)
      if (value.type === "identity") {
        if (!launch || launch.role !== value.role || launch.state !== "spawn" || launch.pid !== value.identity.pid) malformed = true
        else launch.state = "observed"
      }
    } else if (value.type === "no-process") {
      if (!launch || launch.role !== value.role || launch.state !== "spawn" || launch.pid !== null) malformed = true
      else launch.state = "none"
    } else malformed = true
  }
  return { exists: true, complete: !malformed && launches.size > 0 && [...launches.values()].every(value => value.state === "observed" || value.state === "none"), owned }
}
export async function runLinuxAcceptance(input: LinuxStackInput, deps: LinuxStackDependencies = linuxStackDependencies()): Promise<LinuxStackReport> {
  input = parseLinuxAcceptanceArgs(["--revision", input.revision, "--node", input.nodePath, "--fixtures", input.fixtureRoot, "--evidence", input.evidenceRoot, "--scenario", input.scenario])
  for (const directory of [input.fixtureRoot, input.evidenceRoot]) {
    await assertPrivateDirectory(directory)
    if (await realpath(directory) !== directory) throw new Error("INVALID_ACCEPTANCE_PATH")
  }
  if (Buffer.byteLength(input.fixtureRoot) > 37) throw new Error("INVALID_ACCEPTANCE_SOCKET_PATH")
  if (input.fixtureRoot === input.evidenceRoot || input.fixtureRoot.startsWith(input.evidenceRoot + "/") || input.evidenceRoot.startsWith(input.fixtureRoot + "/")) throw new Error("INVALID_ACCEPTANCE_PATH")
  const runDirectory = join(input.evidenceRoot, "linux-stack-" + randomUUID())
  await mkdir(runDirectory, { mode: 0o700 })
  const report: LinuxStackReport = { protocol: "agency-linux-stack/1", scope: input.scenario, nodeVersion: null, provenance: { revision: "", dirty: true, sourceDigest: "", distDigest: "", verified: false }, cases: [], owned: [], survivors: [], cleanupVerified: false, success: false, failure: null, reportPath: join(runDirectory, "report.json") }
  let admitted = false
  try {
    if (deps.platform !== "linux") throw new Error("LINUX_REQUIRED")
    report.nodeVersion = await deps.runtime(input.nodePath)
    if (report.nodeVersion !== "v24.13.0") throw new Error("NODE_VERSION")
    report.provenance = await deps.provenance()
    if (!report.provenance.verified) throw new Error("MIXED_BUILD")
    if (report.provenance.revision !== input.revision) throw new Error("REVISION_MISMATCH")
    if (input.scenario === "live") throw new Error("LIVE_CONFIG_REQUIRED")
    admitted = true
    let result: Execution | undefined, executionFailure: unknown
    try { result = await deps.execute({ ...input, runDirectory }) } catch (error) { executionFailure = error }
    report.cases = result?.cases ?? []; report.owned = result?.owned ?? []; report.cleanupVerified = result?.cleanupVerified === true
    try {
      const evidence = await ownershipEvidence(runDirectory)
      for (const identity of evidence.owned) if (!report.owned.some(previous => sameProcess(previous, identity))) report.owned.push(identity)
      if (evidence.exists && !evidence.complete) report.cleanupVerified = false
    } catch (error) { report.cleanupVerified = false; executionFailure ??= error }
    for (const identity of report.owned) {
      try {
        for (let pass = 0; pass < 2; pass++) {
          const current = await deps.observe(identity)
          if (current !== null && sameProcess(identity, current)) throw new Error("OWNED_PROCESS_SURVIVED")
          if (identity.pid === identity.processGroupId && (await deps.group(identity.processGroupId)).length > 0) throw new Error("OWNED_GROUP_SURVIVED")
        }
      } catch (error) { report.survivors.push({ identity, reason: String(error) }) }
    }
    if (report.survivors.length) report.cleanupVerified = false
    if (executionFailure) throw executionFailure
    if (report.survivors.length) throw new Error("CLEANUP_UNVERIFIED")
    if (!report.cleanupVerified || report.owned.length === 0) throw new Error("MISSING_CLEANUP_EVIDENCE")
    if (!result || result.exitCode !== 0 || result.cases.length !== LINUX_STACK_CASES.length || LINUX_STACK_CASES.some(name => result.cases.filter(value => value.name === name && value.passed && !value.skipped).length !== 1)) throw new Error("CASES_FAILED")
    const after = await deps.provenance()
    if (!after.verified || JSON.stringify(after) !== JSON.stringify(report.provenance)) throw new Error("BUILD_CHANGED_DURING_RUN")
    report.success = true
  } catch (error) {
    report.failure = String(error)
    await publish(report)
    if (!admitted) throw error
    return report
  }
  await publish(report)
  return report
}
export function linuxStackDependencies(): LinuxStackDependencies {
  const root = fileURLToPath(new URL("../../", import.meta.url)), adapter = createLinuxAdapter()
  return {
    platform: process.platform,
    async runtime(nodePath) { return (await execute(nodePath, ["--version"], { timeout: 5000 })).stdout.trim() },
    async provenance() {
      const manifest = await captureBuildManifest(root)
      const revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()
      const status = (await execute("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], { cwd: root })).stdout.trim()
      return { revision, dirty: status.length > 0, sourceDigest: manifest.sourceDigest, distDigest: manifest.distDigest, verified: await verifyBuildManifest(root) }
    },
    observe: identity => adapter.readProcess(identity.pid), group: id => adapter.readGroup(id),
    async execute(input) {
      const logPath = join(input.runDirectory, "tests.tap"), cases: Case[] = [], cleaned = new Set<string>()
      let partial = "", records: Promise<unknown> = Promise.resolve(), malformed = false
      const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT
      const child = spawn(input.nodePath, ["--test", "--test-reporter=tap", "--test-concurrency=1", "dist/test/linux-stack.test.js"], { cwd: root, env: { ...environment, AGENCY_LINUX_STACK_CASES: "1", AGENCY_TEST_FIXTURE_ROOT: input.fixtureRoot, AGENCY_TEST_EVIDENCE_ROOT: input.runDirectory, AGENCY_TEST_OWNERSHIP_MODULE: fileURLToPath(new URL("../test/fixtures/ownership.js", import.meta.url)) }, stdio: ["ignore", "pipe", "pipe"] })
      const consume = (chunk: Buffer): void => {
        const bytes = chunk.toString(); records = records.then(() => appendFile(logPath, bytes, { mode: 0o600 }))
        partial += bytes
        if (partial.length > 8 * 1024 * 1024) { malformed = true; partial = ""; return }
        let newline: number
        while ((newline = partial.indexOf("\n")) !== -1) {
          const line = partial.slice(0, newline); partial = partial.slice(newline + 1)
          const match = /^(not ok|ok) \d+ - (.*)$/.exec(line)
          if (match && LINUX_STACK_CASES.includes(match[2] as typeof LINUX_STACK_CASES[number])) cases.push({ name: match[2]!, passed: match[1] === "ok", skipped: /# SKIP|# TODO/.test(line) })
          const prefix = "agy-linux-case-evidence:", index = line.indexOf(prefix)
          if (index >= 0) {
            try { const value = JSON.parse(line.slice(index + prefix.length)); if (value.cleanupVerified === true) cleaned.add(value.name) } catch { malformed = true }
          }
        }
      }
      child.stdout.on("data", consume); child.stderr.on("data", consume)
      const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve(signal ? 1 : code ?? 1)) })
      await records
      const evidence = await ownershipEvidence(input.runDirectory)
      return { exitCode, cases, owned: evidence.owned, cleanupVerified: !malformed && evidence.complete && LINUX_STACK_CASES.every(name => cleaned.has(name)) }
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runLinuxAcceptance(parseLinuxAcceptanceArgs(process.argv.slice(2)))
  process.stdout.write(JSON.stringify(report) + "\n")
  process.exitCode = report.success ? 0 : 1
}