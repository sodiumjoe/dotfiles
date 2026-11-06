import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough, Readable } from "node:stream"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { runTaskClient } from "../src/tasks/cli.js"
import { readInputJson } from "../src/cli/input-json.js"
import { fixtureSpawner } from "./fixtures/fixture-spawn.js"
import { fileURLToPath } from "node:url"

const hostId = "a".repeat(64), commandId = "00000000-0000-4000-8000-000000000001"
async function refuse(argv: string[], stdin: Readable) {
  let output = "", environments = 0
  const deps = { ...productionControlDependencies(), stdin, environment: async () => { environments++; throw new Error("environment forbidden") }, stdout: (text: string) => { output += text } }
  const code = await runControl([...argv, "--json"], deps)
  assert.equal(environments, 0)
  return { code, reply: JSON.parse(output) }
}

test("host enrollment receives the exact JSON object from stdin", async () => {
  const enrollment = { hostId, hostname: "fixture-host" }, saved: unknown[] = []
  let output = ""
  const base = productionControlDependencies()
  const deps = { ...base, stdin: Readable.from([Buffer.from(JSON.stringify(enrollment))]),
    environment: async () => ({}) as Awaited<ReturnType<typeof base.environment>>,
    hostInventory: () => ({ list: async () => [], enroll: async (value: unknown) => { saved.push(value) } }),
    stdout: (value: string) => { output += value } }
  assert.equal(await runControl(["host", "enroll", "--input-json", "-", "--json"], deps), 0)
  assert.deepEqual(saved, [{ hostId, hostname: "fixture-host" }])
  assert.equal(JSON.parse(output).result.state, "enrolled")
})

const clients = [
  { argv: ["session", "submit", "--host", hostId], malformed: "USAGE", oversized: "INPUT_TOO_LARGE" },
  { argv: ["entry", "open"], malformed: "USAGE", oversized: "INPUT_TOO_LARGE" },
  { argv: ["git", "prepare"], malformed: "USAGE", oversized: "USAGE" },
  { argv: ["task", "wait", commandId, "--host", hostId], malformed: "INVALID_INPUT", oversized: "INPUT_TOO_LARGE" },
  { argv: ["permission", "decide", "--host", hostId], malformed: "USAGE", oversized: "INPUT_TOO_LARGE" },
  { argv: ["permission", "decide", "--local"], malformed: "USAGE", oversized: "INPUT_TOO_LARGE" },
  { argv: ["host", "enroll"], malformed: "USAGE", oversized: "INPUT_TOO_LARGE" },
]
for (const client of clients) {
  test(client.argv.join(" ") + " rejects malformed stdin before environment access", async () => {
    const result = await refuse([...client.argv, "--input-json", "-"], Readable.from(["{"]))
    assert.equal(result.code, 64); assert.equal(result.reply.error.code, client.malformed)
  })
  test(client.argv.join(" ") + " rejects oversized stdin before environment access", async () => {
    const result = await refuse([...client.argv, "--input-json", "-"], Readable.from([Buffer.alloc(1048577, 32)]))
    assert.equal(result.code, 64); assert.equal(result.reply.error.code, client.oversized)
  })
}

for (const argv of [
  ["session", "inspect", commandId, "--host", hostId],
  ["session", "command", "invalid", "--host", hostId],
  ["entry", "open", "--host", "invalid"],
  ["permission", "decide", "--host", hostId, "--command-id", "invalid"],
  ["task", "inspect", commandId, "--host", hostId],
]) test("invalid argv refuses without touching unfinished stdin: " + argv.join(" "), async () => {
  const stream = new PassThrough()
  try {
    const result = await refuse([...argv, "--input-json", "-"], stream)
    assert.equal(result.code, 64); assert.equal(stream.readableFlowing, null)
  } finally { stream.destroy() }
})

test("task cancellation while reading stdin exits 130 before environment access", async () => {
  const stream = new PassThrough(), controller = new AbortController()
  let output = "", environments = 0
  const deps = {
    ...productionControlDependencies(), stdin: stream, signal: controller.signal,
    environment: async () => { environments++; throw new Error("environment forbidden") }, stdout: (value: string) => { output += value },
  }
  const waiting = runTaskClient(["task", "wait", commandId, "--host", hostId, "--input-json", "-", "--json"], deps)
  controller.abort()
  assert.equal(await waiting, 130); assert.equal(JSON.parse(output).error.code, "CANCELLED"); assert.equal(environments, 0)
  stream.destroy()
})

test("inline JSON leaves stdin untouched", async () => {
  const stdin = new PassThrough()
  assert.deepEqual(await readInputJson('{"text":"λ"}', { stdin }), { text: "λ" })
  assert.equal(stdin.readableFlowing, null); stdin.destroy()
})

