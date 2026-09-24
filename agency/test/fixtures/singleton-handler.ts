import { appendFile, lstat, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { Socket } from "node:net"
import { basename, dirname, join } from "node:path"
import { createDarwinAdapter, DarwinObservationUnavailable } from "../../src/platform/darwin.js"
import { bindPrivateSocket } from "../../src/platform/private-socket.js"
import { agencyLaunchMarker, parseAgencyLaunchMarker } from "../../src/platform/launch-marker.js"
import { assertPrivateDirectory, readHandlerRecord, readLaunchRecord, writeHandlerRecord } from "../../src/platform/private-state.js"
import { reconcileRecord } from "../../src/platform/reconcile.js"
import { startOrConnect, type StartTransition } from "../../src/platform/singleton.js"
import { type HandlerGenerationRecord, type PlatformAdapter, type ProcessIdentity } from "../../src/platform/types.js"

type FixtureConfig = {
  root: string
  bootId: string
  hostId: string
  handlerLog: string
  eventLog?: string
  resultPath?: string
  releasePath?: string
  launcherPauseAt?: StartTransition
  handlerPauseAt?: "before_socket_bind" | "after_socket_bind_before_publication" | "after_first_reconciliation" | "before_ready_ack"
  retainedDirectory: string
  fakeGroups?: FakeGroup[]
  signalLog?: string
  identityDelayMs?: number
  readyDelayMs?: number
  readyRecordMutation?: "socket_path" | "launch_attempt_id" | "host_id" | "process_identity"
  readySocketPath?: string
  combinedReadyFrames?: boolean
  response?: string
  timeoutMs?: number
  lockTimeoutSeconds?: number
  adapterMode?: "darwin-real"
}

type FakeGroup = {
  processGroupId: number
  currentLeader: ProcessIdentity | null
  members: ProcessIdentity[]
  termOutcome: "empty" | "survive"
}

async function withPrivateUmask<T>(create: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077)
  try {
    return await create()
  } finally {
    process.umask(previous)
  }
}

async function appendPrivateFile(path: string, data: string): Promise<void> {
  await withPrivateUmask(() => appendFile(path, data, { mode: 0o600 }))
}

async function writePrivateFile(path: string, data: string): Promise<void> {
  await withPrivateUmask(() => writeFile(path, data, { mode: 0o600 }))
}

async function writePrivateHandlerRecord(path: string, record: HandlerGenerationRecord): Promise<void> {
  await withPrivateUmask(() => writeHandlerRecord(path, record))
}

function identity(pid: number, bootId: string, parentPid = 1, birth = `fixture-${pid}`): ProcessIdentity {
  return {
    bootId,
    pid,
    birth,
    parentPid,
    processGroupId: pid,
    sessionId: pid,
    uid: process.getuid!(),
    gid: process.getgid!(),
  }
}

function canonicalHandlerBirth(birth: string): boolean {
  const separator = birth.indexOf(":")
  if (separator <= 0 || !/^(0|[1-9]\d*)$/.test(birth.slice(0, separator))) return false
  return parseAgencyLaunchMarker(birth.slice(separator + 1))?.role === "handler"
}

async function handlerBirth(recordPath: string, pid: number): Promise<string> {
  const record = await readHandlerRecord(recordPath)
  if (record.process?.pid === pid && canonicalHandlerBirth(record.process.birth)) return record.process.birth
  return `1780000000:${agencyLaunchMarker("handler", record.launchAttemptId)}`
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

function adapter(config: FixtureConfig): PlatformAdapter {
  if (config.adapterMode === "darwin-real") {
    if (process.platform !== "darwin") throw new Error("the real Darwin adapter requires Darwin")
    return createDarwinAdapter()
  }
  const groups = new Map((config.fakeGroups ?? []).map(group => [group.processGroupId, {
    ...group,
    members: [...group.members],
  }]))
  return {
    platform: process.platform === "darwin" ? "darwin" : "linux",
    bootId: async () => config.bootId,
    readProcess: async pid => {
      const group = groups.get(pid)
      if (group !== undefined) return group.currentLeader
      if (!processExists(pid)) return null
      const birth = process.platform === "darwin"
        ? await handlerBirth(join(config.root, "handler.json"), pid)
        : `fixture-${pid}`
      return identity(pid, config.bootId, 1, birth)
    },
    readGroup: async processGroupId => groups.get(processGroupId)?.members ?? [],
    signalGroup: async (processGroupId, signal) => {
      const group = groups.get(processGroupId)
      if (group === undefined) throw new Error(`unknown fake process group ${processGroupId}`)
      if (config.signalLog !== undefined) await appendPrivateFile(config.signalLog, `${JSON.stringify({ processGroupId, signal })}\n`)
      if (signal === "SIGTERM" && group.termOutcome === "empty") {
        group.currentLeader = null
        group.members = []
      }
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function event(config: FixtureConfig, value: string): Promise<void> {
  if (config.eventLog !== undefined) await appendPrivateFile(config.eventLog, `${value}\n`)
}

async function waitForRelease(config: FixtureConfig, label: string): Promise<void> {
  if (config.releasePath === undefined) throw new Error(`${label} release path is unavailable`)
  const timeoutMs = fixtureTimeout(config)
  const deadline = Date.now() + timeoutMs
  while (!await exists(config.releasePath)) {
    if (Date.now() >= deadline) throw new Error(`${label} pause timed out`)
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))))
  }
}

