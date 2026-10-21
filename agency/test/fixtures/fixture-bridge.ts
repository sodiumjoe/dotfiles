import { spawn } from "node:child_process"
import { fixtureRuntime, registerFixtureChild, cleanFixtureEnvironment } from "./fixture-spawn.js"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { BridgeProcess } from "../../src/bridge/ssh.js"
import type { FixtureScope, LaunchRef } from "./run-scope.js"

export function fixtureBridgeProcess(scope: FixtureScope, ref: LaunchRef, child: ChildProcess): BridgeProcess {
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Fixture bridge requires piped streams")
  let pending: Promise<void> | undefined
  const facade = Object.assign(new EventEmitter(), { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, kill() {
    pending ??= scope.signal(ref, "SIGTERM", { allowAbsent: true, allowTerminal: true })
    void pending.catch(() => {})
    return true
  } })
  for (const event of ["error", "exit", "close"] as const) child.on(event, (...args) => facade.emit(event, ...args))
  scope.finalizer("bridge stop", async () => { await pending })
  return facade
}
export async function fixtureBridgeSpawner() {
  const runtime = await fixtureRuntime()
  return (file: string, args: string[], options: import("node:child_process").SpawnOptions) => {
    const ref = runtime.scope.intent("runtime-bridge")
    const child = registerFixtureChild(runtime, ref, () => spawn(file, args, { ...options, env: cleanFixtureEnvironment(options.env) }))
    return fixtureBridgeProcess(runtime.scope, ref, child)
  }
}