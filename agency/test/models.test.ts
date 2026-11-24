import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createModelCache } from "../src/live/models.js"

async function codexProfile(t: import("node:test").TestContext, scenario: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agency-models-test-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, "codex"), log = join(root, "listings")
  await writeFile(executable, `#!/bin/sh\nFIXTURE_MODEL_LOG=${log} FIXTURE_MODEL_SCENARIO=${scenario} exec ${process.execPath} ${fileURLToPath(new URL("./fixtures/codex-app-server.js", import.meta.url))} "$@"\n`, { mode: 0o700 })
  await writeFile(join(root, "adapter.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0", main: "index.js" }), { mode: 0o600 })
  await writeFile(join(root, "index.js"), "", { mode: 0o600 })
  await writeFile(join(root, "config.toml"), "", { mode: 0o600 })
  const state = join(root, "state")
  await mkdir(join(state, "catalog"), { recursive: true, mode: 0o700 })
  await writeFile(join(state, "catalog/providers.json"), JSON.stringify({ version: 1, providers: [{ id: "codex-acp", enabled: true, executable, adapterPackageJson: join(root, "adapter.json"), sdkPackageJson: null, configurationFiles: [join(root, "config.toml")] }] }), { mode: 0o600 })
  return { state, listings: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length }
}

test("models come from the provider's own listing and are cached in memory", async t => {
  const { state, listings } = await codexProfile(t, "normal")
  const cache = createModelCache({ root: state })
  const [first, second] = await Promise.all([cache.list("codex-acp"), cache.list("codex-acp")])
  assert.equal(first.error, null)
  assert.deepEqual(first.models.map(model => [model.modelId, model.reasoning]), [["model-a", { state: "values", values: ["high", "low"] }], ["model-b", { state: "unknown" }]])
  assert.deepEqual(second, first)
  assert.deepEqual(await cache.list("codex-acp"), first)
  assert.equal(await listings(), 1)
  cache.observe("codex-acp", "model", { configOptions: [{ id: "model", options: [{ value: "model-a" }, { value: "model-c" }] }], models: null, modes: null, availableCommands: [], revision: 1 })
  assert.deepEqual((await cache.list("codex-acp")).models.map(model => model.modelId), ["model-a", "model-c"])
  assert.equal((await cache.list("claude-agent-acp")).error, "backend claude-agent-acp is not configured")
})

test("a listing that does not answer times out with the reason and is retried next time", async t => {
  const { state, listings } = await codexProfile(t, "hang")
  const cache = createModelCache({ root: state, timeoutMs: 600 })
  const started = Date.now(), listing = await cache.list("codex-acp")
  assert.ok(Date.now() - started < 5000)
  assert.deepEqual(listing, { backendId: "codex-acp", models: [], error: "model listing for codex-acp timed out after 600 ms" })
  await cache.list("codex-acp")
  assert.equal(await listings(), 2)
})