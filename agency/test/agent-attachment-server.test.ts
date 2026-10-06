import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createConnection, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { createNdjsonDecoder, parseAttachmentFrame } from "../src/agent/attachment-protocol.js"
import { createConversation } from "../src/agent/conversation.js"
import { serveAttachment } from "../src/agent/attachment-server.js"

async function fixture(t: TestContext, hang = false) {
  const f = await agentServiceFixture(t, { prompt: hang ? "hang" : "normal" })
  const started = await f.service.start(f.input)
  const ready = await until(async () => { const value = await f.service.command(started.command.commandId, started.command.handlerGeneration); return value.command.state === "completed" ? value : undefined })
  const target = ready.command.target!, peers = new Set<Socket>(), clients: Socket[] = []
  const server = await bindPrivateSocket(f.root, "test.sock", socket => {
    peers.add(socket); socket.once("close", () => peers.delete(socket))
    void serveAttachment(socket, f.service, target.handlerGeneration)
  })
  t.after(async () => { for (const client of clients) client.destroy(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  async function attach() {
    const socket = createConnection(f.root + "/test.sock"), frames: any[] = [], faults: unknown[] = []
    clients.push(socket)
    const decoder = createNdjsonDecoder(frame => frames.push(parseAttachmentFrame(frame)), error => faults.push(error))
    socket.on("data", bytes => decoder.feed(bytes)); socket.on("error", () => undefined)
    await once(socket, "connect")
    const send = (value: unknown) => { socket.write(JSON.stringify(value) + "\n") }
    send({ protocol: "agency-attachment/1", target, op: "attach", requestId: randomUUID() })
    await until(async () => frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
    return { socket, frames, faults, send, async request(body: Record<string, unknown>) {
      const requestId = randomUUID()
      send({ protocol: "agency-attachment/1", target, requestId, ...body })
      return until(async () => frames.find(frame => frame.type === "response" && frame.requestId === requestId))
    } }
  }
  return { ...f, target, attach, server, peers }
}

test("attachment snapshot and streamed turns converge for two observers without duplicate dispatch", async t => {
  const f = await fixture(t, true), first = await f.attach(), second = await f.attach(), submissionId = randomUUID()
  const ack = await first.request({ op: "submit", submissionId, text: "α question" })
  assert.equal(ack.ok, true)
  await f.promptEntered
  const duplicate = await second.request({ op: "submit", submissionId, text: "α question" })
  assert.equal(duplicate.receipt.submissionId, submissionId)
  const conflict = await second.request({ op: "submit", submissionId, text: "different" })
  assert.equal(conflict.error.code, "COMMAND_CONFLICT")
  first.socket.destroy()
  f.completePrompt(f.target.agentId)
  await until(async () => second.frames.some(frame => frame.type === "event" && frame.event.kind === "turn" && frame.event.state === "completed") ? true : undefined)
  const receipt = await second.request({ op: "inspect-submission", submissionId })
  assert.equal(receipt.receipt.state, "completed")
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 1)
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
  assert.deepEqual(second.faults, [])
})

test("attachment cancellation preserves the provider and a subsequent turn", async t => {
  const f = await fixture(t, true), peer = await f.attach(), submissionId = randomUUID()
  await peer.request({ op: "submit", submissionId, text: "cancel" }); await f.promptEntered
  const cancelled = await peer.request({ op: "cancel", submissionId })
  assert.equal(cancelled.ok, true)
  await until(async () => peer.frames.some(frame => frame.type === "event" && frame.event.stopReason === "cancelled") ? true : undefined)
  const next = randomUUID()
  await peer.request({ op: "submit", submissionId: next, text: "next" })
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  f.completePrompt(f.target.agentId)
  await until(async () => peer.frames.some(frame => frame.type === "event" && frame.event.submissionId === next && frame.event.state === "completed") ? true : undefined)
  assert.equal(f.spawns(), 1)
})

test("reattachment snapshots retain maximum raw and escaped submissions", async t => {
  const f = await fixture(t, true), peer = await f.attach(), submissionId = randomUUID(), text = "x".repeat(262144)
  await peer.request({ op: "submit", submissionId, text }); await f.promptEntered
  const second = await f.attach()
  assert.equal(second.frames.filter(frame => frame.type === "snapshot_events").flatMap(frame => frame.events).find(event => event.kind === "submitted").text, text)
  f.completePrompt(f.target.agentId)
  await until(async () => peer.frames.some(frame => frame.type === "event" && frame.event.state === "completed") ? true : undefined)
  const escaped = "\u0001".repeat(152917), next = randomUUID()
  await peer.request({ op: "submit", submissionId: next, text: escaped })
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  const third = await f.attach()
  assert.equal(third.frames.filter(frame => frame.type === "snapshot_events").flatMap(frame => frame.events).find(event => event.submissionId === next && event.kind === "submitted").text, escaped)
  f.completePrompt(f.target.agentId)
})

test("stale generation and pre-snapshot requests cannot dispatch a turn", async t => {
  const f = await fixture(t), socket = createConnection(f.root + "/test.sock"), received: any[] = []
  socket.on("error", () => undefined)
  const decoder = createNdjsonDecoder(value => received.push(value), () => undefined)
  socket.on("data", bytes => decoder.feed(bytes))
  await once(socket, "connect")
  const gone = once(socket, "close")
  socket.write(JSON.stringify({ protocol: "agency-attachment/1", target: { ...f.target, handlerGeneration: randomUUID() }, requestId: randomUUID(), op: "attach" }) + "\n")
  await gone
  assert.equal(received[0].error.code, "STALE_HANDLER")
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
  const pipelined = createConnection(f.root + "/test.sock"), failures: any[] = []
  pipelined.on("error", () => undefined)
  const decode = createNdjsonDecoder(value => failures.push(value), () => undefined)
  pipelined.on("data", bytes => decode.feed(bytes)); await once(pipelined, "connect")
  const closed = once(pipelined, "close")
  pipelined.write([{ op: "attach" }, { op: "submit", submissionId: randomUUID(), text: "not accepted" }].map(body => JSON.stringify({ protocol: "agency-attachment/1", target: f.target, requestId: randomUUID(), ...body }) + "\n").join(""))
  await closed
  assert.ok(failures.some(frame => frame.type === "fault" && frame.error.code === "INVALID_PROTOCOL"))
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
})

test("lost submit response can be inspected after reattachment without another provider call", async t => {
  const f = await fixture(t, true), peer = await f.attach(), submissionId = randomUUID()
  peer.socket.removeAllListeners("data")
  peer.send({ protocol: "agency-attachment/1", target: f.target, requestId: randomUUID(), op: "submit", submissionId, text: "one dispatch" })
  await f.promptEntered
  peer.socket.destroy()
  const reattached = await f.attach(), receipt = await reattached.request({ op: "inspect-submission", submissionId })
  assert.equal(receipt.receipt.state, "running")
  assert.equal(reattached.frames[0].currentTurn.submissionId, submissionId)
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 1)
  f.completePrompt(f.target.agentId)
})

test("snapshot transfer includes concurrent updates strictly after its captured boundary", async t => {
  const f = await fixture(t), conversation = createConversation(f.target), ready = (await f.service.current(f.workspace)).agents[0]!.record
  conversation.append({ kind: "lifecycle", phase: "ready", session: ready.session, cwd: f.workspace })
  for (let n = 0; n < 160; n++) conversation.append({ kind: "update", replay: true, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "α".repeat(24000) } } })
  f.service.observe = async (target, listener) => {
    assert.deepEqual(target, f.target)
    const observation = conversation.observe(listener)
    queueMicrotask(() => conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "during transfer" } } }))
    return observation
  }
  const peer = await f.attach()
  await until(async () => peer.frames.some(frame => frame.type === "event") ? true : undefined)
  const events = peer.frames.flatMap(frame => frame.type === "snapshot_events" ? frame.events : frame.type === "event" ? [frame.event] : [])
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 162 }, (_, n) => n + 1))
  assert.equal(peer.frames.find(frame => frame.type === "snapshot_end").lastSeq, 161)
  assert.equal(events.at(-1).update.content.text, "during transfer")
  assert.deepEqual(peer.faults, [])
  conversation.close()
})

