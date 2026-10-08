import { parsePublicationDestination } from "../bureau/publication-policy.js"
import { parseEntryRef } from "../bureau/entry.js"
import { parsePermissionRef } from "../orchestration/permission-routing.js"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { absolutePath, hash, id, keys, object, providerId, text, timestamp } from "../catalog/types.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { captureInvocation } from "../bureau/service.js"
import type { LaunchAssignment, RootLaunch, OrchestrationHost } from "../bureau/host.js"
import type { JournalPool } from "../orchestration/journal.js"
import { canonicalDigest, enumValue, fail, parseAgentRef, parseAttemptRef, parseAssignmentSpec, parseEventRef, parseExecutionRef, parseGitInput, parseLineage, parseOverrides } from "../orchestration/types.js"
import { parseGitPreparation } from "../orchestration/git-worktree.js"
import { parseRequestedSettings } from "../agent/session-config.js"
import type { AcpSubmissionRequest } from "../agent/turns.js"
import { createBridgePeer } from "./codec.js"
import { BRIDGE_PROTOCOL, parseAdmission, type BridgeHello } from "./protocol.js"
import { parseHostCall } from "./invocation.js"
import { createPagedReads } from "./paging.js"
import { BRIDGE_FRAME_BYTES } from "./protocol.js"

