import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, rename, rm, type FileHandle } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import type { RemovalEvidence, RetirementView } from "../retention/store.js"
import { isDeepStrictEqual } from "node:util"
import { decodeJson, readBoundedFile } from "../catalog/config.js"
import type { CatalogFileSystem } from "../catalog/store.js"
import { id } from "../catalog/types.js"
import { UUID } from "../control/protocol.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { AgentError, parseAgentCommand, parseAgentRecord, parseLegacyAgentRecord, type AgentCommand, type AgentPhase, type AgentRecord, type LegacyAgentRecord } from "./types.js"

export type AgentStateIssue = { kind: "agent" | "command" | "unknown"; id: string | null; path: string; message: string }
export type AgentInventory = { agents: AgentRecord[]; legacyAgents: LegacyAgentRecord[]; commands: AgentCommand[]; issues: AgentStateIssue[] }
export type AgentStore = {
  readAgent(id: string): Promise<AgentRecord | null>
  readCommand(id: string): Promise<AgentCommand | null>
  writeAgent(next: AgentRecord, expected: AgentRecord | null): Promise<void>
  writeCommand(next: AgentCommand, expected: AgentCommand | null): Promise<void>
  verifyDurability(kind: "agent" | "command"): Promise<void>
  inventory(): Promise<AgentInventory>
  forgetRemoved(entry: RemovalEvidence): void
  terminalTimes(agentId: string, commandIds: readonly string[]): Promise<number[] | null>
}
type FileEvidence = { bytes: Buffer; identity: string }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"
function unavailable(): never { throw new AgentError("INVALID_AGENT_STATE") }
const conflict = (): never => { throw new AgentError("COMMAND_CONFLICT") }
const edges: Record<AgentPhase, AgentPhase[]> = { starting: ["ready", "stopping", "failed", "interrupted"], ready: ["recoverable", "stopping", "failed", "interrupted"], recoverable: ["restoring", "stopping", "failed", "interrupted"], restoring: ["ready", "recoverable", "stopping", "failed", "interrupted"], stopping: ["stopped", "recoverable", "failed", "interrupted"], stopped: ["restoring"], failed: [], interrupted: [] }

