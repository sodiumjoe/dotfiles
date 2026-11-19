process.umask(0o077)
if (process.argv[2] === "internal-runtime-bridge") {
  try { const { runRuntimeBridgeCli, productionRuntimeBridgeDependencies } = await import("./bridge/runtime-remote.js"); await runRuntimeBridgeCli(process.argv.slice(3), productionRuntimeBridgeDependencies()) }
  catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1 }
  finally { process.exit() }
} else if (process.argv[2] === "internal-runtime-entry") {
  const { runRuntimeEntryHelper } = await import("./entry/cli.js")
  const { productionEnvironment } = await import("./handler/environment.js")
  const { inspectHandlerGeneration } = await import("./platform/singleton.js")
  const { connectHandlerBridge } = await import("./bridge/handler-client.js")
  process.exitCode = await runRuntimeEntryHelper(process.argv.slice(3), { environment: productionEnvironment, inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter), connect: connectHandlerBridge, stderr: value => { process.stderr.write(value) } })
} else if (process.argv[2] === "internal-handler") {
  try {
    const { fstatSync } = await import("node:fs")
    const { Socket } = await import("node:net")
    if (process.argv.length !== 3 || !process.env.AGENCY_HANDLER_RECORD || !process.env.AGENCY_HANDLER_GENERATION || !fstatSync(3).isSocket() || !fstatSync(4).isSocket()) throw new Error("Handler requires launcher descriptors and identity")
    const { fileURLToPath } = await import("node:url")
    const { readDistDigest } = await import("./handler/build-digest.js")
    const distDigest = readDistDigest(fileURLToPath(new URL("../build-manifest.json", import.meta.url)))
    const { productionEnvironment } = await import("./handler/environment.js")
    const { runHandler } = await import("./handler/daemon.js")
    const { macNotify } = await import("./hosts/attention.js")
    const env = await productionEnvironment()
    await runHandler({ ...env, distDigest, ...(process.platform === "darwin" ? { attentionNotify: macNotify } : {}), recordPath: process.env.AGENCY_HANDLER_RECORD, generation: process.env.AGENCY_HANDLER_GENERATION, status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }) })
  } catch (error) { process.stderr.write(String(error).slice(0, 2048) + "\n"); process.exitCode = 70 }
} else if (process.argv[2] === "acp") {
  const { runAcpEndpoint } = await import("./acp/endpoint.js")
  const { snapshotLaunchEnvironment } = await import("./agent/environment.js")
  process.exitCode = await runAcpEndpoint(process.argv.slice(3), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, environment: snapshotLaunchEnvironment(process.env) })
} else {
  const { runControl, productionControlDependencies } = await import("./cli/control.js")
  process.exitCode = await runControl(process.argv.slice(2), productionControlDependencies())
}