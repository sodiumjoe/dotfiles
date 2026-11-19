import type { ConversationListener } from "../agent/conversation.js"
import type { JsonObject } from "../agent/session-config.js"
import type { OutboxStore } from "./outbox.js"

export function recordTurns(input: { childId: string; conversation: { observe(listener: ConversationListener): { close(): void } }; outbox: OutboxStore; running(): string | null; changed(): void }): { close(): void } {
  const open = new Map<string, { text: string; gap: boolean }>()
  const latest = () => [...open.values()].at(-1)
  const finish = (submissionId: string, state: "answer" | "failed" | "interrupted", stopReason: string | null, failure: string | null): void => {
    const turn = open.get(submissionId)
    if (!turn) return
    open.delete(submissionId)
    void input.outbox.append(input.childId, { submissionId, state, stopReason, failure, text: turn.text }).then(() => input.changed()).catch(() => undefined)
  }
  void input.outbox.read(input.childId).then(outbox => {
    if (outbox?.open && outbox.open !== input.running()) return input.outbox.append(input.childId, { submissionId: outbox.open, state: "interrupted", stopReason: null, failure: null, text: "" }).then(() => input.changed())
  }).catch(() => undefined)
  const observation = input.conversation.observe(notification => {
    if (notification.kind === "closed") { for (const submissionId of [...open.keys()]) finish(submissionId, "interrupted", null, null); return }
    const event = notification.event
    const current = latest()
    if (event.kind === "submitted") {
      open.set(event.submissionId, { text: "", gap: false })
      void input.outbox.update(input.childId, outbox => { outbox.open = event.submissionId }).catch(() => undefined)
    } else if (event.kind === "update" && current && !event.replay) {
      const kind = event.update.sessionUpdate
      if (kind === "tool_call" || kind === "tool_call_update") current.gap = true
      else if (kind === "agent_message_chunk") {
        const content = event.update.content as JsonObject | undefined
        if (content?.type === "text" && typeof content.text === "string") {
          if (current.gap) current.text = ""
          current.gap = false
          current.text += content.text
        }
      }
    } else if (event.kind === "turn" && (event.state === "completed" || event.state === "failed")) {
      finish(event.submissionId, event.state === "failed" ? "failed" : "answer", event.stopReason, event.failure?.code ?? null)
    }
  })
  return { close: () => observation.close() }
}