import { randomUUID } from "node:crypto"
import { createConnection, createServer, type Socket } from "node:net"
import { unlink } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { constants } from "node:os"
import { nativeFixtureAccess, type FixtureScope, type FixtureLaunchResult, type LaunchRef } from "./run-scope.js"

export type FixtureConnection = { socketPath: string; runId: string; ownerRef: LaunchRef; ownerToken: string }
export type SnapshotPhase = "progress" | "complete" | "before-intentional-exit"
export type FixtureClient = { prepareExit(ref: LaunchRef): Promise<void>; connection(ref: LaunchRef): FixtureConnection; report(): void; checkpoint(phase?: SnapshotPhase): Promise<void>; finish(): Promise<void> }
export type FixtureReceiver = { connection(ref: LaunchRef): FixtureConnection; prepareExit(ref: LaunchRef): Promise<void>; settle(refs: readonly LaunchRef[]): Promise<void>; close(): Promise<void> }
type Frame = Record<string, unknown>
type Report = { launch: FixtureLaunchResult; ownGroup: boolean; pipesClosed: boolean }
type Snapshot = { failures: string[]; children: FixtureConnection[]; launches: Report[] }
type Declaration = { connection: FixtureConnection; parent: string | null }
type Source = { ref: LaunchRef; socket: Socket; pid: number; role: string; sequence: number; complete: boolean; sealed: boolean; launches: Set<string>; ended: Promise<void>; sealWait?: ReturnType<typeof deferred<void>> }
const sealRoles = new Set(["channel-prepared", "singleton-contender", "darwin-handler", "provider-tree", "darwin-identity-tree", "darwin-exec-tree", "agent-handler", "control-handler", "catalog-handler", "catalog-worker"])
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
async function deadline<T>(promise: Promise<T>, label: string, ms = 15000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + " deadline")), ms) })]) }
  finally { clearTimeout(timer) }
}
function keys(value: unknown, allowed: string[]): asserts value is Frame {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid fixture frame")
}
function ref(value: unknown, runId: string): asserts value is LaunchRef {
  keys(value, ["runId", "launchId"])
  if (value.runId !== runId || typeof value.launchId !== "string" || !value.launchId) throw new Error("Foreign fixture ref")
}
function connection(value: unknown, runId: string, socketPath: string): asserts value is FixtureConnection {
  keys(value, ["socketPath", "runId", "ownerRef", "ownerToken"])
  ref(value.ownerRef, runId)
  if (value.runId !== runId || value.socketPath !== socketPath || typeof value.ownerToken !== "string" || !value.ownerToken) throw new Error("Invalid source connection")
}
function launch(value: unknown, runId: string): asserts value is FixtureLaunchResult {
  keys(value, ["ref", "role", "ownerId", "pid", "identity", "error", "exit", "close", "absent", "reporting", "unavailable"])
  ref(value.ref, runId)
  if (Object.keys(value).length !== 11) throw new Error("Incomplete launch snapshot")
  if (value.identity !== null) {
    keys(value.identity, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
    if (Object.keys(value.identity).length !== 8 || typeof value.identity.bootId !== "string" || typeof value.identity.birth !== "string"
      || value.identity.pid !== value.pid || ["pid", "parentPid", "processGroupId", "sessionId", "uid", "gid"].some(key => !Number.isSafeInteger((value.identity as Frame)[key]))) throw new Error("Invalid snapshot identity")
  }
  if (typeof value.role !== "string" || !value.role || typeof value.ownerId !== "string"
    || value.pid !== null && (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0)
    || value.error !== null && typeof value.error !== "string"
    || ![null, false, true].includes(value.close as boolean | null)
    || !["direct", "detached-handler", "editor-endpoint", "editor-control"].includes(value.reporting as string)
    || ![null, "editor-handle-closed", "editor-api-completion"].includes(value.unavailable as string | null)
    || value.unavailable === "editor-handle-closed" && value.reporting !== "editor-endpoint"
    || value.unavailable === "editor-api-completion" && (value.reporting !== "editor-control" || value.exit === null)) throw new Error("Invalid launch snapshot")
  if (value.exit !== null) {
    keys(value.exit, ["code", "signal"])
    if ((value.exit.code === null) === (value.exit.signal === null) || value.exit.code !== null && !Number.isSafeInteger(value.exit.code)
      || value.exit.signal !== null && (typeof value.exit.signal !== "string" || !(value.exit.signal in constants.signals))) throw new Error("Invalid terminal snapshot")
  }
  if (value.pid === null && !value.error) throw new Error("Unspawned report")
}
async function send(socket: Socket, frame: unknown): Promise<void> {
  const line = JSON.stringify(frame) + "\n"
  if (Buffer.byteLength(line) > 65536) throw new Error("Fixture frame too large")
  if (socket.destroyed || !socket.writable) throw new Error("Fixture channel closed")
  await new Promise<void>((resolve, reject) => { socket.write(line, error => error ? reject(error) : resolve()) })
}
function receive(socket: Socket, onFrame: (frame: Frame) => void, fail: (error: unknown) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const index = buffer.indexOf(10)
        if (index < 0) { if (buffer.length > 65536) throw new Error("Fixture frame too large"); break }
        if (index + 1 > 65536) throw new Error("Fixture frame too large")
        const frame: unknown = JSON.parse(buffer.subarray(0, index).toString("utf8"))
        buffer = buffer.subarray(index + 1)
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid fixture frame")
        onFrame(frame as Frame)
      }
    } catch (error) { fail(error); socket.destroy() }
  })
  socket.on("error", fail)
  socket.on("end", () => { if (buffer.length) fail(new Error("Truncated fixture frame")) })
}

