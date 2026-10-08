import type { HostSnapshot } from "../bureau/host.js"
import type { OriginKey, RemoteOrigins } from "../bureau/origins.js"
import { fail, parseJournalEntry, type JournalPage } from "../orchestration/types.js"

export async function replayOriginSnapshot(input: { mirror: RemoteOrigins; snapshot: HostSnapshot; connectionId: string; read(key: OriginKey, after: number, retained: boolean): Promise<JournalPage> }): Promise<void> {
  for (const fence of input.snapshot.replayFences) {
    const key = { hostId: input.snapshot.hostId, runId: fence.runId, streamId: fence.streamId }
    let after = Math.min(await input.mirror.watermark(key), fence.throughSeq), retained = false
    while (after < fence.throughSeq) {
      let page: JournalPage
      try { page = await input.read(key, after, retained) }
      catch (error) { if (!retained && error instanceof Error && ((error as { code?: string }).code ?? error.message) === "CURSOR_EXPIRED") { retained = true; continue }; throw error }
      if (!Number.isSafeInteger(page.lastSeq) || page.lastSeq < fence.throughSeq || page.checkpoint > page.lastSeq || !Array.isArray(page.entries) || !page.entries.length || page.entries.length > 256) fail("MISSING_ORIGIN")
      const entries = page.entries.map(parseJournalEntry).filter(entry => entry.seq <= fence.throughSeq)
      if (!entries.length || entries.some((entry, index) => entry.seq !== after + index + 1) || page.nextCursor !== page.entries.at(-1)?.seq) fail("MISSING_ORIGIN")
      await input.mirror.import(key, entries)
      after = entries.at(-1)!.seq
    }
  }
  await input.mirror.complete(input.snapshot, input.connectionId)
}