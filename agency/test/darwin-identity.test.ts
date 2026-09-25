import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Readable } from "node:stream"
import test, { type TestContext } from "node:test"
import { pathToFileURL } from "node:url"
import {
  createDarwinAdapter,
  DarwinObservationUnavailable,
  type DarwinCommandExecutor,
} from "../src/platform/darwin.js"
import { agencyLaunchMarker, parseAgencyLaunchMarker } from "../src/platform/launch-marker.js"
import { launchHandlerGeneration } from "../src/platform/startup.js"
import { sameProcess, type PlatformAdapter, type ProcessIdentity } from "../src/platform/types.js"

const node = "/Users/moon/.nodenv/versions/24.13.0/bin/node"
const canonicalId = "123e4567-e89b-12d3-a456-426614174000"
const bootOutput = "DF993A61-4C0C-4823-A031-FC41A4A84081\n"
const expectedBootId = bootOutput.trim().toLowerCase()
const processScript = "setInterval(() => undefined, 1000)"
const darwinTest = process.platform === "darwin" ? test : test.skip

test("Darwin process groups reject unsafe signal targets", async t => {
  const calls: unknown[] = []
  t.mock.method(process, "kill", (...args: unknown[]) => { calls.push(args); return true })
  const adapter = createDarwinAdapter()
  for (const value of [0, 1, -1, -42, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(adapter.signalGroup(value, "SIGTERM"), /group|integer/i)
  assert.deepEqual(calls, [])
  await adapter.signalGroup(42, "SIGTERM")
  assert.deepEqual(calls, [[-42, "SIGTERM"]])
})

type CommandOptions = Parameters<DarwinCommandExecutor>[2]

function psRow(values: {
  pid: number
  ppid?: number
  pgid?: number
  uid?: number
  gid?: number
  weekday?: string
  month?: string
  day?: number
  time?: string
  year?: number
  command?: string
}): string {
  return `${values.pid} ${values.ppid ?? 1} ${values.pgid ?? values.pid} ${values.uid ?? process.getuid!()} ${values.gid ?? process.getgid!()} ${values.weekday ?? "Wed"} ${values.month ?? "Sep"} ${values.day ?? 23} ${values.time ?? "12:34:56"} ${values.year ?? 2026} ${values.command ?? "/usr/bin/true"}`
}

function scriptedExecutor(psOutputs: readonly (string | Error)[], boot = bootOutput): { execute: DarwinCommandExecutor; calls: Array<{ file: string; args: readonly string[]; options: CommandOptions }> } {
  const queue = [...psOutputs]
  const calls: Array<{ file: string; args: readonly string[]; options: CommandOptions }> = []
  const execute: DarwinCommandExecutor = async (file, args, options) => {
    calls.push({ file, args, options })
    if (file === "/usr/sbin/sysctl") return { stdout: boot }
    const value = queue.shift()
    if (value === undefined) throw new Error("unexpected ps invocation")
    if (value instanceof Error) throw value
    return { stdout: value }
  }
  return { execute, calls }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function readLine(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const data = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      cleanup()
      resolve(buffer.slice(0, newline))
    }
    const failed = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const ended = (): void => {
      cleanup()
      reject(new Error("child output ended before a line"))
    }
    const cleanup = (): void => {
      stream.off("data", data)
      stream.off("error", failed)
      stream.off("end", ended)
    }
    stream.on("data", data)
    stream.once("error", failed)
    stream.once("end", ended)
  })
}

async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error
  }
  await waitFor(() => {
    try {
      process.kill(child.pid!, 0)
      return false
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true
      throw error
    }
  }, `fixture group ${child.pid} survived`)
}

function spawnMarked(t: TestContext, marker: string, args: readonly string[] = ["-e", processScript]): ChildProcess {
  const child = spawn(node, [...args], { argv0: marker, detached: true, stdio: ["ignore", "pipe", "ignore"] })
  t.after(async () => stopGroup(child))
  return child
}