export async function startFixtureReceiver(scope: FixtureScope, socketPath: string): Promise<FixtureReceiver> {
  const access = nativeFixtureAccess(scope), runId = scope.snapshot().runId
  if (Buffer.byteLength(socketPath) >= 100) throw new Error("Fixture socket path too long")
  const declarations = new Map<string, Declaration>(), sources = new Map<string, Source>(), sockets = new Set<Socket>()
  let closing: Promise<void> | undefined, accepting = true
  const alive = async (source: Source) => {
    const until = Date.now() + Math.min(access.deadlineMs, 15000)
    while (!source.socket.destroyed && !source.complete && !source.sealed) {
      try { return await access.sourceAlive(source.ref) }
      catch (error) {
        if (Date.now() >= until) throw error
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
    }
    return false
  }
  const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    const until = Date.now() + Math.min(access.deadlineMs, 15000)
    while (accepting && Date.now() < until) {
      const value = read()
      if (value !== undefined) return value
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    throw new Error(label + " unavailable or deadline")
  }
  const server = createServer(socket => {
    sockets.add(socket)
    let source: Source | undefined, chain = Promise.resolve(), lastSequence = 0
    const end = deferred<void>()
    socket.once("close", () => {
      sockets.delete(socket); end.resolve()
      if (!source || !source.complete && !source.sealed) access.fault(new Error("Fixture source lost before complete"))
    })
    receive(socket, frame => {
      chain = chain.then(async () => {
        let outcome: string | undefined, seal = false, complete = false
        if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) <= lastSequence) throw new Error("Invalid fixture sequence")
        lastSequence = frame.seq as number
        if (frame.type === "hello") {
          keys(frame, ["type", "seq", "connection", "pid"])
          if (source) throw new Error("Duplicate source hello")
          connection(frame.connection, runId, socketPath)
          const supplied = frame.connection
          const declared = await waitFor(() => declarations.get(supplied.ownerRef.launchId), "source declaration")
          if (!isDeepStrictEqual(declared.connection, supplied) || sources.has(supplied.ownerRef.launchId)) throw new Error("Refused fixture source token")
          if (declared.parent !== null) {
            const parent = sources.get(declared.parent)
            if (!parent || !await alive(parent)) throw new Error("Fixture source parent lost")
          }
          const identity = await access.admitSource(supplied.ownerRef)
          if (!identity || identity.pid !== frame.pid) throw new Error("Refused source identity")
          source = { ref: supplied.ownerRef, socket, pid: identity.pid, role: access.result(supplied.ownerRef).role, sequence: lastSequence, complete: false, sealed: false, launches: new Set(), ended: end.promise }
          sources.set(supplied.ownerRef.launchId, source)
        } else {
          if (!source || source.complete || source.sealed) throw new Error("Fixture source unavailable or sealed")
          if (frame.type === "snapshot") {
            keys(frame, ["type", "seq", "phase", "snapshot"])
            if (!["progress", "complete", "before-intentional-exit"].includes(frame.phase as string)) throw new Error("Invalid snapshot phase")
            keys(frame.snapshot, ["failures", "children", "launches"])
            const data = frame.snapshot as unknown as Snapshot
            if (!Array.isArray(data.failures) || data.failures.length || !Array.isArray(data.launches) || !Array.isArray(data.children)) throw new Error("Failed source report")
            const ids = new Set(data.launches.map(item => item.launch.ref.launchId))
            if (ids.size !== data.launches.length || [...source.launches].some(id => !ids.has(id))) throw new Error("Omitted or duplicate fixture launch")
            if (!await alive(source)) throw new Error("Fixture source identity lost")
            for (const child of data.children) {
              connection(child, runId, socketPath)
              if (!data.launches.some(item => item.launch.ref.launchId === child.ownerRef.launchId)) throw new Error("Undeclared child source")
              const prior = declarations.get(child.ownerRef.launchId)
              if (prior && (prior.parent !== source.ref.launchId || !isDeepStrictEqual(prior.connection, child))) throw new Error("Conflicting child token")
            }
            for (const item of data.launches) {
              keys(item, ["launch", "ownGroup", "pipesClosed"])
              launch(item.launch, runId)
              if (typeof item.ownGroup !== "boolean" || typeof item.pipesClosed !== "boolean") throw new Error("Invalid launch flags")
              const owner = source
              const reported = { ...item.launch, ownerId: source.ref.launchId }
              await access.accept(reported, source.pid, item.ownGroup, async () => {
                const independent = sources.get(reported.ref.launchId)
                return owner.sealed && owner.launches.has(reported.ref.launchId) || independent !== undefined && (independent.sealed || await alive(independent)) || await alive(owner)
              })
              if (reported.unavailable) {
                if (source.role !== "editor") throw new Error("Undeclared editor evidence")
                access.unavailable(reported.ref, reported.unavailable)
              }
              source.launches.add(reported.ref.launchId)
            }
            for (const child of data.children) declarations.set(child.ownerRef.launchId, { connection: child, parent: source.ref.launchId })
            if (frame.phase === "before-intentional-exit") {
              if (!sealRoles.has(source.role)) throw new Error("Undeclared seal source")
              for (const child of data.children) {
                const launch = data.launches.find(item => item.launch.ref.launchId === child.ownerRef.launchId)!.launch
                if (launch.pid !== null && !launch.exit) await receiver.prepareExit(child.ownerRef)
              }
              seal = true
              for (const item of data.launches) if (item.launch.exit === null) access.unavailable(item.launch.ref, "prepared-owner-exit")
            } else if (frame.phase === "complete") {
              for (const item of data.launches) {
                if (item.launch.pid === null && item.launch.error && item.launch.close === null) continue
                if (item.launch.close === true && (item.launch.exit || item.launch.error && item.launch.pid === null)) continue
                if (source.role === "editor" && (item.launch.reporting === "editor-endpoint" && (item.launch.exit || item.launch.unavailable === "editor-handle-closed" || item.launch.error && item.launch.pid === null) || item.launch.reporting === "editor-control" && item.launch.exit && item.launch.unavailable === "editor-api-completion")) {
                  access.unavailable(item.launch.ref, item.launch.reporting === "editor-control" ? "editor-api-completion" : "editor-handle-closed")
                  continue
                }
                const leaf = source.role === "singleton-contender" && item.launch.role === "singleton-handler" && !declarations.has(item.launch.ref.launchId)
                if (item.launch.reporting !== "detached-handler" || !item.pipesClosed || !leaf && !declarations.has(item.launch.ref.launchId)) throw new Error("Outstanding undeclared child or launcher pipe")
                if (!leaf) await waitFor(() => sources.get(item.launch.ref.launchId), "detached source admission")
                if (leaf) seal = true
                access.unavailable(item.launch.ref, "launcher-finished")
              }
              complete = true
            }
          } else if (frame.type === "prepare-exit") {
            keys(frame, ["type", "seq", "ref"])
            ref(frame.ref, runId)
            if (!source.launches.has(frame.ref.launchId) || declarations.get(frame.ref.launchId)?.parent !== source.ref.launchId || !await alive(source)) throw new Error("Refused child preparation")
            await receiver.prepareExit(frame.ref)
          } else if (frame.type === "editor-stop") {
            keys(frame, ["type", "seq", "ref", "signal"])
            ref(frame.ref, runId)
            if (source.role !== "editor" || !source.launches.has(frame.ref.launchId) || typeof frame.signal !== "string" || !["SIGTERM", "SIGKILL"].includes(frame.signal) || !await alive(source)) throw new Error("Refused editor identity")
            const target = access.result(frame.ref)
            if (!["editor-endpoint", "editor-control"].includes(target.reporting)) throw new Error("Refused non-editor stop")
            if (target.exit || target.pid === null && target.error) outcome = "already-absent"
            else outcome = await access.signalEditor(frame.ref, frame.signal as NodeJS.Signals, target.reporting === "editor-endpoint")
          } else throw new Error("Unknown fixture message")
        }
        await send(socket, { type: "ack", seq: frame.seq, accepted: true, ...(outcome ? { outcome } : {}) })
        if (source && seal) { source.sealed = true; source.sealWait?.resolve() }
        if (source && complete) { source.complete = true; source.sealWait?.resolve() }
      }).catch(error => {
        access.fault(error)
        source?.sealWait?.reject(error)
        void send(socket, { type: "ack", seq: frame.seq, accepted: false, error: errorText(error), ...(frame.type === "editor-stop" ? { outcome: "refused-identity" } : {}) }).catch(() => {}).finally(() => socket.end())
      })
    }, error => { access.fault(error); source?.sealWait?.reject(error) })
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) })
  const receiver: FixtureReceiver = {
    connection(ref) {
      access.result(ref)
      if (!accepting || ref.runId !== runId || declarations.has(ref.launchId)) throw new Error("Duplicate/closed fixture source")
      const value = { socketPath, runId, ownerRef: ref, ownerToken: randomUUID() }
      declarations.set(ref.launchId, { connection: value, parent: null })
      return value
    },
    async prepareExit(ref) {
      const source = await waitFor(() => sources.get(ref.launchId), "seal source")
      if (ref.runId !== runId || !sealRoles.has(source.role)) throw new Error("Undeclared seal target")
      if (source.sealed || source.complete) return
      if (!source.sealWait) { source.sealWait = deferred<void>(); await send(source.socket, { type: "seal", ref }) }
      await deadline(source.sealWait.promise, "source seal", Math.min(access.deadlineMs, 15000))
    },
    async settle(refs) {
      const known = new Set(refs.map(ref => { if (ref.runId !== runId) throw new Error("Foreign source settlement"); return ref.launchId }))
      let prior = -1
      while (prior !== known.size) {
        prior = known.size
        for (const id of known) {
          const source = await waitFor(() => sources.get(id), "source admission")
          await waitFor(() => source.complete || source.sealed ? true : undefined, "source report completion")
          await deadline(source.ended, "source disconnect", Math.min(access.deadlineMs, 30000))
        }
        for (const [id, declaration] of declarations) if (declaration.parent && known.has(declaration.parent)) known.add(id)
      }
    },
    close() {
      if (closing) return closing
      accepting = false
      closing = (async () => {
        try {
          await deadline(Promise.all([...sources.values()].map(value => value.ended)), "source completion", Math.min(access.deadlineMs, 30000))
          for (const [id] of declarations) if (!sources.has(id)) throw new Error("Missing fixture source")
          for (const source of sources.values()) {
            if (!source.complete && !source.sealed) throw new Error("Missing source complete")
          }
        } catch (error) { access.fault(error) }
        finally {
          for (const socket of sockets) socket.destroy()
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          await unlink(socketPath).catch(error => { if (error.code !== "ENOENT") throw error })
        }
      })()
      return closing
    },
  }
  access.beforeAbsence(() => receiver.close())
  return receiver
}

