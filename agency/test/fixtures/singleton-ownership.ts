import { type ChildProcess, spawn } from "node:child_process"
import { cp, lstat, readlink, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { startOrConnect, type StartOrConnectOptions } from "../../src/platform/singleton.js"
import { type StartupDependencies, type StartupSpawn } from "../../src/platform/startup.js"
import { fixtureRuntime, fixtureSpawner, registerFixtureChild, signalFixturePid } from "./fixture-spawn.js"

export async function singletonDependencies(): Promise<StartupDependencies> {
  const launch = await fixtureSpawner()
  const runtime = await fixtureRuntime(), { client } = runtime
  const spawnDependency: StartupSpawn = (file, args, options) => {
    if (file === "/usr/bin/lockf" || file === "/usr/bin/flock") {
      const ref = runtime.scope.intent("startup-lock", { ownGroup: false, reporting: "direct" })
      return registerFixtureChild(runtime, ref, () => spawn(file, [...args], options), undefined, { observeAfterExec: true })
    }
    return launch("singleton-handler", file, args, options, { reporting: client ? "detached-handler" : "direct" })
  }
  return { spawn: spawnDependency }
}
export async function ownedStartOrConnect(options: StartOrConnectOptions, dependencies?: StartupDependencies) {
  const { scope } = await fixtureRuntime()
  const startup = dependencies ?? await singletonDependencies()
  return scope.operation("singleton start", () => startOrConnect(options, startup))
}
export async function spawnSingletonContender(fixturePath: string, configPath: string): Promise<ChildProcess> {
  const launch = await fixtureSpawner()
  return launch("singleton-contender", process.execPath, [fixturePath, "contender", configPath], { stdio: ["ignore", "ignore", "pipe"] }, { source: true })
}
export async function killSingletonPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  const { scope } = await fixtureRuntime()
  const launch = scope.snapshot().launches.find(value => value.pid === pid)
  await signalFixturePid(pid, signal, launch?.role === "singleton-contender")
}

export async function settleSingletonStarts<T>(starts: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(starts)
  const results: T[] = [], failures: unknown[] = []
  for (const value of settled) {
    if (value.status === "fulfilled") results.push(value.value)
    else failures.push(value.reason)
  }
  if (failures.length) throw new AggregateError(failures, "singleton startup contenders failed", { cause: failures[0] })
  return results
}

export async function preserveSingletonFixture(source: string, destination: string): Promise<void> {
  const links: Array<{ path: string; target: string }> = []
  await cp(source, destination, { recursive: true, filter: async path => {
    const observed = await lstat(path)
    if (observed.isSymbolicLink()) {
      links.push({ path: relative(source, path), target: await readlink(path) })
      return false
    }
    return !observed.isSocket()
  } })
  await writeFile(join(destination, "singleton-symlinks.json"), JSON.stringify(links.sort((a, b) => a.path.localeCompare(b.path))), { mode: 0o600, flag: "wx" })
}