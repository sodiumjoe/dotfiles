import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { PassThrough, Writable } from "node:stream"
import test from "node:test"
import { discoverClaude } from "../src/catalog/drivers/claude.js"
import { discoverCodex } from "../src/catalog/drivers/codex.js"
import { NativeFacade, type DriverContext, type RegisteredChild } from "../src/catalog/drivers/transport.js"
import { gate, syntheticProbeFixture } from "./catalog-support.js"

async function peer(t: Parameters<typeof syntheticProbeFixture>[0], scenario = "good") {
  const f = await syntheticProbeFixture(t), stdout = new PassThrough(), methods: string[] = [], controller = new AbortController()
  let pages = 0, cleanup = 0
  const child: RegisteredChild = { stdout, terminal: new Promise(() => undefined), requestCleanup: () => { cleanup++ }, stdin: new Writable({ write(bytes: Buffer, _enc, callback) {
    const request = JSON.parse(bytes.toString())
    methods.push(request.method)
    assert.ok(["initialize", "initialized", "model/list"].includes(request.method))
    if (request.method === "initialized") { callback(); return }
    let result: unknown = { serverInfo: { version: "native-1" } }
    if (request.method === "model/list") {
      assert.equal(request.params.limit, 100)
      pages++
      result = { data: [{ id: `m${pages}`, displayName: "Modèle", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "More" }] }], nextCursor: pages === 1 ? "next" : null }
      if (scenario === "cursor") result = { data: [], nextCursor: "same" }
      if (scenario === "pages") result = { data: [], nextCursor: String(pages) }
      if (scenario === "long-cursor") result = { data: [], nextCursor: "x".repeat(1025) }
      if (scenario === "models") result = { data: Array.from({ length: 513 }, (_, i) => ({ id: String(i), displayName: "M" })), nextCursor: null }
    }
    const response = JSON.stringify({ id: request.id, result }) + "\n"
    queueMicrotask(() => {
      if (scenario === "hang") return
      if (scenario === "invalid") { stdout.write("not json\n"); return }
      if (scenario === "utf8") { stdout.write(Buffer.from([0xff, 10])); return }
      if (scenario === "eof") { stdout.end('{"id":'); return }
      if (scenario === "huge") { stdout.write("x".repeat(1048577)); return }
      if (scenario === "notifications") { stdout.write('{"method":"notice"}\n'.repeat(60000)); return }
      if (scenario === "request") { stdout.write('{"id":42,"method":"exec","params":{"secret":"SECRET"}}\n'); return }
      if (scenario === "id") { stdout.write(JSON.stringify({ id: 99999, result }) + "\n"); return }
      if (scenario === "error") { stdout.write(JSON.stringify({ id: request.id, error: { message: "SECRET" } }) + "\n"); return }
      if (scenario === "split") for (const byte of Buffer.from(response)) stdout.write(Buffer.from([byte]))
      else stdout.write(response)
      if (scenario === "duplicate") stdout.write(response)
    })
    callback()
  } }) }
  const context: DriverContext = { request: { ...f.request, profile: { ...f.request.profile, id: "codex-acp", sdkPackageJson: null } }, signal: controller.signal, spawnNative: (file, args) => { assert.equal(file, f.profile.executable); assert.deepEqual(args, ["app-server"]); return child } }
  return { context, methods, controller, child, cleanup: () => cleanup, f }
}

for (const scenario of ["good", "split"]) test(`Codex fixed discovery handles ${scenario} native evidence without session methods`, async t => {
  const f = await peer(t, scenario), result = await discoverCodex(f.context)
  assert.deepEqual(f.methods, ["initialize", "initialized", "model/list", "model/list"])
  assert.deepEqual(result.models.map(m => [m.modelId, m.displayName, m.reasoning, m.modes]), [["m1", "Modèle", { state: "values", values: ["high"] }, { state: "unknown" }], ["m2", "Modèle", { state: "values", values: ["high"] }, { state: "unknown" }]])
  assert.equal(result.providerVersion, "native-1")
})
for (const scenario of ["invalid", "utf8", "eof", "huge", "notifications", "request", "id", "error", "duplicate", "cursor", "pages", "long-cursor", "models"]) test(`Codex rejects ${scenario} without exposing provider text`, async t => {
  const f = await peer(t, scenario)
  await assert.rejects(discoverCodex(f.context), error => error instanceof Error && !error.message.includes("SECRET"))
  assert.ok(f.methods.length <= 18)
})
test("Codex cancellation bounds an incomplete protocol exchange", async t => {
  const f = await peer(t, "hang"), operation = discoverCodex(f.context)
  f.controller.abort()
  await assert.rejects(operation)
})

