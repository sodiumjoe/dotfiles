import { readFile } from "node:fs/promises"
import { runAcpEndpoint } from "../../src/acp/endpoint.js"
import { inspectHandlerGeneration } from "../../src/platform/singleton.js"
import { assertPrivateSocket } from "../../src/platform/private-socket.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
const config = JSON.parse(await readFile(process.argv[2]!, "utf8"))
const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
process.exitCode = await runAcpEndpoint([], { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, environment: config.environment, discover: async () => {
  const inspection = await inspectHandlerGeneration(config.paths.runtimeRoot, adapter)
  if (inspection?.disposition !== "live" || inspection.record.phase !== "ready") throw new Error("fixture Handler unavailable")
  return { socketPath: await assertPrivateSocket(config.paths.runtimeRoot, "acp.sock"), generation: inspection.record.generation }
} })