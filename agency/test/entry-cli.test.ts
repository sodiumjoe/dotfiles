import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { runEntryHelper } from "../src/bureau/entry-cli.js"
import { canonicalDigest } from "../src/orchestration/types.js"
import type { ControlDependencies } from "../src/cli/control.js"
import { runBureauClient } from "../src/bureau/cli.js"

function fixture(state = "consumed") {
  const commandId = randomUUID(), generation = randomUUID(), hostId = "b".repeat(64), inventoryId = randomUUID(), ref = { hostId, inventoryId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() } }
  const digest = canonicalDigest({ commandId, ref }), calls: any[] = [], entered: any[] = []
  const deps = { environment: async () => ({ paths: { hostKey: hostId, runtimeRoot: "/fixture" } }), inspect: async () => ({ disposition: "live", record: { generation, phase: "ready" } }),
    callBureau: async (_env: unknown, request: any) => { calls.push(request); return { protocol: request.protocol, requestId: request.requestId, handlerGeneration: generation, ok: true,
      result: { commandId, ref, digest, expiresAt: 1000, state, editor: { editorId: randomUUID(), session: "owned-entry", pane: "%2" } } } },
    stdout() {}, stderr() {}, cwd: () => "/fixture" } as unknown as ControlDependencies
  const argv = [commandId, "--digest", digest, "--host-id", hostId, "--inventory-id", inventoryId, "--handler-generation", generation]
  return { deps, argv, calls, entered, enter: async (file: string, args: string[]) => { entered.push([file, ...args]); return 0 } }
}
test("remote helper consumes the local exact intent before attaching the owned tmux target", async () => {
  const f = fixture(); assert.equal(await runEntryHelper(f.argv, f.deps, f.enter), 0)
  assert.equal(f.calls[0].op, "entry_consume"); assert.equal(f.entered.length, 1)
  assert.deepEqual(f.entered[0], ["tmux", "-S", "/fixture/entry-tmux.sock", "attach-session", "-t", "=owned-entry"])
})
test("uncertain entry never attaches a terminal or stops a provider", async () => {
  const f = fixture("uncertain"); assert.equal(await runEntryHelper(f.argv, f.deps, f.enter), 75)
  assert.equal(f.entered.length, 0); assert.equal(f.calls.length, 1)
})
for (const argv of [["roster", "--json"], ["roster", "list", "--json"]]) test(argv.join(" ") + " reads one roster snapshot", async () => {
  const f = fixture(); assert.equal(await runBureauClient(argv, f.deps), 0); assert.equal(f.calls[0].op, "roster_snapshot")
})