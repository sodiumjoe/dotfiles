import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { HandlerStatus } from "../control/protocol.js"
import type { InventoryEntry } from "../handler/inventory.js"
import { refreshLaunchState, type HandlerMutations } from "../handler/mutations.js"
import type { PlatformPaths } from "../platform/paths.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import type { LaunchRecord, PlatformAdapter } from "../platform/types.js"
import { checkoutsOverlap, resolveCheckout, type CheckoutIdentity } from "./identity.js"
import { inventoryAdmissions, parseAdmissionRecord, readAdmission, writeAdmission, type AdmissionInventory, type AdmissionRecord } from "./records.js"

export type CheckoutDecision = { state: "available" | "leased" | "quarantined" | "unavailable"; attempts: string[]; reasons: string[] }

function paired(record: LaunchRecord, admission: AdmissionRecord): boolean {
  return record.launchAttemptId === admission.launchAttemptId && record.handlerGeneration === admission.handlerGeneration
    && record.agentId === admission.agentId && record.leaseId === admission.leaseId && record.checkoutId === admission.checkout.checkoutId
}

export function admissionInventoryIssues(hostId: string, launches: readonly InventoryEntry[], admissions: AdmissionInventory): string[] {
  const reasons = admissions.issues.map(issue => issue.reason), byAttempt = new Map<string, AdmissionRecord>()
  for (const value of admissions.records) {
    try {
      const record = parseAdmissionRecord(value)
      if (byAttempt.has(record.launchAttemptId) || record.checkout.hostId !== hostId) throw new Error("admission duplicate or host mismatch")
      byAttempt.set(record.launchAttemptId, record)
    } catch (error) { reasons.push(String(error).slice(0, 512)) }
  }
  const seen = { launchAttemptId: new Set<string>(), agentId: new Set<string>(), leaseId: new Set<string>() }
  for (const { record } of launches) {
    if (record.version !== 1) continue
    for (const key of ["launchAttemptId", "agentId", "leaseId"] as const) {
      if (seen[key].has(record[key])) reasons.push(`duplicate retained ${key}`)
      seen[key].add(record[key])
    }
    const admission = byAttempt.get(record.launchAttemptId)
    if (admission === undefined) {
      if (record.phase !== "cleanup_verified") reasons.push(`unmapped launch ${record.launchAttemptId}`)
    } else if (!paired(record, admission)) reasons.push(`admission pair mismatch ${record.launchAttemptId}`)
  }
  for (const attempt of byAttempt.keys()) if (!seen.launchAttemptId.has(attempt)) reasons.push(`orphan admission ${attempt}`)
  return [...new Set(reasons)].sort()
}

export function classifyCheckout(checkout: CheckoutIdentity, launches: readonly InventoryEntry[], admissions: AdmissionInventory): CheckoutDecision {
  const reasons = admissionInventoryIssues(checkout.hostId, launches, admissions)
  if (reasons.length > 0) return { state: "unavailable", attempts: [], reasons }
  const byAttempt = new Map(admissions.records.map(record => [record.launchAttemptId, record]))
  const overlapping = launches.map(entry => entry.record).filter(record => record.phase !== "cleanup_verified" && checkoutsOverlap(checkout, byAttempt.get(record.launchAttemptId)!.checkout))
  const attempts = overlapping.map(record => record.launchAttemptId).sort()
  return { state: overlapping.some(record => record.phase === "quarantined") ? "quarantined" : attempts.length > 0 ? "leased" : "available", attempts, reasons: overlapping.map(record => record.reason).filter((value): value is string => value !== null).sort() }
}

export type ReservationRequest = { checkout: CheckoutIdentity; agentId: string; leaseId: string; launchAttemptId: string; handlerGeneration: string }
export type Reservation = { admission: AdmissionRecord; launch: LaunchRecord }
export type AdmissionContext = { paths: PlatformPaths; adapter: PlatformAdapter; state: HandlerStatus; mutations: HandlerMutations; shutdownPending(): boolean }
export type AdmissionDependencies = { resolve: typeof resolveCheckout; publishLaunch: typeof writeLaunchRecord; publishAdmission: typeof writeAdmission; reconcile: typeof reconcileRecord }
export type AdmissionController = { reserve(request: ReservationRequest): Promise<Reservation>; cancel(request: ReservationRequest): Promise<LaunchRecord> }
export class AdmissionError extends Error {
  constructor(readonly code: "STALE_HANDLER" | "NOT_READY" | "CHECKOUT_BUSY" | "CHECKOUT_QUARANTINED" | "ADMISSION_UNAVAILABLE" | "IDENTITY_CONFLICT" | "IDENTITY_CHANGED" | "ATTEMPT_RELEASED" | "CANNOT_CANCEL", message: string = code) { super(message) }
}

