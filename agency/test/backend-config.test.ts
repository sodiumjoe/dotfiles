import assert from "node:assert/strict"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import test from "node:test"
import { backendFingerprint, mergeBackendEnvironment, parseBackendConfig, readBackendConfig } from "../src/agent/backend-config.js"
import { projectRestorableSettings, nonRestorableOptionIds } from "../src/agent/session-config.js"
import { privateRoot } from "./control-support.js"
import { createCatalogStore } from "../src/catalog/store.js"

const config = () => ({ version: 1, defaultBackendId: "codex-acp", backends: [{ id: "codex-acp", args: ["--fixture"], environmentDefaults: { MODEL_PROVIDER: "litellm" }, initial: { modeId: "agent-full-access" }, compatibilityId: "fixture-v1" }] })
const snapshot = () => ({ configOptions: [
  { id: "model", type: "select", category: "model", currentValue: "model-a", options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] },
  { id: "reasoning", type: "select", currentValue: "high", options: [{ group: "effort", options: [{ value: "high" }, { value: "low" }] }] },
  { id: "enabled", type: "boolean", currentValue: true },
  { id: "credential", type: "text", currentValue: "secret-not-restorable" },
], models: null, modes: null, availableCommands: [], revision: 1 })

test("caller changes override defaults without ambient Handler substitution", () => {
  assert.deepEqual(mergeBackendEnvironment({ MODEL_PROVIDER: "custom", NVIM: "/new" }, { MODEL_PROVIDER: "litellm", INITIAL_AGENT_MODE: "agent-full-access" }), { MODEL_PROVIDER: "custom", NVIM: "/new", INITIAL_AGENT_MODE: "agent-full-access" })
  assert.deepEqual(mergeBackendEnvironment({}, {}), {})
  assert.throws(() => mergeBackendEnvironment({ BAD: "\0" }, {}))
})

test("backend parser rejects ambiguous defaults and undeclared configuration", () => {
  assert.deepEqual(parseBackendConfig(config()), config())
  for (const value of [
    { ...config(), version: 2 },
    { ...config(), defaultBackendId: "claude-agent-acp" },
    { ...config(), backends: [...config().backends, ...config().backends] },
    { ...config(), extra: true },
    { ...config(), backends: [{ ...config().backends[0], args: ["\0"] }] },
    { ...config(), backends: [{ ...config().backends[0], initial: { unknown: true } }] },
    { ...config(), backends: [{ ...config().backends[0], environmentDefaults: { NVIM: "/stale" } }] },
  ]) assert.throws(() => parseBackendConfig(value))
})

test("absent configuration uses Codex defaults only with an enabled Codex profile", async t => {
  const root = await privateRoot(t), catalog = join(root, "catalog")
  await mkdir(catalog, { mode: 0o700 })
  const profile = { id: "codex-acp", enabled: true, executable: "/fixture/native", adapterPackageJson: "/fixture/package.json", sdkPackageJson: null, configurationFiles: [] }
  const save = (providers: unknown[]) => writeFile(join(catalog, "providers.json"), JSON.stringify({ version: 1, providers }), { mode: 0o600 })
  await save([profile])
  const value = await readBackendConfig(root)
  assert.equal(value.defaultBackendId, "codex-acp")
  assert.deepEqual(value.backends[0]?.environmentDefaults, { CODEX_PATH: join(homedir(), "bin/acp-codex"), INITIAL_AGENT_MODE: "agent-full-access", MODEL_PROVIDER: "litellm" })
  assert.deepEqual(value.backends[0]?.initial, { modeId: "agent-full-access" })
  await save([{ ...profile, enabled: false }])
  await assert.rejects(readBackendConfig(root))
  await save([{ ...profile, id: "claude-agent-acp", sdkPackageJson: "/fixture/sdk.json" }])
  await assert.rejects(readBackendConfig(root))
})

test("private backend file remains configuration rather than an inventory issue", async t => {
  const root = await privateRoot(t), catalog = join(root, "catalog")
  await mkdir(catalog, { mode: 0o700 })
  await writeFile(join(catalog, "backends.json"), JSON.stringify(config()), { mode: 0o600 })
  assert.deepEqual(await readBackendConfig(root), config())
  assert.deepEqual((await createCatalogStore(root).inventory()).issues, [])
})

test("backend reader rejects unsafe files and invalid defaults", async t => {
  const root = await privateRoot(t), catalog = join(root, "catalog"), file = join(root, "input.json")
  await mkdir(catalog, { mode: 0o700 })
  await writeFile(file, JSON.stringify(config()), { mode: 0o600 })
  await symlink(file, join(catalog, "backends.json"))
  await assert.rejects(readBackendConfig(root))
})

test("backend admission fingerprint changes for args, defaults and compatibility manifests", () => {
  const backend = parseBackendConfig(config()).backends[0]!, before = backendFingerprint(backend, { protocolVersion: 1 })
  assert.equal(before, backendFingerprint(backend, { protocolVersion: 1 }))
  assert.notEqual(before, backendFingerprint({ ...backend, args: ["--different"] }, { protocolVersion: 1 }))
  assert.notEqual(before, backendFingerprint({ ...backend, environmentDefaults: { MODEL_PROVIDER: "other" } }, { protocolVersion: 1 }))
  assert.notEqual(before, backendFingerprint(backend, { protocolVersion: 2 }))
})

test("restore projection keeps only advertised public select and boolean values", () => {
  const value = snapshot()
  assert.deepEqual(projectRestorableSettings(value), { configValues: { model: "model-a", reasoning: "high", enabled: true } })
  assert.deepEqual(nonRestorableOptionIds(value), ["credential"])
  assert.equal(JSON.stringify(projectRestorableSettings(value)).includes("secret"), false)
  value.configOptions[0]!.currentValue = "unadvertised"
  assert.equal(projectRestorableSettings(value).configValues?.model, undefined)
  assert.deepEqual(nonRestorableOptionIds(value), ["credential", "model"])
})

test("legacy model and mode choices project only when advertised", () => {
  assert.deepEqual(projectRestorableSettings({ configOptions: [], models: { currentModelId: "model-a", availableModels: [{ modelId: "model-a", name: "A" }] }, modes: { currentModeId: "agent-full-access", availableModes: [{ id: "agent-full-access", name: "Full" }] }, availableCommands: [], revision: 1 }), { modelId: "model-a", modeId: "agent-full-access" })
})