darwinTest("constructs and parses exact Agency launch markers", () => {
  assert.equal(agencyLaunchMarker("handler", canonicalId), `agy-handler:${canonicalId}`)
  assert.equal(agencyLaunchMarker("provider", canonicalId), `agy-provider:${canonicalId}`)
  assert.deepEqual(parseAgencyLaunchMarker(`agy-handler:${canonicalId}`), { role: "handler", launchAttemptId: canonicalId })
  assert.deepEqual(parseAgencyLaunchMarker(`agy-provider:${canonicalId}`), { role: "provider", launchAttemptId: canonicalId })
  for (const value of ["", "agy-handler:", `agy-handler:${canonicalId.slice(0, -1)}`, `agy-handler:${canonicalId}x`, `agy-handler:${canonicalId} trailing`, `agy-worker:${canonicalId}`, `agy-handler:${canonicalId.toUpperCase()}`]) assert.equal(parseAgencyLaunchMarker(value), null)
  for (const role of ["worker", "", "HANDLER"]) assert.throws(() => agencyLaunchMarker(role as "handler", canonicalId), /role|marker/i)
  for (const id of [canonicalId.toUpperCase(), canonicalId.slice(0, -1), `${canonicalId}0`, ` ${canonicalId}`, `${canonicalId}\n`]) assert.throws(() => agencyLaunchMarker("handler", id), /uuid|launch|marker/i)
})

darwinTest("qualifies fixed root-owned system tools", async () => {
  for (const path of ["/bin/ps", "/usr/sbin/sysctl"]) {
    const stats = await lstat(path)
    assert.equal(stats.isSymbolicLink(), false)
    assert.equal(stats.isFile(), true)
    assert.equal(stats.uid, 0)
    assert.equal(stats.mode & 0o022, 0)
    assert.equal(await realpath(path), path)
  }
})

darwinTest("reads a stable lowercase boot session UUID through the qualified sysctl", async () => {
  const adapter = createDarwinAdapter()
  const first = await adapter.bootId()
  const second = await adapter.bootId()
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(second, first)
})

darwinTest("uses only fixed commands with a bounded C-locale UTC execution contract", async () => {
  const snapshot = `${psRow({ pid: 41 })}\n`
  const scripted = scriptedExecutor([snapshot, snapshot])
  const observed = await createDarwinAdapter(scripted.execute).readProcess(41)
  assert.notEqual(observed, null)
  assert.deepEqual(scripted.calls.map(call => [call.file, call.args]), [
    ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]],
    ["/bin/ps", ["-ww", "-axo", "pid=,ppid=,pgid=,uid=,gid=,lstart=,command="]],
    ["/bin/ps", ["-ww", "-axo", "pid=,ppid=,pgid=,uid=,gid=,lstart=,command="]],
  ])
  for (const call of scripted.calls) assert.deepEqual(call.options, { encoding: "utf8", env: { LANG: "C", TZ: "UTC" }, maxBuffer: 1024 * 1024, shell: false, timeout: 2000 })
})

darwinTest("observes exact marker-bound leader identity and distinguishes marker changes", async t => {
  const marker = agencyLaunchMarker("handler", crypto.randomUUID())
  const child = spawnMarked(t, marker)
  assert.notEqual(child.pid, undefined)
  const adapter = createDarwinAdapter()
  await waitFor(async () => await adapter.readProcess(child.pid!) !== null, "marked child was not observed")
  const first = await adapter.readProcess(child.pid!)
  const second = await adapter.readProcess(child.pid!)
  assert.notEqual(first, null)
  assert.deepEqual(second, first)
  assert.equal(first!.pid, child.pid)
  assert.equal(first!.processGroupId, child.pid)
  assert.equal(first!.sessionId, child.pid)
  assert.equal(first!.parentPid, process.pid)
  assert.equal(first!.uid, process.getuid!())
  assert.equal(first!.gid, process.getgid!())
  assert.match(first!.birth, new RegExp(`^[0-9]+:${marker}$`))
  const otherMarker = agencyLaunchMarker("handler", crypto.randomUUID())
  assert.equal(sameProcess({ ...first!, birth: first!.birth.replace(marker, otherMarker) }, first!), false)
})

darwinTest("same-executable leaders retain distinct marker-bound births", async t => {
  const firstMarker = agencyLaunchMarker("provider", crypto.randomUUID())
  const secondMarker = agencyLaunchMarker("provider", crypto.randomUUID())
  const firstChild = spawnMarked(t, firstMarker)
  const secondChild = spawnMarked(t, secondMarker)
  const adapter = createDarwinAdapter()
  const [first, second] = await Promise.all([adapter.readProcess(firstChild.pid!), adapter.readProcess(secondChild.pid!)])
  assert.notEqual(first, null)
  assert.notEqual(second, null)
  assert.notEqual(first!.birth, second!.birth)
  assert.match(first!.birth, new RegExp(`${firstMarker}$`))
  assert.match(second!.birth, new RegExp(`${secondMarker}$`))
})

