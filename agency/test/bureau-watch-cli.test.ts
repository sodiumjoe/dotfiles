import assert from "node:assert/strict"
import test from "node:test"
import { Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { runBureauClient } from "../src/bureau/cli.js"
import type { ControlDependencies } from "../src/cli/control.js"

for (const group of ["permission", "roster", "roster-ndjson"]) test(`${group} watch polls snapshots through the ready Handler and cancels its CLI resources`, async () => {
  const generation = randomUUID(), frames: any[] = [], requests: any[] = [], signals = new Map<string, () => void>()
  const output = new Writable({ write(bytes, _encoding, done) {
    frames.push(JSON.parse(bytes.toString())); done(); signals.get("SIGTERM")!()
  } })
  const deps = { environment: async () => ({ paths: { hostKey: "a".repeat(64) } }),
    inspect: async () => ({ disposition: "live", record: { generation, phase: "ready" } }),
    callBureau: async (_env: unknown, request: any) => { requests.push(request); return { ...request, ok: true, result: { pending: [], hosts: [], unavailable: [] } } },
    watch: { stdout: output, onSignal(signal: string, callback: () => void) { signals.set(signal, callback); return () => { signals.delete(signal) } } },
    stdout() { throw new Error("watch must await writable completion") }, stderr() {}, cwd: () => "/fixture", sleep: async () => {} } as unknown as ControlDependencies
  assert.equal(await runBureauClient(group === "roster-ndjson" ? ["roster", "watch", "--format", "ndjson"] : [group, "watch", "--json"], deps), 0)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].op, group === "permission" ? "permission_snapshot" : "roster_snapshot")
  assert.equal(requests[0].handlerGeneration, generation)
  assert.equal(frames[0].protocol, "agency-bureau-watch-v1")
  assert.equal(frames[0].seq, 1)
  assert.deepEqual(frames[0].result.pending, [])
  assert.equal(signals.size, 0)
  assert.equal(output.listenerCount("close"), 0)
})