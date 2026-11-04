import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readBackendConfig } from "../src/agent/backend-config.js"
import { configureLaunchContract } from "../src/agent/contracts.js"
import { staticProductionContracts } from "../src/agent/production-contracts.js"
import { observeConfig, parseProfile, readBoundedFile, readProfiles } from "../src/catalog/config.js"
import type { ProviderProfile } from "../src/catalog/types.js"
import { productionEnvironment } from "../src/handler/environment.js"
import { assertPrivateDirectory } from "../src/platform/private-state.js"
import { withStartupLock } from "../src/platform/singleton.js"

async function validateProvider(profile: ProviderProfile, compatibilityId: string): Promise<void> {
  const contract = staticProductionContracts().find(value => value.providerId === profile.id && value.id === compatibilityId)
  if (!contract) throw new Error(`unsupported backend compatibility ${compatibilityId}`)
  await access(profile.executable, constants.X_OK)
  await configureLaunchContract(contract, profile, await observeConfig(profile))
}

try {
  const { paths, adapter } = await productionEnvironment()
  const catalog = join(paths.persistentRoot, "catalog")
  const profilePath = join(catalog, "providers.json")
  await withStartupLock({ root: paths.runtimeRoot, adapter }, async guard => {
    await assertPrivateDirectory(paths.persistentRoot)
    try { await mkdir(catalog, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    await assertPrivateDirectory(catalog)
    let created = false
    if (await readBoundedFile(profilePath, 65536, true) === null) {
      if (await readBoundedFile(join(catalog, "backends.json"), 65536, true) !== null) {
        throw new Error(`existing backends.json requires a provider profile at ${profilePath}`)
      }
      const repo = fileURLToPath(new URL("../../../", import.meta.url))
      const home = process.env.HOME ?? homedir()
      const profile = parseProfile({
        id: "codex-acp", enabled: true,
        executable: await realpath(join(repo, "home/bin/acp-codex")),
        adapterPackageJson: await realpath(join(repo, "node-bin/node_modules/@agentclientprotocol/codex-acp/package.json")),
        sdkPackageJson: null,
        configurationFiles: [await realpath(join(home, ".codex/config.toml"))],
      })
      await validateProvider(profile, "codex-acp-1.7")
      const temporary = join(catalog, `.providers.${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await handle.writeFile(JSON.stringify({ version: 1, providers: [profile] }))
          await handle.sync()
        } finally { await handle.close() }
        await assertPrivateDirectory(catalog)
        if (await readBoundedFile(profilePath, 65536, true) === null) {
          guard.assertHeld()
          await rename(temporary, profilePath)
          created = true
          const directory = await open(catalog, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { await directory.sync() } finally { await directory.close() }
        }
      } finally { await rm(temporary, { force: true }) }
    }
    const config = await readBackendConfig(paths.persistentRoot)
    const backend = config.backends.find(value => value.id === config.defaultBackendId)!
    const profile = (await readProfiles(paths.persistentRoot)).find(value => value.enabled && value.id === backend.id)
    if (!profile) throw new Error(`no enabled profile for default backend ${backend.id} in ${profilePath}`)
    await validateProvider(profile, backend.compatibilityId)
    guard.assertHeld()
    process.stdout.write(`${created ? "Created" : "Preserved"} Agency provider profile at ${profilePath} (default backend ${backend.id}).\n`)
  })
} catch (error) {
  process.stderr.write(`setup-provider: ${error instanceof Error ? error.message : String(error)}; check the installed provider files and catalog configuration.\n`)
  process.exitCode = 1
}