import { randomUUID } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { runHandler } from "../../src/handler/daemon.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { resolveCheckout } from "../../src/checkout/identity.js"
import type { ControlFixtureConfig } from "../control-support.js"

process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as ControlFixtureConfig
const root = dirname(config.paths.runtimeRoot)
const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
try {
  await runHandler({ paths: config.paths, adapter, recordPath: process.env.AGENCY_HANDLER_RECORD!, generation: process.env.AGENCY_HANDLER_GENERATION!, status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), onPhase: async phase => {
    if (config.delayMs !== undefined && phase === "reconciling") await new Promise(resolve => setTimeout(resolve, config.delayMs))
    if (config.pauseAt === phase) {
      await writeFile(join(root, "paused"), phase, { mode: 0o600 })
      const deadline = Date.now() + 10000
      while (true) {
        try { await readFile(join(root, "release")); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        if (Date.now() >= deadline) throw new Error("fixture pause timed out")
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    if (config.mutateAt === phase) {
      const directory = join(config.paths.persistentRoot, "launches")
      const names = await readdir(directory)
      const path = join(directory, names.find(name => name.endsWith(".json"))!)
      const record = JSON.parse(await readFile(path, "utf8"))
      if (config.mutate === "add") { record.launchAttemptId = randomUUID(); await writeFile(join(directory, record.launchAttemptId + ".json"), JSON.stringify(record), { mode: 0o600 }) }
      else { record.checkoutId = "replaced"; await writeFile(path, JSON.stringify(record), { mode: 0o600 }) }
    }
  }, onAdmissionReady: async controller => {
    if (config.admissionOperations === undefined) return
    if (config.admissionOperations.length < 1 || config.admissionOperations.length > 3) throw new Error("invalid fixture operation count")
    const results: unknown[] = []
    for (const operation of config.admissionOperations) {
      try {
        const checkout = await resolveCheckout(operation.checkoutPath, config.paths.hostKey)
        const request = { checkout, agentId: operation.agentId, leaseId: operation.leaseId, launchAttemptId: operation.launchAttemptId, handlerGeneration: process.env.AGENCY_HANDLER_GENERATION! }
        const reservation = await controller.reserve(request)
        const launch = operation.action === "reserve_cancel" ? await controller.cancel(request) : reservation.launch
        results.push({ ok: true, admission: reservation.admission, launch })
      } catch (error) {
        results.push({ ok: false, code: error instanceof Error && "code" in error ? error.code : "FIXTURE_ERROR", message: String(error).slice(0, 512) })
      }
    }
    await writeFile(join(root, "admission-result.json"), JSON.stringify(results), { mode: 0o600 })
  } })
} catch (error) {
  await writeFile(join(root, "failure"), String(error), { mode: 0o600 })
  process.exitCode = 1
}