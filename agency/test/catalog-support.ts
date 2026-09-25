import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { privateRoot } from "./control-support.js"
import type { ProviderProfile } from "../src/catalog/types.js"

export async function profileFixture(t: TestContext) {
  const root = await privateRoot(t)
  const catalog = join(root, "catalog"), sdk = join(root, "sdk"), adapter = join(root, "adapter")
  for (const directory of [catalog, sdk, adapter]) await mkdir(directory, { mode: 0o700 })
  const executable = join(root, "native"), config = join(root, "declared-config.json")
  await writeFile(executable, "fixture executable", { mode: 0o700 })
  await writeFile(join(adapter, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.70.0" }), { mode: 0o600 })
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.232", main: "sdk.mjs" }), { mode: 0o600 })
  await writeFile(join(sdk, "sdk.mjs"), "throw new Error('SDK must not be imported during configuration discovery')", { mode: 0o600 })
  const profile: ProviderProfile = { id: "claude-agent-acp", enabled: true, executable, adapterPackageJson: join(adapter, "package.json"), sdkPackageJson: join(sdk, "package.json"), configurationFiles: [config] }
  const manifest = join(catalog, "providers.json")
  const save = async (providers: unknown = [profile]) => writeFile(manifest, JSON.stringify({ version: 1, providers }), { mode: 0o600 })
  return { root, catalog, sdk, adapter, executable, config, profile, manifest, save }
}