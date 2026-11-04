import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { readBackendConfig } from "../src/agent/backend-config.js"
import { configureLaunchContract } from "../src/agent/contracts.js"
import { staticProductionContracts } from "../src/agent/production-contracts.js"
import { observeConfig, readProfiles } from "../src/catalog/config.js"
import { productionEnvironment } from "../src/handler/environment.js"

try {
  const { paths } = await productionEnvironment()
  const config = await readBackendConfig(paths.persistentRoot)
  const backend = config.backends.find(value => value.id === config.defaultBackendId)!
  const profile = (await readProfiles(paths.persistentRoot)).find(value => value.enabled && value.id === backend.id)
  if (!profile) throw new Error(`no enabled provider for default backend ${backend.id}`)
  const contract = staticProductionContracts().find(value => value.providerId === profile.id && value.id === backend.compatibilityId)
  if (!contract) throw new Error(`unsupported backend compatibility ${backend.compatibilityId}`)
  await access(profile.executable, constants.X_OK)
  await configureLaunchContract(contract, profile, await observeConfig(profile))
  process.stdout.write(`Validated Agency default backend ${backend.id}.\n`)
} catch (error) {
  process.stderr.write(`setup-provider: ${error instanceof Error ? error.message : String(error)}; check the installed provider files and any catalog overrides.\n`)
  process.exitCode = 1
}