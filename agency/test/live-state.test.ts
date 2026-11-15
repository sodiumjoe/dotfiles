import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { agentHandlerFixture } from "./agent-support.js"
import { until } from "./control-support.js"

test("providers exit within seconds when the Handler is killed", async t => {
  const f = await agentHandlerFixture(t, { selectionCatalog: true, nativeAcp: true })
  const started = await f.waitCompleted(await f.start({ mode: "read-only" }))
  const target = started.command.target!
  await f.crashHandler()
  await until(async () => { try { await f.assertProviderAbsent(target); return true } catch { return undefined } }, 10000)
  await f.restart({ selectionCatalog: true, nativeAcp: true })
  await f.verifyZeroSurvivors()
})

test("a provider in the middle of a turn exits within seconds when the Handler is killed", async t => {
  const f = await agentHandlerFixture(t, { selectionCatalog: true, nativeAcp: true, pauseAt: "prompt" })
  const target = (await f.waitCompleted(await f.start({ mode: "read-only" }))).command.target!
  void f.prompt(target, "hello").catch(() => undefined)
  await f.waitPrompt()
  await f.crashHandler()
  await until(async () => { try { await f.assertProviderAbsent(target); return true } catch { return undefined } }, 10000)
  await f.restart({ selectionCatalog: true, nativeAcp: true })
  await f.verifyZeroSurvivors()
})

test("the event log records Handler starts, clean stops and unclean exits", async t => {
  const f = await agentHandlerFixture(t, { selectionCatalog: true, nativeAcp: true })
  const events = async () => (await readFile(join(f.paths.persistentRoot, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).type).filter((type: string) => type.startsWith("handler_"))
  const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  await f.control({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: handler.generation, op: "shutdown", commandId: randomUUID(), stopAgents: false })
  await f.waitHandlerExit()
  await f.restart({ selectionCatalog: true, nativeAcp: true })
  assert.deepEqual(await events(), ["handler_started", "handler_stopped", "handler_started"])
  await f.crashHandler()
  await f.restart({ selectionCatalog: true, nativeAcp: true })
  assert.deepEqual((await events()).slice(-2), ["handler_unclean_exit", "handler_started"])
  await f.verifyZeroSurvivors()
})

test("a Handler stopped with SIGTERM is not logged as an unclean exit", async t => {
  const f = await agentHandlerFixture(t, { selectionCatalog: true, nativeAcp: true })
  const events = async () => (await readFile(join(f.paths.persistentRoot, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).type).filter((type: string) => type.startsWith("handler_"))
  await f.terminateHandler()
  await f.restart({ selectionCatalog: true, nativeAcp: true })
  assert.deepEqual(await events(), ["handler_started", "handler_stopped", "handler_started"])
  await f.verifyZeroSurvivors()
})