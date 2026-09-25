import type { InventoryEntry } from "../handler/inventory.js"
import type { LaunchRecord } from "../platform/types.js"
import { checkoutsOverlap, type CheckoutIdentity } from "./identity.js"
import { parseAdmissionRecord, type AdmissionInventory, type AdmissionRecord } from "./records.js"

export type CheckoutDecision = { state: "available" | "leased" | "quarantined" | "unavailable"; attempts: string[]; reasons: string[] }

function paired(record: LaunchRecord, admission: AdmissionRecord): boolean {
  return record.launchAttemptId === admission.launchAttemptId && record.handlerGeneration === admission.handlerGeneration
    && record.agentId === admission.agentId && record.leaseId === admission.leaseId && record.checkoutId === admission.checkout.checkoutId
}

export function classifyCheckout(checkout: CheckoutIdentity, launches: readonly InventoryEntry[], admissions: AdmissionInventory): CheckoutDecision {
  const reasons = admissions.issues.map(issue => issue.reason), byAttempt = new Map<string, AdmissionRecord>()
  for (const value of admissions.records) {
    try {
      const record = parseAdmissionRecord(value)
      if (byAttempt.has(record.launchAttemptId) || record.checkout.hostId !== checkout.hostId) throw new Error("admission duplicate or host mismatch")
      byAttempt.set(record.launchAttemptId, record)
    } catch (error) { reasons.push(String(error).slice(0, 512)) }
  }
  const seen = { launchAttemptId: new Set<string>(), agentId: new Set<string>(), leaseId: new Set<string>() }
  const overlapping: LaunchRecord[] = []
  for (const { record } of launches) {
    for (const key of ["launchAttemptId", "agentId", "leaseId"] as const) {
      if (seen[key].has(record[key])) reasons.push(`duplicate retained ${key}`)
      seen[key].add(record[key])
    }
    const admission = byAttempt.get(record.launchAttemptId)
    if (admission === undefined) {
      if (record.phase !== "cleanup_verified") reasons.push(`unmapped launch ${record.launchAttemptId}`)
    } else if (!paired(record, admission)) reasons.push(`admission pair mismatch ${record.launchAttemptId}`)
    else if (record.phase !== "cleanup_verified" && checkoutsOverlap(checkout, admission.checkout)) overlapping.push(record)
  }
  for (const attempt of byAttempt.keys()) if (!seen.launchAttemptId.has(attempt)) reasons.push(`orphan admission ${attempt}`)
  if (reasons.length > 0) return { state: "unavailable", attempts: [], reasons: [...new Set(reasons)].sort() }
  const attempts = overlapping.map(record => record.launchAttemptId).sort()
  return { state: overlapping.some(record => record.phase === "quarantined") ? "quarantined" : attempts.length > 0 ? "leased" : "available", attempts, reasons: overlapping.map(record => record.reason).filter((value): value is string => value !== null).sort() }
}