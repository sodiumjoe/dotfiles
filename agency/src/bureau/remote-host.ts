import type { HostEnrollment } from "./hosts.js"
import type { Invocation, LaunchAssignment, RootLaunch, OrchestrationHost, LaunchReceipt, StopReceipt, HostSnapshot } from "./host.js"
import { connectHost, parseHostSnapshot, type BridgeConnection } from "../bridge/ssh.js"
import { parseOriginReceipt } from "../orchestration/receipts.js"
import { parseSubmissionReceipt } from "../agent/attachment-protocol.js"
import { fail, parseAgentRef, parseExecutionRef, type EventRef } from "../orchestration/types.js"
import { object } from "../catalog/types.js"
import type { RemoteOrigins, OriginSource, OriginKey } from "./origins.js"
import { replayOriginSnapshot } from "../bridge/replay.js"

export function createRemoteHost(input: { enrollment: HostEnrollment; connect?: () => Promise<BridgeConnection>; origins?: RemoteOrigins; onTool?(payload: unknown, signal?: AbortSignal): Promise<unknown> }) {
  const { enrollment } = input
  const settled = new Set<Parameters<NonNullable<OrchestrationHost["onSettled"]>>[0]>()
  let connection: BridgeConnection | undefined, connecting: Promise<BridgeConnection> | undefined
  async function connected() {
    if (connection) return connection
    connecting ??= (input.connect ?? (() => connectHost(enrollment)))().then(peer => { connection = peer
      peer.onRequest(async (channel, payload, _requestId, signal) => {
        if (channel === "tool" && input.onTool) return input.onTool(payload, signal)
        if (channel === "settled") { const parent = parseAgentRef(object(payload).parent); if (parent.hostId !== enrollment.hostId) fail("STALE_EXECUTION"); for (const listener of settled) listener(parent); return { observed: true } }
        fail("UNSUPPORTED_CAPABILITY")
      })
      void peer.closed.then(() => { if (connection === peer) connection = undefined }); return peer }).finally(() => { connecting = undefined })
    return connecting
  }
  const delivered = new Set<string>()
  async function forwardAck(key: OriginKey, ref: EventRef) {
    const peer = await connected(), receiptKey = peer.hello.connectionId + "/" + key.streamId + "/" + ref.seq
    if (delivered.has(receiptKey)) return
    await peer.request("origin-ack", { key, ref: { seq: ref.seq, eventId: ref.eventId, digest: ref.digest } })
    delivered.add(receiptKey)
  }
  async function tryAck(key: OriginKey, ref: EventRef) {
    try { await forwardAck(key, ref) }
    catch (error) { if (!(error instanceof Error) || !/BRIDGE_|HOST_UNAVAILABLE|DESTINATION_INVOCATION_TIMEOUT/.test(error.message)) throw error }
  }
  const originSource: OriginSource | undefined = input.origins ? { ...input.origins, async acknowledge(key, ref) { await input.origins!.acknowledge(key, ref); await tryAck(key, ref) } } : undefined
  async function retryAcks(snapshot: HostSnapshot) {
    if (!input.origins) return
    for (const key of await input.origins.list()) {
      const fence = snapshot.replayFences.find(fence => fence.runId === key.runId && fence.streamId === key.streamId)
      let after = 0
      while (true) {
        const page = await input.origins.read(key, after, 256)
        for (const entry of page.entries) {
          if (entry.kind !== "report-retained" && fence && entry.seq <= fence.throughSeq) await input.origins.acknowledge(key, entry)
          if (await input.origins.acknowledged(key, entry)) await tryAck(key, entry)
        }
        if (page.nextCursor >= page.lastSeq) break
        after = page.nextCursor
      }
    }
  }
  const request = async (channel: string, payload: unknown) => (await connected()).request(channel, payload)
  const receipt = (raw: unknown, runId: string) => parseOriginReceipt({ runId, receipt: raw }).receipt
  async function launch(channel: string, command: LaunchAssignment | RootLaunch | Parameters<NonNullable<OrchestrationHost["restoreRoot"]>>[0], invocation: Invocation): Promise<LaunchReceipt> {
    const peer = await connected()
    if (command.agent.hostId !== enrollment.hostId || command.handlerGeneration !== peer.hello.handlerGeneration) fail("STALE_HANDLER")
    return receipt(await peer.request(channel, { command, nativeParams: invocation.nativeParams }, { timeoutMs: 150000 }), command.runId)
  }
  const host: OrchestrationHost & { hostId: string } = {
    hostId: enrollment.hostId,
    onSettled(listener) { settled.add(listener); return () => { settled.delete(listener) } },
    async snapshot(): Promise<HostSnapshot> {
      const peer = await connected(), snapshot = parseHostSnapshot(await peer.request("snapshot", {}), peer.hello)
      if (input.origins) await replayOriginSnapshot({ mirror: input.origins, snapshot, connectionId: peer.hello.connectionId, read: (key, after, retained) => peer.request(retained ? "origin-retained" : "origin-read", { key, after, limit: 256 }) as Promise<import("../orchestration/types.js").JournalPage> })
      await retryAcks(snapshot)
      return input.origins ? snapshot : { ...snapshot, replayFences: [] }
    },
    launch: (command, invocation) => launch("launch", command, invocation),
    launchRoot: (command, invocation) => launch("launchRoot", command, invocation),
    restoreRoot: (command, invocation) => launch("restoreRoot", command, invocation),
    async inspectCommand(commandId, handlerGeneration) { const peer = await connected(); if (peer.hello.handlerGeneration !== handlerGeneration) return null; const raw = await peer.request("inspectCommand", { commandId, handlerGeneration }); return raw === null ? null : receipt(raw, commandId) },
    async submission(target, submissionId) { const raw = await request("submission", { target: parseExecutionRef(target), submissionId }); return raw === null ? null : parseSubmissionReceipt(raw) },
    async submit(target, submission, beforeAccepted) { const peer = await connected(); return parseSubmissionReceipt(await peer.request("submit", { target: parseExecutionRef(target), request: submission, admissionRequired: !!beforeAccepted }, beforeAccepted ? { beforeAccepted, timeoutMs: 0 } : { timeoutMs: 0 })) },
    async stop(commandId, target) { const raw = object(await request("stop", { commandId, target: parseExecutionRef(target) })); if (raw.commandId !== commandId || !["stopped", "uncertain", "stale"].includes(String(raw.state))) fail("INVALID_RECEIPT"); const execution = parseExecutionRef(raw.execution); if (JSON.stringify(execution) !== JSON.stringify(parseExecutionRef(target))) fail("INVALID_RECEIPT"); return { commandId, execution, state: raw.state as StopReceipt["state"] } }
  }
  return { ...host, origins: input.origins, originSource, async close() { (await connecting?.catch(() => undefined))?.close(); connection?.close(); connection = undefined } }
}