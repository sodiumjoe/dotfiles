import { fixtureSpawner, finishFixtureSource } from "./fixture-spawn.js"
import { fileURLToPath } from "node:url"
import { runWorker } from "../../src/catalog/worker.js"
import { jsonRpc } from "../../src/catalog/drivers/transport.js"

const launch = await fixtureSpawner()
await runWorker(async context => {
  const child = context.spawnNative(context.request.profile.executable, [fileURLToPath(new URL("./catalog-native.js", import.meta.url)), ...(context.request.profile.configurationFiles.length === 1 ? ["--ignore-term"] : []), ...(context.request.profile.configurationFiles.length === 2 ? ["--verbose-stderr"] : []), ...(context.request.profile.configurationFiles.length === 3 ? ["--rpc-failure"] : []), ...(context.request.profile.configurationFiles.length === 4 ? ["--early-exit"] : []), ...(context.request.profile.configurationFiles.length === 5 ? ["--graceful-exit"] : [])])
  if (context.request.profile.configurationFiles.length === 3) {
    const rpc = jsonRpc(child, context.signal)
    try { await rpc.request("model/list", {}) } finally { rpc.close() }
  }
  const response = new Promise<void>((resolve, reject) => {
    let settled = false
    const data = () => finish()
    const error = (cause: Error) => finish(cause)
    const abort = () => finish(new Error("fixture discovery cancelled"))
    function finish(cause?: Error) {
      if (settled) return
      settled = true
      child.stdout.off("data", data)
      child.stdout.off("error", error)
      context.signal.removeEventListener("abort", abort)
      if (cause) reject(cause)
      else resolve()
    }
    child.stdout.once("data", data)
    child.stdout.once("error", error)
    context.signal.addEventListener("abort", abort, { once: true })
    void child.terminal.then(() => finish(new Error("fixture native closed before output")))
    if (context.signal.aborted) abort()
  })
  child.stdin.write("catalog\n")
  await response
  if (context.request.profile.configurationFiles.length === 5) await child.terminal
  return { models: [], providerVersion: "fixture-1", providerVersionSource: "reported" }
}, { spawn: ((file, args, options) => launch("catalog-native", file, args ?? [], options ?? {})) as typeof import("node:child_process").spawn })
await finishFixtureSource()