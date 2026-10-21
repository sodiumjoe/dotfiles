import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { captureOwnedProcess, signalOwnedProcess, type OwnedSignal } from "./fixture-signal.js"

try {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Unsupported fixture platform")
  const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  let input = ""
  for await (const bytes of process.stdin) { input += String(bytes); if (Buffer.byteLength(input) > 65536) throw new Error("Oversized fixture request") }
  const request = JSON.parse(input)
  let result: unknown
  if (request.action === "capture" && Object.keys(request).length === 4 && typeof request.ownGroup === "boolean") {
    result = await captureOwnedProcess(adapter, request.pid, request.parentPid, request.ownGroup)
  } else if (request.action === "signal" && Object.keys(request).length === 6 && request.identity && request.ownerIdentity
    && Array.isArray(request.knownMembers) && typeof request.group === "boolean") {
    result = await signalOwnedProcess(adapter, request as OwnedSignal, (pid, signal) => { process.kill(pid, signal) })
  } else throw new Error("Invalid fixture process request")
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}