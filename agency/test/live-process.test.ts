import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { spawnOwnedChild } from "../src/runtime/owned-child.js"
import { captureLiveProcess, LiveProcessError } from "../src/platform/live-process.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const attempt = "11111111-1111-4111-8111-111111111111", marker = "agy-provider:" + attempt
function fixture(t: test.TestContext) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, unref() {} }) as unknown as ChildProcess
  t.after(() => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() })
  const owner = spawnOwnedChild({ launchAttemptId: attempt, spawn: () => child })
  const identity: ProcessIdentity = { bootId: "boot-a", pid: 12345, birth: "100:" + marker, parentPid: process.pid, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  let members = [identity], live = true
  const signals: NodeJS.Signals[] = []
  const exit = (close = true) => { live = false; members = []; Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); if (close) child.emit("close", 0, null) }
  const adapter: PlatformAdapter = {
    platform: "linux", bootId: async () => "boot-a",
    readProcess: async pid => live && pid === identity.pid ? structuredClone(identity) : null,
    readGroup: async () => structuredClone(members),
    signalGroup: async (pgid, signal) => { assert.equal(pgid, 12345); signals.push(signal); exit() },
  }
  const capture = () => captureLiveProcess({ owner, adapter, launchBootId: "boot-a", marker, deadline: Date.now() + 5000, now: () => Date.now() })
  const limits = () => ({ deadline: Date.now() + 1000, terminateMs: 200, absenceMs: 200, transportCloseMs: 100 })
  return { child, owner, identity, adapter, signals, exit, capture, limits, setMembers(value: ProcessIdentity[]) { members = value } }
}


test("a reused PID prevents cleanup from signaling another process", async t => {
  const f = fixture(t), group = await f.capture()
  f.identity.birth = "200:" + marker
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  assert.deepEqual(f.signals, [])
})