import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acpFixture } from "./acp-support.js"
import { until, fileExists } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { TASK_PROTOCOL, parseTaskReply } from "../src/tasks/protocol.js"

for (const tasks of ["hold", "reject"] as const) test(`task initialization ${tasks} preserves core and advertised capabilities`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks, coordination: "reject" })
  await until(async () => await fileExists(join(f.root, "tasks-entered")) ? true : undefined)
  const record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json")), hostId = f.paths.hostKey
  const transport = await connectBridge({ inventoryId: randomUUID(), hostId, hostname: "fixture", agyPath: "/opt/agy", loginShell: "/bin/sh" }, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "task-read", "task-write"], processFactory: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const taskId = randomUUID(), request = { protocol: TASK_PROTOCOL, requestId: randomUUID(), hostId, handlerGeneration: record.generation, op: "inspect", taskId }
  const call = async () => parseTaskReply(await transport.request("task-read", request))
  const unavailable = await call(); assert.ok(!unavailable.ok); assert.equal(unavailable.error.code, "TASKS_UNAVAILABLE")
  const peer = await f.connect(), initialized = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(initialized.protocolVersion, 1)
  peer.close()
  if (tasks === "hold") {
    await writeFile(join(f.root, "release-tasks"), "released", { mode: 0o600 })
    const missing = await until(async () => { const reply = await call(); return !reply.ok && reply.error.code === "TASK_NOT_FOUND" ? reply : undefined })
    assert.ok(!missing.ok)
  }
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("Handler shutdown completes while task initialization remains held", { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks: "hold", coordination: "hold" })
  await until(async () => await fileExists(join(f.root, "tasks-entered")) ? true : undefined)
  await f.verifyZeroSurvivors()
})