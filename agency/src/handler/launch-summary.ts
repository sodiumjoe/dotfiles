import type { LaunchSummary } from "../control/protocol.js"
import { launchOwner, type LaunchRecord } from "../platform/types.js"

export function summarizeLaunches(records: LaunchRecord[]): LaunchSummary[] {
  return records.map(record => ({ launchAttemptId: record.launchAttemptId, owner: launchOwner(record), phase: record.phase, reason: record.reason }))
}