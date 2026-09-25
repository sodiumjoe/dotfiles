import { fstatSync } from "node:fs"
import { Socket } from "node:net"
import { runControl, productionControlDependencies } from "./cli/control.js"
import { productionEnvironment } from "./handler/environment.js"
import { runHandler } from "./handler/daemon.js"

process.umask(0o077)
if (process.argv[2] === "internal-handler") {
  try {
    if (process.argv.length !== 3 || !process.env.AGENCY_HANDLER_RECORD || !process.env.AGENCY_HANDLER_GENERATION || !fstatSync(3).isSocket() || !fstatSync(4).isSocket()) throw new Error("Handler requires launcher descriptors and identity")
    const env = await productionEnvironment()
    await runHandler({ ...env, recordPath: process.env.AGENCY_HANDLER_RECORD, generation: process.env.AGENCY_HANDLER_GENERATION, status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }) })
  } catch (error) { process.stderr.write(String(error).slice(0, 2048) + "\n"); process.exitCode = 70 }
} else process.exitCode = await runControl(process.argv.slice(2), productionControlDependencies())