export function createAgentStore(root: string, filesystem: CatalogFileSystem = { open, rename, rm, mkdir }, retirement?: RetirementView): AgentStore {
  const directory = join(root, "agents")
  const known = new Map<string, "agent" | "command">()
  async function checkDirectory(path: string): Promise<boolean> {
    await assertPrivateDirectory(root)
    try { await assertPrivateDirectory(directory); if (path !== directory) await assertPrivateDirectory(path); return true }
    catch (error) { if (absent(error)) return false; return unavailable() }
  }
  async function evidence(path: string): Promise<FileEvidence | null> {
    if (!await checkDirectory(dirname(path))) return null
    const bytes = await readBoundedFile(path, 1048576, true)
    if (bytes === null) return null
    const s = await lstat(path, { bigint: true })
    if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) !== 0n) unavailable()
    const identity = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].join(":")
    return { bytes, identity }
  }
  async function readAgent(agentId: string): Promise<AgentRecord | null> {
    const file = await evidence(join(directory, "records", id(agentId) + ".json"))
    if (!file) return null
    const raw = decodeJson(file.bytes)
    if ((raw as { version?: unknown }).version === 1) { if (parseLegacyAgentRecord(raw).spec.agentId !== agentId) unavailable(); return null }
    const value = parseAgentRecord(raw)
    if (value.definition.agentId !== agentId) unavailable()
    return value
  }
  async function readCommand(commandId: string): Promise<AgentCommand | null> {
    const file = await evidence(join(directory, "commands", id(commandId) + ".json"))
    if (!file) return null
    const raw = decodeJson(file.bytes)
    if ((raw as { version?: unknown }).version === 1) { if (id((raw as { commandId?: unknown }).commandId) !== commandId) unavailable(); return null }
    const value = parseAgentCommand(raw)
    if (value.commandId !== commandId) unavailable()
    return value
  }
  async function names(path: string): Promise<string[]> {
    if (!await checkDirectory(path)) return []
    const result: string[] = []
    for await (const entry of await opendir(path)) result.push(entry.name)
    return result.sort()
  }
  async function inventory(): Promise<AgentInventory> {
    const result: AgentInventory = { agents: [], legacyAgents: [], commands: [], issues: [] }, seen = new Set<string>()
    try {
      await retirement?.validate()
      for (const name of await names(directory)) {
        if (name === "records" || name === "commands") continue
        if (name !== "provider-state") result.issues.push({ kind: "unknown", id: null, path: join(directory, name), message: "unknown agent state entry" })
      }
      for (const kind of ["records", "commands"] as const) {
        for (const name of await names(join(directory, kind))) {
          const path = join(directory, kind, name)
          if (retirement?.hides(relative(root, path))) continue
          seen.add(path)
          try {
            const stat = await lstat(path)
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) unavailable()
            const remnant = /^\.(.+)\.json\.(.+)\.tmp$/.exec(name)
            if (remnant && UUID.test(remnant[1]!) && UUID.test(remnant[2]!)) continue
            if (!name.endsWith(".json")) unavailable()
            const recordId = id(name.slice(0, -5)), file = await evidence(path)
            if (!file) unavailable()
            const raw = decodeJson(file.bytes)
            if (kind === "records") {
              if ((raw as { version?: unknown }).version === 1) { const value = parseLegacyAgentRecord(raw); if (value.spec.agentId !== recordId) unavailable(); result.legacyAgents.push(value) }
              else { const value = parseAgentRecord(raw); if (value.definition.agentId !== recordId) unavailable(); result.agents.push(value) }
            } else if ((raw as { version?: unknown }).version === 1) { if (id((raw as { commandId?: unknown }).commandId) !== recordId) unavailable() }
            else { const value = parseAgentCommand(raw); if (value.commandId !== recordId) unavailable(); result.commands.push(value) }
            known.set(path, kind === "records" ? "agent" : "command")
          } catch (error) {
            const recordId = name.endsWith(".json") ? name.slice(0, -5) : ""
            result.issues.push({ kind: UUID.test(recordId) ? kind === "records" ? "agent" : "command" : "unknown", id: UUID.test(recordId) ? recordId : null, path, message: String(error).slice(0, 512) })
          }
        }
      }
      for (const [path, kind] of known) if (!seen.has(path) && !retirement?.hides(relative(root, path))) result.issues.push({ kind, id: basename(path, ".json"), path, message: "missing agent state entry" })
    } catch (error) { result.issues.push({ kind: "unknown", id: null, path: directory, message: String(error).slice(0, 512) }) }
    return result
  }
  async function sync(path: string): Promise<void> {
    const handle = await filesystem.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  async function ensure(path: string): Promise<void> {
    await assertPrivateDirectory(root)
    for (const child of [directory, path]) {
      try { await filesystem.mkdir(child, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      await assertPrivateDirectory(child); await sync(dirname(child))
    }
  }
  async function publish(path: string, value: unknown, expected: unknown): Promise<void> {
    try { await names(directory) } catch { unavailable() }
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > 1048576) throw new AgentError("INCOMPLETE")
    const before = await evidence(path)
    if (!before?.bytes.equals(bytes) && !isDeepStrictEqual(before ? decodeJson(before.bytes) : null, expected)) conflict()
    await ensure(dirname(path))
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    let handle: FileHandle | undefined, renamed = false
    try {
      handle = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined
      if (!isDeepStrictEqual(await evidence(path), before)) unavailable()
      await filesystem.rename(temporary, path); renamed = true
      const visible = await evidence(path)
      if (!visible?.bytes.equals(bytes)) unavailable()
      await sync(dirname(path))
      if (!isDeepStrictEqual(await evidence(path), visible)) unavailable()
      known.set(path, path.includes("/records/") ? "agent" : "command")
    } finally { await handle?.close(); if (!renamed) await filesystem.rm(temporary, { force: true }) }
  }
  return {
    readAgent, readCommand, inventory,
    forgetRemoved(entry) { known.delete(join(root, entry.path)) },
    async terminalTimes(agentId, commandIds) {
      try {
        const paths = [join(directory, "records", id(agentId) + ".json"), ...commandIds.map(value => join(directory, "commands", id(value) + ".json"))], times: number[] = []
        for (const path of paths) {
          const before = await evidence(path)
          if (!before) return null
          const stat = await lstat(path, { bigint: true })
          if (!isDeepStrictEqual(before, await evidence(path))) return null
          const time = Number(stat.mtimeNs) / 1000000
          if (!Number.isFinite(time) || time < 0) return null
          times.push(time)
        }
        return times
      } catch { return null }
    },
    async verifyDurability(kind) {
      const path = join(directory, kind === "agent" ? "records" : "commands")
      if (!await checkDirectory(path)) return
      await sync(path); await sync(directory); await sync(root)
    },
    async writeAgent(input, expected) {
      const value = parseAgentRecord(input), current = await readAgent(value.definition.agentId)
      if (!isDeepStrictEqual(value, current)) {
        if (!isDeepStrictEqual(current, expected)) conflict()
        if (current === null) { if (value.phase !== "starting") conflict() }
        else {
          if (!isDeepStrictEqual(value.definition, current.definition) || !edges[current.phase].includes(value.phase)) conflict()
          const restoring = value.phase === "restoring" && ["stopped", "recoverable"].includes(current.phase)
          if (restoring || value.phase === "recoverable") {
            const launch = await readLaunchRecordForReconciliation(join(root, "launches", current.launch.launchAttemptId + ".json"))
            if (!current.session || launch?.phase !== "cleanup_verified" || launch.version !== 2 || launch.owner.kind !== "agent" || launch.owner.agentId !== current.definition.agentId || launch.owner.providerGeneration !== current.launch.providerGeneration || launch.handlerGeneration !== current.launch.handlerGeneration) conflict()
          }
          if (restoring) {
            if (["providerGeneration", "launchAttemptId", "commandId"].some(field => value.launch[field as keyof typeof value.launch] === current.launch[field as keyof typeof current.launch]) || !isDeepStrictEqual(value.session, current.session)) conflict()
          } else {
            if (!isDeepStrictEqual(value.launch, current.launch)) conflict()
            if (current.session !== null && !isDeepStrictEqual(value.session, current.session)) {
              if (current.phase !== "restoring" || value.phase !== "ready" || !value.session || value.session.sessionGeneration === current.session.sessionGeneration || !isDeepStrictEqual({ ...value.session, sessionGeneration: current.session.sessionGeneration }, current.session)) conflict()
            }
          }
        }
      }
      await publish(join(directory, "records", value.definition.agentId + ".json"), value, expected)
    },
    async writeCommand(input, expected) {
      const value = parseAgentCommand(input), current = await readCommand(value.commandId)
      if (!isDeepStrictEqual(value, current)) {
        if (!isDeepStrictEqual(current, expected)) conflict()
        if (current === null) { if (value.state !== "pending" && !(value.op === "start" && value.target === null && value.result?.outcome === "failed")) conflict() }
        else if (current.state !== "pending" || value.state === "pending" || !isDeepStrictEqual({ ...value, state: current.state, result: current.result }, current)) conflict()
      }
      await publish(join(directory, "commands", value.commandId + ".json"), value, expected)
    },
  }
}