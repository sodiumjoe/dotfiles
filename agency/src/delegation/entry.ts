import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { relative } from "node:path"
import type { JsonObject } from "../agent/session-config.js"
import type { LiveCore } from "../live/core.js"
import { RequestError } from "../live/errors.js"
import type { LiveOperation } from "../live/protocol.js"
import { normalizeRemote } from "./checkout.js"
import type { Coordinator, DelegateRequest } from "./coordinator.js"
import type { OutboxStore } from "./outbox.js"
import { unwrapReply } from "./reply.js"

export const MAX_DEPTH = 1
type DelegateOperation = Extract<LiveOperation, { op: "delegate" }>

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())))
}

async function repository(cwd: string): Promise<{ remote: string; path: string }> {
  const refusal = new RequestError("INVALID", cwd + " is not in a git repository with an origin remote")
  try {
    const here = await realpath(cwd), top = await realpath(await git(here, ["rev-parse", "--show-toplevel"])), origin = await git(here, ["remote", "get-url", "origin"])
    if (!origin) throw refusal
    return { remote: normalizeRemote(origin), path: relative(top, here) || "." }
  } catch { throw refusal }
}

export function createDelegateEntry(input: { core: LiveCore; outbox: OutboxStore; hostId: string; isLaptop(): boolean; coordinator: Coordinator; upward(payload: JsonObject): Promise<unknown>; owners(): number }): (request: DelegateOperation) => Promise<JsonObject> {
  return async request => {
    if (!input.core.liveAgents().some(agent => agent.agentId === request.callerAgentId)) throw new RequestError("INVALID", "agy delegate must run inside an Agency agent")
    const parent = { hostId: input.hostId, agentId: request.callerAgentId }
    let delegate: DelegateRequest
    if (request.action === "start") {
      const depth = (await input.outbox.read(request.callerAgentId))?.depth ?? 0
      if (depth >= MAX_DEPTH) throw new RequestError("INVALID", "children cannot start children (depth limit " + MAX_DEPTH + ")")
      const { remote, path } = await repository(request.cwd)
      delegate = { op: "start", parent, parentName: "", depth: depth + 1, task: request.task!, ref: request.ref!, remote, path, ...(request.backendId ? { backendId: request.backendId } : {}), ...(request.model ? { model: request.model } : {}) }
    } else if (request.action === "ask") delegate = { op: "ask", parent, childId: request.childId!, text: request.text! }
    else if (request.action === "stop") delegate = { op: "stop", parent, childId: request.childId! }
    else delegate = { op: "list", parent }
    if (input.isLaptop()) return input.coordinator.handle(delegate)
    if (input.owners() === 0) throw new RequestError("UNAVAILABLE", "this devbox is not connected to the laptop")
    return unwrapReply(await input.upward(delegate as unknown as JsonObject))
  }
}
