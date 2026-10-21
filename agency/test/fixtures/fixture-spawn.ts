import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { workerScope, workerReceiver } from "./run-boundary.js"
import { connectFixture, type FixtureClient, type FixtureConnection } from "./fixture-channel.js"
import { createNativeFixtureScope, nativeFixtureAccess, type FixtureScope, type LaunchRef, type Reporting } from "./run-scope.js"

export type FixtureRuntime = { scope: FixtureScope; client?: FixtureClient; sealed?: boolean }
let runtime: Promise<FixtureRuntime> | undefined
export function fixtureRuntime(): Promise<FixtureRuntime> {
  runtime ??= (async () => {
    const raw = process.env.AGENCY_FIXTURE_CONNECTION
    if (!raw) return { scope: await workerScope() }
    const config = JSON.parse(raw) as FixtureConnection
    delete process.env.AGENCY_FIXTURE_CONNECTION
    const scope = createNativeFixtureScope({ runId: config.runId, workerFile: config.ownerRef.launchId, deadlineMs: 120000 })
    return { scope, client: connectFixture(config, scope) }
  })()
  return runtime
}
export function cleanFixtureEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env }
  delete result.AGENCY_TEST_WORKER_RUN
  delete result.NODE_TEST_CONTEXT
  delete result.AGENCY_FIXTURE_CONNECTION
  return result
}
export function registerFixtureChild<C extends ChildProcess>(runtime: FixtureRuntime, ref: LaunchRef, work: () => C, execImage?: string): C {
  const { scope, client } = runtime
  if (execImage) nativeFixtureAccess(scope).declareExec(ref, execImage)
  let child: C
  try {
    child = scope.spawn(ref, work, { closeAdmission(child) { for (const pipe of child.stdio.slice(3)) pipe?.destroy() } })
  } catch (error) { runtime.sealed || client?.report(); throw error }
  for (const event of ["error", "exit", "close"] as const) child.on(event, () => runtime.sealed || client?.report())
  runtime.sealed || client?.report()
  if (!execImage) void scope.observe(ref).then(() => { runtime.sealed || client?.report() }, () => {})
  return child
}
export async function fixtureSpawner() {
  const runtime = await fixtureRuntime()
  const receiver = runtime.client ? undefined : await workerReceiver()
  return (role: string, file: string, args: readonly string[], options: SpawnOptions, input: { source?: boolean; reporting?: Reporting; ownGroup?: boolean } = {}): ChildProcess => {
    const ref = runtime.scope.intent(role, { ownGroup: input.ownGroup ?? options.detached ?? false, reporting: input.reporting ?? "direct" })
    const env = cleanFixtureEnvironment(options.env)
    if (input.source) env.AGENCY_FIXTURE_CONNECTION = JSON.stringify((runtime.client ?? receiver!).connection(ref))
    return registerFixtureChild(runtime, ref, () => spawn(file, [...args], { ...options, env }))
  }
}
export async function signalFixturePid(pid: number, signal: NodeJS.Signals = "SIGKILL", prepare = false, group = false): Promise<void> {
  const { scope } = await fixtureRuntime()
  const until = Date.now() + 15000
  let launch
  while (!(launch = scope.snapshot().launches.find(value => value.pid === pid))) {
    if (Date.now() >= until) throw new Error("No current-run fixture registration for " + pid)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (launch.exit || launch.absent === true) return
  if (prepare) await (await workerReceiver()).prepareExit(launch.ref)
  if (group) await scope.signal(launch.ref, signal)
  else await nativeFixtureAccess(scope).signalPid(launch.ref, signal)
}
export async function finishFixtureSource(): Promise<void> {
  await (await fixtureRuntime()).client?.finish()
}
export async function sealFixtureSource(): Promise<void> {
  const runtime = await fixtureRuntime()
  runtime.sealed = true
  await runtime.client?.checkpoint("before-intentional-exit")
}
export async function fixtureLeafSpawner(role: string): Promise<typeof spawn> {
  const runtime = await fixtureRuntime()
  return ((file, args, options) => {
    const settings = options ?? {}, ref = runtime.scope.intent(role, { ownGroup: settings.detached ?? false })
    return registerFixtureChild(runtime, ref, () => spawn(file, args ?? [], { ...settings, env: cleanFixtureEnvironment(settings.env) }))
  }) as typeof spawn
}
export async function prepareFixtureExit(pid: number): Promise<void> {
  const runtime = await fixtureRuntime()
  const launch = runtime.scope.snapshot().launches.find(value => value.pid === pid)
  if (!launch) throw new Error("No current-run fixture registration for " + pid)
  if (launch.exit || launch.absent === true) return
  await (runtime.client ?? await workerReceiver()).prepareExit(launch.ref)
}