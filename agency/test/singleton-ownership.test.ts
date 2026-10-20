import assert from "node:assert/strict"
import childProcess, { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { settleSingletonStarts, preserveSingletonFixture } from "./fixtures/singleton-ownership.js"
import { createSyntheticFixtureScope } from "./fixtures/run-scope.js"
import { registerFixtureChild } from "./fixtures/fixture-spawn.js"

test("startup dependencies are local and preserve synchronous spawn failure", async () => {
  const { launchHandlerGeneration } = await import("../src/platform/startup.js")
  const { startOrConnect } = await import("../src/platform/singleton.js")
  const roots = await Promise.all([mkdtemp("/tmp/agv-").then(value => realpath(value)), mkdtemp("/tmp/agv-").then(value => realpath(value))])
  const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const original = childProcess.spawn
  const calls: string[] = []
  await Promise.all(roots.map(async (root, index) => {
    const spawn = (file: string) => { calls.push(index + ":" + file); throw new Error("local-spawn-" + index) }
    const options = { root, hostId: "dependency-test", adapter, handler: { file: "/missing-handler", args: [] }, timeoutMs: 500 }
    await assert.rejects(launchHandlerGeneration(options, { spawn }), new RegExp("local-spawn-" + index))
    await assert.rejects(startOrConnect(options, { spawn }), new RegExp("local-spawn-" + index))
  }))
  assert.equal(childProcess.spawn, original)
  assert.equal(calls.length, 4)
  assert.equal(calls.filter(value => value.endsWith(":/missing-handler")).length, 2)
})

test("singleton startup failure waits for every contender before teardown", async () => {
  const failure = new Error("first startup refused")
  const release = Promise.withResolvers<number>()
  let finished = false
  const starting = settleSingletonStarts([Promise.reject(failure), release.promise])
  const result = starting.then(value => ({ value }), error => ({ error })).finally(() => { finished = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
  } finally { release.resolve(2) }
  const outcome = await result
  assert.ok("error" in outcome)
  assert.ok(outcome.error instanceof AggregateError)
  assert.deepEqual(outcome.error.errors, [failure])
  assert.deepEqual(await settleSingletonStarts([Promise.resolve(1), Promise.resolve(2)]), [1, 2])
})


test("synchronous fixture registration writes no event files and retains the original launch", async () => {
  const root = await mkdtemp("/tmp/agv-")
  const scope = createSyntheticFixtureScope({ runId: "no-event-io", workerFile: "singleton", deadlineMs: 100,
    adapter: { platform: "darwin", bootId: async () => "b", readProcess: async () => null, readGroup: async () => [], signalGroup: async () => assert.fail("unexpected signal") }, signal: () => assert.fail("unexpected signal") })
  const ref = scope.intent("throwing-handler")
  assert.throws(() => registerFixtureChild({ scope }, ref, () => { throw new Error("spawn threw") }), /spawn threw/)
  assert.deepEqual(await readdir(root), [])
  assert.equal(scope.snapshot().launches.length, 1)
  assert.equal(scope.snapshot().launches[0]!.ref.launchId, ref.launchId)
  assert.equal(scope.snapshot().launches[0]!.error, "spawn threw")
  assert.equal((await scope.finish()).state, "settled")
})

test("fixture child event listeners attach before asynchronous observation", async () => {
  const scope = createSyntheticFixtureScope({ runId: "early-exit", workerFile: "singleton", deadlineMs: 100,
    adapter: { platform: "darwin", bootId: async () => "b", readProcess: async () => null, readGroup: async () => [], signalGroup: async () => assert.fail("unexpected signal") }, signal: () => assert.fail("unexpected signal") })
  const child = Object.assign(new EventEmitter(), { pid: 123, stdio: [], exitCode: null as number | null, signalCode: null }) as unknown as ChildProcess
  const ref = scope.intent("early-handler")
  registerFixtureChild({ scope }, ref, () => child)
  Object.assign(child, { exitCode: 0 })
  child.emit("exit", 0, null)
  child.emit("close", 0, null)
  const result = await scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result))
  assert.deepEqual(result.launches[0]!.exit, { code: 0, signal: null })
  assert.equal(result.launches[0]!.close, true)
})

test("singleton fixture preservation records symlink targets and excludes sockets", async () => {
  const root = await mkdtemp("/tmp/agv-"), source = join(root, "source"), destination = join(root, "snapshot")
  await mkdir(source)
  await writeFile(join(source, "regular"), "retained")
  await symlink("../missing-target", join(source, "unsafe-entry"))
  const { createServer } = await import("node:net")
  const server = createServer()
  await new Promise<void>(resolve => server.listen(join(source, "s.sock"), resolve))
  try {
    await preserveSingletonFixture(source, destination)
    assert.equal(await readFile(join(destination, "regular"), "utf8"), "retained")
    await assert.rejects(lstat(join(destination, "unsafe-entry")), { code: "ENOENT" })
    await assert.rejects(lstat(join(destination, "s.sock")), { code: "ENOENT" })
    assert.deepEqual(JSON.parse(await readFile(join(destination, "singleton-symlinks.json"), "utf8")), [{ path: "unsafe-entry", target: "../missing-target" }])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})