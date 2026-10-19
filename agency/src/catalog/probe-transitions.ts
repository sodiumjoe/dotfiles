import { isDeepStrictEqual } from "node:util"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import type { ManagedLaunchRecord } from "../platform/types.js"
import { CatalogError } from "./types.js"

export type ProbeTransitionIO = { publish: typeof writeLaunchRecord; read: typeof readLaunchRecordForReconciliation }
export type ProbeTransition = { current(): ManagedLaunchRecord; durable(): boolean; publish(next: ManagedLaunchRecord): Promise<void> }
export function createProbeTransition(input: { path: string; initial: ManagedLaunchRecord; io: ProbeTransitionIO; accept(record: ManagedLaunchRecord): void }): ProbeTransition {
  let expected = structuredClone(input.initial), exists = false, durable = false
  const unavailable = (): never => { throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") }
  return {
    current: () => structuredClone(expected), durable: () => durable,
    async publish(next) {
      next = structuredClone(next)
      const stable = (record: ManagedLaunchRecord) => ({ version: record.version, owner: record.owner, handlerGeneration: record.handlerGeneration, launchAttemptId: record.launchAttemptId, launchBootId: record.launchBootId })
      if (next.version !== 2 || next.owner.kind !== "catalog-probe" || !isDeepStrictEqual(stable(next), stable(input.initial))) unavailable()
      try {
        const visible = await input.io.read(input.path)
        if (!exists || !isDeepStrictEqual(visible, expected)) unavailable()
      } catch (cause) {
        if (exists || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
      }
      durable = false
      let matched = false
      try { await input.io.publish(input.path, next) }
      finally {
        try {
          if (isDeepStrictEqual(await input.io.read(input.path), next)) { expected = structuredClone(next); exists = true; matched = true; input.accept(structuredClone(next)) }
        } catch { }
      }
      if (!matched) unavailable()
      durable = true
    },
  }
}