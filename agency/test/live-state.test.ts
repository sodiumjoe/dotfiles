import assert from "node:assert/strict"
import test from "node:test"
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