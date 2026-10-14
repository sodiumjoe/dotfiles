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
import { parseHostReply, type HostResult } from "../src/hosts/protocol.js"

for (const coordination of ["reject", "hold"] as const) test(`remote ordinary controls work while task startup ${coordination}s`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { coordination }), acp = await f.connect()
  if (coordination === "hold") await until(async () => await fileExists(join(f.root, "coordination-entered")) ? true : undefined)
  const record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const enrollment = { inventoryId: randomUUID(), hostId: f.paths.hostKey, hostname: "fixture", agyPath: "/opt/agy", loginShell: "/bin/sh" }
  const transport = await connectBridge(enrollment, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "runtime-write"], processFactory: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId: f.paths.hostKey, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const call = async (argv: string[]): Promise<HostResult> => {
    const output: string[] = []
    assert.equal(await runControl([...argv, "--host", f.paths.hostKey, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), hostRoute: (_env, route) => transport.request(route.channel, route.payload), start: async () => { throw new Error("start forbidden") }, callBureau: async () => { throw new Error("Bureau forbidden") }, stdout: value => output.push(value) }), 0)
    const reply = parseHostReply(JSON.parse(output.join(""))); assert.ok(reply.ok); return reply.result
  }
  await acp.request("initialize", { protocolVersion: 1 })
  const session = await acp.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const roster = await call(["roster", "list"]); assert.ok(roster.state === "page" && roster.agents.length === 1)
  const prompt = acp.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  await acp.next("session/request_permission")
  const pending = await call(["permission", "list"]); assert.ok(pending.state === "permissions" && "snapshot" in pending)
  const offer = pending.snapshot.pending[0]!, commandId = randomUUID()
  const answer = await call(["permission", "decide", "--input-json", JSON.stringify({ commandId, ref: offer.ref, optionId: offer.options[0]!.optionId })])
  assert.deepEqual(await call(["permission", "inspect", commandId]), answer)
  assert.ok(answer.state === "permission" && answer.receipt?.state === "applied")
  assert.equal((await prompt).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
  transport.close(); await transport.closed
  assert.equal((await f.choices()).state, "choices")
  await f.stopSession(String(session.sessionId)); acp.close(); await f.verifyZeroSurvivors()
})