function parseLaunch(channel: string, raw: unknown): LaunchAssignment | RootLaunch {
  const v = object(raw), common = ["commandId", "runId", "agent", "handlerGeneration", "bindingEpoch"]
  const base = { commandId: id(v.commandId), runId: id(v.runId), agent: parseAgentRef(v.agent), handlerGeneration: id(v.handlerGeneration), bindingEpoch: id(v.bindingEpoch) }
  if (channel === "restoreRoot") { keys(v, common); return base as RootLaunch }
  if (channel === "launchRoot") {
    keys(v, [...common, "cwd", "backendId", "modelId", "overrides", ...(Object.hasOwn(v, "retryMode") ? ["retryMode"] : [])])
    if (v.retryMode !== undefined && v.retryMode !== "restore") fail("INVALID_LAUNCH")
    return { ...base, cwd: absolutePath(v.cwd), backendId: providerId(v.backendId), modelId: text(v.modelId), overrides: parseOverrides(v.overrides), ...(v.retryMode ? { retryMode: "restore" as const } : {}) }
  }
  keys(v, [...common, "ref", "spec", "lineage", "git", "retryMode", "savedSettings", ...["savedGit", "publication"].filter(key => Object.hasOwn(v, key))])
  const spec = parseAssignmentSpec(v.spec), ref = parseAttemptRef(v.ref), lineage = parseLineage(v.lineage)
  const g = v.git === null ? null : object(v.git), git = g === null ? null : { ...parseGitInput({ remote: g.remote, repository: g.repository, baseOid: g.baseOid }), branch: text(g.branch) }
  if (g) keys(g, ["remote", "repository", "baseOid", "branch"])
  if (ref.runId !== base.runId || lineage.runId !== base.runId || lineage.assignmentId !== ref.assignmentId || spec.hostId !== base.agent.hostId || JSON.stringify(spec.parent) !== JSON.stringify(lineage.parent)) fail("INVALID_LAUNCH")
  return { ...base, spec, ref, lineage, git, ...(Object.hasOwn(v, "publication") ? { publication: parsePublicationDestination(v.publication) } : {}), retryMode: enumValue(v.retryMode, ["new", "restore", "replace"]), savedSettings: v.savedSettings === null ? null : parseRequestedSettings(v.savedSettings), ...(Object.hasOwn(v, "savedGit") ? { savedGit: v.savedGit === null ? null : parseGitPreparation(v.savedGit) } : {}) }
}
export async function createHandlerBridge(input: { root: string; host: OrchestrationHost; journals: JournalPool; replay?(): Promise<void>; sourceRevision?: string; identity?: { hostId: string; handlerGeneration: string } }) {
  const snapshot = input.identity ?? await input.host.snapshot(), revision = input.sourceRevision ?? text(JSON.parse(await readFile(new URL("../../build-manifest.json", import.meta.url), "utf8")).sourceRevision)
  const peers = new Set<ReturnType<typeof createBridgePeer>>()
  let coordinator: ReturnType<typeof createBridgePeer> | undefined
  const server = await bindPrivateSocket(input.root, "bridge.sock", socket => {
    const hello: BridgeHello = { protocol: BRIDGE_PROTOCOL, hostId: snapshot.hostId, handlerGeneration: snapshot.handlerGeneration, connectionId: randomUUID(), sourceRevision: revision, nodeVersion: process.version, capabilities: ["snapshot", "launch", "launchRoot", "restoreRoot", "invoke", "inspectCommand", "submission", "submit", "stop", "origin-read", "origin-retained", "origin-ack", "coordinate", "read-pages", "read-open", "read-page", "read-close", ...(input.host.publicationInspect ? ["publication-inspect"] : []), ...(input.host.entryPrepare ? ["entry-prepare", "entry-inspect"] : []), ...(input.host.permissionDecide ? ["permission-decide", "permission-inspect", "permission-read", "permission-ack"] : []), ...(input.replay ? ["replay"] : [])], outboxCursor: 0 }
    const peer = createBridgePeer({ input: socket, output: socket, hello }); peers.add(peer)
    void peer.closed.then(() => { peers.delete(peer); if (coordinator === peer) coordinator = undefined; socket.destroy() })
    const target = (raw: unknown) => { const execution = parseExecutionRef(raw); if (execution.hostId !== hello.hostId || execution.handlerGeneration !== hello.handlerGeneration) fail("STALE_HANDLER"); return execution }
    const origin = (raw: unknown) => { const key = object(raw); keys(key, ["hostId", "runId", "streamId"]); if (hash(key.hostId) !== hello.hostId || id(key.runId) !== id(key.streamId)) fail("INVALID_ORIGIN"); return input.journals.forRun(id(key.runId)) }
    const reads = createPagedReads((channel, payload, signal) => handle(channel, payload, "", signal))
    void peer.closed.then(() => reads.close())
    async function handle(channel: string, raw: unknown, requestId: string, signal: AbortSignal): Promise<unknown> {
      const p = object(raw)
      if (["read-open", "read-page", "read-close"].includes(channel)) return reads.request(channel, p, signal)
      if (channel === "coordinate") { keys(p, []); if (coordinator && coordinator !== peer) fail("COORDINATOR_EXISTS"); coordinator = peer; return { connected: true } }
      if (channel === "replay") { keys(p, []); if (coordinator !== peer || !input.replay) fail("UNSUPPORTED_CAPABILITY"); await input.replay(); return { replayed: true } }
      if (channel === "entry-prepare" && input.host.entryPrepare) { keys(p, ["commandId", "ref"]); const ref = parseEntryRef(p.ref); if (ref.hostId !== hello.hostId || ref.target.handlerGeneration !== hello.handlerGeneration) fail("STALE_EXECUTION"); return input.host.entryPrepare(id(p.commandId), ref) }
      if (channel === "entry-inspect" && input.host.entryInspect) { keys(p, ["commandId"]); return input.host.entryInspect(id(p.commandId)) }
      if (channel === "permission-decide" && input.host.permissionDecide) { keys(p, ["commandId", "ref", "optionId"]); const ref = parsePermissionRef(p.ref); if (ref.hostId !== hello.hostId) fail("INVALID_ORIGIN"); return input.host.permissionDecide(id(p.commandId), ref, text(p.optionId)) }
      if (channel === "permission-inspect" && input.host.permissionInspect) { keys(p, ["commandId"]); return input.host.permissionInspect(id(p.commandId)) }
      if (channel === "permission-read" && input.host.permissionRead) { keys(p, ["after", "limit"]); return input.host.permissionRead(timestamp(p.after), timestamp(p.limit)) }
      if (channel === "permission-ack" && input.host.permissionAcknowledge) { keys(p, ["event"]); await input.host.permissionAcknowledge(parseEventRef(p.event)); return { acknowledged: true } }
      if (channel === "publication-inspect" && input.host.publicationInspect) { keys(p, ["commandId"]); return input.host.publicationInspect(id(p.commandId)) }
      if (channel === "snapshot") { keys(p, []); return input.host.snapshot() }
      if (channel === "invoke") {
        keys(p, ["channel", "payload", "invocation"])
        const call = parseHostCall({ channel: p.channel, payload: p.payload }), command = parseLaunch(call.channel, call.payload.command), invocation = captureInvocation(p.invocation as Parameters<typeof captureInvocation>[0])
        if (command.agent.hostId !== hello.hostId || command.handlerGeneration !== hello.handlerGeneration) fail("STALE_HANDLER")
        if (call.channel === "launch") return input.host.launch(command as LaunchAssignment, invocation)
        if (call.channel === "launchRoot") return input.host.launchRoot(command as RootLaunch, invocation)
        if (!input.host.restoreRoot) fail("UNSUPPORTED_CAPABILITY")
        return input.host.restoreRoot(command, invocation)
      }
      if (channel === "inspectCommand") { keys(p, ["commandId", "handlerGeneration"]); if (id(p.handlerGeneration) !== hello.handlerGeneration) fail("STALE_HANDLER"); return input.host.inspectCommand(id(p.commandId), hello.handlerGeneration) }
      if (channel === "submission") { keys(p, ["target", "submissionId"]); return input.host.submission(target(p.target), id(p.submissionId)) }
      if (channel === "stop") { keys(p, ["target", "commandId"]); return input.host.stop(id(p.commandId), target(p.target)) }
      if (channel === "submit") {
        keys(p, ["target", "request", "admissionRequired"])
        if (typeof p.admissionRequired !== "boolean") fail("INVALID_ADMISSION")
        const execution = target(p.target), r = object(p.request)
        keys(r, ["submissionId", "prompt", ...(Object.hasOwn(r, "meta") ? ["meta"] : [])])
        if (!Array.isArray(r.prompt)) fail("INVALID_SUBMISSION")
        const request: AcpSubmissionRequest = { submissionId: id(r.submissionId), prompt: structuredClone(r.prompt), ...(r.meta === undefined ? {} : { meta: object(r.meta) as NonNullable<AcpSubmissionRequest["meta"]> }) }
        const admission = parseAdmission({ execution, submissionId: request.submissionId, digest: canonicalDigest({ prompt: request.prompt }) })
        return input.host.submit(execution, request, async () => { if (signal.aborted) throw signal.reason; if (p.admissionRequired) await peer.prepareAdmission(requestId, admission); if (signal.aborted) throw signal.reason })
      }
      if (channel === "origin-read" || channel === "origin-retained") {
        keys(p, ["key", "after", "limit"])
        const journal = origin(p.key), after = timestamp(p.after), page = await (channel === "origin-read" ? journal.read : journal.retainedRead)(after, timestamp(p.limit)), entries = []
        let bytes = 1024
        for (const entry of page.entries) { const size = Buffer.byteLength(JSON.stringify(entry)) + 1; if (entries.length && bytes + size > BRIDGE_FRAME_BYTES - 1024) break; entries.push(entry); bytes += size }
        return { ...page, entries, nextCursor: entries.at(-1)?.seq ?? after }
      }
      if (channel === "origin-ack") { keys(p, ["key", "ref"]); await origin(p.key).acknowledge("bureau", parseEventRef(p.ref)); return { acknowledged: true } }
      fail("UNSUPPORTED_CAPABILITY")
    }
    peer.onRequest(handle)
    peer.sendHello()
  })
  const unsubscribe = input.host.onSettled?.(parent => { void coordinator?.request("settled", { parent }).catch(() => undefined) })
  return { async coordinatorRequest(payload: unknown, signal?: AbortSignal) { if (!coordinator) fail("BUREAU_UNAVAILABLE"); return coordinator.request(object(payload).kind === "human" ? "human" : "tool", payload, { timeoutMs: 0, ...(signal ? { signal } : {}) }) }, async close() { unsubscribe?.(); for (const peer of peers) peer.close(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}