import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"

type Fixture = Awaited<ReturnType<typeof liveHandlerFixture>>
const handlerEvents = async (f: Fixture) => (await readFile(join(f.paths.persistentRoot, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).type).filter((type: string) => type.startsWith("handler_"))

test("a provider in the middle of a turn exits within seconds when the Handler is killed", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  await f.pausePrompts()
  void f.prompt(agentId, "paused").catch(() => undefined)
  await f.waitPrompt()
  await f.crashHandler()
  for (const item of f.providers()) if (item.pid) await until(async () => await f.observe(item.pid!) === null ? true : undefined, 10000)
  await f.releasePrompts()
  await f.restart()
  await f.verifyZeroSurvivors()
})

test("the event log records Handler starts, clean stops and unclean exits", async t => {
  const f = await liveHandlerFixture(t)
  await f.stopHandler()
  await f.restart()
  assert.deepEqual(await handlerEvents(f), ["handler_started", "handler_stopped", "handler_started"])
  await f.crashHandler()
  await f.restart()
  assert.deepEqual((await handlerEvents(f)).slice(-2), ["handler_unclean_exit", "handler_started"])
  await f.verifyZeroSurvivors()
})

test("a Handler stopped with SIGTERM is not logged as an unclean exit", async t => {
  const f = await liveHandlerFixture(t), current = await f.handler()
  assert.ok(current.process)
  await f.signal(current.process, "SIGTERM")
  await until(async () => await f.observe(current.process!.pid) === null ? true : undefined, 15000)
  await f.restart()
  assert.deepEqual(await handlerEvents(f), ["handler_started", "handler_stopped", "handler_started"])
  await f.verifyZeroSurvivors()
})