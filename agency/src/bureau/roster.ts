import { randomUUID } from "node:crypto"
import { createStorage, storageQueue } from "../orchestration/storage.js"
import { canonicalDigest, fail, type AgentRef, type ExecutionRef, type Lineage } from "../orchestration/types.js"
import { hash, object, timestamp } from "../catalog/types.js"
import { parseHostSnapshot } from "../bridge/task-ssh.js"
import { MutationQueue } from "../handler/mutations.js"
import type { RequestedSettings } from "../agent/session-config.js"
import type { BureauStore } from "./store.js"
import type { HostEnrollment } from "./hosts.js"
import type { HostSnapshot, OrchestrationHost } from "./host.js"
import type { AttemptRecord } from "./types.js"

export type HostView = { inventoryId: string | null; hostId: string; hostname: string; connectivity: "connected" | "disconnected"; observedAt: number | null; handlerGeneration: string | null; clockRegressed: boolean; readiness: { snapshot: boolean; model: "unknown"; tools: "unknown"; git: "unknown" } }
export type RosterAgent = { agent: AgentRef; execution: ExecutionRef | null; inventoryId: string | null; hostname: string; cwd: string; settings: RequestedSettings; backendId: string | null; title: string | null; providerPhase: string; connectivity: HostView["connectivity"]; observedAt: number; lineage: Lineage | null; parent: AgentRef | null; depth: number | null; lineageIssue: "MISSING_PARENT" | "LINEAGE_CYCLE" | "ASSIGNMENT_MISMATCH" | null; attempt: { assignmentId: string; attemptId: string; state: AttemptRecord["state"]; active: boolean; description: string } | null; permissionCount: number; dispatchable: boolean }
export type RosterSnapshot = { bureauId: string; generation: string; seq: number; hosts: HostView[]; agents: RosterAgent[] }
export function createBureauRoster(input: { root: string; bureauId: string; hosts: OrchestrationHost[]; store: BureauStore; enabled(): boolean; enrollments(): Promise<HostEnrollment[]>; now?: () => number }) {
  const storage = createStorage(input.root, "bureau"), queue = storageQueue(input.root), reads = new MutationQueue(), generation = randomUUID(), now = input.now ?? Date.now
  let seq = 0
  return {
    snapshot(): Promise<RosterSnapshot> { return reads.run(async () => {
      if (!input.enabled()) fail("BUREAU_DISABLED")
      const enrollments = await input.enrollments(), hosts: HostView[] = [], agents: RosterAgent[] = [], memberships = new Map<string, string | null>()
      const [assignments, attempts] = await Promise.all([input.store.listAssignments(), input.store.listAttempts()])
      for (const adapter of input.hosts) {
        const hostId = hash(adapter.hostId), enrollment = enrollments.find(value => value.hostId === hostId), key = `roster-observations/${hostId}.json`
        const prior = await queue.run(() => storage.read(key))
        let snapshot: HostSnapshot | null = null, observedAt: number | null = null, connected = false, clockRegressed = false
        if (prior !== null) {
          const value = object(prior), raw = object(value.snapshot)
          snapshot = parseHostSnapshot(raw, { hostId, handlerGeneration: String(raw.handlerGeneration) }); observedAt = timestamp(value.observedAt)
        }
        try {
          const raw = await adapter.snapshot()
          snapshot = parseHostSnapshot(raw, { hostId, handlerGeneration: raw.handlerGeneration })
          const time = timestamp(now()); clockRegressed = observedAt !== null && time < observedAt
          observedAt = Math.max(observedAt ?? 0, time)
          await queue.run(() => storage.publish(key, { snapshot, observedAt }, prior))
          connected = true
        } catch {
          if (prior === null) { snapshot = null; observedAt = null }
          else { const raw = object(object(prior).snapshot); snapshot = parseHostSnapshot(raw, { hostId, handlerGeneration: String(raw.handlerGeneration) }); observedAt = timestamp(object(prior).observedAt) }
        }
        const host: HostView = { inventoryId: enrollment?.inventoryId ?? null, hostId, hostname: enrollment?.hostname ?? "local", connectivity: connected ? "connected" : "disconnected", observedAt, handlerGeneration: snapshot?.handlerGeneration ?? null, clockRegressed, readiness: { snapshot: connected, model: "unknown", tools: "unknown", git: "unknown" } }
        hosts.push(host)
        for (const value of snapshot?.agents ?? []) {
          memberships.set(canonicalDigest(value.agent), value.membership?.runId ?? null)
          const attempt = value.execution ? attempts.find(attempt => attempt.execution && canonicalDigest(attempt.execution) === canonicalDigest(value.execution)) : undefined
          const assignment = attempt && assignments.find(assignment => assignment.assignmentId === attempt.ref.assignmentId)
          agents.push({ agent: value.agent, execution: value.execution, inventoryId: host.inventoryId, hostname: host.hostname, cwd: value.cwd, settings: value.settings, backendId: value.backendId ?? null, title: value.title ?? null,
            providerPhase: value.phase, connectivity: host.connectivity, observedAt: observedAt!, lineage: value.lineage, parent: value.lineage?.parent ?? null, depth: null,
            lineageIssue: value.lineage && (!attempt || !assignment || attempt.ref.runId !== value.lineage.runId || assignment.runId !== value.lineage.runId || canonicalDigest(attempt.child) !== canonicalDigest(value.agent) || canonicalDigest(assignment.spec.parent) !== canonicalDigest(value.lineage.parent) || value.membership?.runId !== value.lineage.runId || canonicalDigest(value.lineage) !== canonicalDigest(attempt.lineage)) ? "ASSIGNMENT_MISMATCH" : null,
            attempt: attempt && assignment ? { assignmentId: attempt.ref.assignmentId, attemptId: attempt.ref.attemptId, state: attempt.state, active: assignment.activeAttemptId === attempt.ref.attemptId, description: assignment.spec.description } : null,
            permissionCount: connected ? snapshot!.permissions?.pending.filter(offer => value.execution && canonicalDigest({ hostId: offer.ref.hostId, ...offer.ref.target }) === canonicalDigest(value.execution)).length ?? 0 : 0,
            dispatchable: connected && value.phase === "ready" && value.execution?.handlerGeneration === snapshot!.handlerGeneration })
        }
      }
      const byAgent = new Map(agents.map(row => [canonicalDigest(row.agent), row]))
      for (const row of agents) {
        let depth = 0, current = row
        const seen = new Set<string>([canonicalDigest(row.agent)])
        while (current.parent) {
          const key = canonicalDigest(current.parent)
          if (seen.has(key)) { row.lineageIssue = "LINEAGE_CYCLE"; break }
          seen.add(key)
          const parent = byAgent.get(key)
          if (!parent) { row.lineageIssue = "MISSING_PARENT"; break }
          if (row.lineage && memberships.get(key) !== row.lineage.runId) { row.lineageIssue = "ASSIGNMENT_MISMATCH"; break }
          current = parent; depth++
        }
        if (row.lineageIssue) row.dispatchable = false; else row.depth = depth
      }
      if (!input.enabled()) fail("BUREAU_DISABLED")
      return { bureauId: hash(input.bureauId), generation, seq: ++seq, hosts, agents }
    }) }
  }
}