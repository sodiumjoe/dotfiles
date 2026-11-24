import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"

const watch = new URL("../src/agent/parent-watch.js", import.meta.url).href
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function startUnderParent() {
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, ["--import", ${JSON.stringify(watch)}, "-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { ...process.env, AGENCY_PARENT_PID: String(process.pid) } })
    process.stdout.write(String(child.pid) + "\\n")
    setInterval(() => {}, 1000)
  `], { stdio: ["ignore", "pipe", "inherit"] })
  const pid = await new Promise<number>(resolve => parent.stdout!.once("data", chunk => resolve(Number(String(chunk).trim()))))
  return { parent, pid }
}

test("a provider started with the parent watch exits after its parent is killed", async t => {
  const { parent, pid } = await startUnderParent()
  t.after(() => { try { process.kill(-pid, "SIGKILL") } catch {} })
  assert.ok(alive(pid))
  parent.kill("SIGKILL")
  const deadline = Date.now() + 8000
  while (alive(pid) && Date.now() < deadline) await pause(100)
  assert.equal(alive(pid), false)
})

test("a provider that ignores SIGTERM and its children are all killed after the parent dies", async t => {
  const script = `process.on("SIGTERM", () => {}); require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000)`
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, ["--import", ${JSON.stringify(watch)}, "-e", ${JSON.stringify(script)}], { detached: true, stdio: "ignore", env: { ...process.env, AGENCY_PARENT_PID: String(process.pid) } })
    process.stdout.write(String(child.pid) + "\\n")
    setInterval(() => {}, 1000)
  `], { stdio: ["ignore", "pipe", "inherit"] })
  const pid = await new Promise<number>(resolve => parent.stdout!.once("data", chunk => resolve(Number(String(chunk).trim()))))
  t.after(() => { try { process.kill(-pid, "SIGKILL") } catch {} })
  const group = (): boolean => { try { process.kill(-pid, 0); return true } catch { return false } }
  await pause(1500)
  assert.ok(group())
  parent.kill("SIGKILL")
  const deadline = Date.now() + 10000
  while (group() && Date.now() < deadline) await pause(100)
  assert.equal(group(), false)
})