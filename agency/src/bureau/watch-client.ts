import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { assertPrivateSocket } from "../platform/private-socket.js"
import type { ControlDependencies } from "../cli/control.js"
import { BUREAU_PROTOCOL, exchangeBureau, parseBureauRequest } from "./protocol.js"
import { createSnapshotWatch, writeWatchFrame } from "./watch.js"

export async function runBureauWatch(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const flags = argv.slice(2)
  const valid = flags.length === 0 || flags.length === 1 && flags[0] === "--json" || flags.length === 2 && flags[0] === "--format" && flags[1] === "ndjson"
  if (!deps.watch || !["permission", "roster"].includes(argv[0] ?? "") || argv[1] !== "watch" || !valid) return 64
  const output = deps.watch.stdout, controller = new AbortController(), removers: Array<() => void> = []
  const cancel = () => controller.abort()
  output.once("close", cancel); output.once("error", cancel)
  for (const signal of ["SIGINT", "SIGTERM"] as const) removers.push(deps.watch.onSignal(signal, cancel))
  try {
    await createSnapshotWatch({ signal: controller.signal,
      async read() {
        const env = await deps.environment(), handler = await deps.inspect(env)
        if (!handler || handler.disposition !== "live" || handler.record.phase !== "ready") throw new Error("BUREAU_UNAVAILABLE")
        const request = parseBureauRequest({ protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.record.generation, op: argv[0] === "permission" ? "permission_snapshot" : "roster_snapshot" })
        const socket = deps.callBureau ? null : createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "bureau.sock"))
        const abort = () => socket?.destroy()
        controller.signal.addEventListener("abort", abort, { once: true })
        try {
          if (controller.signal.aborted) throw new Error("CANCELLED")
          const response = deps.callBureau ? await deps.callBureau(env, request, 5000) : await exchangeBureau(socket!, request, 5000)
          if (!response.ok) throw new Error(response.error.code)
          return response.result
        } finally { controller.signal.removeEventListener("abort", abort); socket?.destroy() }
      },
      write: frame => writeWatchFrame(output, frame, controller.signal),
      pause: () => new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve() }
        const timer = setTimeout(done, 500)
        controller.signal.addEventListener("abort", done, { once: true })
        if (controller.signal.aborted) done()
      })
    }).run()
    return 0
  } catch { return controller.signal.aborted ? 0 : 69 }
  finally { cancel(); removers.forEach(remove => remove()); output.off("close", cancel); output.off("error", cancel) }
}