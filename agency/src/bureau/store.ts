import { createInboxStore } from "./inbox.js"
import { createWaitStore } from "./waits.js"
import { parseAcceptedReport, type AcceptedReport } from "../orchestration/reports.js"
import { hash, id, keys, object } from "../catalog/types.js"
import { createStorage, storageQueue, defaultFileSystem } from "../orchestration/storage.js"
import { parseRunRecord, parseAssignmentRecord, parseAttemptRecord, parseCommandRecord, type AssignmentRecord, type AttemptRecord, type CommandRecord, type RunRecord } from "./types.js"

export function createBureauStore(root: string, filesystem = defaultFileSystem) {
  const storage = createStorage(root, "bureau", filesystem), queue = storageQueue(root)
  async function read<T>(area: string, recordId: string, parse: (value: unknown) => T): Promise<T | null> {
    const raw = await storage.read(`${area}/${id(recordId)}.json`)
    if (raw === null) return null
    const value = parse(raw), record = object(value)
    const actual = area === "runs" ? record.runId : area === "commands" ? record.commandId : area === "assignments" ? record.assignmentId : object(record.ref).attemptId
    if (actual !== recordId) throw new Error("INVALID_BUREAU")
    return value
  }
  async function list<T>(area: string, parse: (value: unknown) => T): Promise<T[]> {
    const records: T[] = []
    for (const name of await storage.names(area)) {
      const value = await read(area, id(name.slice(0, -5)), parse)
      if (value === null) throw new Error("INVALID_BUREAU")
      records.push(value)
    }
    return records
  }
  return {
    async readForgotten(kind: "commands" | "assignments" | "waits", recordId: string): Promise<string | null> {
      const raw = await storage.read(`forgotten/${kind}/${id(recordId)}.json`)
      if (raw === null) return null
      const value = object(raw); keys(value, ["recordId", "runId", "digest"])
      if (value.recordId !== recordId) throw new Error("INVALID_BUREAU")
      if (value.digest !== null) hash(value.digest)
      return id(value.runId)
    },
    async sealIds(runId: string, forgetCommandId: string): Promise<void> {
      id(runId); id(forgetCommandId)
      await queue.run(async () => {
        const commands = (await list("commands", parseCommandRecord)).filter(value => value.runId === runId), assignments = (await list("assignments", parseAssignmentRecord)).filter(value => value.runId === runId), waits = (await createWaitStore(root, filesystem).listWaits()).filter(value => value.input.runId === runId)
        for (const command of commands) await storage.publish(`forgotten/commands/${command.commandId}.json`, { recordId: command.commandId, runId, digest: command.digest }, null, true)
        for (const assignment of assignments) await storage.publish(`forgotten/assignments/${assignment.assignmentId}.json`, { recordId: assignment.assignmentId, runId, digest: null }, null, true)
        for (const wait of waits) await storage.publish(`forgotten/waits/${wait.input.waitId}.json`, { recordId: wait.input.waitId, runId, digest: wait.digest }, null, true)
        for (const ack of await createInboxStore(root, filesystem).listAcknowledgments()) if (ack.runId === runId) await storage.publish(`forgotten/commands/${ack.commandId}.json`, { recordId: ack.commandId, runId, digest: null }, null, true)
        for (const delivery of await createInboxStore(root, filesystem).listDeliveries()) if (delivery.runId === runId && delivery.channel === "prompt") await storage.publish(`forgotten/commands/${delivery.deliveryId}.json`, { recordId: delivery.deliveryId, runId, digest: null }, null, true)
        await storage.publish(`forgotten/commands/${forgetCommandId}.json`, { recordId: forgetCommandId, runId, digest: null }, null, true)
      })
    },
    async eraseRun(runId: string): Promise<void> {
      id(runId)
      await queue.run(async () => {
        for (const area of ["commands", "assignments", "attempts", "reports", "inbox", "deliveries", "waits", "acknowledgments"]) for (const name of await storage.names(area)) {
          const raw = object(await storage.read(`${area}/${name}`)), actual = area === "attempts" ? object(raw.ref).runId : area === "reports" ? object(raw.input).runId : area === "waits" ? object(raw.input).runId : raw.runId
          if (actual === runId) await storage.remove(`${area}/${name}`)
        }
      })
    },
    ...createInboxStore(root, filesystem), ...createWaitStore(root, filesystem),
    async readReport(attemptId: string): Promise<AcceptedReport | null> { const raw = await storage.read(`reports/${id(attemptId)}.json`); if (raw === null) return null; const report = parseAcceptedReport(raw); if (report.input.attemptId !== attemptId) throw new Error("INVALID_REPORT"); return report },
    async writeReport(value: AcceptedReport) { const report = parseAcceptedReport(value); await queue.run(() => storage.publish(`reports/${report.input.attemptId}.json`, report, null, true)) },
    readAssignment: (assignmentId: string) => read("assignments", assignmentId, parseAssignmentRecord),
    readAttempt: (attemptId: string) => read("attempts", attemptId, parseAttemptRecord),
    readCommand: (commandId: string) => read("commands", commandId, parseCommandRecord),
    listRuns: () => list("runs", parseRunRecord),
    listAssignments: () => list("assignments", parseAssignmentRecord),
    listAttempts: () => list("attempts", parseAttemptRecord),
    listCommands: () => list("commands", parseCommandRecord),
    async writeAssignment(value: AssignmentRecord, expected: AssignmentRecord | null) { const record = parseAssignmentRecord(value); await queue.run(() => storage.publish(`assignments/${record.assignmentId}.json`, record, expected)) },
    async writeAttempt(value: AttemptRecord, expected: AttemptRecord | null) { const record = parseAttemptRecord(value); await queue.run(() => storage.publish(`attempts/${record.ref.attemptId}.json`, record, expected)) },
    async writeCommand(value: CommandRecord, expected: CommandRecord | null) { const record = parseCommandRecord(value); await queue.run(() => storage.publish(`commands/${record.commandId}.json`, record, expected)) },
    async readEnabled(): Promise<boolean> { const raw = await storage.read("settings/state.json"); if (raw === null) return false; const v = object(raw); keys(v, ["enabled"]); if (typeof v.enabled !== "boolean") throw new Error("INVALID_BUREAU"); return v.enabled },
    async writeEnabled(enabled: boolean, expected: boolean) { await queue.run(async () => { const raw = await storage.read("settings/state.json"); await storage.publish("settings/state.json", { enabled }, raw === null ? null : { enabled: expected }) }) },
    async readRun(runId: string): Promise<RunRecord | null> {
      const raw = await storage.read(`runs/${id(runId)}.json`)
      if (raw === null) return null
      const value = parseRunRecord(raw)
      if (value.runId !== runId) throw new Error("INVALID_RUN")
      return value
    },
    async writeRun(value: RunRecord, expected: RunRecord | null): Promise<void> {
      const record = parseRunRecord(value)
      await queue.run(() => storage.publish(`runs/${record.runId}.json`, record, expected))
    }
  }
}
export type BureauStore = ReturnType<typeof createBureauStore>