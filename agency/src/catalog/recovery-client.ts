import { randomUUID } from "node:crypto"
import { ControlError, PROTOCOL, UUID, controlError, exitCode } from "../control/protocol.js"
import type { ControlDependencies } from "../cli/control.js"
import { recoverCatalogProbe, type ProbeRecoveryRequest } from "./recovery.js"

export async function runProbeRecovery(argv: readonly string[], dependencies: Pick<ControlDependencies, "environment" | "stdout" | "stderr">): Promise<number> {
  const requestId = randomUUID(), flags = new Map<string, string>()
  try {
    for (let index = 2; index < argv.length; index++) {
      const flag = argv[index]!
      if (flags.has(flag)) throw new ControlError("USAGE", "duplicate recovery flag")
      if (flag === "--json") { flags.set(flag, "true"); continue }
      if (!["--attempt-id", "--handler-generation", "--sha256"].includes(flag)) throw new ControlError("USAGE", "unknown recovery flag")
      const value = argv[++index]
      if (value === undefined || !(flag === "--sha256" ? /^[0-9a-f]{64}$/ : UUID).test(value)) throw new ControlError("USAGE", "recovery requires canonical targeting values")
      flags.set(flag, value)
    }
    if (!["--attempt-id", "--handler-generation", "--sha256"].every(flag => flags.has(flag))) throw new ControlError("USAGE", "recovery requires --attempt-id UUID --handler-generation UUID --sha256 HEX")
    const request: ProbeRecoveryRequest = { attemptId: flags.get("--attempt-id")!, handlerGeneration: flags.get("--handler-generation")!, sha256: flags.get("--sha256")! }
    const result = await recoverCatalogProbe(await dependencies.environment(), request)
    dependencies.stdout(JSON.stringify({ protocol: PROTOCOL, requestId, handlerGeneration: request.handlerGeneration, ok: true, result }) + "\n")
    return 0
  } catch (error) {
    const value = controlError(error, "INCOMPLETE")
    dependencies.stdout(JSON.stringify({ protocol: PROTOCOL, requestId, handlerGeneration: flags.get("--handler-generation") ?? null, ok: false, error: { code: value.code, message: value.message.slice(0, 2048) } }) + "\n")
    dependencies.stderr(value.message.slice(0, 2048) + "\n")
    return exitCode(value.code)
  }
}