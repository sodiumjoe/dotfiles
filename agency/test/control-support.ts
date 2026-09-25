import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import type { LaunchRecord } from "../src/platform/types.js"

export async function privateRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-control-"))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

export function launch(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return { version: 1, checkoutId: "checkout-a", leaseId: randomUUID(), agentId: "agent-a", handlerGeneration: randomUUID(), launchAttemptId: randomUUID(), launchBootId: "boot-a", launchAttempted: true, phase: "launch_pending", provider: null, reason: null, ...overrides }
}