async function pause(config: FixtureConfig, stage: FixtureConfig["handlerPauseAt"]): Promise<void> {
  await event(config, `handler:${stage}`)
  if (config.handlerPauseAt !== stage || config.releasePath === undefined) return
  await waitForRelease(config, `Handler ${stage}`)
}

async function delay(milliseconds: number | undefined): Promise<void> {
  if (milliseconds === undefined || milliseconds === 0) return
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function fixtureTimeout(config: FixtureConfig): number {
  const timeoutMs = config.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("fixture timeout must be a positive integer")
  return timeoutMs
}

async function observedIdentity(adapter: PlatformAdapter, pid: number, timeoutMs: number): Promise<ProcessIdentity> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const observed = await adapter.readProcess(pid)
      if (observed !== null) return observed
    } catch (error) {
      if (!(error instanceof DarwinObservationUnavailable)) throw error
    }
    if (Date.now() >= deadline) throw new Error("real Darwin Handler identity is unavailable")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function retainedInventory(config: FixtureConfig): Promise<string[]> {
  await assertPrivateDirectory(config.retainedDirectory)
  const names = (await readdir(config.retainedDirectory)).sort()
  const paths: string[] = []
  for (const name of names) {
    const path = join(config.retainedDirectory, name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`retained inventory entry ${name} is a symlink`)
    if (!stats.isFile()) throw new Error(`retained inventory entry ${name} is not a regular file`)
    await readLaunchRecord(path)
    paths.push(path)
  }
  return paths
}

function socketForFd(fd: number): Socket {
  return new Socket({ fd, readable: true, writable: true })
}

async function waitForGate(status: Socket, gate: Socket, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = (released: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      status.off("end", lost)
      status.off("close", lost)
      status.off("error", lost)
      gate.off("end", lost)
      gate.off("close", lost)
      gate.off("error", lost)
      gate.off("data", opened)
      resolve(released)
    }
    const lost = (): void => finish(false)
    const opened = (data: Buffer): void => {
      if (data.toString("utf8").includes("start\n")) finish(true)
    }
    status.on("end", lost)
    status.on("close", lost)
    status.on("error", lost)
    gate.on("end", lost)
    gate.on("close", lost)
    gate.on("error", lost)
    gate.on("data", opened)
  })
}

