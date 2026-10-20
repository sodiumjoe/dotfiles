import { fixtureSpawner, fixtureRuntime, sealFixtureSource } from "./fixture-spawn.js"

const launch = await fixtureSpawner()
const mode = process.argv[2]
if (mode === "identity") {
  const child = launch("darwin-descendant", process.execPath, ["-e", "setInterval(() => undefined, 1000)", process.argv[3]!], { stdio: "ignore" })
  await sealFixtureSource()
  process.stdout.write(String(child.pid) + "\n")
} else if (mode === "exec") {
  const child = launch("darwin-exec-helper", "/bin/sh", ["-c", "read value; exec /bin/sleep 30"], { stdio: ["pipe", "ignore", "ignore"] })
  process.on("message", async value => {
    if (value !== "exec") return
    child.stdin!.end("exec\n")
    const { createDarwinAdapter } = await import("../../src/platform/darwin.js")
    const adapter = createDarwinAdapter(), until = Date.now() + 5000
    while (!(await adapter.readProcess(child.pid!))?.birth.endsWith(":unmarked:/bin/sleep")) {
      if (Date.now() >= until) throw new Error("Exec helper did not become sleep")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const { scope } = await fixtureRuntime()
    await scope.observe(scope.snapshot().launches.find(value => value.pid === child.pid)!.ref)
    await sealFixtureSource()
    process.send?.("executed")
  })
} else throw new Error("Unknown Darwin descendant fixture mode")
setInterval(() => undefined, 1000)