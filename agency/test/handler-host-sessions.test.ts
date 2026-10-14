import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { acpFixture } from "./acp-support.js"
import { fileExists, until } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { parseHostReply } from "../src/hosts/protocol.js"

for (const tasks of ["reject", "hold"] as const) test(`ordinary host sessions run while task initialization ${tasks}s`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks })
  if (tasks === "hold") await until(async () => await fileExists(join(f.root, "tasks-entered")) ? true : undefined)
  const record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json")), hostId = f.paths.hostKey
  const transport = await connectBridge({ inventoryId: randomUUID(), hostId, hostname: "fixture", agyPath: "/opt/agy", loginShell: "/bin/sh" }, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "runtime-write"], processFactory: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const call = async (args: string[]) => {
    let output = ""
    const code = await runControl(["session", ...args, "--host", hostId, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), hostRoute: (_env, route) => transport.request(route.channel, route.payload), start: async () => { throw new Error("automatic startup forbidden") }, stdout: value => { output += value } })
    const reply = parseHostReply(JSON.parse(output)); return { code, reply }
  }
  const commandId = randomUUID()
  const start = await call(["start", "--input-json", JSON.stringify({ commandId, handlerGeneration: record.generation, cwd: f.workspace, backendId: "codex-acp" })])
  assert.equal(start.code, 0); assert.ok(start.reply.ok && start.reply.result.state === "command")
  const command = await until(async () => { const r = await call(["command", commandId, "--input-json", JSON.stringify({ commandGeneration: record.generation })]); return r.reply.ok && r.reply.result.state === "session_command" && r.reply.result.receipt?.command.state === "completed" ? r.reply.result.receipt : undefined })
  assert.equal(command.command.result?.outcome, "started")
  const target = command.command.target!, submissionId = randomUUID()
  const submitted = await call(["submit", "--input-json", JSON.stringify({ target, submissionId, text: "held" })])
  assert.equal(submitted.code, 0); assert.ok(submitted.reply.ok && submitted.reply.result.state === "submission")
  await until(async () => (await f.requests("codex-acp")).some(frame => frame.method === "session/prompt") ? true : undefined)
  const held = await call(["submission", "--input-json", JSON.stringify({ target, submissionId })]); assert.equal(held.code, 75)
  assert.equal((await call(["inspect", target.agentId])).code, 0)
  if (tasks === "reject") assert.equal((await call(["cancel", "--input-json", JSON.stringify({ target, submissionId })])).code, 0)
  else await f.release("codex-acp")
  const completed = await until(async () => { const r = await call(["submission", "--input-json", JSON.stringify({ target, submissionId })]); return r.code === 0 ? r : undefined })
  assert.ok(completed.reply.ok && completed.reply.result.state === "submission")
  assert.equal(completed.reply.result.receipt?.stopReason, tasks === "reject" ? "cancelled" : "end_turn")
  const stopId = randomUUID()
  assert.equal((await call(["stop", "--input-json", JSON.stringify({ ...target, commandId: stopId })])).code, 0)
  await until(async () => (await call(["command", stopId, "--input-json", JSON.stringify({ commandGeneration: record.generation })])).code === 0 ? true : undefined)
  const requests = await f.requests("codex-acp")
  assert.equal(requests.filter(frame => frame.method === "session/new").length, 1)
  assert.equal(requests.filter(frame => frame.method === "session/prompt").length, 1)
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})