import { fileURLToPath } from "node:url"
import { runWorker } from "../../src/catalog/worker.js"
import { jsonRpc } from "../../src/catalog/drivers/transport.js"

await runWorker(async context => {
  const child = context.spawnNative(context.request.profile.executable, [fileURLToPath(new URL("./catalog-native.js", import.meta.url)), ...(context.request.profile.configurationFiles.length === 1 ? ["--ignore-term"] : []), ...(context.request.profile.configurationFiles.length === 2 ? ["--verbose-stderr"] : []), ...(context.request.profile.configurationFiles.length === 3 ? ["--rpc-failure"] : []), ...(context.request.profile.configurationFiles.length === 4 ? ["--early-exit"] : []), ...(context.request.profile.configurationFiles.length === 5 ? ["--graceful-exit"] : [])])
  if (context.request.profile.configurationFiles.length === 3) {
    const rpc = jsonRpc(child, context.signal)
    try { await rpc.request("model/list", {}) } finally { rpc.close() }
  }
  const response = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve())
    child.stdout.once("error", reject)
  })
  child.stdin.write("catalog\n")
  await response
  if (context.request.profile.configurationFiles.length === 5) await new Promise(resolve => setTimeout(resolve, 100))
  return { models: [], providerVersion: "fixture-1", providerVersionSource: "reported" }
})