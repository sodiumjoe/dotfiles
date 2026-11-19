import { createHash } from "node:crypto"
import { RequestError } from "../live/errors.js"
import type { LiveCore } from "../live/core.js"

export function childSubmissionId(childId: string, submissionId: string): string {
  const hex = createHash("sha256").update(childId + ":" + submissionId).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 + (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export async function deliverToParent(core: LiveCore, request: { parentAgentId: string; childId: string; submissionId: string; label: string; text: string }): Promise<{ state: "delivered" }> {
  const agent = core.liveAgents().find(value => value.agentId === request.parentAgentId)
  if (!agent || agent.phase !== "ready") throw new RequestError("NOT_FOUND", "parent agent " + request.parentAgentId + " is not live")
  const submissionId = childSubmissionId(request.childId, request.submissionId)
  if (agent.turns?.inspect(submissionId)) return { state: "delivered" }
  if (core.liveRows().find(value => value.agentId === request.parentAgentId)?.live?.activity !== "idle") throw new RequestError("BUSY", "parent agent " + request.parentAgentId + " is busy")
  await core.submitAcp(agent.tuple, { submissionId, prompt: [{ type: "text", text: request.label.toWellFormed() + "\n\n" + request.text.toWellFormed() }] })
  return { state: "delivered" }
}