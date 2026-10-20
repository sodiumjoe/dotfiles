import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { createNativeFixtureScope } from "../run-scope.js"
import type { FixtureConnection } from "../fixture-channel.js"

const config = JSON.parse(process.env.AGENCY_TEST_CONNECTION!) as FixtureConnection
const mode = process.argv[2]
const scope = createNativeFixtureScope({ runId: config.runId, workerFile: "raw", deadlineMs: 5000 })
const socket = createConnection(config.socketPath)
let buffer = "", sequence = 0
const replies: Array<(frame: Record<string, unknown>) => void> = []
socket.on("data", chunk => {
  buffer += String(chunk)
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), frame = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    replies.shift()?.(frame)
  }
})
socket.on("error", () => {})
const request = (frame: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
  replies.push(resolve)
  socket.write(JSON.stringify({ ...frame, seq: ++sequence }) + "\n")
})
await new Promise<void>(resolve => socket.once("connect", resolve))
if (mode === "oversized") {
  socket.write("x".repeat(65537))
  socket.end()
} else {
  const supplied = structuredClone(config)
  if (mode === "foreign-run") supplied.runId = "foreign"
  if (mode === "foreign-ref") supplied.ownerRef = { ...supplied.ownerRef, runId: "foreign" }
  const hello = await request({ type: "hello", connection: supplied, pid: mode === "wrong-pid" ? process.ppid : process.pid })
  process.stdout.write(JSON.stringify(hello) + "\n")
  if (hello.accepted === true) {
    const ref = scope.intent("raw-leaf", { reporting: mode === "open-pipe" ? "detached-handler" : mode?.startsWith("editor-") ? "editor-endpoint" : "direct" })
    const child = scope.spawn(ref, () => spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 800)"], { stdio: mode === "open-pipe" ? ["ignore", "ignore", "ignore", "pipe"] : "ignore" }), { closeAdmission() {} })
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
    await scope.observe(ref)
    const snapshot = () => ({ failures: scope.snapshot().failures, children: [], launches: scope.snapshot().launches.map(launch => ({ launch, ownGroup: false, pipesClosed: mode !== "open-pipe" })) })
    const initial = snapshot()
    if (mode === "bad-observation") initial.launches[0]!.launch.identity!.birth = "999:forged"
    const first = await request({ type: "snapshot", phase: "progress", snapshot: initial })
    process.stdout.write(JSON.stringify(first) + "\n")
    if (first.accepted === true) {
      let frame: Record<string, unknown> = { type: "snapshot", phase: "progress", snapshot: snapshot() }
      if (mode === "conflict") (frame.snapshot as ReturnType<typeof snapshot>).launches[0]!.launch.role = "forged"
      if (mode === "omitted") (frame.snapshot as ReturnType<typeof snapshot>).launches = []
      if (mode === "unknown-field") frame.extra = true
      if (mode === "open-pipe" || mode === "outstanding") frame.phase = "complete"
      if (mode === "editor-delivery") frame = { type: "editor-stop", ref, signal: "SIGTERM" }
      if (mode === "editor-absent") {
        await closed
        await request({ type: "snapshot", phase: "progress", snapshot: snapshot() })
        frame = { type: "editor-stop", ref, signal: "SIGTERM" }
      }
      if (mode === "editor-refusal") {
        await scope.signal(ref, "SIGTERM")
        await closed
        frame = { type: "editor-stop", ref, signal: "SIGKILL" }
      }
      if (mode === "sealed-late") {
        process.stdout.write(JSON.stringify(await request({ type: "snapshot", phase: "before-intentional-exit", snapshot: snapshot() })) + "\n")
      }
      if (mode === "replay") sequence = 0
      if (mode === "seal-eof") {
        void request({ type: "snapshot", phase: "before-intentional-exit", snapshot: snapshot() })
        socket.destroy()
      } else process.stdout.write(JSON.stringify(await request(frame)) + "\n")
    }
    await closed
    if (mode === "editor-delivery" || mode === "editor-absent") process.stdout.write(JSON.stringify(await request({ type: "snapshot", phase: "complete", snapshot: snapshot() })) + "\n")
  }
  socket.end()
}
await new Promise<void>(resolve => socket.closed ? resolve() : socket.once("close", resolve))