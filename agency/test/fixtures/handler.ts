import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { agencyLaunchMarker } from "../../src/platform/launch-marker.js"
import { writeLaunchRecord } from "../../src/platform/private-state.js"
import { RUNTIME_RECORD_VERSION, type LaunchPhase, type LaunchRecord, type ProcessIdentity } from "../../src/platform/types.js"

type ProviderMode = "normal" | "leader-exits-on-term"
type CrashPhase = "before-spawn" | "after-attempt" | "identity-published" | "readiness" | "active"

type Config = {
  phase: CrashPhase
  recordPath: string
  providerReadyPath: string
  providerMode: ProviderMode
  timeoutMs: number
}

const providerFixture = fileURLToPath(new URL("./provider-tree.js", import.meta.url))
const adapter = createDarwinAdapter()

async function withPrivateUmask<T>(create: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077)
  try {
    return await create()
  } finally {
    process.umask(previous)
  }
}

async function writePrivateLaunchRecord(path: string, value: LaunchRecord): Promise<void> {
  await withPrivateUmask(() => writeLaunchRecord(path, value))
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function waitFor<T>(read: () => Promise<T | null>, message: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    let value: T | null
    try {
      value = await read()
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "DarwinObservationUnavailable") throw error
      value = null
    }
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function phase(value: CrashPhase): LaunchPhase {
  if (value === "readiness" || value === "active") return value
  return "launch_pending"
}

function assertProviderIdentity(leader: ProcessIdentity, members: ProcessIdentity[], marker: string, childPid: number): void {
  const separator = leader.birth.indexOf(":")
  if (leader.pid !== childPid || leader.processGroupId !== leader.pid || leader.sessionId !== leader.pid) throw new Error("provider leader does not own its pid, group, and derived session")
  if (separator <= 0 || leader.birth.slice(separator + 1) !== marker) throw new Error("provider leader marker is not exact")
  if (leader.uid !== process.getuid!() || leader.gid !== process.getgid!()) throw new Error("provider leader owner is not exact")
  if (!members.some(member => member.pid === leader.pid && member.birth === leader.birth)) throw new Error("provider group omits its leader")
  if (members.some(member => member.bootId !== leader.bootId || member.processGroupId !== leader.processGroupId || member.sessionId !== leader.sessionId || member.uid !== leader.uid || member.gid !== leader.gid)) throw new Error("provider group identity is inconsistent")
}

function record(config: Config, launchAttemptId: string, bootId: string, changes: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    checkoutId: `checkout-${launchAttemptId}`,
    leaseId: `lease-${launchAttemptId}`,
    agentId: `agent-${launchAttemptId}`,
    handlerGeneration: `handler-${launchAttemptId}`,
    launchAttemptId,
    launchBootId: bootId,
    launchAttempted: false,
    phase: "launch_pending",
    provider: null,
    reason: null,
    ...changes,
  }
}

async function emit(config: Config, handler: ProcessIdentity, provider: { leader: ProcessIdentity; members: ProcessIdentity[] } | null): Promise<never> {
  process.stdout.write(`${JSON.stringify({ type: "phase", phase: config.phase, handler, provider })}\n`)
  setInterval(() => undefined, 1000)
  return new Promise(() => undefined)
}

if (process.argv.length !== 3) throw new Error("usage: handler <config>")
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Config
if (!["before-spawn", "after-attempt", "identity-published", "readiness", "active"].includes(config.phase)) throw new Error("handler phase is invalid")
if (config.providerMode !== "normal" && config.providerMode !== "leader-exits-on-term") throw new Error("handler provider mode is invalid")
if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("handler timeout is invalid")
const handler = await waitFor(() => adapter.readProcess(process.pid), "Handler identity was not observable", config.timeoutMs)
const bootId = await adapter.bootId()
const launchAttemptId = randomUUID()
const pending = record(config, launchAttemptId, bootId)
await writePrivateLaunchRecord(config.recordPath, pending)
if (config.phase === "before-spawn") await emit(config, handler, null)
const attempted = { ...pending, launchAttempted: true }
await writePrivateLaunchRecord(config.recordPath, attempted)
const marker = agencyLaunchMarker("provider", launchAttemptId)
const child = spawn(process.execPath, [providerFixture, "leader", config.providerReadyPath, config.providerMode, String(config.timeoutMs)], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "ignore", 3, 4] })
if (child.pid === undefined) throw new Error("provider leader pid is unavailable")
const structural = await waitFor(async () => await exists(config.providerReadyPath) ? JSON.parse(await readFile(config.providerReadyPath, "utf8")) as { leaderPid: number; descendantPid: number } : null, "provider structural pids were not published", config.timeoutMs)
if (structural.leaderPid !== child.pid) throw new Error("provider leader pid changed")
const leader = await waitFor(() => adapter.readProcess(child.pid!), "provider leader was not observable", config.timeoutMs)
const members = await waitFor(async () => {
  const current = await adapter.readGroup(leader.processGroupId)
  return current.some(member => member.pid === structural.descendantPid) ? current : null
}, "provider descendant was not observable", config.timeoutMs)
assertProviderIdentity(leader, members, marker, child.pid)
if (config.phase === "after-attempt") await emit(config, handler, { leader, members })
const provider = { kind: "process-group" as const, group: { leader, observed: members } }
await writePrivateLaunchRecord(config.recordPath, record(config, launchAttemptId, bootId, { launchAttempted: true, phase: phase(config.phase), provider }))
await emit(config, handler, { leader, members })