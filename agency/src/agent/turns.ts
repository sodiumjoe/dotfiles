import { createHash } from "node:crypto"
import { id } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import type { Conversation, TurnState } from "./conversation.js"
import { validateTurnInput, type StopReason, type TurnOptions, type TurnResult } from "./session-events.js"
import { AgentError, agentFailure, type AgentFailure, type AgentTuple } from "./types.js"

export type SubmissionRequest = { submissionId: string; text: string; limits: TurnOptions }
export type SubmissionReceipt = { submissionId: string; digest: string; state: TurnState; stopReason: StopReason | null; failure: AgentFailure | null; acceptedSeq: number; completedSeq: number | null }
export type TurnCoordinator = { submit(request: SubmissionRequest): Promise<SubmissionReceipt>; inspect(submissionId: string): SubmissionReceipt | null; cancel(submissionId: string): Promise<SubmissionReceipt>; settled(submissionId: string): Promise<TurnResult>; close(failure: AgentFailure | null): void }

export function createTurnCoordinator(input: { target: AgentTuple; conversation: Conversation; invoke(text: string, limits: TurnOptions): Promise<TurnResult>; cancel(): Promise<void>; validate(): Promise<void>; queue?: MutationQueue; onSettled?(): void }): TurnCoordinator {
  const { conversation } = input, queue = input.queue ?? new MutationQueue(), receipts = new Map<string, SubmissionReceipt>()
  type Active = { submissionId: string; deferred: ReturnType<typeof Promise.withResolvers<TurnResult>>; cancellation?: Promise<void> }
  let active: Active | null = null, closed = false
  const check = (): void => { if (closed) throw new AgentError("NOT_READY") }
  const inspect = (submissionId: string): SubmissionReceipt | null => structuredClone(receipts.get(submissionId) ?? null)
  const terminal = (receipt: SubmissionReceipt, result: TurnResult | null, failure: AgentFailure | null): void => {
    receipt.state = failure ? "failed" : "completed"; receipt.stopReason = result?.stopReason ?? null; receipt.failure = failure
    receipt.completedSeq = conversation.append({ kind: "turn", submissionId: receipt.submissionId, state: receipt.state, stopReason: receipt.stopReason, failure })
  }
  return {
    inspect,
    async submit(request) {
      id(request.submissionId); validateTurnInput(request.text, request.limits)
      const digest = createHash("sha256").update(request.text, "utf8").digest("hex")
      return queue.run(async () => {
        check(); await input.validate(); check()
        const previous = receipts.get(request.submissionId)
        if (previous) { if (previous.digest !== digest) throw new AgentError("COMMAND_CONFLICT"); return structuredClone(previous) }
        if (active) throw new AgentError("INCOMPLETE")
        const receipt: SubmissionReceipt = { submissionId: request.submissionId, digest, state: "accepted", stopReason: null, failure: null, acceptedSeq: conversation.append({ kind: "submitted", submissionId: request.submissionId, text: request.text }), completedSeq: null }
        receipts.set(request.submissionId, receipt)
        const current: Active = { submissionId: request.submissionId, deferred: Promise.withResolvers<TurnResult>() }
        void current.deferred.promise.catch(() => undefined)
        active = current
        void Promise.resolve().then(async () => {
          if (closed) return
          try {
            receipt.state = "running"
            conversation.append({ kind: "turn", submissionId: request.submissionId, state: "running", stopReason: null, failure: null })
            const result = await input.invoke(request.text, request.limits)
            if (!closed) terminal(receipt, result, null)
            current.deferred.resolve(result)
          } catch (error) {
            const failure = error instanceof AgentError ? agentFailure(error) : agentFailure(new AgentError("STARTUP_FAILED"))
            if (!closed) terminal(receipt, null, failure)
            current.deferred.reject(new AgentError(failure.code))
          } finally { if (active === current) active = null; input.onSettled?.() }
        })
        return structuredClone(receipt)
      })
    },
    async cancel(submissionId) {
      id(submissionId)
      let cancellation: Promise<void> | undefined
      await queue.run(async () => {
        check(); await input.validate(); check()
        const receipt = receipts.get(submissionId)
        if (!receipt) throw new AgentError("UNAVAILABLE")
        if (active?.submissionId !== submissionId) return
        active.cancellation ??= input.cancel()
        cancellation = active.cancellation
      })
      await cancellation
      return inspect(submissionId)!
    },
    settled(submissionId) {
      if (active?.submissionId === submissionId) return active.deferred.promise
      const receipt = receipts.get(submissionId)
      if (!receipt) return Promise.reject(new AgentError("UNAVAILABLE"))
      if (receipt.failure) return Promise.reject(new AgentError(receipt.failure.code))
      const observation = conversation.observe(() => {}), snapshot = observation.snapshot
      observation.close()
      if (snapshot.firstSeq > receipt.acceptedSeq || receipt.completedSeq === null) return Promise.reject(new AgentError("INCOMPLETE"))
      const text = snapshot.events.filter(event => event.seq > receipt.acceptedSeq && event.seq < receipt.completedSeq! && event.kind === "update" && !event.replay && event.update.sessionUpdate === "agent_message_chunk").map(event => event.kind === "update" ? (event.update.content as { text: string }).text : "").join("")
      return Promise.resolve({ stopReason: receipt.stopReason!, text })
    },
    close(failure) {
      if (closed) return
      closed = true
      active?.deferred.reject(new AgentError(failure?.code ?? "STARTUP_FAILED")); active = null; receipts.clear()
    },
  }
}