import assert from "node:assert/strict"
import test from "node:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
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

test("a Handler that fails during startup reports why", async t => {
  const f = await liveHandlerFixture(t)
  await f.stopHandler()
  await writeFile(join(f.root, "fail-startup"), "")
  const error = await f.restart().then(() => null, (failure: Error) => failure.cause as Error)
  assert.equal(error?.message, "Handler startup failed: Error: fixture startup failure")
  await rm(join(f.root, "fail-startup"))
  await f.restart()
  await f.verifyZeroSurvivors()
})

test("a pending doorbell does not keep the Handler process alive", async () => {
  const state = fileURLToPath(new URL("../src/live/state.js", import.meta.url)), started = Date.now()
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const { createLiveTable } = await import(${JSON.stringify(state)}); const table = createLiveTable(); void table.changed(table.version(), 60000)`], { timeout: 20000 })
  assert.ok(Date.now() - started < 10000)
})