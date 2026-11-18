import type { PermissionBroker } from "../acp/permissions.js"
import type { EventLog } from "../handler/event-log.js"
import { requestFailure, RequestError } from "./errors.js"
import type { LiveAgent, LiveTable } from "./state.js"

export function stopAgent(agent: LiveAgent, input: { table: LiveTable; permissions: PermissionBroker; events?: EventLog; reason: "request" | "failure" | "shutdown" }): Promise<void> {
  if (agent.stopped) return agent.stopped
  agent.phase = "stopping"
  input.table.touch()
  agent.conversation.append({ kind: "lifecycle", phase: "stopping" })
  agent.editor?.revoke()
  input.permissions.invalidate(agent.tuple)
  agent.controller.abort()
  agent.stopped = (async () => {
    try {
      await agent.launched.catch(() => undefined)
      await Promise.allSettled([...agent.prompts])
      if (agent.owner) await agent.owner.cleanup()
      input.events?.append({ type: "agent_stopped", agentId: agent.agentId, reason: input.reason })
    } catch (error) {
      const failure = requestFailure(error)
      input.events?.append({ type: "agent_stop_failed", agentId: agent.agentId, ...failure })
      throw new RequestError("FAILED", "agent " + agent.agentId + " did not stop cleanly: " + failure.message)
    } finally {
      agent.turns?.close(null)
      agent.conversation.append({ kind: "lifecycle", phase: "stopped" })
      agent.conversation.close()
      agent.editor?.close()
      agent.owner?.dispose()
      input.table.remove(agent)
    }
  })()
  return agent.stopped
}