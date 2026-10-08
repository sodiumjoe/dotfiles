import { parsePermissionReceipt } from "../orchestration/permission-routing.js"
import type { HostEnrollment } from "./hosts.js"
import type { Invocation, LaunchAssignment, RootLaunch, OrchestrationHost, LaunchReceipt, StopReceipt, HostSnapshot } from "./host.js"
import { connectHost, parseHostSnapshot, type BridgeConnection } from "../bridge/ssh.js"
import { parseOriginReceipt } from "../orchestration/receipts.js"
import { parseSubmissionReceipt } from "../agent/attachment-protocol.js"
import { fail, parseAgentRef, parseExecutionRef, type EventRef } from "../orchestration/types.js"
import { object } from "../catalog/types.js"
import type { RemoteOrigins, OriginSource, OriginKey } from "./origins.js"
import { replayOriginSnapshot } from "../bridge/replay.js"

export function createRemoteHost(input: { enrollment: HostEnrollment; connect?: () => Promise<BridgeConnection>; origins?: RemoteOrigins; onTool?(payload: unknown, signal?: AbortSignal): Promise<unknown>; onHuman?(payload: unknown): Promise<unknown>; managed?: boolean; now?: () => number; random?: () => number; schedule?(delay: number, task: () => void): () => void; onReady?(peer: BridgeConnection): Promise<void>; ownsRun?(runId: string): Promise<boolean> }) {
  const { enrollment } = input
  const settled = new Set<Parameters<NonNullable<OrchestrationHost["onSettled"]>>[0]>()
  let connection: BridgeConnection | undefined, connecting: Promise<BridgeConnection> | undefined
  let enabled = !input.managed, closed = false, epoch = 0, failures = 0, timer: (() => void) | undefined, retryInMs: number | null = null
  let cached: HostSnapshot | null = null, observedAt: number | null = null, ready = false, lastError: string | null = null, readyConnection: string | null = null
  let observing: { peer: BridgeConnection; promise: Promise<HostSnapshot> } | undefined
  const delivered = new Set<string>(), now = input.now ?? Date.now, random = input.random ?? Math.random
  const schedule = input.schedule ?? ((delay: number, task: () => void) => { const handle = setTimeout(task, delay); handle.unref(); return () => clearTimeout(handle) })
  function kick() { void host.snapshot().catch(() => undefined) }
  function retry(delay?: number) {
    if (!input.managed || !enabled || closed || timer) return
    const version = epoch
    retryInMs = delay ?? Math.min(30000, Math.round(Math.min(30000, 1000 * 2 ** Math.min(failures++, 6)) * (0.5 + random())))
    timer = schedule(retryInMs, () => { timer = undefined; retryInMs = null; if (version === epoch && enabled && !closed) kick() })
  }
  function disconnect(peer: BridgeConnection, error: unknown) {
    if (connection !== peer) return
    connection = undefined; ready = false; readyConnection = null; delivered.clear()
    lastError = error instanceof Error ? error.message : "HOST_UNAVAILABLE"
    peer.close(); retry()
  }
  async function connected(): Promise<BridgeConnection> {
    if (!enabled || closed) fail("HOST_UNAVAILABLE")
    if (connection) return connection
    if (connecting) return connecting
    if (input.managed && timer) fail("HOST_UNAVAILABLE")
    const version = epoch
    connecting = (input.connect ?? (() => connectHost(enrollment)))().then(peer => {
      if (version !== epoch || !enabled || closed) { peer.close(); fail("HOST_UNAVAILABLE") }
      if (peer.hello.hostId !== enrollment.hostId) { peer.close(); fail("HOST_IDENTITY_CHANGED") }
      if (peer.hello.nodeVersion !== "v24.13.0") { peer.close(); fail("UNSUPPORTED_RUNTIME") }
      connection = peer; delivered.clear()
      peer.onRequest(async (channel, payload, _requestId, signal) => {
        if (channel === "human" && input.onHuman) return input.onHuman(payload)
        if (channel === "tool" && input.onTool) return input.onTool(payload, signal)
        if (channel === "settled") { const parent = parseAgentRef(object(payload).parent); if (parent.hostId !== enrollment.hostId) fail("STALE_EXECUTION"); for (const listener of settled) listener(parent); return { observed: true } }
        fail("UNSUPPORTED_CAPABILITY")
      })
      void peer.closed.then(error => disconnect(peer, error))
      return peer
    }).catch(error => { if (version === epoch) { ready = false; lastError = error instanceof Error ? error.message : "HOST_UNAVAILABLE"; retry() }; throw error }).finally(() => { connecting = undefined; if (version !== epoch && enabled && !closed) retry(0) })
    return connecting
  }
  async function observe(peer: BridgeConnection): Promise<HostSnapshot> {
    try {
      let snapshot = parseHostSnapshot(await peer.request("snapshot", {}), peer.hello)
      if (input.ownsRun) {
        const fences = []
        for (const fence of snapshot.replayFences) if (await input.ownsRun(fence.runId)) fences.push(fence)
        snapshot = { ...snapshot, replayFences: fences }
      }
      if (input.origins) await replayOriginSnapshot({ mirror: input.origins, snapshot, connectionId: peer.hello.connectionId, read: (key, after, retained) => peer.request(retained ? "origin-retained" : "origin-read", { key, after, limit: 256 }) as Promise<import("../orchestration/types.js").JournalPage> })
      await retryAcks(snapshot)
      if (connection !== peer || !enabled || closed) fail("HOST_UNAVAILABLE")
      cached = structuredClone(input.origins ? snapshot : { ...snapshot, replayFences: [] }); observedAt = now(); ready = true; failures = 0; lastError = null
      timer?.(); timer = undefined; retryInMs = null
      if (readyConnection !== peer.hello.connectionId) {
        readyConnection = peer.hello.connectionId
        void Promise.resolve().then(() => { if (connection === peer && enabled && !closed) return input.onReady?.(peer) }).catch(error => { lastError = error instanceof Error ? error.message : "HOST_UNAVAILABLE" })
      }
      return structuredClone(cached)
    } catch (error) { disconnect(peer, error); throw error }
  }
  async function forwardAck(key: OriginKey, ref: EventRef) {
    if (input.ownsRun && !await input.ownsRun(key.runId)) return
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
      if (input.ownsRun && !await input.ownsRun(key.runId)) continue
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
  async function dispatchPeer() { if (input.managed) await host.snapshot(); const peer = await connected(); if (input.managed && (!ready || readyConnection !== peer.hello.connectionId)) fail("HOST_UNAVAILABLE"); return peer }
  const request = async (channel: string, payload: unknown) => (await dispatchPeer()).request(channel, payload)
  const receipt = (raw: unknown, runId: string) => parseOriginReceipt({ runId, receipt: raw }).receipt
  async function launch(channel: string, command: LaunchAssignment | RootLaunch | Parameters<NonNullable<OrchestrationHost["restoreRoot"]>>[0], invocation: Invocation): Promise<LaunchReceipt> {
    const peer = await dispatchPeer()
    if (command.agent.hostId !== enrollment.hostId || command.handlerGeneration !== peer.hello.handlerGeneration) fail("STALE_HANDLER")
    return receipt(await peer.request(channel, { command, nativeParams: invocation.nativeParams }, { timeoutMs: 150000 }), command.runId)
  }
  const host: OrchestrationHost & { hostId: string } = {
    hostId: enrollment.hostId,
    async permissionDecide(commandId, ref, optionId) { return parsePermissionReceipt(await request("permission-decide", { commandId, ref, optionId })) },
    async permissionInspect(commandId) { const receipt = await request("permission-inspect", { commandId }); return receipt === null ? null : parsePermissionReceipt(receipt) },
    async permissionRead(after, limit) { return request("permission-read", { after, limit }) as Promise<import("../orchestration/types.js").JournalPage> },
    async permissionAcknowledge(event) { await request("permission-ack", { event: { seq: event.seq, eventId: event.eventId, digest: event.digest } }) },
    onSettled(listener) { settled.add(listener); return () => { settled.delete(listener) } },
    async snapshot(): Promise<HostSnapshot> {
      const peer = await connected()
      if (observing?.peer === peer) return observing.promise
      const promise = observe(peer).finally(() => { if (observing?.promise === promise) observing = undefined })
      observing = { peer, promise }
      return promise
    },
    launch: (command, invocation) => launch("launch", command, invocation),
    launchRoot: (command, invocation) => launch("launchRoot", command, invocation),
    restoreRoot: (command, invocation) => launch("restoreRoot", command, invocation),
    async inspectCommand(commandId, handlerGeneration) { const peer = await connected(); if (peer.hello.handlerGeneration !== handlerGeneration) return null; const raw = await peer.request("inspectCommand", { commandId, handlerGeneration }); return raw === null ? null : receipt(raw, commandId) },
    async submission(target, submissionId) { const raw = await request("submission", { target: parseExecutionRef(target), submissionId }); return raw === null ? null : parseSubmissionReceipt(raw) },
    async submit(target, submission, beforeAccepted) { const peer = await dispatchPeer(); return parseSubmissionReceipt(await peer.request("submit", { target: parseExecutionRef(target), request: submission, admissionRequired: !!beforeAccepted }, beforeAccepted ? { beforeAccepted, timeoutMs: 0 } : { timeoutMs: 0 })) },
    async stop(commandId, target) { const raw = object(await request("stop", { commandId, target: parseExecutionRef(target) })); if (raw.commandId !== commandId || !["stopped", "uncertain", "stale"].includes(String(raw.state))) fail("INVALID_RECEIPT"); const execution = parseExecutionRef(raw.execution); if (JSON.stringify(execution) !== JSON.stringify(parseExecutionRef(target))) fail("INVALID_RECEIPT"); return { commandId, execution, state: raw.state as StopReceipt["state"] } }
  }
  return { ...host, origins: input.origins, originSource,
    observation() { return { enabled, connected: !!connection, ready, observedAt, snapshot: structuredClone(cached), error: lastError, retryInMs } },
    setEnabled(value: boolean) {
      if (closed || value === enabled) return
      enabled = value; epoch++; timer?.(); timer = undefined; retryInMs = null; ready = false; readyConnection = null
      if (!value) { const peer = connection; connection = undefined; delivered.clear(); peer?.close() }
      else if (!connecting) kick()
    },
    async close() { closed = true; enabled = false; epoch++; timer?.(); timer = undefined; retryInMs = null; ready = false; const peer = connection; connection = undefined; peer?.close(); (await connecting?.catch(() => undefined))?.close() }
  }
}