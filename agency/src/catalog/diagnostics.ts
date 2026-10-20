import { constants, writeSync } from "node:fs"
import { open, rename, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessIdentity } from "../platform/types.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { decodeJson, readBoundedFile } from "./config.js"
import { CatalogError, invalid, keys, object, type ProbeMeta, type RetainedProbeMeta } from "./types.js"

export const PROBE_DIAGNOSTIC_TTL_MS = 604800000
const stages = ["preparation", "worker-launch", "worker-registration", "worker-ipc", "worker-exit", "worker-stream", "worker-config", "native-launch", "native-registration", "native-exit", "native-stream", "discovery", "rpc-rejection", "rpc-decode", "rpc-stream", "rpc-write", "timeout", "cancelled", "cleanup", "configuration", "diagnostic-write"] as const
export type ProbeStage = typeof stages[number]
export type ProbeFailureDetail = { stage: ProbeStage; name: string; message: string; code: string | null; syscall: string | null; method: string | null }
export type ProbeTerminal = { code: number | null; signal: string | null }
export type ProbeDiagnostic = {
  version: 1; hostId: string; commandId: string; attemptId: string; handlerGeneration: string; providerId: string; fingerprint: string
  startedAt: number; finishedAt: number | null; failed: boolean; firstFailure: ProbeFailureDetail | null
  workerIdentity: ProcessIdentity | null; nativeIdentity: ProcessIdentity | null
  nativeCommand: { file: string; args: string[] } | null; workerTerminal: ProbeTerminal | null; nativeTerminal: ProbeTerminal | null
  stderrComplete: boolean; workerStderrBytes: number; nativeStderrBytes: number
}
const clipped = (value: unknown): string | null => typeof value === "string" ? value.slice(0, 4096) : null
export function probeFailureDetail(stage: ProbeStage, cause: unknown, method: string | null = null): ProbeFailureDetail {
  if (cause instanceof DiscoveryError) return cause.detail
  const error = cause as { name?: unknown; message?: unknown; code?: unknown; syscall?: unknown } | null
  return { stage, name: clipped(error?.name) ?? "Error", message: clipped(error?.message) ?? String(cause).slice(0, 4096), code: typeof error?.code === "number" && Number.isFinite(error.code) ? String(error.code) : clipped(error?.code), syscall: clipped(error?.syscall), method }
}
export function parseProbeFailureDetail(raw: unknown): ProbeFailureDetail {
  const v = object(raw)
  keys(v, ["stage", "name", "message", "code", "syscall", "method"])
  if (!stages.includes(v.stage as ProbeStage)) invalid()
  for (const key of ["name", "message", "code", "syscall", "method"]) if (!(v[key] === null && ["code", "syscall", "method"].includes(key)) && (typeof v[key] !== "string" || (v[key] as string).length > 4096)) invalid()
  return v as ProbeFailureDetail
}
export class DiscoveryError extends CatalogError {
  readonly detail: ProbeFailureDetail
  constructor(stage: ProbeStage, cause: unknown, method: string | null = null) { super("PROBE_FAILED"); this.detail = probeFailureDetail(stage, cause, method) }
}
export function parseProbeTerminal(raw: unknown): ProbeTerminal {
  const v = object(raw)
  keys(v, ["code", "signal"])
  if (v.code !== null && (typeof v.code !== "number" || !Number.isSafeInteger(v.code))) invalid()
  if (v.signal !== null && (typeof v.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(v.signal))) invalid()
  return v as ProbeTerminal
}
export function initialProbeDiagnostic(meta: ProbeMeta, now = Date.now()): ProbeDiagnostic {
  return { version: 1, hostId: meta.hostId, commandId: meta.commandId, attemptId: meta.attemptId, handlerGeneration: meta.handlerGeneration, providerId: meta.providerId, fingerprint: meta.fingerprint, startedAt: now, finishedAt: null, failed: false, firstFailure: null, workerIdentity: null, nativeIdentity: null, nativeCommand: null, workerTerminal: null, nativeTerminal: null, stderrComplete: false, workerStderrBytes: 0, nativeStderrBytes: 0 }
}
const bindingKeys = ["version", "hostId", "commandId", "attemptId", "handlerGeneration", "providerId", "fingerprint"] as const
function captureBinding(diagnostic: ProbeDiagnostic): Record<string, unknown> {
  return Object.fromEntries(bindingKeys.map(key => [key, diagnostic[key]]))
}
export async function beginProbeCapture(work: string, diagnostic: ProbeDiagnostic): Promise<void> {
  await assertPrivateDirectory(work)
  const handle = await open(join(work, "capture-pending.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(captureBinding(diagnostic))); await handle.sync() } finally { await handle.close() }
  const directory = await open(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}
export async function completeProbeCapture(work: string): Promise<void> {
  await assertPrivateDirectory(work)
  await unlink(join(work, "capture-pending.json"))
}
export async function writeProbeDiagnostic(work: string, diagnostic: ProbeDiagnostic): Promise<void> {
  await assertPrivateDirectory(work)
  const temporary = join(work, ".diagnostic.json.tmp"), handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(diagnostic)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(work, "diagnostic.json"))
  const directory = await open(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}
export async function readProbeDiagnostic(meta: RetainedProbeMeta): Promise<ProbeDiagnostic | null> {
  await assertPrivateDirectory(meta.workPath)
  const bytes = await readBoundedFile(join(meta.workPath, "diagnostic.json"), 1048576, true)
  if (bytes === null) return null
  const v = object(decodeJson(bytes)), expected = initialProbeDiagnostic({ ...meta, version: 2 })
  keys(v, Object.keys(expected))
  for (const key of ["version", "hostId", "commandId", "attemptId", "handlerGeneration", "providerId", "fingerprint"] as const) if (v[key] !== expected[key]) invalid()
  for (const key of ["startedAt", "workerStderrBytes", "nativeStderrBytes"]) if (typeof v[key] !== "number" || !Number.isSafeInteger(v[key]) || (v[key] as number) < 0) invalid()
  if (v.finishedAt !== null && (typeof v.finishedAt !== "number" || !Number.isSafeInteger(v.finishedAt) || v.finishedAt < (v.startedAt as number))) invalid()
  if (typeof v.failed !== "boolean" || typeof v.stderrComplete !== "boolean") invalid()
  if (v.firstFailure !== null) { parseProbeFailureDetail(v.firstFailure); if (!v.failed) invalid() }
  for (const key of ["workerTerminal", "nativeTerminal"]) if (v[key] !== null) parseProbeTerminal(v[key])
  for (const key of ["workerIdentity", "nativeIdentity"]) if (v[key] !== null) {
    const p = object(v[key]); keys(p, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
    if (typeof p.bootId !== "string" || typeof p.birth !== "string") invalid()
    for (const field of ["pid", "parentPid", "processGroupId", "sessionId", "uid", "gid"]) if (typeof p[field] !== "number" || !Number.isSafeInteger(p[field]) || (p[field] as number) < 0) invalid()
  }
  if (v.nativeCommand !== null) {
    const c = object(v.nativeCommand); keys(c, ["file", "args"])
    if (typeof c.file !== "string" || !Array.isArray(c.args) || c.args.some(a => typeof a !== "string") || Buffer.byteLength(JSON.stringify(c)) > 65536) invalid()
  }
  const pending = await readBoundedFile(join(meta.workPath, "capture-pending.json"), 1048576, true)
  if (pending !== null) {
    const marker = object(decodeJson(pending)); keys(marker, [...bindingKeys])
    for (const key of bindingKeys) if (marker[key] !== expected[key]) invalid()
    return { ...v, stderrComplete: false } as ProbeDiagnostic
  }
  return v as ProbeDiagnostic
}
export async function openProbeStderr(work: string, name: "worker.stderr" | "native.stderr"): Promise<FileHandle> {
  await assertPrivateDirectory(work)
  return open(join(work, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
}
export function writeProbeStderr(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written === 0) throw new Error("stderr write made no progress"); offset += written }
}
export function retainProbeDiagnostic(diagnostic: ProbeDiagnostic, now: number): boolean {
  if (diagnostic.finishedAt === null || !diagnostic.stderrComplete) return true
  return diagnostic.failed && (!Number.isSafeInteger(now) || now < diagnostic.finishedAt || now - diagnostic.finishedAt < PROBE_DIAGNOSTIC_TTL_MS)
}