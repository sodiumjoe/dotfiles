import { createHash } from "node:crypto"
import { id } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import type { Conversation, TurnState } from "./conversation.js"
import { validateTurnInput, type StopReason, type TurnOptions, type TurnResult } from "./session-events.js"
import { AgentError, ProviderRequestError, agentFailure, type AgentFailure, type AgentTuple } from "./types.js"
import { canonicalJson, type JsonObject } from "./session-config.js"
import { withoutAgencyMetadata } from "./acp.js"

export type SubmissionRequest = { submissionId: string; text: string; limits: TurnOptions }
export type AcpSubmissionRequest = { submissionId: string; prompt: JsonObject[]; meta?: JsonObject; originConnectionId?: string; originAttachment?: string; editorAddress?: string | null }
export type SubmissionReceipt = { submissionId: string; digest: string; state: TurnState; stopReason: StopReason | null; failure: AgentFailure | null; acceptedSeq: number; completedSeq: number | null }
export type TurnCoordinator = { submit(request: SubmissionRequest): Promise<SubmissionReceipt>; submitAcp(request: AcpSubmissionRequest, beforeAccepted?: () => Promise<void>): Promise<SubmissionReceipt>; inspect(submissionId: string): SubmissionReceipt | null; cancel(submissionId: string): Promise<SubmissionReceipt>; settled(submissionId: string): Promise<TurnResult>; settledAcp(submissionId: string): Promise<JsonObject>; busy(): boolean; close(failure: AgentFailure | null): void }