export async function verifyRetainedMappings(launches: readonly InventoryEntry[], admissions: AdmissionInventory, resolve: typeof resolveCheckout = resolveCheckout): Promise<void> {
  for (const { record } of launches) {
    if (record.phase === "cleanup_verified") continue
    const admission = admissions.records.find(value => value.launchAttemptId === record.launchAttemptId)
    if (admission === undefined || !paired(record, admission)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "unmapped retained launch")
    try {
      if (!isDeepStrictEqual(await resolve(admission.checkout.root.path, admission.checkout.hostId), admission.checkout)) throw new Error("retained identity changed")
    } catch { throw new AdmissionError("ADMISSION_UNAVAILABLE", `retained checkout mapping unavailable: ${record.launchAttemptId}`) }
  }
}

export function createAdmissionController(context: AdmissionContext, dependencies: AdmissionDependencies = { resolve: resolveCheckout, publishLaunch: writeLaunchRecord, publishAdmission: writeAdmission, reconcile: reconcileRecord }): AdmissionController {
  const root = context.paths.persistentRoot, directory = join(root, "launches")
  const ready = (request: ReservationRequest, checkPending: boolean): void => {
    if (request.handlerGeneration !== context.state.handlerGeneration) throw new AdmissionError("STALE_HANDLER")
    if (context.state.phase !== "ready" || (checkPending && context.shutdownPending())) throw new AdmissionError("NOT_READY")
    if (request.checkout.hostId !== context.paths.hostKey) throw new AdmissionError("IDENTITY_CONFLICT", "checkout belongs to another host")
  }
  const trusted = async (launchAttemptId: string): Promise<void> => {
    await refreshLaunchState(context.state, context.mutations, directory)
    const path = join(directory, `${launchAttemptId}.json`)
    if (context.mutations.issues?.some(issue => issue.path === path)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "launch inventory changed")
    const entry = context.mutations.accepted.find(value => value.path === path)
    if (entry) {
      let visible: LaunchRecord
      try { visible = await readLaunchRecordForReconciliation(path) }
      catch { throw new AdmissionError("ADMISSION_UNAVAILABLE", "launch readback unavailable") }
      if (!isDeepStrictEqual(visible, entry.record)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "launch readback mismatch")
    }
  }
  const accept = async (path: string, record: LaunchRecord): Promise<void> => {
    if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(path), record)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "launch readback mismatch")
    context.mutations.accepted = [...context.mutations.accepted.filter(entry => entry.path !== path), { path, record: structuredClone(record) }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }
  const resolveRequest = async (request: ReservationRequest): Promise<void> => {
    try {
      if (!isDeepStrictEqual(await dependencies.resolve(request.checkout.root.path, request.checkout.hostId), request.checkout)) throw new Error("identity changed")
    } catch { throw new AdmissionError("IDENTITY_CHANGED", "requested checkout identity changed or is unavailable") }
  }
  const queued = async <T>(input: ReservationRequest, operation: (request: AdmissionRecord) => Promise<T>): Promise<T> => {
    let request: AdmissionRecord
    try { request = parseAdmissionRecord({ version: 1, ...input }) } catch { throw new AdmissionError("IDENTITY_CONFLICT", "invalid reservation identity") }
    return context.mutations.queue.run(async () => {
      try {
        ready(request, true)
        await trusted(request.launchAttemptId)
        const result = await operation(request)
        ready(request, false)
        await trusted(request.launchAttemptId)
        return structuredClone(result)
      } catch (error) {
        if (error instanceof AdmissionError) throw error
        throw new AdmissionError("ADMISSION_UNAVAILABLE", String(error).slice(0, 512))
      } finally {
        await refreshLaunchState(context.state, context.mutations, directory)
      }
    })
  }
  return {
    reserve: input => queued(input, async request => {
      const entries = structuredClone(context.mutations.accepted), admissions = await inventoryAdmissions(root)
      const existing = entries.find(entry => entry.record.launchAttemptId === request.launchAttemptId)
      if (existing?.record.phase === "cleanup_verified") throw new AdmissionError("ATTEMPT_RELEASED")
      if (entries.some(entry => entry.record.launchAttemptId !== request.launchAttemptId && (entry.record.agentId === request.agentId || entry.record.leaseId === request.leaseId))) throw new AdmissionError("IDENTITY_CONFLICT", "retained agent or lease identity reused")
      const priorAdmission = admissions.records.find(value => value.launchAttemptId === request.launchAttemptId)
      if (existing !== undefined) {
        if (!paired(existing.record, request) || (priorAdmission !== undefined && !isDeepStrictEqual(priorAdmission, request))) throw new AdmissionError("IDENTITY_CONFLICT")
        if (existing.record.phase !== "launch_pending" || existing.record.launchAttempted || existing.record.provider !== null || existing.record.reason !== null) throw new AdmissionError(existing.record.phase === "quarantined" ? "CHECKOUT_QUARANTINED" : "CHECKOUT_BUSY")
      } else if (priorAdmission !== undefined) throw new AdmissionError("ADMISSION_UNAVAILABLE", "orphan admission cannot authorize reservation")
      const others = entries.filter(entry => entry !== existing)
      const otherAdmissions = { records: admissions.records.filter(value => value.launchAttemptId !== existing?.record.launchAttemptId), issues: admissions.issues }
      const decision = classifyCheckout(request.checkout, others, otherAdmissions)
      if (decision.state !== "available") throw new AdmissionError(decision.state === "leased" ? "CHECKOUT_BUSY" : decision.state === "quarantined" ? "CHECKOUT_QUARANTINED" : "ADMISSION_UNAVAILABLE", decision.reasons.join("; ") || decision.state)
      await resolveRequest(request)
      await verifyRetainedMappings(others, otherAdmissions, dependencies.resolve)
      const boot = await context.adapter.bootId()
      const record: LaunchRecord = existing?.record ?? { version: 1, checkoutId: request.checkout.checkoutId, agentId: request.agentId, leaseId: request.leaseId, handlerGeneration: request.handlerGeneration, launchAttemptId: request.launchAttemptId, launchBootId: boot, launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
      if (record.launchBootId !== boot) throw new AdmissionError("ADMISSION_UNAVAILABLE", "launch boot changed")
      await trusted(request.launchAttemptId)
      if (!isDeepStrictEqual(await inventoryAdmissions(root), admissions)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "admission inventory changed")
      const path = join(directory, `${record.launchAttemptId}.json`)
      try { await dependencies.publishLaunch(path, record) }
      catch (error) {
        try { await accept(path, record) }
        catch { }
        throw error
      }
      await accept(path, record)
      await dependencies.publishAdmission(root, request)
      if (!isDeepStrictEqual(await readAdmission(root, record.launchAttemptId), request)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "admission readback mismatch")
      const expectedAdmissions: AdmissionInventory = { records: [...admissions.records.filter(value => value.launchAttemptId !== request.launchAttemptId), request].sort((a, b) => a.launchAttemptId < b.launchAttemptId ? -1 : 1), issues: [] }
      await resolveRequest(request)
      await verifyRetainedMappings(others, otherAdmissions, dependencies.resolve)
      if (await context.adapter.bootId() !== record.launchBootId) throw new AdmissionError("ADMISSION_UNAVAILABLE", "launch boot changed")
      if (!isDeepStrictEqual(await inventoryAdmissions(root), expectedAdmissions)) throw new AdmissionError("ADMISSION_UNAVAILABLE", "admission inventory changed")
      return { admission: request, launch: record }
    }),
    cancel: input => queued(input, async request => {
      const entry = context.mutations.accepted.find(value => value.record.launchAttemptId === request.launchAttemptId)
      if (entry === undefined) throw new AdmissionError("CANNOT_CANCEL", "no pinned reservation")
      if (!paired(entry.record, request)) throw new AdmissionError("IDENTITY_CONFLICT")
      const admission = await readAdmission(root, request.launchAttemptId)
      if (admission !== null && !isDeepStrictEqual(admission, request)) throw new AdmissionError("IDENTITY_CONFLICT")
      const record = entry.record
      if (record.launchAttempted || record.provider !== null || record.reason !== null || (record.phase !== "launch_pending" && record.phase !== "cleanup_verified")) throw new AdmissionError("CANNOT_CANCEL")
      if (record.phase === "cleanup_verified") return record
      const result = await dependencies.reconcile(entry.path, context.adapter, record)
      await accept(entry.path, result.record)
      if (result.record.phase !== "cleanup_verified") throw new AdmissionError("CANNOT_CANCEL", "cleanup remains unverified")
      return result.record
    }),
  }
}