import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, rename, rm, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { decodeJson, readBoundedFile } from "../catalog/config.js"
import type { CatalogFileSystem } from "../catalog/store.js"
import { id } from "../catalog/types.js"
import { UUID } from "../control/protocol.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { AgentError, parseAgentCommand, parseAgentRecord, type AgentCommand, type AgentPhase, type AgentRecord } from "./types.js"

export type AgentInventory = { agents: AgentRecord[]; commands: AgentCommand[]; issues: string[] }
export type AgentStore = {
  readAgent(id: string): Promise<AgentRecord | null>
  readCommand(id: string): Promise<AgentCommand | null>
  writeAgent(next: AgentRecord, expected: AgentRecord | null): Promise<void>
  writeCommand(next: AgentCommand, expected: AgentCommand | null): Promise<void>
  inventory(): Promise<AgentInventory>
}
type FileEvidence = { bytes: Buffer; identity: string }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"
function unavailable(): never { throw new AgentError("INVALID_AGENT_STATE") }
const conflict = (): never => { throw new AgentError("COMMAND_CONFLICT") }
const edges: Record<AgentPhase, AgentPhase[]> = { starting: ["ready", "stopping", "failed", "interrupted"], ready: ["stopping", "failed", "interrupted"], stopping: ["stopped", "failed", "interrupted"], stopped: [], failed: [], interrupted: [] }

export function createAgentStore(root: string, filesystem: CatalogFileSystem = { open, rename, rm, mkdir }): AgentStore {
  const directory = join(root, "agents")
  let accepted: Map<string, FileEvidence> | null = null, blocked = false
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
    const value = parseAgentRecord(decodeJson(file.bytes))
    if (value.spec.agentId !== agentId) unavailable()
    return value
  }
  async function readCommand(commandId: string): Promise<AgentCommand | null> {
    const file = await evidence(join(directory, "commands", id(commandId) + ".json"))
    if (!file) return null
    const value = parseAgentCommand(decodeJson(file.bytes))
    if (value.commandId !== commandId) unavailable()
    return value
  }
  async function names(path: string): Promise<string[]> {
    if (!await checkDirectory(path)) return []
    const result: string[] = []
    for await (const entry of await opendir(path)) { if (result.length >= 4096) unavailable(); result.push(entry.name) }
    return result.sort()
  }
  async function inventory(): Promise<AgentInventory> {
    const result: AgentInventory = { agents: [], commands: [], issues: [] }, observed = new Map<string, FileEvidence>()
    try {
      for (const name of await names(directory)) if (name !== "records" && name !== "commands") unavailable()
      for (const kind of ["records", "commands"] as const) {
        for (const name of await names(join(directory, kind))) {
          const path = join(directory, kind, name)
          try {
            const stat = await lstat(path)
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) unavailable()
            const remnant = /^\.(.+)\.json\.(.+)\.tmp$/.exec(name)
            if (remnant && UUID.test(remnant[1]!) && UUID.test(remnant[2]!)) continue
            if (!name.endsWith(".json")) unavailable()
            const recordId = id(name.slice(0, -5)), file = await evidence(path)
            if (!file) unavailable()
            if (kind === "records") { const value = parseAgentRecord(decodeJson(file.bytes)); if (value.spec.agentId !== recordId) unavailable(); result.agents.push(value) }
            else { const value = parseAgentCommand(decodeJson(file.bytes)); if (value.commandId !== recordId) unavailable(); result.commands.push(value) }
            observed.set(path, file)
          } catch { result.issues.push(`${kind}/${name}`) }
        }
      }
      if (accepted !== null && !isDeepStrictEqual(observed, accepted)) unavailable()
      if (!result.issues.length && !blocked) accepted = observed
    } catch { result.issues.push("inventory") }
    if (result.issues.length) blocked = true
    if (blocked && !result.issues.length) result.issues.push("previous inventory failure")
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
    if ((await inventory()).issues.length) unavailable()
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
      if (!isDeepStrictEqual(await evidence(path), before)) { blocked = true; unavailable() }
      await filesystem.rename(temporary, path); renamed = true
      const visible = await evidence(path)
      if (!visible?.bytes.equals(bytes)) { blocked = true; unavailable() }
      accepted!.set(path, visible)
      await sync(dirname(path))
      if (!isDeepStrictEqual(await evidence(path), visible)) { blocked = true; unavailable() }
      if ((await inventory()).issues.length) unavailable()
    } catch (error) {
      try {
        const visible = await evidence(path)
        if (visible?.bytes.equals(bytes)) accepted!.set(path, visible)
        else if (!isDeepStrictEqual(visible, before)) blocked = true
      } catch { blocked = true }
      throw error
    } finally { await handle?.close(); if (!renamed) await filesystem.rm(temporary, { force: true }) }
  }
  return {
    readAgent, readCommand, inventory,
    async writeAgent(input, expected) {
      const value = parseAgentRecord(input), current = await readAgent(value.spec.agentId)
      if (!isDeepStrictEqual(value, current)) {
        if (!isDeepStrictEqual(current, expected)) conflict()
        if (current === null) { if (value.phase !== "starting") conflict() }
        else if (!isDeepStrictEqual(value.spec, current.spec) || !edges[current.phase].includes(value.phase) || current.session !== null && !isDeepStrictEqual(value.session, current.session)) conflict()
      }
      await publish(join(directory, "records", value.spec.agentId + ".json"), value, expected)
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