import { readFile } from "node:fs/promises"
import { runControl, productionControlDependencies } from "../../src/cli/control.js"
import { inspectHandlerGeneration } from "../../src/platform/singleton.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
const config = JSON.parse(await readFile(process.argv[2]!, "utf8"))
const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
const environment = { paths: config.paths, adapter }
process.exitCode = await runControl(process.argv.slice(3), {
  ...productionControlDependencies(),
  environment: async () => environment,
  start: async () => {
    const inspection = await inspectHandlerGeneration(config.paths.runtimeRoot, adapter)
    if (inspection?.disposition !== "live" || inspection.record.phase !== "ready") throw new Error("fixture Handler unavailable")
    return inspection
  },
})