test("a slow observer overflows independently while a fast observer keeps receiving events", async t => {
  const f = await fixture(t), conversation = createConversation(f.target), ready = (await f.service.current(f.workspace)).agents[0]!.record
  conversation.append({ kind: "lifecycle", phase: "ready", session: ready.session, cwd: f.workspace })
  f.service.observe = async (_target, listener) => conversation.observe(listener)
  const slow = await f.attach(), fast = await f.attach()
  slow.socket.pause()
  for (let n = 0; n < 120; n++) {
    const seq = conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(64000) } } })
    await until(async () => fast.frames.some(frame => frame.type === "event" && frame.event.seq === seq) ? true : undefined)
  }
  await until(async () => f.peers.size === 1 ? true : undefined)
  assert.equal(fast.socket.destroyed, false)
  slow.socket.resume()
  await until(async () => slow.socket.destroyed ? true : undefined)
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
  conversation.close()
})

test("generation retirement closes attachments and cannot redirect them through restoration", async t => {
  const f = await fixture(t), peer = await f.attach()
  await f.service.stop({ ...f.target, commandId: randomUUID() })
  await until(async () => peer.socket.destroyed ? true : undefined)
  assert.equal(peer.frames.at(-1).type, "fault")
  assert.equal(peer.frames.at(-1).target.providerGeneration, f.target.providerGeneration)
})