test("split UTF-8 characters and the exact byte limit are accepted", async () => {
  const prefix = Buffer.from('{"text":"'), unicode = Buffer.from("λ🙂"), suffix = Buffer.from('"}')
  const stdin = Readable.from([prefix, unicode.subarray(0, 1), unicode.subarray(1, 3), unicode.subarray(3), suffix])
  assert.deepEqual(await readInputJson("-", { stdin }), { text: "λ🙂" })
  const bounded = Buffer.from('"' + "a".repeat(1048574) + '"')
  assert.equal((await readInputJson("-", { stdin: Readable.from([bounded]) }) as string).length, 1048574)
  for (const event of ["data", "end", "error", "close"]) assert.equal(stdin.listenerCount(event), 0)
})

for (const bytes of [Buffer.alloc(0), Buffer.from("{"), Buffer.from([34, 0xff, 34]), Buffer.from([34, 0xc2])]) {
  test("invalid JSON or UTF-8 is refused: " + bytes.toString("hex"), async () => {
    await assert.rejects(readInputJson("-", { stdin: Readable.from([bytes]) }), { code: "USAGE" })
  })
}

test("stdin overflow releases the stream and its listeners", async () => {
  const stdin = new PassThrough(), promise = readInputJson("-", { stdin })
  stdin.write(Buffer.alloc(1048577))
  await assert.rejects(promise, { code: "INPUT_TOO_LARGE" })
  assert.equal(stdin.readableFlowing, false)
  for (const event of ["data", "end", "error", "close"]) assert.equal(stdin.listenerCount(event), 0)
  stdin.destroy()
})

for (const kind of ["error", "close", "deadline", "abort"]) {
  test(kind + " settles stdin and removes reader listeners", async () => {
    const stdin = new PassThrough(), controller = new AbortController()
    const promise = readInputJson("-", { stdin, signal: controller.signal, timeoutMs: 20 })
    if (kind === "error") stdin.destroy(new Error("fixture stream failure"))
    if (kind === "close") stdin.destroy()
    if (kind === "abort") controller.abort()
    await assert.rejects(promise, { code: "USAGE" })
    assert.equal(stdin.readableFlowing, false)
    for (const event of ["data", "end", "error", "close"]) assert.equal(stdin.listenerCount(event), 0)
    stdin.destroy()
  })
}

test("missing, interactive and already aborted stdin are refused without reading", async () => {
  await assert.rejects(readInputJson("-", {}), { code: "USAGE" })
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  await assert.rejects(readInputJson("-", { stdin }), { code: "USAGE" })
  stdin.isTTY = false
  await assert.rejects(readInputJson("-", { stdin, signal: AbortSignal.abort() }), { code: "USAGE" })
  assert.equal(stdin.readableFlowing, null); stdin.destroy()
})

test("task write cancellation preserves unknown mutation outcome and its reference", async () => {
  const controller = new AbortController(), base = productionControlDependencies()
  let output = "", writes = 0
  const code = await runTaskClient(["task", "report", commandId, "--host", hostId, "--input-json", "-", "--json"], {
    ...base, stdin: Readable.from(['{"outcome":"completed","summary":"fixture"}']), signal: controller.signal,
    environment: async () => ({ paths: { hostKey: hostId, persistentRoot: "/unused" } }) as Awaited<ReturnType<typeof base.environment>>,
    hostRoute: async (_env, route) => {
      if (route.channel === "host-identity") return { hostId, handlerGeneration: commandId }
      assert.equal(route.channel, "task-write"); writes++; controller.abort(); throw new Error("write interrupted")
    }, stdout: value => { output += value },
  })
  assert.equal(writes, 1); assert.equal(code, 75)
  assert.equal(JSON.parse(output).error.code, "OUTCOME_UNKNOWN")
  assert.deepEqual(JSON.parse(output).error.ref, { hostId, taskId: commandId })
})

for (const launcher of ["node", "agy"]) test("actual " + launcher + " accepts long stdin and refuses own-op locally", { timeout: 10000 }, async () => {
  const spawn = await fixtureSpawner(), root = fileURLToPath(new URL("../../../", import.meta.url))
  const child = launcher === "node"
    ? spawn("stdin-cli-node", process.execPath, [fileURLToPath(new URL("../src/main.js", import.meta.url)), "session", "submit", "--host", hostId, "--input-json", "-", "--json"], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn("stdin-cli-wrapper", root + "home/bin/agy", ["session", "submit", "--host", hostId, "--input-json", "-", "--json"], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }))
  })
  child.stdout!.on("data", value => { stdout += value }); child.stderr!.on("data", value => { stderr += value })
  child.stdin!.end(JSON.stringify({ op: "forbidden-fixture", text: "λ".repeat(32768) }))
  assert.deepEqual(await closed, { code: 64, signal: null }); assert.equal(stderr, "")
  const reply = JSON.parse(stdout)
  assert.equal(reply.ok, false); assert.equal(reply.error.code, "USAGE")
  assert.equal(reply.hostId, null); assert.equal(reply.handlerGeneration, null)
})