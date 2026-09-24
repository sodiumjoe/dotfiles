export type AgencyLaunchRole = "handler" | "provider"

export type AgencyLaunchMarker = {
  role: AgencyLaunchRole
  launchAttemptId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MARKER = /^agy-(handler|provider):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function agencyLaunchMarker(role: AgencyLaunchRole, launchAttemptId: string): string {
  if (role !== "handler" && role !== "provider") throw new Error("Agency launch marker role is invalid")
  if (!UUID.test(launchAttemptId)) throw new Error("Agency launch marker launch UUID is invalid")
  return `agy-${role}:${launchAttemptId}`
}

export function parseAgencyLaunchMarker(value: string): AgencyLaunchMarker | null {
  const match = MARKER.exec(value)
  if (match === null) return null
  return { role: match[1] as AgencyLaunchRole, launchAttemptId: match[2]! }
}