import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createConnection, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { serveAttachment } from "../src/agent/attachment-server.js"
import { createNdjsonDecoder, parseAttachmentFrame } from "../src/agent/attachment-protocol.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { ATTACHMENT_LIMITS } from "../src/agent/attachment-protocol.js"
import { runAttachmentClient, type AttachmentDependencies } from "../src/agent/attachment-client.js"
import type { HandlerInspection } from "../src/platform/types.js"

async function fixture(t: TestContext) {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const started = await f.service.start(f.input)
  const command = await until(async () => { const value = await f.service.command(started.command.commandId, started.command.handlerGeneration); return value.command.state === "completed" ? value.command : undefined })
  const target = command.target!, peers = new Set<Socket>(), signals = new Map<string, () => void>(), stdin = new PassThrough(), stdout = new PassThrough(), frames: any[] = [], stderr: string[] = []
  const server = await bindPrivateSocket(f.root, "attachment.sock", socket => { peers.add(socket); socket.once("close", () => peers.delete(socket)); void serveAttachment(socket, f.service, target.handlerGeneration) })
  const decoder = createNdjsonDecoder(value => frames.push(parseAttachmentFrame(value)), error => { throw error })
  stdout.on("data", bytes => decoder.feed(bytes))
  const inspection: HandlerInspection = { disposition: "live", record: { version: 1, hostId: f.context.paths.hostKey, launchBootId: "boot-a", generation: target.handlerGeneration, launchAttemptId: randomUUID(), launchAttempted: true, phase: "ready", process: { bootId: "boot-a", pid: 1001, birth: "1:fixture", parentPid: 1, processGroupId: 1001, sessionId: 1001, uid: process.getuid!(), gid: process.getgid!() }, socketPath: f.context.paths.handlerSocketPath, writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null } }
  let connects = 0
  const deps: AttachmentDependencies = { environment: async () => ({ paths: f.context.paths, adapter: f.context.adapter }), inspect: async () => inspection, connect: async () => { connects++; return createConnection(f.root + "/attachment.sock") }, stdin, stdout, stderr: (text: string) => { stderr.push(text) }, onSignal: (signal, callback) => { signals.set(signal, callback); return () => { signals.delete(signal) } } }
  const args = ["agent", "attach", target.agentId, "--handler-generation", target.handlerGeneration, "--provider-generation", target.providerGeneration, "--format", "ndjson"]
  const run = (argv = args) => runAttachmentClient(argv, deps)
  const request = (body: object) => { const requestId = randomUUID(); stdin.write(JSON.stringify({ protocol: "agency-attachment/1", target, requestId, ...body }) + "\n"); return requestId }
  t.after(async () => { stdin.destroy(); stdout.destroy(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { ...f, target, deps, args, run, request, frames, stdin, stdout, stderr, signals, connects: () => connects }
}

test("attachment proxy performs a full duplex turn and cancel without owning provider lifetime", async t => {
  const f = await fixture(t), running = f.run()
  await until(async () => f.frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  const submissionId = randomUUID(), requestId = f.request({ op: "submit", submissionId, text: "α question" })
  await until(async () => f.frames.some(frame => frame.requestId === requestId) ? true : undefined)
  await f.promptEntered
  const cancelId = f.request({ op: "cancel", submissionId })
  await until(async () => f.frames.some(frame => frame.requestId === cancelId && frame.ok) ? true : undefined)
  f.stdin.end()
  assert.equal(await running, 0)
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
  assert.equal(f.signals.size, 0)
  assert.deepEqual(f.stderr, [])
})

test("attachment proxy rejects a stale Handler without starting or connecting a replacement", async t => {
  const f = await fixture(t)
  assert.equal(await f.run(f.args.map(value => value === f.target.handlerGeneration ? randomUUID() : value)), 69)
  assert.equal(f.connects(), 0)
  assert.equal(f.frames.at(-1).error.code, "STALE_HANDLER")
  assert.equal(f.stderr.join("").includes(f.root), false)
})

for (const kind of ["SIGINT", "SIGTERM", "stdout lost", "malformed input"]) test(`attachment proxy ${kind} closes only its transport`, async t => {
  const f = await fixture(t), running = f.run()
  await until(async () => f.frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  const submissionId = randomUUID()
  f.request({ op: "submit", submissionId, text: "accepted" }); await f.promptEntered
  if (kind.startsWith("SIG")) f.signals.get(kind)!()
  else if (kind === "stdout lost") f.stdout.destroy(Object.assign(new Error("not public"), { code: "EPIPE" }))
  else f.stdin.write("bad\n")
  await running
  assert.equal((await f.service.submission(f.target, submissionId))!.state, "running")
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
  assert.equal(f.methodHistory.includes("session/cancel"), false)
  f.completePrompt(f.target.agentId)
})

test("attachment proxy missing endpoint emits a bounded sanitized fault", async t => {
  const f = await fixture(t)
  f.deps.connect = async () => { throw Object.assign(new Error("secret environment and path"), { code: "ENOENT" }) }
  assert.equal(await f.run(), 69)
  assert.equal(f.frames.at(-1).error.code, "UNAVAILABLE")
  assert.equal(f.stderr.join("").includes("secret"), false)
  assert.match(f.stderr.join(""), /restart.*upgrade|upgrade.*restart/)
})

test("agent attach is routed through the stream client without starting a Handler", async t => {
  const f = await fixture(t)
  let starts = 0
  const running = runControl(f.args, { ...productionControlDependencies(), environment: f.deps.environment, inspect: f.deps.inspect, attachment: f.deps, start: async () => { starts++; throw new Error("must not start") }, stderr: f.deps.stderr })
  await until(async () => f.frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  f.stdin.end()
  assert.equal(await running, 0)
  assert.equal(starts, 0)
})

async function scripted(t: TestContext, kind: string) {
  const f = await fixture(t), observation = await f.service.observe(f.target, () => {}), snapshot = observation.snapshot
  observation.close()
  const snapshotId = randomUUID(), base = { protocol: "agency-attachment/1", target: f.target }, peers = new Set<Socket>()
  const frames: any[] = [
    { ...base, type: "snapshot_begin", snapshotId, sessionId: snapshot.metadata.session!.sessionId, cwd: snapshot.metadata.cwd, selection: snapshot.metadata.selection, metadata: { ...snapshot.metadata, title: { title: "α", titleTruncated: false, titleOriginalBytes: 2 } }, firstSeq: snapshot.firstSeq, lastSeq: snapshot.lastSeq, historyTruncated: false, currentTurn: null, limits: ATTACHMENT_LIMITS },
    { ...base, type: "snapshot_events", snapshotId, chunkIndex: 0, events: snapshot.events },
    { ...base, type: "snapshot_end", snapshotId, firstSeq: snapshot.firstSeq, lastSeq: snapshot.lastSeq, historyTruncated: false, chunkCount: 1 },
  ]
  if (kind === "wrong tuple") frames[0].target = { ...f.target, providerGeneration: randomUUID() }
  if (kind === "missing chunk") frames.splice(1, 1)
  if (kind === "out of order chunk") frames[1].chunkIndex = 1
  if (kind === "conflicting boundary") frames[2].lastSeq++
  if (kind === "excess raw snapshot") {
    frames[0].lastSeq = 12
    const end = { ...frames[2], lastSeq: 12, chunkCount: 12 }
    frames.splice(1, 2, ...Array.from({ length: 12 }, (_, n) => ({ ...base, type: "snapshot_events", snapshotId, chunkIndex: n, events: [{ ...snapshot.events[0], seq: n + 1 }] })), end)
  }
  const server = await bindPrivateSocket(f.root, "scripted.sock", socket => {
    peers.add(socket); socket.once("close", () => peers.delete(socket)); socket.on("error", () => undefined)
    socket.once("data", async () => {
      const bytes = Buffer.from(frames.map(frame => JSON.stringify(frame) + (kind === "excess raw snapshot" && frame.type === "snapshot_events" ? " ".repeat(1572864) : "") + "\n").join("")), step = kind === "excess raw snapshot" ? 16384 : 7
      for (let n = 0; n < bytes.length && !socket.destroyed; n += step) { socket.write(bytes.subarray(n, n + step)); await new Promise<void>(resolve => setImmediate(resolve)) }
      if (kind === "partial EOF") socket.end('{"type":')
      if (kind === "excess raw snapshot") socket.end()
    })
  })
  f.deps.connect = async () => createConnection(f.root + "/scripted.sock")
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return f
}

test("attachment proxy accepts a snapshot fragmented inside multibyte text", async t => {
  const f = await scripted(t, "fragmented"), running = f.run()
  await until(async () => f.frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  assert.equal(f.frames[0].metadata.title.title, "α")
  f.stdin.end()
  assert.equal(await running, 0)
})

for (const kind of ["wrong tuple", "missing chunk", "out of order chunk", "conflicting boundary", "partial EOF", "excess raw snapshot"]) test(`attachment proxy rejects ${kind} without changing provider state`, async t => {
  const f = await scripted(t, kind)
  assert.equal(await f.run(), 65)
  assert.equal(f.frames.at(-1).error.code, "INVALID_PROTOCOL")
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
})

test("attachment proxy has no idle deadline but bounds pending acknowledgements", async t => {
  const f = await scripted(t, "silent"), running = f.run()
  let ended = false
  void running.then(() => { ended = true })
  await until(async () => f.frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.timers.tick(60000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(ended, false)
  f.request({ op: "inspect-submission", submissionId: randomUUID() })
  t.mock.timers.tick(5000)
  assert.equal(await running, 75)
  t.mock.timers.reset()
  assert.equal(f.frames.at(-1).error.code, "INCOMPLETE")
})

test("asynchronous missing endpoint reports the explicit upgrade diagnostic", async t => {
  const f = await fixture(t)
  f.deps.connect = async () => createConnection(f.root + "/absent.sock")
  assert.equal(await f.run(), 69)
  assert.match(f.stderr.join(""), /restart.*upgrade|upgrade.*restart/)
})

test("an unavailable stdout cannot produce a successful attachment exit", async t => {
  const f = await fixture(t)
  f.stdout.destroy()
  assert.equal(await f.run(), 69)
  assert.equal(f.connects(), 0)
})

test("stdout loss during a terminal fault does not leave an unhandled EPIPE", async t => {
  const f = await fixture(t), running = f.run()
  await until(async () => f.frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  f.stdout.on("data", bytes => { if (bytes.toString().includes('"type":"fault"')) f.stdout.destroy(Object.assign(new Error("closed consumer"), { code: "EPIPE" })) })
  await f.service.stop({ ...f.target, commandId: randomUUID() })
  await running
  await new Promise<void>(resolve => setImmediate(resolve))
})