test("Claude queries only model metadata with empty prompts and restrictive options", async t => {
  const f = await syntheticProbeFixture(t), records: Record<string, unknown>[] = []
  let spawns = 0, prompts = 0
  const stdout = new PassThrough(), stdin = new PassThrough(), spawnAbort = new AbortController()
  const context: DriverContext = { request: f.request, signal: new AbortController().signal, spawnNative: (file, args) => { assert.equal(file, f.profile.executable); assert.deepEqual(args, ["--fixture"]); spawns++; return { stdout, stdin, terminal: new Promise(() => undefined), requestCleanup() {} } } }
  const result = await discoverClaude(context, async () => ({ query: ({ options, prompt }: { options: Record<string, any>; prompt: AsyncIterable<unknown> }) => {
    records.push(options)
    options.spawnClaudeCodeProcess({ command: f.profile.executable, args: ["--fixture"], cwd: f.request.meta.workPath, env: { SECRET: "do not inherit" }, signal: spawnAbort.signal })
    return { supportedModels: async () => { for await (const _ of prompt) prompts++; return [{ value: "alias", displayName: "A", supportsEffort: true, supportedEffortLevels: ["high"] }] } }
  } }))
  assert.equal(spawns, 1); assert.equal(prompts, 0)
  const options = records[0]!
  assert.deepEqual(options.settingSources, []); assert.deepEqual(options.mcpServers, {}); assert.deepEqual(options.tools, [])
  assert.equal(options.persistSession, false); assert.equal(options.cwd, f.request.meta.workPath)
  assert.deepEqual(result.models[0]!.modes, { state: "unknown" })
  assert.deepEqual(result.models[0]!.reasoning, { state: "values", values: ["high"] })
  assert.equal(result.providerVersion, null)
})

for (const scenario of ["zero", "multiple", "wrong-file", "sdk-abort", "contradiction", "sdk-error"]) test(`Claude refuses ${scenario} SDK behavior`, async t => {
  const f = await syntheticProbeFixture(t), abort = new AbortController()
  let spawns = 0, cleanup = 0
  const child = { stdin: new PassThrough(), stdout: new PassThrough(), terminal: new Promise<void>(() => undefined), requestCleanup: () => { cleanup++ } }
  const context: DriverContext = { request: f.request, signal: new AbortController().signal, spawnNative: () => { spawns++; return child } }
  await assert.rejects(discoverClaude(context, async () => ({ query: ({ options }: { options: Record<string, any> }) => {
    const call = () => options.spawnClaudeCodeProcess({ command: scenario === "wrong-file" ? "/bin/sh" : f.profile.executable, args: [], cwd: f.request.meta.workPath, env: {}, signal: abort.signal })
    if (scenario !== "zero") call()
    if (scenario === "multiple") call()
    if (scenario === "sdk-abort") abort.abort()
    return { supportedModels: async () => {
      if (scenario === "sdk-error") throw new Error("SECRET")
      return scenario === "contradiction" ? [{ value: "m", displayName: "M", supportsEffort: false, supportedEffortLevels: ["high"] }] : []
    } }
  } })), error => error instanceof Error && !error.message.includes("SECRET"))
  assert.ok(spawns <= 1)
  if (scenario === "sdk-abort") assert.equal(cleanup, 1)
})

test("SDK process facade buffers input and routes kill to its owner", async () => {
  const raw = new ChildProcess(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), registered = gate()
  let rawKills = 0, ownedCleanup = 0, received = ""
  Object.assign(raw, { stdin, stdout, stderr, pid: 123, kill: () => { rawKills++; return true } })
  stdin.on("data", bytes => { received += bytes.toString() })
  const facade = new NativeFacade(raw, registered.promise, () => { ownedCleanup++ })
  facade.stdin.write("before-registration")
  await Promise.resolve()
  assert.equal(received, "")
  registered.resolve()
  await new Promise<void>(resolve => facade.stdin.write("-after", () => resolve()))
  assert.equal(received, "before-registration-after")
  facade.kill()
  assert.equal(ownedCleanup, 1); assert.equal(rawKills, 0)
  raw.emit("exit", 0, null); raw.emit("close", 0, null)
  await facade.terminal
})