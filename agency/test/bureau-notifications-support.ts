import { randomUUID } from "node:crypto"
import type { TestContext } from "node:test"
import { createBureauService } from "../src/bureau/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { bureauFixture } from "./bureau-support.js"
import type { AssignmentView } from "../src/bureau/types.js"
import type { WaitInput, WaitResult, WaitRecord } from "../src/bureau/waits.js"
import type { AgentRef } from "../src/orchestration/types.js"
import type { InboxView } from "../src/bureau/inbox.js"

type Core = ReturnType<typeof createBureauService> & { wait(input: WaitInput, signal?: AbortSignal): Promise<WaitResult>; waitRecord(waitId: string): Promise<WaitRecord | null>; cancelWait(waitId: string): Promise<WaitRecord>; inbox(parent: AgentRef, runId: string, after?: number): Promise<InboxView>; close(): void }
export async function notificationsFixture(t: TestContext) {
  const f = await bureauFixture(t), child = await f.delegate(), origins = createJournalPool(f.root, f.filesystem, f.clock.now, "origin")
  const make = () => createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), origins, hosts: [f.host.raw] }) as Core
  let core = make()
  t.after(() => core.close())
  await core.initialize()
  const parent = (await f.snapshot()).root
  const waitInput: WaitInput = { waitId: randomUUID(), parent, runId: f.input.runId, assignmentIds: [child.assignmentId], after: 0, timeoutMs: 10000 }
  return { ...f, child, parent, origins, waitInput, get core() { return core },
    async report(target: AssignmentView = child, receiver = core) {
      const input = { ...target.attempt.ref, commandId: randomUUID(), execution: target.attempt.execution!, report: f.input.report }
      const event = await origins.forRun(f.input.runId).append(input.commandId, "report-retained", input)
      return receiver.acceptReport({ input, origin: { seq: event.seq, eventId: event.eventId, digest: event.digest } })
    },
    async restart() { await core.close(); core = make(); await core.initialize() }
  }
}