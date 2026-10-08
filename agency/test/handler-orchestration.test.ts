import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

test("Handler admission holds ACP dispatch until publication under its existing queue", async t => {
  const f = await agentServiceFixture(t), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const record = await f.service.createSession({ commandId: randomUUID(), cwd: f.input.cwd, backendId: "codex-acp", selection: { modelId: "model-a" }, environment: f.input.environment, nativeParams: {} }), target = { agentId: record.definition.agentId, handlerGeneration: record.launch!.handlerGeneration, providerGeneration: record.launch!.providerGeneration }
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "notification" }] }
  const accepted = f.service.submitAcp(target, request, async () => { entered.resolve(); await gate.promise })
  await entered.promise
  assert.equal(f.methodHistory.some(entry => entry === "session/prompt"), false)
  gate.resolve(); await accepted; await f.service.settledAcp(target, request.submissionId)
  assert.equal(f.methodHistory.filter(entry => entry === "session/prompt").length, 1)
  await f.service.submitAcp(target, request, async () => { throw new Error("duplicate admission must not run") })
  assert.equal(f.methodHistory.filter(entry => entry === "session/prompt").length, 1)
})

test("Handler publication failure releases admission for a human turn", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.input.cwd, backendId: "codex-acp", selection: { modelId: "model-a" }, environment: f.input.environment, nativeParams: {} }), target = { agentId: record.definition.agentId, handlerGeneration: record.launch!.handlerGeneration, providerGeneration: record.launch!.providerGeneration }
  await assert.rejects(f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "notification" }] }, async () => { throw new Error("ENOSPC receipt") }), /ENOSPC/)
  assert.equal(f.methodHistory.some(entry => entry === "session/prompt"), false)
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "human" }] }
  await f.service.submitAcp(target, request); await f.service.settledAcp(target, request.submissionId)
  assert.equal(f.methodHistory.filter(entry => entry === "session/prompt").length, 1)
})

test("orchestrated settled hooks run after the active turn lock is released", async t => {
  const f = await agentServiceFixture(t), agentId = randomUUID(), settled = Promise.withResolvers<void>()
  let count = 0
  const accepted = await f.service.launchSession({ commandId: randomUUID(), cwd: f.input.cwd, backendId: "codex-acp", selection: { modelId: "model-a" }, environment: f.input.environment, nativeParams: {} }, "start", { agentId, async prepare(_record, params) { return params }, settled() { count++; settled.resolve() } })
  await until(async () => (await f.service.command(accepted.command.commandId, f.input.handlerGeneration)).command.state !== "pending" ? true : undefined)
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "first" }] }
  await f.service.submitAcp(accepted.command.target!, request); await settled.promise
  const second = { ...request, submissionId: randomUUID() }
  await f.service.submitAcp(accepted.command.target!, second); await f.service.settledAcp(accepted.command.target!, second.submissionId)
  assert.equal(count, 2)
})