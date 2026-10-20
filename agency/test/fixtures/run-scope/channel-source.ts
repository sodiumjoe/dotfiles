import { spawn } from "node:child_process"
import { access, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createNativeFixtureScope } from "../run-scope.js"
import { connectFixture, type FixtureConnection } from "../fixture-channel.js"

const config = JSON.parse(process.env.AGENCY_TEST_CONNECTION!) as FixtureConnection
const mode = process.argv[2]
if (mode === "wrong-token") config.ownerToken = "wrong"
const scope = createNativeFixtureScope({ runId: config.runId, workerFile: "channel-source", deadlineMs: 5000 })
const client = connectFixture(config, scope)
process.stdout.write("application-started\n")
if (mode === "wrong-token") {
  await client.finish().catch(() => {})
} else if (mode === "throw") {
  const ref = scope.intent("thrown-provider")
  try { scope.spawn(ref, () => { throw new Error("synchronous spawn failure") }, { closeAdmission() {} }) } catch {}
  client.report()
  await client.finish()
} else if (mode === "failed-spawn" || mode === "largest") {
  const closed: Promise<void>[] = []
  for (let index = 0; index < (mode === "largest" ? 32 : 1); index++) {
    const ref = scope.intent("failed-provider-" + index)
    const child = scope.spawn(ref, () => spawn("/missing/agency-fixture-" + index, [], { stdio: "ignore" }), { closeAdmission() {} })
    closed.push(new Promise<void>(resolve => child.once("close", () => resolve())))
    client.report()
  }
  await Promise.all(closed)
  await client.finish()
} else if (mode === "ipc") {
  process.on("message", value => {
    if (value === "disconnect") process.disconnect?.()
    else process.send?.(value === "ping" ? "pong" : "application-refused")
  })
  await new Promise<void>(resolve => process.once("disconnect", resolve))
  await client.finish()
} else if (mode === "launcher" || mode === "early-launcher" || mode === "sealed-launcher" || mode === "singleton") {
  const ref = scope.intent(mode === "singleton" ? "singleton-handler" : mode === "sealed-launcher" ? "darwin-handler" : "channel-handler", { reporting: "detached-handler", ownGroup: true })
  const connection = mode !== "singleton" ? client.connection(ref) : null
  const child = scope.spawn(ref, () => spawn(process.execPath, mode !== "singleton" ? [fileURLToPath(import.meta.url), mode === "early-launcher" ? "early-child" : mode === "sealed-launcher" ? "sealed" : "late"] : ["-e", "setTimeout(() => process.exit(0), 3000)"], {
    detached: true, stdio: "ignore", env: { ...process.env, AGENCY_TEST_CONNECTION: connection ? JSON.stringify(connection) : "" },
  }), { closeAdmission() {} })
  child.unref()
  await scope.observe(ref)
  if (mode === "early-launcher") {
    const until = Date.now() + 3000
    while (true) {
      try { await access(process.env.AGENCY_TEST_RELEASE! + ".entered"); break } catch {}
      if (Date.now() >= until) throw new Error("Child application entry deadline")
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    process.stdout.write("child-application-before-report\n")
  }
  client.report()
  await client.finish()
} else {
  if (mode === "early-child") await writeFile(process.env.AGENCY_TEST_RELEASE! + ".entered", "entered")
  if (mode === "late" || mode === "early-child") {
    const until = Date.now() + 4000
    while (true) {
      try { await access(process.env.AGENCY_TEST_RELEASE!); break } catch {}
      if (Date.now() >= until) throw new Error("Application release deadline")
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
  }
  const ref = scope.intent("channel-leaf")
  const child = scope.spawn(ref, () => spawn(process.execPath, ["-e", (mode === "normal" || mode === "late" || mode === "early-child") ? "process.exit(0)" : "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: (mode === "normal" || mode === "late" || mode === "early-child") ? "ignore" : ["pipe", "ignore", "ignore"] }), { closeAdmission() {} })
  client.report()
  if (mode === "normal" || mode === "late" || mode === "early-child") {
    await new Promise<void>(resolve => child.once("close", () => resolve()))
    await client.finish()
  } else {
    await scope.observe(ref)
    await client.checkpoint()
    child.unref()
    if (mode === "lost") process.exit(0)
    void scope.operation("pending application", () => new Promise<never>(() => {}))
    process.stdout.write("ready\n")
  }
}