darwinTest("equal start-second observations remain distinct only through their markers", async () => {
  const firstMarker = agencyLaunchMarker("provider", "123e4567-e89b-12d3-a456-426614174001")
  const secondMarker = agencyLaunchMarker("provider", "123e4567-e89b-12d3-a456-426614174002")
  const snapshot = `${psRow({ pid: 41, command: firstMarker })}\n${psRow({ pid: 42, command: secondMarker })}\n`
  const scripted = scriptedExecutor([snapshot, snapshot, snapshot, snapshot])
  const adapter = createDarwinAdapter(scripted.execute)
  const first = await adapter.readProcess(41)
  const second = await adapter.readProcess(42)
  assert.notEqual(first, null)
  assert.notEqual(second, null)
  const firstSeparator = first!.birth.indexOf(":")
  const secondSeparator = second!.birth.indexOf(":")
  assert.equal(first!.birth.slice(0, firstSeparator), second!.birth.slice(0, secondSeparator))
  assert.equal(first!.birth.slice(firstSeparator + 1), firstMarker)
  assert.equal(second!.birth.slice(secondSeparator + 1), secondMarker)
  assert.notEqual(first!.birth, second!.birth)
})

darwinTest("present missing and malformed markers remain mismatching identities", async t => {
  const children = [spawnMarked(t, node), spawnMarked(t, "agy-handler:not-a-uuid")]
  const adapter = createDarwinAdapter()
  for (const child of children) {
    const observed = await adapter.readProcess(child.pid!)
    assert.notEqual(observed, null)
    assert.match(observed!.birth, /^[0-9]+:unmarked:/)
    assert.equal(parseAgencyLaunchMarker(observed!.birth.slice(observed!.birth.indexOf(":") + 1)), null)
  }
})

darwinTest("returns null only after two complete snapshots confirm PID absence", async () => {
  const empty = `${psRow({ pid: 99 })}\n`
  const absent = scriptedExecutor([empty, empty])
  assert.equal(await createDarwinAdapter(absent.execute).readProcess(41), null)
  const changed = scriptedExecutor([empty, `${empty}${psRow({ pid: 41 })}\n`])
  await assert.rejects(createDarwinAdapter(changed.execute).readProcess(41), DarwinObservationUnavailable)
})

darwinTest("returns null after a real marked child terminates", async t => {
  const child = spawnMarked(t, agencyLaunchMarker("handler", crypto.randomUUID()))
  const adapter = createDarwinAdapter()
  assert.notEqual(await adapter.readProcess(child.pid!), null)
  await stopGroup(child)
  assert.equal(await adapter.readProcess(child.pid!), null)
})

darwinTest("enumerates stable complete groups independently of leader presence", async t => {
  const marker = agencyLaunchMarker("provider", crypto.randomUUID())
  const leaderCode = `const {spawn}=require("node:child_process");const child=spawn(${JSON.stringify(node)},["-e",${JSON.stringify(processScript)},${JSON.stringify(marker)}],{stdio:"ignore"});process.stdout.write(String(child.pid)+"\\n");setInterval(()=>undefined,1000)`
  const leader = spawnMarked(t, marker, ["-e", leaderCode])
  const descendantPid = Number(await readLine(leader.stdout!))
  const adapter = createDarwinAdapter()
  const members = await adapter.readGroup(leader.pid!)
  assert.ok(members.some(member => member.pid === leader.pid && member.birth.endsWith(`:${marker}`)))
  const descendant = members.find(member => member.pid === descendantPid)
  assert.notEqual(descendant, undefined)
  assert.match(descendant!.birth, /^[0-9]+:unmarked:/)
  assert.ok(members.every(member => member.processGroupId === leader.pid && member.sessionId === leader.pid))
  process.kill(leader.pid!, "SIGKILL")
  await waitFor(async () => (await adapter.readProcess(leader.pid!)) === null, "leader survived")
  const leaderless = await adapter.readGroup(leader.pid!)
  assert.ok(leaderless.some(member => member.pid === descendantPid))
  process.kill(descendantPid, "SIGKILL")
  await waitFor(async () => (await adapter.readGroup(leader.pid!)).length === 0, "leaderless group survived")
})

darwinTest("retries complete group pairs and never returns their intersection", async () => {
  const first = psRow({ pid: 41, pgid: 41, command: `agy-provider:${canonicalId}` })
  const second = psRow({ pid: 42, ppid: 41, pgid: 41 })
  const both = `${first}\n${second}\n`
  const leaderOnly = `${first}\n`
  const scripted = scriptedExecutor([both, leaderOnly, both, both])
  const members = await createDarwinAdapter(scripted.execute).readGroup(41)
  assert.deepEqual(members.map(member => member.pid), [41, 42])
})

