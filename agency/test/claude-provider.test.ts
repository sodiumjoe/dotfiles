import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { adapterEntry, observeConfig, readProfiles, sdkEntry } from "../src/catalog/config.js"
import { readBackendConfig } from "../src/agent/backend-config.js"
import { backendSelection } from "../src/agent/backend-selection.js"
import { configureLaunchContract, productionLaunchContracts } from "../src/agent/contracts.js"
import type { ProviderProfile } from "../src/catalog/types.js"
import type { ProviderView } from "../src/catalog/service.js"
import type { JsonObject } from "../src/agent/session-config.js"
import { createAcpConnection } from "../src/agent/acp.js"
import { AGENT_LIMITS } from "../src/agent/types.js"

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agency-claude-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "catalog"), { mode: 0o700 })
  const profile: ProviderProfile = {
    id: "claude-agent-acp", enabled: true, executable: process.execPath,
    adapterPackageJson: await realpath(fileURLToPath(new URL("../../../node-bin/node_modules/@agentclientprotocol/claude-agent-acp/package.json", import.meta.url))),
    sdkPackageJson: await realpath(fileURLToPath(new URL("../../../node-bin/node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url))),
    configurationFiles: [],
  }
  const profiles = (providers: ProviderProfile[]) => writeFile(join(root, "catalog/providers.json"), JSON.stringify({ version: 1, providers }), { mode: 0o600 })
  return { root, profile, profiles }
}

test("default installations expose Claude alongside the default Codex backend", async t => {
  const { root } = await fixture(t)
  const profiles = await readProfiles(root)
  assert.deepEqual(profiles.map(profile => profile.id), ["codex-acp", "claude-agent-acp"])
  assert.ok(profiles[1]!.executable.includes("/@anthropic-ai/claude-agent-sdk-"))
  assert.equal(await realpath(profiles[1]!.executable), profiles[1]!.executable)
  const config = await readBackendConfig(root)
  assert.equal(config.defaultBackendId, "codex-acp")
  assert.deepEqual(config.backends.map(backend => backend.id), ["codex-acp", "claude-agent-acp"])
  assert.deepEqual(config.backends[1]!.initial, {})
})

test("Claude-only provider overrides select Claude without changing disabled or empty overrides", async t => {
  const { root, profile, profiles } = await fixture(t)
  await profiles([profile])
  const config = await readBackendConfig(root)
  assert.equal(config.defaultBackendId, "claude-agent-acp")
  assert.deepEqual(config.backends.map(backend => backend.id), ["claude-agent-acp"])
  await profiles([{ ...profile, enabled: false }])
  assert.deepEqual(await readProfiles(root), [{ ...profile, enabled: false }])
  await assert.rejects(readBackendConfig(root), { code: "UNAVAILABLE" })
  await profiles([])
  assert.deepEqual(await readProfiles(root), [])
  await assert.rejects(readBackendConfig(root), { code: "UNAVAILABLE" })
})

test("an explicit backend configuration preserves its model and permission defaults", async t => {
  const { root } = await fixture(t)
  const config = { version: 1, defaultBackendId: "claude-agent-acp", backends: [{ id: "claude-agent-acp", args: [], environmentDefaults: {}, initial: { configValues: { model: "sonnet", mode: "plan", effort: "high" } }, compatibilityId: "claude-agent-acp-0.102" }] }
  await writeFile(join(root, "catalog/backends.json"), JSON.stringify(config), { mode: 0o600 })
  assert.deepEqual(await readBackendConfig(root), config)
})

test("Claude qualification uses the executable binary and rejects dependency mismatches", async t => {
  const { root, profile, profiles } = await fixture(t)
  await profiles([profile])
  const evidence = await observeConfig(profile)
  const backend = (await readBackendConfig(root)).backends[0]!
  const declaration = productionLaunchContracts().find(contract => contract.id === backend.compatibilityId)!
  const contract = await configureLaunchContract(declaration, profile, evidence)
  assert.equal(contract.entrypoint, join(profile.adapterPackageJson, "../dist/index.js"))
  assert.equal(contract.sessionLoad, true)
  await assert.rejects(configureLaunchContract(declaration, profile, { ...evidence, adapterVersion: "0.102.1" }), { code: "ADAPTER_UNQUALIFIED" })
  await assert.rejects(configureLaunchContract(declaration, profile, { ...evidence, sdkVersion: "0.3.232" }), { code: "ADAPTER_UNQUALIFIED" })
})

test("Claude model choices use native model and effort configuration", async t => {
  const { root, profile, profiles } = await fixture(t)
  await profiles([profile])
  const backend = (await readBackendConfig(root)).backends[0]!
  const contract = productionLaunchContracts().find(contract => contract.id === backend.compatibilityId)!
  const provider: ProviderView = { providerId: profile.id, fingerprint: null, verifiedAt: 1, verifiedHandlerGeneration: null, providerVersion: null, providerVersionSource: "unknown", adapterVersion: "0.102.0", sdkVersion: "0.3.321", error: null, state: "ready", freshness: "fresh", models: [{ providerId: profile.id, modelId: "opus", resolvedModelId: null, displayName: "Opus", reasoning: { state: "values", values: ["low", "high"] }, modes: { state: "unknown" }, availability: "advertised" }] }
  const model = (backendSelection(backend, contract, provider).models as JsonObject[])[0]!
  assert.deepEqual(model.selection, { configValues: { model: "opus" } })
  assert.deepEqual(model.settings, [{ id: "effort", name: "Reasoning effort", kind: "config", values: [{ value: "low", name: "low" }, { value: "high", name: "high" }] }])
})

test("Claude executable metadata rejects escaping paths and preserves older main entries", async t => {
  const { root, profile } = await fixture(t)
  const adapterPackageJson = join(root, "adapter.json"), configured = { ...profile, adapterPackageJson }
  await writeFile(join(root, "entry.js"), "export {}", { mode: 0o600 })
  const metadata = { name: "@agentclientprotocol/claude-agent-acp", version: "0.102.0", main: "entry.js" }
  await writeFile(adapterPackageJson, JSON.stringify(metadata), { mode: 0o600 })
  assert.equal(await adapterEntry(configured), join(root, "entry.js"))
  await writeFile(adapterPackageJson, JSON.stringify({ ...metadata, bin: { "claude-agent-acp": "../entry.js" } }), { mode: 0o600 })
  await assert.rejects(adapterEntry(configured), { code: "INVALID_CATALOG" })
})

test("Claude discovery accepts the current SDK while rejecting an unrecognized version", async t => {
  const { root, profile } = await fixture(t)
  assert.ok((await sdkEntry(profile)).endsWith("/sdk.mjs"))
  const sdkPackageJson = join(root, "sdk.json"), configured = { ...profile, sdkPackageJson }
  await writeFile(join(root, "sdk.js"), "export {}", { mode: 0o600 })
  await writeFile(sdkPackageJson, JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.232", main: "sdk.js" }), { mode: 0o600 })
  assert.equal(await sdkEntry(configured), join(root, "sdk.js"))
  await writeFile(sdkPackageJson, JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.322", main: "sdk.js" }), { mode: 0o600 })
  await assert.rejects(sdkEntry(configured), { code: "UNSUPPORTED_PROVIDER_VERSION" })
})

test("Agency initializes the installed Claude adapter without starting a model session", async t => {
  const { root, profile } = await fixture(t)
  const child = spawn(process.execPath, [await adapterEntry(profile)], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const closed = once(child, "close")
  let stderr = ""
  child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-8192) })
  const connection = createAcpConnection({ readable: child.stdout, writable: child.stdin, limits: AGENT_LIMITS })
  t.after(async () => {
    connection.close(); child.stdin.end()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Claude adapter did not close: " + stderr)), 5000) })])
    } catch (error) { child.kill("SIGKILL"); await closed; throw error }
    finally { clearTimeout(timer) }
    assert.equal(child.exitCode, 0, stderr)
  })
  const response = await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agency-test", version: "1" } })
  assert.equal(response.protocolVersion, 1)
  assert.equal((response.agentCapabilities as JsonObject).loadSession, true)
})