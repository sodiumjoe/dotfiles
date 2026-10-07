import { readFile, readdir } from "node:fs/promises"
import { sameProcess, type PlatformAdapter, type ProcessIdentity } from "./types.js"

export class LinuxObservationUnavailable extends Error {
  override readonly name = "LinuxObservationUnavailable"
}

export type LinuxProcfs = {
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
}

const defaults: LinuxProcfs = { readFile: path => readFile(path, "utf8"), readdir }
const absent = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")

function integer(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new LinuxObservationUnavailable("malformed procfs integer")
  return Number(value)
}

export function parseLinuxStat(value: string): { pid: number; parentPid: number; processGroupId: number; sessionId: number; starttime: string; state: string } {
  const prefix = /^([1-9]\d*) \(/.exec(value)
  const end = value.lastIndexOf(")")
  if (prefix === null || end < prefix[0].length) throw new LinuxObservationUnavailable("malformed procfs stat comm")
  const fields = value.slice(end + 1).trim().split(/\s+/)
  if (fields.length < 20 || !/^[RSDZTWtXxKWPIN]$/.test(fields[0] ?? "") || !/^(0|[1-9]\d*)$/.test(fields[19] ?? "")) throw new LinuxObservationUnavailable("malformed procfs stat fields")
  return { pid: integer(prefix[1]), parentPid: integer(fields[1]), processGroupId: integer(fields[2]), sessionId: integer(fields[3]), starttime: fields[19]!, state: fields[0]! }
}

export function parseLinuxStatus(value: string): { uid: number; gid: number } {
  function first(name: string): number {
    const matches = [...value.matchAll(new RegExp(`^${name}:\\s+(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+[ \\t]*$`, "gm"))]
    if (matches.length !== 1) throw new LinuxObservationUnavailable(`malformed procfs ${name}`)
    return integer(matches[0]![1])
  }
  return { uid: first("Uid"), gid: first("Gid") }
}

function argv0(value: string): string {
  const end = value.indexOf("\0")
  if (end <= 0) throw new LinuxObservationUnavailable("procfs argv0 is empty or unterminated")
  const first = value.slice(0, end)
  if (first.includes("\n") || first.includes("\r") || Buffer.byteLength(first, "utf8") > 4096) throw new LinuxObservationUnavailable("procfs argv0 is malformed or oversized")
  return first
}

function sameStat(first: ReturnType<typeof parseLinuxStat>, second: ReturnType<typeof parseLinuxStat>): boolean {
  return first.pid === second.pid && first.starttime === second.starttime && first.processGroupId === second.processGroupId && first.sessionId === second.sessionId
}

export function createLinuxAdapter(procfs: LinuxProcfs = defaults): PlatformAdapter {
  async function bootId(): Promise<string> {
    try {
      const value = (await procfs.readFile("/proc/sys/kernel/random/boot_id")).trim()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("malformed Linux boot identity")
      return value
    } catch (error) { throw new LinuxObservationUnavailable(String(error)) }
  }

  async function observe(pid: number): Promise<ProcessIdentity | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new LinuxObservationUnavailable("procfs pid must be a positive integer")
    const boot = await bootId()
    let zombieDeadline: number | null = null
    let commandError: LinuxObservationUnavailable | null = null
    for (let attempt = 0; attempt < 3 || zombieDeadline !== null; attempt++) {
      try {
        const path = `/proc/${pid}`
        const first = parseLinuxStat(await procfs.readFile(path + "/stat"))
        if (first.pid !== pid) throw new LinuxObservationUnavailable("procfs returned a different PID")
        if (first.state === "Z") {
          zombieDeadline ??= Date.now() + 250
          const second = parseLinuxStat(await procfs.readFile(path + "/stat"))
          if (second.state !== "Z" || !sameStat(first, second)) throw new LinuxObservationUnavailable("zombie identity is unstable")
          if (Date.now() >= zombieDeadline) throw new LinuxObservationUnavailable("terminal process remains unreaped")
          await new Promise(resolve => setTimeout(resolve, 25))
          continue
        }
        if (zombieDeadline !== null) throw new LinuxObservationUnavailable("zombie identity changed before reaping")
        const firstOwner = parseLinuxStatus(await procfs.readFile(path + "/status"))
        const firstCommand = await procfs.readFile(path + "/cmdline")
        const second = parseLinuxStat(await procfs.readFile(path + "/stat"))
        if (second.state === "Z") {
          zombieDeadline = Date.now() + 250
          continue
        }
        const secondOwner = parseLinuxStatus(await procfs.readFile(path + "/status"))
        const secondCommand = await procfs.readFile(path + "/cmdline")
        const third = parseLinuxStat(await procfs.readFile(path + "/stat"))
        if (third.state === "Z") {
          zombieDeadline = Date.now() + 250
          continue
        }
        let firstArgv0: string, secondArgv0: string
        try {
          firstArgv0 = argv0(firstCommand)
          secondArgv0 = argv0(secondCommand)
        } catch (error) {
          if (error instanceof LinuxObservationUnavailable) {
            commandError ??= error
            continue
          }
          throw error
        }
        if (commandError !== null) throw commandError
        if (sameStat(first, second) && sameStat(second, third) && firstOwner.uid === secondOwner.uid && firstOwner.gid === secondOwner.gid && firstArgv0 === secondArgv0) {
          return { bootId: boot, pid, parentPid: third.parentPid, processGroupId: third.processGroupId, sessionId: third.sessionId, birth: `${third.starttime}:${secondArgv0}`, ...secondOwner }
        }
      } catch (error) {
        if (absent(error)) return null
        if (error instanceof LinuxObservationUnavailable) throw error
        throw new LinuxObservationUnavailable(String(error))
      }
    }
    if (commandError !== null) throw commandError
    throw new LinuxObservationUnavailable(`procfs identity ${pid} is unstable`)
  }

  async function scan(group: number): Promise<ProcessIdentity[]> {
    const names = (await procfs.readdir("/proc")).filter(name => /^[1-9]\d*$/.test(name)).sort((a,b) => Number(a)-Number(b))
    const members: ProcessIdentity[] = []
    for (const name of names) {
      let candidate: ReturnType<typeof parseLinuxStat>
      try { candidate = parseLinuxStat(await procfs.readFile(`/proc/${name}/stat`)) } catch(error) {
        if (absent(error)) continue
        throw new LinuxObservationUnavailable(String(error))
      }
      if (candidate.pid !== integer(name)) throw new LinuxObservationUnavailable("candidate stat PID mismatch")
      if (candidate.processGroupId !== group) continue
      const current = await observe(candidate.pid)
      if (current !== null && current.processGroupId === group) members.push(current)
    }
    return members
  }

  return {
    platform: "linux",
    bootId,
    readProcess: observe,
    readGroup: async group => {
      if (!Number.isSafeInteger(group) || group <= 1) throw new LinuxObservationUnavailable("process group must be a safe integer greater than 1")
      try {
        let previous: ProcessIdentity[] | null = null
        for (let attempt = 0; attempt < 6; attempt++) {
          const current = await scan(group)
          if (previous !== null && previous.length === current.length && previous.every((member,index) => sameProcess(member,current[index]!))) return current
          previous = current
        }
      } catch(error) {
        if(error instanceof LinuxObservationUnavailable) throw error
        throw new LinuxObservationUnavailable(String(error))
      }
      throw new LinuxObservationUnavailable("process group membership is unstable after three scan pairs")
    },
    signalGroup: async (group, signal) => {
      if (!Number.isSafeInteger(group) || group <= 1) throw new Error("process group must be a safe integer greater than 1")
      process.kill(-group, signal)
    },
  }
}