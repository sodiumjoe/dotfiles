import { randomUUID } from "node:crypto"
import { CatalogError, id, keys, object, providerId, text } from "../config/validate.js"
import type { LiveCore } from "../live/core.js"
import { RequestError } from "../live/errors.js"
import { liveErrorReply, REQUEST_PROTOCOL, type LiveReply } from "../live/protocol.js"
import type { Box } from "./box.js"
import { deliverToParent } from "./deliver.js"

export const DELEGATION_OPS = ["child-start", "child-ask", "child-stop", "children", "child-mark", "deliver"]
const LONG_TEXT_BYTES = 262144

function invalid(message: string): never { throw new RequestError("INVALID", message) }
export function longText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > LONG_TEXT_BYTES || !value.isWellFormed()) invalid(label + " must be 1 to " + LONG_TEXT_BYTES + " bytes of well-formed text")
  return value
}
function shape(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  keys(value, ["op", ...required, ...optional.filter(key => Object.hasOwn(value, key))])
}
export function validated<T>(parse: () => T): T {
  try { return parse() } catch (error) { if (error instanceof CatalogError) return invalid("invalid request payload"); throw error }
}

async function perform(op: string, value: Record<string, unknown>, box: Box, core: LiveCore): Promise<Record<string, unknown>> {
  if (op === "child-start") {
    const request = validated(() => {
      shape(value, ["childId", "parent", "depth", "task", "ref", "remote", "path"], ["backendId", "model"])
      const parent = object(value.parent); keys(parent, ["hostId", "agentId"])
      if (typeof value.depth !== "number" || !Number.isInteger(value.depth) || value.depth < 0 || value.depth > 64) invalid("depth must be a small non-negative integer")
      return { childId: id(value.childId), parent: { hostId: text(parent.hostId), agentId: id(parent.agentId) }, depth: value.depth, task: longText(value.task, "task"), ref: text(value.ref, 1024), remote: text(value.remote, 1024), path: text(value.path, 4096), ...(Object.hasOwn(value, "backendId") ? { backendId: providerId(value.backendId) } : {}), ...(Object.hasOwn(value, "model") ? { model: text(value.model, 1024) } : {}) }
    })
    return box.start(request)
  }
  if (op === "child-ask") {
    const request = validated(() => { shape(value, ["childId", "text"]); return { childId: id(value.childId), text: longText(value.text, "text") } })
    return box.ask(request.childId, request.text)
  }
  if (op === "child-stop") return box.stop(validated(() => { shape(value, ["childId"]); return id(value.childId) }))
  if (op === "children") { validated(() => shape(value, [])); return { state: "children", children: await box.children() } }
  if (op === "child-mark") {
    const request = validated(() => {
      shape(value, ["childId", "submissionIds"])
      if (!Array.isArray(value.submissionIds) || value.submissionIds.length > 64) invalid("submissionIds must be a short list")
      return { childId: id(value.childId), submissionIds: value.submissionIds.map(item => id(item)) }
    })
    return box.mark(request.childId, request.submissionIds)
  }
  const request = validated(() => {
    shape(value, ["parentAgentId", "childId", "submissionId", "label", "text"])
    return { parentAgentId: id(value.parentAgentId), childId: id(value.childId), submissionId: id(value.submissionId), label: longText(value.label, "label").toWellFormed(), text: longText(typeof value.text === "string" ? value.text.toWellFormed() : value.text, "text") }
  })
  return deliverToParent(core, request)
}

export async function delegationReply(op: string, value: Record<string, unknown>, box: Box, core: LiveCore): Promise<LiveReply> {
  const requestId = randomUUID()
  try { return { protocol: REQUEST_PROTOCOL, requestId, ok: true, result: await perform(op, value, box, core) as never } }
  catch (error) { return liveErrorReply({ requestId }, error) }
}