export function createTurnCoordinator(input: { target: AgentTuple; conversation: Conversation; invoke?(text: string, limits: TurnOptions): Promise<TurnResult>; invokeAcp?(params: JsonObject): Promise<JsonObject>; cancel(submissionId: string): Promise<void>; validate(): Promise<void>; queue?: MutationQueue; beforeAccepted?(request: AcpSubmissionRequest): Promise<void>; onAccepted?(request: AcpSubmissionRequest): void; onSettled?(submissionId: string): void }): TurnCoordinator {
  const { conversation } = input, queue = input.queue ?? new MutationQueue(), receipts = new Map<string, SubmissionReceipt>(), nativeResults = new Map<string, JsonObject>(), nativeErrors = new Map<string, ProviderRequestError>()
  type Active = { legacy: boolean; submissionId: string; deferred: ReturnType<typeof Promise.withResolvers<TurnResult>>; native: ReturnType<typeof Promise.withResolvers<JsonObject>> }
  const active = new Map<string, Active>()
  const cancelled = new Set<string>()
  let closed = false, cancellation: Promise<void> | undefined
  const check = (): void => { if (closed) throw new AgentError("NOT_READY") }
  const inspect = (submissionId: string): SubmissionReceipt | null => structuredClone(receipts.get(submissionId) ?? null)
  const terminal = (receipt: SubmissionReceipt, result: TurnResult | null, failure: AgentFailure | null): void => {
    receipt.state = failure ? "failed" : "completed"; receipt.stopReason = result?.stopReason ?? null; receipt.failure = failure
    receipt.completedSeq = conversation.append({ kind: "turn", submissionId: receipt.submissionId, state: receipt.state, stopReason: receipt.stopReason, failure })
  }
  const submit = async (request: AcpSubmissionRequest, legacy?: SubmissionRequest, beforeAccepted?: () => Promise<void>): Promise<SubmissionReceipt> => {
      id(request.submissionId)
      if (!Array.isArray(request.prompt) || !request.prompt.length || request.prompt.some(value => !value || Array.isArray(value) || typeof value !== "object" || typeof value.type !== "string")) throw new AgentError("INVALID_AGENT_STATE")
      const params = withoutAgencyMetadata({ prompt: request.prompt, ...(request.meta ? { _meta: request.meta } : {}) })
      const encoded = canonicalJson(params)
      const digest = createHash("sha256").update(encoded, "utf8").digest("hex")
      return queue.run(async () => {
        check(); await input.validate(); check()
        const previous = receipts.get(request.submissionId)
        if (previous) { if (previous.digest !== digest) throw new AgentError("COMMAND_CONFLICT"); return structuredClone(previous) }
        if (active.size && (legacy || [...active.values()].some(value => value.legacy))) throw new AgentError("BUSY")
        await input.beforeAccepted?.(request)
        await beforeAccepted?.()
        check()
        input.onAccepted?.(request)
        const text = request.prompt.filter(value => value.type === "text" && typeof value.text === "string").map(value => value.text).join("")
        const receipt: SubmissionReceipt = { submissionId: request.submissionId, digest, state: "accepted", stopReason: null, failure: null, acceptedSeq: conversation.append({ kind: "submitted", submissionId: request.submissionId, text, prompt: structuredClone(request.prompt), ...(request.meta ? { meta: params._meta as JsonObject } : {}), ...(request.originConnectionId ? { originConnectionId: request.originConnectionId } : {}) }), completedSeq: null }
        receipts.set(request.submissionId, receipt)
        const current: Active = { legacy: !!legacy, submissionId: request.submissionId, deferred: Promise.withResolvers<TurnResult>(), native: Promise.withResolvers<JsonObject>() }
        void current.deferred.promise.catch(() => undefined)
        void current.native.promise.catch(() => undefined)
        active.set(request.submissionId, current)
        void Promise.resolve().then(async () => {
          if (closed) return
          try {
            receipt.state = "running"
            conversation.append({ kind: "turn", submissionId: request.submissionId, state: "running", stopReason: null, failure: null })
            let result: TurnResult, native: JsonObject
            if (legacy && input.invoke) { result = await input.invoke(legacy.text, legacy.limits); native = { stopReason: result.stopReason } }
            else {
              if (!input.invokeAcp) throw new AgentError("UNSUPPORTED_SESSION_FEATURE")
              native = await input.invokeAcp(params)
              result = { stopReason: native.stopReason as StopReason, text: "" }
            }
            if (!closed) terminal(receipt, result, null)
            if (!closed) nativeResults.set(request.submissionId, structuredClone(native))
            current.native.resolve(native)
            current.deferred.resolve(result)
          } catch (error) {
            const failure = error instanceof AgentError ? agentFailure(error) : agentFailure(new AgentError("STARTUP_FAILED"))
            if (!closed) terminal(receipt, null, failure)
            current.deferred.reject(new AgentError(failure.code))
            if (!closed && error instanceof ProviderRequestError) nativeErrors.set(request.submissionId, error)
            current.native.reject(error instanceof ProviderRequestError ? error : new AgentError(failure.code))
          } finally {
            cancelled.delete(request.submissionId)
            if (!cancelled.size) cancellation = undefined
            if (active.delete(request.submissionId)) input.onSettled?.(request.submissionId)
          }
        })
        return structuredClone(receipt)
      })
  }
  return {
    inspect, busy: () => active.size > 0,
    submitAcp: (request, beforeAccepted) => submit(request, undefined, beforeAccepted),
    async submit(request) { validateTurnInput(request.text, request.limits); return submit({ submissionId: request.submissionId, prompt: [{ type: "text", text: request.text }] }, request) },
    async cancel(submissionId) {
      id(submissionId)
      let pendingCancel: Promise<void> | undefined
      await queue.run(async () => {
        check(); await input.validate(); check()
        const receipt = receipts.get(submissionId)
        if (!receipt) throw new AgentError("UNAVAILABLE")
        const current = active.get(submissionId)
        if (!current) return
        if ([...active.keys()].some(id => !cancelled.has(id))) {
          cancellation = input.cancel(submissionId)
          for (const id of active.keys()) cancelled.add(id)
        }
        pendingCancel = cancellation
      })
      await pendingCancel
      return inspect(submissionId)!
    },
    settled(submissionId) {
      if (active.has(submissionId)) return active.get(submissionId)!.deferred.promise
      const receipt = receipts.get(submissionId)
      if (!receipt) return Promise.reject(new AgentError("UNAVAILABLE"))
      if (receipt.failure) return Promise.reject(new AgentError(receipt.failure.code))
      const observation = conversation.observe(() => {}), snapshot = observation.snapshot
      observation.close()
      if (snapshot.firstSeq > receipt.acceptedSeq || receipt.completedSeq === null) return Promise.reject(new AgentError("INCOMPLETE"))
      const text = snapshot.events.filter(event => event.seq > receipt.acceptedSeq && event.seq < receipt.completedSeq! && event.kind === "update" && !event.replay && event.update.sessionUpdate === "agent_message_chunk").map(event => event.kind === "update" ? (event.update.content as { text: string }).text : "").join("")
      return Promise.resolve({ stopReason: receipt.stopReason!, text })
    },
    settledAcp(submissionId) {
      if (active.has(submissionId)) return active.get(submissionId)!.native.promise
      if (nativeErrors.has(submissionId)) return Promise.reject(nativeErrors.get(submissionId))
      const receipt = receipts.get(submissionId), result = nativeResults.get(submissionId)
      if (receipt?.failure) return Promise.reject(new AgentError(receipt.failure.code))
      return result ? Promise.resolve(structuredClone(result)) : Promise.reject(new AgentError(receipt ? "INCOMPLETE" : "UNAVAILABLE"))
    },
    close(failure) {
      if (closed) return
      closed = true
      const pending = [...active.values()]; active.clear()
      for (const current of pending) {
        current.deferred.reject(new AgentError(failure?.code ?? "STARTUP_FAILED")); current.native.reject(new AgentError(failure?.code ?? "STARTUP_FAILED"))
        input.onSettled?.(current.submissionId)
      }
      receipts.clear(); nativeResults.clear(); nativeErrors.clear(); cancelled.clear(); cancellation = undefined
    },
  }
}