import { join } from "node:path"
import type { CatalogService } from "../catalog/service.js"
import type { AgentService } from "../agent/service.js"
import { isDeepStrictEqual } from "node:util"
import { ControlError, PROTOCOL, controlError, errorReply, type ControlRequest, type ControlReply, type HandlerStatus } from "../control/protocol.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { HandlerGenerationRecord, PlatformAdapter } from "../platform/types.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { inventoryLaunchState, summarizeLaunches } from "./inventory.js"
import { assertSameShutdown, readShutdownReceipt, writeShutdownReceipt, type ShutdownReceipt } from "./receipt.js"
import { confirmReconciledLaunch, refreshLaunchState, type HandlerMutations } from "./mutations.js"

type ShutdownRequest = ControlRequest & { op: "shutdown" }
export type ShutdownContext = {
  record: HandlerGenerationRecord
  state: HandlerStatus
  paths: PlatformPaths
  adapter: PlatformAdapter
  mutations: HandlerMutations
  closeAfterReply(): Promise<void>
  publishReceipt?: typeof writeShutdownReceipt
  catalog?: Pick<CatalogService, "freezeAndDrain" | "resume" | "verifyDischarged">
  agents?: Pick<AgentService, "assertOrdinaryShutdownSafe" | "freezeAndDrain" | "resume" | "verifyDischarged">
  accepted?: ShutdownReceipt
  pending?: { request: ShutdownRequest; operation: Promise<ShutdownReceipt> }
}

async function admit(request: ShutdownRequest, context: ShutdownContext): Promise<ShutdownReceipt> {
  const previous = await readShutdownReceipt(context.paths.persistentRoot, request.commandId)
  if (previous !== null) {
    assertSameShutdown(previous, request)
    if (previous.hostId !== context.record.hostId || !isDeepStrictEqual(previous.handlerIdentity, context.record.process)) throw new ControlError("COMMAND_CONFLICT")
  }
  const directory = join(context.paths.persistentRoot, "launches")
  const inventory = await inventoryLaunchState(directory), entries = inventory.records
  context.state.launches = summarizeLaunches(entries.map(entry => entry.record))
  context.state.issues = [...inventory.issues, ...(context.mutations.reconciliationIssues ?? [])]
  if (!request.stopAgents && (context.state.issues.length || entries.some(entry => entry.record.phase !== "cleanup_verified"))) throw new ControlError("ACTIVE_AGENTS", "unverified launches or quarantined checkouts remain; inspect status")
  if (request.stopAgents) {
    const failures: unknown[] = []
    for (const entry of entries) {
      try {
        const result = await reconcileRecord(entry.path, context.adapter, entry.record)
        if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) throw new Error("RETAINED_INVENTORY_CHANGED")
        entry.record = result.record
        context.mutations.accepted = [...context.mutations.accepted.filter(value => value.path !== entry.path), structuredClone(entry)].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        if (result.record.phase === "cleanup_verified") confirmReconciledLaunch(context.mutations, entry.path)
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new ControlError("INCOMPLETE", "one or more launch cleanups remain unverified")
  }
  const checked = await inventoryLaunchState(directory)
  if (!isDeepStrictEqual(checked.records, entries)) throw new ControlError("INCOMPLETE", "retained inventory changed")
  context.state.issues = [...checked.issues, ...(context.mutations.reconciliationIssues ?? [])]
  context.state.launches = summarizeLaunches(entries.map(entry => entry.record))
  context.state.reconciliation = { classified: entries.length, total: entries.length, uncertain: entries.filter(entry => entry.record.phase === "quarantined").length }
  if (context.state.issues.length || entries.some(entry => entry.record.phase !== "cleanup_verified")) throw new ControlError("INCOMPLETE", "checkout cleanup remains unverified")
  if (context.record.process === null) throw new ControlError("INCOMPLETE", "Handler identity unavailable")
  await context.catalog?.verifyDischarged()
  const receipt: ShutdownReceipt = { version: 1, commandId: request.commandId, handlerGeneration: context.record.generation, hostId: context.record.hostId, handlerIdentity: context.record.process, stopAgents: request.stopAgents, state: "accepted" }
  await (context.publishReceipt ?? writeShutdownReceipt)(context.paths.persistentRoot, receipt)
  context.accepted = receipt
  context.state.phase = "draining"
  return receipt
}

export async function shutdownHandler(request: ShutdownRequest, context: ShutdownContext): Promise<ControlReply> {
  try {
    if (request.handlerGeneration !== context.record.generation) throw new ControlError("STALE_HANDLER")
    let receipt: ShutdownReceipt
    if (context.accepted !== undefined) {
      if (context.accepted.commandId !== request.commandId) throw new ControlError("INCOMPLETE", "Handler is draining")
      assertSameShutdown(context.accepted, request)
      receipt = context.accepted
    } else if (context.pending !== undefined) {
      if (context.pending.request.commandId !== request.commandId) throw new ControlError("INCOMPLETE", "shutdown already in progress")
      assertSameShutdown(context.pending.request, request)
      receipt = await context.pending.operation
    } else {
      if (context.state.phase !== "ready") throw new ControlError("INCOMPLETE", "Handler has not completed startup")
      if (!request.stopAgents) context.agents?.assertOrdinaryShutdownSafe()
      const operation = Promise.resolve().then(async () => {
        await context.agents?.freezeAndDrain(request.stopAgents)
        await context.catalog?.freezeAndDrain()
        return context.mutations.queue.run(async () => {
          try {
            if (request.handlerGeneration !== context.record.generation) throw new ControlError("STALE_HANDLER")
            if (context.state.phase !== "ready") throw new ControlError("INCOMPLETE", "Handler is not ready")
            try { await context.agents?.verifyDischarged() } catch { throw new ControlError("INCOMPLETE", "agent cleanup or command durability remains unverified") }
            return await admit(request, context)
          } finally { await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches")) }
        })
      })
      context.pending = { request, operation }
      try { receipt = await operation } finally { delete context.pending; if (context.accepted === undefined && context.state.phase === "ready") { context.catalog?.resume(); context.agents?.resume() } }
    }
    return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: context.record.generation, ok: true, result: { state: "shutdown_accepted", commandId: receipt.commandId, handlerGeneration: receipt.handlerGeneration } }
  } catch (error) { return errorReply({ ...request, handlerGeneration: context.record.generation }, controlError(error, "INCOMPLETE")) }
}