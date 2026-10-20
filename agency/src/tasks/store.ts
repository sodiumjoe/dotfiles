import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hash } from "../catalog/types.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { checkedTask, parseTaskRecord, parseTaskReport, taskId, TaskError, type TaskRecord, type TaskReport } from "./types.js"

export type TaskStore = {
  initialize(): Promise<void>
  reserve(record: TaskRecord): Promise<void>
  read(taskId: string): Promise<TaskRecord | null>
  writeRecord(record: TaskRecord): Promise<void>
  readReport(taskId: string): Promise<TaskReport | null>
  writeReport(taskId: string, report: TaskReport): Promise<void>
  serialize<T>(taskId: string, operation: () => Promise<T>): Promise<T>
}
export function createTaskStore(input: { root: string; hostId: string; filesystem?: { rename(from: string, to: string): Promise<void> } }): TaskStore {
  const hostId = checkedTask(() => hash(input.hostId)), root = join(input.root, "tasks"), queues = new Map<string, Promise<void>>()
  const publishRename = input.filesystem?.rename ?? rename
  const hasCode = (error: unknown, code: string): boolean => error !== null && typeof error === "object" && "code" in error && error.code === code
  const directory = (raw: string): string => join(root, taskId(raw))
  const bound = (raw: TaskRecord): TaskRecord => {
    const record = parseTaskRecord(raw)
    if (record.ref.hostId !== hostId) throw new TaskError("INVALID_INPUT")
    return record
  }
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) { if (error instanceof TaskError) throw error; throw new TaskError("TASK_INCOMPLETE") }
  }
  async function publish(task: string, name: string, value: unknown): Promise<void> {
    const dir = directory(task), temporary = join(dir, `.${name}.${randomUUID()}.tmp`)
    await storage(async () => {
      try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await publishRename(temporary, join(dir, name)) }
      finally { await rm(temporary, { force: true }).catch(() => undefined) }
    })
  }
  async function read(task: string): Promise<TaskRecord | null> {
    const dir = directory(task)
    return storage(async () => {
      try { await assertPrivateDirectory(dir) }
      catch (error) { if (hasCode(error, "ENOENT")) return null; throw error }
      try {
        const record = bound(JSON.parse(await readFile(join(dir, "record.json"), "utf8")))
        if (record.ref.taskId !== task) throw new Error("record identity differs")
        return record
      } catch { throw new TaskError("TASK_INCOMPLETE", { hostId, taskId: task }) }
    })
  }
  return {
    async initialize() {
      await storage(async () => {
        await assertPrivateDirectory(input.root)
        try { await mkdir(root, { mode: 0o700 }) } catch (error) { if (!hasCode(error, "EEXIST")) throw error }
        await assertPrivateDirectory(root)
      })
    },
    async reserve(raw) {
      const record = bound(raw), dir = directory(record.ref.taskId)
      await storage(async () => {
        try { await mkdir(dir, { mode: 0o700 }) }
        catch (error) { if (hasCode(error, "EEXIST")) throw new TaskError("TASK_EXISTS", record.ref); throw error }
        await publish(record.ref.taskId, "record.json", record)
      })
    },
    read,
    async writeRecord(raw) {
      const record = bound(raw)
      if (!await read(record.ref.taskId)) throw new TaskError("TASK_NOT_FOUND", record.ref)
      await publish(record.ref.taskId, "record.json", record)
    },
    async readReport(task) {
      const dir = directory(task)
      return storage(async () => {
        let bytes: string
        try { bytes = await readFile(join(dir, "report.json"), "utf8") }
        catch (error) { if (hasCode(error, "ENOENT")) return null; throw error }
        try { return parseTaskReport(JSON.parse(bytes)) } catch { throw new TaskError("TASK_INCOMPLETE", { hostId, taskId: task }) }
      })
    },
    async writeReport(task, raw) {
      const report = parseTaskReport(raw)
      if (!await read(task)) throw new TaskError("TASK_NOT_FOUND", { hostId, taskId: taskId(task) })
      await publish(task, "report.json", report)
    },
    serialize<T>(task: string, operation: () => Promise<T>): Promise<T> {
      taskId(task)
      const result = (queues.get(task) ?? Promise.resolve()).then(operation)
      const tail = result.then(() => undefined, () => undefined)
      queues.set(task, tail)
      void tail.then(() => { if (queues.get(task) === tail) queues.delete(task) })
      return result
    },
  }
}