export function connectFixture(config: FixtureConnection, local: FixtureScope): FixtureClient {
  const access = nativeFixtureAccess(local), socket = createConnection(config.socketPath), children = new Map<string, FixtureConnection>()
  const hello = deferred<void>(), closed = deferred<void>(), replies = new Map<number, ReturnType<typeof deferred<void>>>()
  let sealed = false
  let sequence = 0, error: unknown, queued = false, chain = Promise.resolve(), finished: Promise<void> | undefined
  const fail = (reason: unknown) => { error ??= reason; access.fault(reason); hello.reject(reason); for (const pending of replies.values()) pending.reject(reason) }
  const request = async (frame: Frame): Promise<void> => {
    if (error) throw error
    const seq = ++sequence, reply = deferred<void>()
    replies.set(seq, reply)
    try { await send(socket, { ...frame, seq }); await deadline(reply.promise, "fixture acknowledgement", Math.min(access.deadlineMs, 15000)) }
    finally { replies.delete(seq) }
  }
  const snapshot = (): Snapshot => ({
    failures: local.snapshot().failures, children: [...children.values()],
    launches: local.snapshot().launches.map(launch => ({ launch, ownGroup: access.ownGroup(launch.ref), pipesClosed: (access.child(launch.ref)?.stdio?.slice(3) ?? []).every(stream => stream == null || "closed" in stream && stream.closed === true) })),
  })
  const publish = (phase: SnapshotPhase) => {
    chain = chain.then(async () => { await hello.promise; if (error) throw error; if (phase === "progress") queued = false; await request({ type: "snapshot", phase, snapshot: snapshot() }) })
    void chain.catch(fail)
    return chain
  }
  receive(socket, frame => {
    if (frame.type === "seal") {
      if (!isDeepStrictEqual(frame.ref, config.ownerRef)) { fail(new Error("Foreign seal ref")); return }
      if (!finished) void client.checkpoint("before-intentional-exit").catch(fail)
    } else if (frame.type === "ack" && Number.isSafeInteger(frame.seq)) {
      const reply = replies.get(frame.seq as number)
      if (!reply) { fail(new Error("Unknown fixture acknowledgement")); return }
      if (frame.accepted === true) reply.resolve()
      else reply.reject(new Error(String(frame.error ?? "Refused fixture report")))
    } else fail(new Error("Unknown fixture receiver message"))
  }, fail)
  socket.once("connect", () => { void request({ type: "hello", connection: config, pid: process.pid }).then(() => hello.resolve(), fail) })
  socket.once("close", () => { closed.resolve(); if (!finished) fail(new Error("Fixture reporting source closed")) })
  const client: FixtureClient = {
    async prepareExit(ref) {
      if (sealed) { await chain; return }
      await client.checkpoint()
      await request({ type: "prepare-exit", ref })
    },
    connection(ref) {
      if (children.has(ref.launchId)) throw new Error("Duplicate child source")
      access.result(ref)
      const value = { ...config, ownerRef: ref, ownerToken: randomUUID() }
      children.set(ref.launchId, value)
      return value
    },
    report() {
      if (queued || sealed || finished) return
      queued = true
      void publish("progress").catch(fail)
    },
    async checkpoint(phase = "progress") {
      if (phase === "before-intentional-exit") { sealed = true; await access.seal() }
      await publish(phase)
    },
    finish() {
      if (finished) return finished
      finished = (async () => {
        try { await chain; if (!sealed) { await access.completeSource(); await client.checkpoint("complete") }; socket.end(); await deadline(closed.promise, "fixture disconnect", Math.min(access.deadlineMs, 30000)) }
        catch (error) { fail(error); socket.destroy(); throw error }
      })()
      return finished
    },
  }
  return client
}