darwinTest("accepts valid zero snapshot fields but rejects nonpositive signal targets", async () => {
  const snapshot = `${psRow({ pid: 41, ppid: 0, command: `agy-handler:${canonicalId}` })}\n${psRow({ pid: 42, ppid: 0, pgid: 0, uid: 0, gid: 0 })}\n${psRow({ pid: 43, uid: -2, gid: -2 })}\n`
  const scripted = scriptedExecutor([snapshot, snapshot])
  const observed = await createDarwinAdapter(scripted.execute).readProcess(41)
  assert.equal(observed?.parentPid, 0)
  const unused = scriptedExecutor([])
  const adapter = createDarwinAdapter(unused.execute)
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await adapter.readProcess(value), null)
    assert.deepEqual(await adapter.readGroup(value), [])
    await assert.rejects(adapter.signalGroup(value, "SIGTERM"), /positive|group/i)
  }
  assert.equal(unused.calls.length, 0)
})

darwinTest("rejects malformed, oversized, localized, non-UTC, duplicate, and unstable observations", async () => {
  const good = `${psRow({ pid: 41 })}\n`
  const malformed = [
    "",
    "not ps output\n",
    `${psRow({ pid: 41, month: "Sept" })}\n`,
    `${psRow({ pid: 41, weekday: "Thu" })}\n`,
    `${psRow({ pid: 41, time: "25:00:00" })}\n`,
    `${good}${good}`,
    "x".repeat(1024 * 1024 + 1),
  ]
  for (const output of malformed) {
    const scripted = scriptedExecutor([output, output])
    await assert.rejects(createDarwinAdapter(scripted.execute).readProcess(41), DarwinObservationUnavailable)
  }
  const rows = Array.from({ length: 65_537 }, (_, index) => psRow({ pid: index + 1 })).join("\n")
  const oversizedRows = scriptedExecutor([rows, rows])
  await assert.rejects(createDarwinAdapter(oversizedRows.execute).readProcess(41), DarwinObservationUnavailable)
  const failed = scriptedExecutor([new Error("ps unavailable")])
  await assert.rejects(createDarwinAdapter(failed.execute).readProcess(41), DarwinObservationUnavailable)
  const unstable = scriptedExecutor([good, `${psRow({ pid: 41, ppid: 2 })}\n`])
  await assert.rejects(createDarwinAdapter(unstable.execute).readProcess(41), DarwinObservationUnavailable)
  const malformedBoot = scriptedExecutor([], "not-a-uuid\n")
  await assert.rejects(createDarwinAdapter(malformedBoot.execute).bootId(), DarwinObservationUnavailable)
})

darwinTest("fails a group observation when no complete stable pair exists", async () => {
  const leader = psRow({ pid: 41, command: `agy-provider:${canonicalId}` })
  const member = psRow({ pid: 42, ppid: 41, pgid: 41 })
  const first = `${leader}\n`
  const second = `${leader}\n${member}\n`
  const scripted = scriptedExecutor([first, second, first, second, first, second])
  await assert.rejects(createDarwinAdapter(scripted.execute).readGroup(41), DarwinObservationUnavailable)
})

