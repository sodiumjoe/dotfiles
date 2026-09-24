import { execFile } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { parseAgencyLaunchMarker } from "./launch-marker.js"
import { type PlatformAdapter, type ProcessIdentity } from "./types.js"

const SYSCTL = "/usr/sbin/sysctl"
const PS = "/bin/ps"
const SYSCTL_ARGS = ["-n", "kern.bootsessionuuid"] as const
const PS_ARGS = ["-ww", "-axo", "pid=,ppid=,pgid=,uid=,gid=,lstart=,command="] as const
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_SNAPSHOT_ROWS = 65_536
const COMMAND_OPTIONS = {
  encoding: "utf8",
  env: { LANG: "C", TZ: "UTC" },
  maxBuffer: MAX_OUTPUT_BYTES,
  shell: false,
  timeout: 2000,
} as const
const MONTHS = new Map<string, number>([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11],
] as const)
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\n?$/
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\S.*)$/

export class DarwinObservationUnavailable extends Error {
  override readonly name = "DarwinObservationUnavailable"
}

export type DarwinCommandOptions = typeof COMMAND_OPTIONS

export type DarwinCommandExecutor = (
  file: string,
  args: readonly string[],
  options: DarwinCommandOptions,
) => Promise<{ stdout: string }>

type SnapshotRow = {
  pid: number
  parentPid: number
  processGroupId: number
  uid: number
  gid: number
  startSeconds: number
  command: string
  commandToken: string
}

function unavailable(message: string, cause?: unknown): DarwinObservationUnavailable {
  return cause === undefined ? new DarwinObservationUnavailable(message) : new DarwinObservationUnavailable(message, { cause })
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function field(value: string, name: string, minimum: number): number {
  if (!/^-?\d+$/.test(value)) throw unavailable(`Darwin ps ${name} is invalid`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw unavailable(`Darwin ps ${name} is invalid`)
  return parsed
}

function startSeconds(match: RegExpExecArray): number {
  const weekday = match[6]!
  const month = MONTHS.get(match[7]!)
  if (month === undefined) throw unavailable("Darwin ps month is invalid")
  const day = field(match[8]!, "day", 1)
  const hour = field(match[9]!, "hour", 0)
  const minute = field(match[10]!, "minute", 0)
  const second = field(match[11]!, "second", 0)
  const year = field(match[12]!, "year", 1970)
  if (day > 31 || hour > 23 || minute > 59 || second > 59 || year > 9999) throw unavailable("Darwin ps start time is invalid")
  const milliseconds = Date.UTC(year, month, day, hour, minute, second)
  const date = new Date(milliseconds)
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || WEEKDAYS[date.getUTCDay()] !== weekday) throw unavailable("Darwin ps start time is internally inconsistent")
  const seconds = milliseconds / 1000
  if (!Number.isSafeInteger(seconds)) throw unavailable("Darwin ps start time is outside the supported range")
  return seconds
}

function parseSnapshot(output: string): Map<number, SnapshotRow> {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw unavailable("Darwin ps output exceeds 1 MiB")
  if (output.length === 0) throw unavailable("Darwin ps output is empty")
  if (/[\u0000-\u0008\u000b-\u001f\u007f\ufffd]/u.test(output)) throw unavailable("Darwin ps output contains invalid characters")
  const lines = output.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines.length > MAX_SNAPSHOT_ROWS) throw unavailable("Darwin ps output exceeds 65536 rows")
  const rows = new Map<number, SnapshotRow>()
  for (const line of lines) {
    const match = PS_ROW.exec(line)
    if (match === null) throw unavailable("Darwin ps output is malformed")
    const pid = field(match[1]!, "pid", 1)
    if (rows.has(pid)) throw unavailable("Darwin ps output contains a duplicate PID")
    const command = match[13]!
    const commandToken = /^\S+/.exec(command)?.[0]
    if (commandToken === undefined || commandToken.length === 0) throw unavailable("Darwin ps command is invalid")
    rows.set(pid, {
      pid,
      parentPid: field(match[2]!, "parent PID", 0),
      processGroupId: field(match[3]!, "process group ID", 0),
      uid: field(match[4]!, "UID", -2),
      gid: field(match[5]!, "GID", -2),
      startSeconds: startSeconds(match),
      command,
      commandToken,
    })
  }
  return rows
}

