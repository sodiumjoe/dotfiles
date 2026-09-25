import { fileURLToPath } from "node:url"
import { runWorker } from "../../src/catalog/worker.js"

await runWorker(async context => {
  const child = context.spawnNative(process.execPath, [fileURLToPath(new URL("./catalog-native.js", import.meta.url)), ...(context.request.profile.configurationFiles.length ? ["--ignore-term"] : [])])
  const response = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve())
    child.stdout.once("error", reject)
  })
  child.stdin.write("catalog\n")
  await response
  return { models: [], providerVersion: "fixture-1", providerVersionSource: "reported" }
})