darwinTest("rejects Darwin Handler publication without the expected launch marker", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agency-darwin-unmarked-startup-"))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const stateUrl = pathToFileURL(join(process.cwd(), "dist/src/platform/private-state.js")).href
  const malformedBirth = "1780000000:unmarked:agy-handler:not-a-uuid"
  let handlerPid: number | undefined
  const adapter = {
    platform: "darwin",
    bootId: async () => "darwin-boot",
    readProcess: async pid => {
      handlerPid = pid
      return {
        bootId: "darwin-boot",
        pid,
        birth: malformedBirth,
        parentPid: process.pid,
        processGroupId: pid,
        sessionId: pid,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }
    },
    readGroup: async () => [],
    signalGroup: async () => undefined,
  } satisfies PlatformAdapter
  t.after(async () => {
    if (handlerPid === undefined) return
    try {
      process.kill(handlerPid, "SIGKILL")
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error
    }
    await waitFor(() => {
      try {
        process.kill(handlerPid!, 0)
        return false
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true
        throw error
      }
    }, `unmarked Handler fixture group ${handlerPid} survived`)
  })
  const script = `import{Socket}from"node:net";const status=new Socket({fd:3,readable:true,writable:true});const gate=new Socket({fd:4,readable:true,writable:true});const identity={bootId:"darwin-boot",pid:process.pid,birth:${JSON.stringify(malformedBirth)},parentPid:process.ppid,processGroupId:process.pid,sessionId:process.pid,uid:process.getuid(),gid:process.getgid()};status.write(JSON.stringify({type:"identity",identity})+"\\n");await new Promise((resolve,reject)=>{gate.once("data",resolve);gate.once("error",reject)});gate.destroy();const{readHandlerRecord,writeHandlerRecord}=await import(${JSON.stringify(stateUrl)});const record=await readHandlerRecord(process.env.AGENCY_HANDLER_RECORD);await writeHandlerRecord(process.env.AGENCY_HANDLER_RECORD,{...record,phase:"ready",writer:"handler",reconciliation:{classified:0,total:0,quarantined:0},reason:null});status.write(JSON.stringify({type:"gate_released",generation:process.env.AGENCY_HANDLER_GENERATION})+"\\n"+JSON.stringify({type:"ready",generation:process.env.AGENCY_HANDLER_GENERATION})+"\\n");status.end();setInterval(()=>undefined,1000)`
  await assert.rejects(launchHandlerGeneration({
    root,
    hostId: "darwin-host",
    adapter,
    handler: { file: node, args: ["--input-type=module", "-e", script] },
    timeoutMs: 5000,
  }), /launch marker/i)
})

darwinTest("binds Handler launchAttemptId into argv0 without changing the command vector", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agency-darwin-startup-"))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const darwinUrl = pathToFileURL(join(process.cwd(), "dist/src/platform/darwin.js")).href
  const stateUrl = pathToFileURL(join(process.cwd(), "dist/src/platform/private-state.js")).href
  const script = `import{Socket}from"node:net";const status=new Socket({fd:3,readable:true,writable:true});const gate=new Socket({fd:4,readable:true,writable:true});const{createDarwinAdapter}=await import(${JSON.stringify(darwinUrl)});const{readHandlerRecord,writeHandlerRecord}=await import(${JSON.stringify(stateUrl)});const identity=await createDarwinAdapter().readProcess(process.pid);status.write(JSON.stringify({type:"identity",identity})+"\\n");await new Promise((resolve,reject)=>{gate.once("data",resolve);gate.once("error",reject)});gate.destroy();const record=await readHandlerRecord(process.env.AGENCY_HANDLER_RECORD);await writeHandlerRecord(process.env.AGENCY_HANDLER_RECORD,{...record,phase:"ready",writer:"handler",reconciliation:{classified:0,total:0,quarantined:0},reason:null});status.write(JSON.stringify({type:"gate_released",generation:process.env.AGENCY_HANDLER_GENERATION})+"\\n"+JSON.stringify({type:"ready",generation:process.env.AGENCY_HANDLER_GENERATION})+"\\n");status.end();setInterval(()=>undefined,1000)`
  const adapter = createDarwinAdapter()
  const result = await launchHandlerGeneration({
    root,
    hostId: "darwin-host",
    adapter,
    handler: { file: node, args: ["--input-type=module", "-e", script] },
    timeoutMs: 5000,
  })
  assert.equal(result.disposition, "live")
  assert.notEqual(result.record.process, null)
  assert.match(result.record.process!.birth, new RegExp(`:agy-handler:${result.record.launchAttemptId}$`))
  const observed = await adapter.readProcess(result.record.process!.pid)
  assert.notEqual(observed, null)
  assert.equal(sameProcess(result.record.process!, observed!), true)
  process.kill(-result.record.process!.processGroupId, "SIGKILL")
  await waitFor(async () => await adapter.readProcess(result.record.process!.pid) === null, "Handler fixture survived")
})

test("Darwin process groups preserve unstable identity observation diagnostics", async () => {
  const command = agencyLaunchMarker("handler",canonicalId)
  const { execute } = scriptedExecutor([psRow({pid:401,ppid:402,command}),psRow({pid:401,ppid:1,command})])
  await assert.rejects(createDarwinAdapter(execute).readProcess(401), error => {
    assert.ok(error instanceof DarwinObservationUnavailable)
    assert.match(error.message,/"parentPid":402/)
    assert.match(error.message,/"parentPid":1/)
    assert.match(error.message,/"pid":401/)
    return true
  })
})