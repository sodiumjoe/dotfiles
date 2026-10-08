import { isDeepStrictEqual } from "node:util"
import { MutationQueue } from "../handler/mutations.js"
import { id, keys, object } from "../catalog/types.js"
import type { JournalPool } from "./journal.js"
import { canonicalDigest, enumValue, parseEventRef, parseReportInput, fail, type ReportInput, type ExecutionRef, type EventRef, type Journal, type JournalEntry } from "./types.js"

export type ReportReceipt = { commandId: string; runId: string; assignmentId: string; attemptId: string; digest: string; originSeq: number; state: "retained" | "accepted" | "late" }
export type ReportRelay = { input: ReportInput; origin: EventRef }
export type AcceptedReport = ReportRelay & { receipt: ReportReceipt }
export function parseAcceptedReport(raw: unknown): AcceptedReport {
  const v = object(raw); keys(v, ["input", "origin", "receipt"])
  const input = parseReportInput(v.input), origin = parseEventRef(v.origin), r = object(v.receipt)
  keys(r, ["commandId", "runId", "assignmentId", "attemptId", "digest", "originSeq", "state"])
  const state = enumValue(r.state, ["accepted", "late"])
  if (r.commandId !== input.commandId || r.runId !== input.runId || r.assignmentId !== input.assignmentId || r.attemptId !== input.attemptId || r.digest !== canonicalDigest(input.report) || r.originSeq !== origin.seq) fail("INVALID_REPORT")
  return { input, origin, receipt: { commandId: input.commandId, runId: input.runId, assignmentId: input.assignmentId, attemptId: input.attemptId, digest: canonicalDigest(input.report), originSeq: origin.seq, state } }
}
export async function journalEntries(journal: Journal): Promise<JournalEntry[]> {
  let after = 0
  const entries: JournalEntry[] = []
  while (true) {
    const page = await journal.read(after, 256)
    entries.push(...page.entries)
    after = page.nextCursor
    if (after >= page.lastSeq) return entries
  }
}
export function createReportOutbox(input: { journals: JournalPool; validate(execution: ExecutionRef, report: ReportInput): Promise<void>; relay(envelope: ReportRelay): Promise<ReportReceipt>; retain?(execution: ExecutionRef, publish: () => Promise<JournalEntry>): Promise<JournalEntry> }) {
  const queue = new MutationQueue()
  async function relay(entry: JournalEntry): Promise<ReportReceipt> {
    await input.journals.forRun(parseReportInput(entry.payload).runId).append(entry.eventId, entry.kind, entry.payload)
    const report = parseReportInput(entry.payload), origin = parseEventRef({ seq: entry.seq, eventId: entry.eventId, digest: entry.digest })
    const retained: ReportReceipt = { commandId: report.commandId, runId: report.runId, assignmentId: report.assignmentId, attemptId: report.attemptId, digest: canonicalDigest(report.report), originSeq: entry.seq, state: "retained" }
    let receipt: ReportReceipt
    try { receipt = await input.relay({ input: report, origin }) } catch { return retained }
    parseAcceptedReport({ input: report, origin, receipt })
    await input.journals.forRun(report.runId).acknowledge("bureau", origin)
    return receipt
  }
  return {
    async report(raw: ReportInput): Promise<ReportReceipt> {
      const report = parseReportInput(raw)
      return queue.run(async () => {
        const journal = input.journals.forRun(report.runId), entries = await journalEntries(journal)
        const sameCommand = entries.find(entry => entry.eventId === report.commandId)
        if (sameCommand && (sameCommand.kind !== "report-retained" || !isDeepStrictEqual(sameCommand.payload, report))) fail("COMMAND_CONFLICT")
        const previous = entries.find(entry => entry.kind === "report-retained" && parseReportInput(entry.payload).attemptId === report.attemptId)
        if (previous) {
          const saved = parseReportInput(previous.payload)
          if (saved.runId === report.runId && saved.assignmentId === report.assignmentId && isDeepStrictEqual(saved.execution, report.execution) && isDeepStrictEqual(saved.report, report.report)) return relay(previous)
        }
        await input.validate(report.execution, report)
        if (previous) fail("REPORT_CONFLICT")
        const publish = () => journal.append(id(report.commandId), "report-retained", report)
        const entry = input.retain ? await input.retain(report.execution, publish) : await publish()
        return relay(entry)
      })
    },
    async replay() {
      return queue.run(async () => {
        for (const runId of await input.journals.list()) for (const entry of await journalEntries(input.journals.forRun(runId))) if (entry.kind === "report-retained") await relay(entry)
      })
    }
  }
}