import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, text } from "../catalog/types.js"
import { AgentError, parseTuple, type AgentTuple } from "../agent/types.js"

export type EntryTarget = { hostId: string; target: AgentTuple }
export type EditorReceipt = { editorId: string; session: string; pane: string }
export type RuntimeEditor = EditorReceipt & { tmuxSocketPath: string }
export type RuntimeEntry = { commandId: string; ref: EntryTarget; state: "opening" | "opened" | "uncertain" | "stale"; editor: RuntimeEditor | null }
export type RuntimeEntryDriver = { ensure(ref: EntryTarget): Promise<RuntimeEditor>; activate(ref: EntryTarget, editor: RuntimeEditor): Promise<void>; inspect(ref: EntryTarget): Promise<RuntimeEditor | null> }
export function parseEntryTarget(raw: unknown): EntryTarget {
  const value = object(raw); keys(value, ["hostId", "target"])
  return { hostId: hash(value.hostId), target: parseTuple(value.target) }
}
export function parseEditorReceipt(raw: unknown): EditorReceipt {
  const value = object(raw); keys(value, ["editorId", "session", "pane"])
  const session = text(value.session), pane = text(value.pane)
  if (!/^[a-zA-Z0-9_-]+$/.test(session) || !/^%[0-9]+$/.test(pane)) throw new Error("INVALID_EDITOR")
  return { editorId: id(value.editorId), session, pane }
}
export function parseRuntimeEditor(raw: unknown): RuntimeEditor {
  const value = object(raw); keys(value, ["editorId", "session", "pane", "tmuxSocketPath"])
  return { ...parseEditorReceipt({ editorId: value.editorId, session: value.session, pane: value.pane }), tmuxSocketPath: absolutePath(value.tmuxSocketPath) }
}
export function parseRuntimeEntry(raw: unknown): RuntimeEntry {
  const value = object(raw); keys(value, ["commandId", "ref", "state", "editor"])
  if (!["opening", "opened", "uncertain", "stale"].includes(String(value.state))) throw new Error("INVALID_ENTRY")
  const editor = value.editor === null ? null : parseRuntimeEditor(value.editor)
  if (value.state === "opened" && !editor) throw new Error("INVALID_ENTRY")
  return { commandId: id(value.commandId), ref: parseEntryTarget(value.ref), state: value.state as RuntimeEntry["state"], editor }
}
export function createRuntimeEntry(input: { hostId: string; generation: string; validate(target: AgentTuple): Promise<boolean>; driver: RuntimeEntryDriver }) {
  type Command = { ref: EntryTarget; receipt: RuntimeEntry; flight: Promise<RuntimeEntry> | null }
  const commands = new Map<string, Command>()
  const current = (ref: EntryTarget) => ref.hostId === input.hostId && ref.target.handlerGeneration === input.generation && input.validate(ref.target)
  const set = (command: Command, state: RuntimeEntry["state"], editor = command.receipt.editor) => { command.receipt = { ...command.receipt, state, editor }; return structuredClone(command.receipt) }
  async function inspect(commandId: string): Promise<RuntimeEntry | null> {
    const command = commands.get(id(commandId))
    if (!command) return null
    try {
      if (!await current(command.ref)) return set(command, "stale")
      if (command.flight) return structuredClone(command.receipt)
      const editor = await input.driver.inspect(command.ref)
      if (!await current(command.ref)) return set(command, "stale")
      return set(command, editor && command.receipt.editor && isDeepStrictEqual(parseRuntimeEditor(editor), command.receipt.editor) ? "opened" : "uncertain")
    } catch { return set(command, "uncertain") }
  }
  async function execute(command: Command): Promise<RuntimeEntry> {
    try {
      if (!await current(command.ref)) return set(command, "stale")
      set(command, "opening", parseRuntimeEditor(await input.driver.ensure(command.ref)))
      if (!await current(command.ref)) return set(command, "stale")
      await input.driver.activate(command.ref, command.receipt.editor!)
      if (!await current(command.ref)) return set(command, "stale")
      const attached = await input.driver.inspect(command.ref)
      if (!await current(command.ref)) return set(command, "stale")
      return set(command, attached && isDeepStrictEqual(parseRuntimeEditor(attached), command.receipt.editor) ? "opened" : "uncertain")
    } catch { return set(command, "uncertain") }
  }
  return { inspect, open(commandId: string, raw: EntryTarget): Promise<RuntimeEntry> {
    commandId = id(commandId); const ref = parseEntryTarget(raw), prior = commands.get(commandId)
    if (prior) {
      if (!isDeepStrictEqual(prior.ref, ref)) return Promise.reject(new AgentError("COMMAND_CONFLICT"))
      return prior.flight ?? inspect(commandId).then(value => value!)
    }
    const command: Command = { ref, receipt: { commandId, ref, state: "opening", editor: null }, flight: null }
    commands.set(commandId, command)
    command.flight = Promise.resolve().then(() => execute(command))
    void command.flight.finally(() => { command.flight = null }).catch(() => {})
    return command.flight
  } }
}