function sameRow(first: SnapshotRow, second: SnapshotRow): boolean {
  return first.pid === second.pid
    && first.parentPid === second.parentPid
    && first.processGroupId === second.processGroupId
    && first.uid === second.uid
    && first.gid === second.gid
    && first.startSeconds === second.startSeconds
    && first.command === second.command
}

function identity(bootId: string, row: SnapshotRow): ProcessIdentity {
  const marker = parseAgencyLaunchMarker(row.commandToken)
  const birth = marker !== null && row.pid === row.processGroupId
    ? `${row.startSeconds}:${row.commandToken}`
    : `${row.startSeconds}:unmarked:${row.commandToken}`
  return {
    bootId,
    pid: row.pid,
    birth,
    parentPid: row.parentPid,
    processGroupId: row.processGroupId,
    sessionId: row.processGroupId,
    uid: row.uid,
    gid: row.gid,
  }
}

async function qualified(path: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== 0 || (stats.mode & 0o022) !== 0 || await realpath(path) !== path) throw unavailable(`${path} is not a qualified system tool`)
}

const executeCommand: DarwinCommandExecutor = async (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout) => {
    if (error !== null) reject(error)
    else resolve({ stdout })
  })
})

async function command(execute: DarwinCommandExecutor, file: string, args: readonly string[]): Promise<string> {
  try {
    await qualified(file)
    const result = await execute(file, args, COMMAND_OPTIONS)
    if (typeof result.stdout !== "string") throw unavailable(`${file} returned non-text output`)
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) throw unavailable(`${file} output exceeds 1 MiB`)
    return result.stdout
  } catch (error) {
    if (error instanceof DarwinObservationUnavailable) throw error
    throw unavailable(`${file} observation is unavailable`, error)
  }
}

async function snapshot(execute: DarwinCommandExecutor): Promise<Map<number, SnapshotRow>> {
  try {
    return parseSnapshot(await command(execute, PS, PS_ARGS))
  } catch (error) {
    if (error instanceof DarwinObservationUnavailable) throw error
    throw unavailable("Darwin process snapshot is unavailable", error)
  }
}

function stableGroup(first: Map<number, SnapshotRow>, second: Map<number, SnapshotRow>, processGroupId: number): SnapshotRow[] | null {
  const firstRows = [...first.values()].filter(row => row.processGroupId === processGroupId).sort((left, right) => left.pid - right.pid)
  const secondRows = [...second.values()].filter(row => row.processGroupId === processGroupId).sort((left, right) => left.pid - right.pid)
  if (firstRows.length !== secondRows.length) return null
  for (let index = 0; index < firstRows.length; index += 1) {
    if (!sameRow(firstRows[index]!, secondRows[index]!)) return null
  }
  return secondRows
}

export function createDarwinAdapter(execute: DarwinCommandExecutor = executeCommand): PlatformAdapter {
  const bootId = async (): Promise<string> => {
    const output = await command(execute, SYSCTL, SYSCTL_ARGS)
    const match = UUID.exec(output)
    if (match === null) throw unavailable("Darwin boot session UUID is malformed")
    return match[1]!.toLowerCase()
  }
  return {
    platform: "darwin",
    bootId,
    readProcess: async pid => {
      if (!positiveSafeInteger(pid)) return null
      const boot = await bootId()
      const first = (await snapshot(execute)).get(pid) ?? null
      const second = (await snapshot(execute)).get(pid) ?? null
      if (first === null && second === null) return null
      if (first === null || second === null || !sameRow(first, second)) throw unavailable(`Darwin PID ${pid} did not have a stable complete observation`)
      return identity(boot, second)
    },
    readGroup: async processGroupId => {
      if (!positiveSafeInteger(processGroupId)) return []
      const boot = await bootId()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const rows = stableGroup(await snapshot(execute), await snapshot(execute), processGroupId)
        if (rows !== null) return rows.map(row => identity(boot, row))
      }
      throw unavailable(`Darwin process group ${processGroupId} did not have a stable complete observation`)
    },
    signalGroup: async (processGroupId, signal) => {
      if (!positiveSafeInteger(processGroupId)) throw new Error("Darwin process group signal target must be a positive safe integer")
      process.kill(-processGroupId, signal)
    },
  }
}