async function runHandler(config: FixtureConfig): Promise<void> {
  const status = socketForFd(3)
  const gate = socketForFd(4)
  const recordPath = process.env.AGENCY_HANDLER_RECORD
  const generation = process.env.AGENCY_HANDLER_GENERATION
  if (recordPath === undefined || generation === undefined) throw new Error("Handler startup environment is incomplete")
  const timeoutMs = fixtureTimeout(config)
  const handlerAdapter = adapter(config)
  const observed = config.adapterMode === "darwin-real" ? await observedIdentity(handlerAdapter, process.pid, timeoutMs) : null
  const birth = process.platform === "darwin" ? await handlerBirth(recordPath, process.pid) : `fixture-${process.pid}`
  const self = observed ?? identity(process.pid, config.bootId, process.ppid, birth)
  await delay(config.identityDelayMs)
  await appendPrivateFile(config.handlerLog, `${JSON.stringify(self)}\n`)
  await event(config, "handler:identity_claimed")
  status.write(`${JSON.stringify({ type: "identity", identity: self })}\n`)
  if (!await waitForGate(status, gate, timeoutMs)) {
    status.destroy()
    gate.destroy()
    return
  }
  gate.destroy()
  await event(config, "handler:gate_released")
  status.on("error", () => undefined)
  const gateFrame = `${JSON.stringify({ type: "gate_released", generation: process.env.AGENCY_HANDLER_GENERATION })}\n`
  if (config.combinedReadyFrames !== true) status.write(gateFrame)
  await pause(config, "before_socket_bind")
  const published = await readHandlerRecord(recordPath)
  const server = await withPrivateUmask(() => bindPrivateSocket(dirname(published.socketPath), basename(published.socketPath), socket => {
    socket.once("data", () => socket.end(config.response ?? generation))
  }))
  process.once("SIGTERM", () => server.close(() => process.exit(0)))
  await pause(config, "after_socket_bind_before_publication")
  await writePrivateHandlerRecord(recordPath, {
    ...published,
    phase: "socket_bound",
    writer: "handler",
    reconciliation: null,
  })
  const inventoryPaths = await retainedInventory(config)
  await writePrivateHandlerRecord(recordPath, {
    ...published,
    phase: "reconciling",
    writer: "handler",
    reconciliation: { classified: 0, total: inventoryPaths.length, quarantined: 0 },
  })
  const reconciliationAdapter = config.adapterMode === "darwin-real" ? handlerAdapter : { ...handlerAdapter, platform: "darwin" as const }
  let classified = 0
  let quarantined = 0
  for (const path of inventoryPaths) {
    const result = await withPrivateUmask(() => reconcileRecord(path, reconciliationAdapter))
    classified += 1
    if (result.disposition === "quarantined") quarantined += 1
    await writePrivateHandlerRecord(recordPath, {
      ...published,
      phase: "reconciling",
      writer: "handler",
      reconciliation: { classified, total: inventoryPaths.length, quarantined },
    })
    if (classified === 1 && inventoryPaths.length > 1) await pause(config, "after_first_reconciliation")
  }
  await delay(config.readyDelayMs)
  let ready: HandlerGenerationRecord = {
    ...published,
    phase: "ready",
    writer: "handler",
    reconciliation: { classified, total: inventoryPaths.length, quarantined },
    reason: null,
  }
  if (config.readyRecordMutation === "socket_path") {
    if (config.readySocketPath === undefined) throw new Error("ready socket mutation requires a path")
    ready = { ...ready, socketPath: config.readySocketPath }
  } else if (config.readyRecordMutation === "launch_attempt_id") {
    ready = { ...ready, launchAttemptId: `${ready.launchAttemptId}-changed` }
  } else if (config.readyRecordMutation === "host_id") {
    ready = { ...ready, hostId: `${ready.hostId}-changed` }
  } else if (config.readyRecordMutation === "process_identity") {
    if (ready.process === null) throw new Error("ready process mutation requires an identity")
    ready = { ...ready, process: { ...ready.process, birth: `${ready.process.birth}-changed` } }
  }
  await writePrivateHandlerRecord(recordPath, ready)
  await pause(config, "before_ready_ack")
  const readyFrame = `${JSON.stringify({ type: "ready", generation })}\n`
  status.write(config.combinedReadyFrames === true ? `${gateFrame}${readyFrame}` : readyFrame)
  status.end()
  await new Promise<void>((resolve, reject) => {
    server.once("close", resolve)
    server.once("error", reject)
  })
}

async function runContender(config: FixtureConfig, configPath: string): Promise<void> {
  try {
    const inspection = await withPrivateUmask(() => startOrConnect({
      root: config.root,
      hostId: config.hostId,
      adapter: adapter(config),
      handler: {
        file: process.execPath,
        args: [process.argv[1]!, "handler", configPath],
      },
      timeoutMs: config.timeoutMs ?? 5000,
      lockTimeoutSeconds: config.lockTimeoutSeconds ?? 10,
      onTransition: async transition => {
        await event(config, `launcher:${transition}`)
        if (config.launcherPauseAt !== transition || config.releasePath === undefined) return
        await waitForRelease(config, `launcher ${transition}`)
      },
    }))
    if (config.resultPath !== undefined) await writePrivateFile(config.resultPath, JSON.stringify({ ok: true, inspection }))
  } catch (error) {
    if (config.resultPath !== undefined) await writePrivateFile(config.resultPath, JSON.stringify({ ok: false, error: String(error) }))
    process.exitCode = 1
  }
}

const mode = process.argv[2]
const configPath = process.argv[3]
if ((mode !== "handler" && mode !== "contender") || configPath === undefined) throw new Error("usage: singleton-handler <handler|contender> <config>")
const config = JSON.parse(await readFile(configPath, "utf8")) as FixtureConfig
if (mode === "handler") await runHandler(config)
else await runContender(config, configPath)