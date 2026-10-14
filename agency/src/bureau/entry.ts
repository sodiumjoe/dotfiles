import { hash, id, keys, object, text, timestamp } from "../catalog/types.js"
import { parseTuple, type AgentTuple } from "../agent/types.js"
import { canonicalDigest, fail } from "../orchestration/types.js"
import { createStorage, storageQueue } from "../orchestration/storage.js"

export type EntryRef = { inventoryId: string; hostId: string; target: AgentTuple }
import { parseEditorReceipt, type EditorReceipt } from "../entry/runtime.js"
export { parseEditorReceipt, type EditorReceipt } from "../entry/runtime.js"
export type EntryIntent = { commandId: string; ref: EntryRef; digest: string; expiresAt: number; state: "prepared" | "opening" | "consumed" | "uncertain" | "expired" | "stale"; editor: EditorReceipt | null }
export type EntryDriver = { ensure(intent: EntryIntent): Promise<EditorReceipt>; activate(intent: EntryIntent, editor: EditorReceipt): Promise<void>; inspect(intent: EntryIntent): Promise<EditorReceipt | null> }
export function parseEntryRef(raw: unknown): EntryRef {
  const v = object(raw); keys(v, ["inventoryId", "hostId", "target"])
  return { inventoryId: id(v.inventoryId), hostId: hash(v.hostId), target: parseTuple(v.target) }
}
export function parseEntryIntent(raw: unknown): EntryIntent {
  const v = object(raw); keys(v, ["commandId", "ref", "digest", "expiresAt", "state", "editor"])
  const commandId = id(v.commandId), ref = parseEntryRef(v.ref), digest = hash(v.digest)
  if (digest !== canonicalDigest({ commandId, ref }) || !["prepared", "opening", "consumed", "uncertain", "expired", "stale"].includes(String(v.state))) fail("INVALID_ENTRY")
  return { commandId, ref, digest, expiresAt: timestamp(v.expiresAt), state: v.state as EntryIntent["state"], editor: v.editor === null ? null : parseEditorReceipt(v.editor) }
}
const flights = new Map<string, Promise<EntryIntent>>()
export function createEntryController(input: { root: string; hostId: string; handlerGeneration: string; now?: () => number; validate(target: AgentTuple): Promise<boolean>; driver: EntryDriver }) {
  const storage = createStorage(input.root, "orchestration"), queue = storageQueue(input.root), now = input.now ?? Date.now
  const key = (commandId: string) => `entry/${id(commandId)}.json`
  const read = async (commandId: string) => { const raw = await storage.read(key(commandId)); return raw === null ? null : parseEntryIntent(raw) }
  const current = (ref: EntryRef) => ref.hostId === input.hostId && ref.target.handlerGeneration === input.handlerGeneration
  const write = async (prior: EntryIntent, state: EntryIntent["state"], editor = prior.editor) => {
    const next = { ...prior, state, editor }
    await queue.run(() => storage.publish(key(prior.commandId), next, prior)); return next
  }
  async function consume(commandId: string, digest: string): Promise<EntryIntent> {
    let intent = await queue.run(() => read(commandId))
    if (!intent) fail("UNKNOWN_ENTRY")
    if (hash(digest) !== intent.digest) fail("COMMAND_CONFLICT")
    if (["consumed", "expired", "stale"].includes(intent.state)) return intent
    if (!current(intent.ref) || !await input.validate(intent.ref.target)) return write(intent, "stale")
    if (intent.state === "opening" || intent.state === "uncertain") {
      let editor: EditorReceipt | null = null
      try { editor = await input.driver.inspect(intent) } catch {}
      return write(intent, editor ? "consumed" : "uncertain", editor ? parseEditorReceipt(editor) : intent.editor)
    }
    if (timestamp(now()) > intent.expiresAt) return write(intent, "expired")
    intent = await write(intent, "opening")
    try {
      const editor = parseEditorReceipt(await input.driver.ensure(intent))
      intent = await write(intent, "opening", editor)
      if (!await input.validate(intent.ref.target)) return write(intent, "stale")
      await input.driver.activate(intent, editor)
      if (!await input.validate(intent.ref.target)) return write(intent, "stale")
      return await write(intent, "consumed")
    } catch { return write(intent, "uncertain") }
  }
  return {
    prepare(commandId: string, raw: EntryRef): Promise<EntryIntent> { return queue.run(async () => {
      commandId = id(commandId); const ref = parseEntryRef(raw), digest = canonicalDigest({ commandId, ref }), prior = await read(commandId)
      if (prior) { if (prior.digest !== digest) fail("COMMAND_CONFLICT"); return prior }
      if (!current(ref) || !await input.validate(ref.target)) fail("STALE_EXECUTION")
      const intent: EntryIntent = { commandId, ref, digest, expiresAt: timestamp(now()) + 120000, state: "prepared", editor: null }
      await storage.publish(key(commandId), intent, null, true); return intent
    }) },
    async consume(commandId: string, digest: string): Promise<EntryIntent> {
      commandId = id(commandId); digest = hash(digest)
      const flightKey = input.root + "/" + commandId, active = flights.get(flightKey)
      if (active) { const result = await active; if (result.digest !== digest) fail("COMMAND_CONFLICT"); return result }
      const task = consume(commandId, digest); flights.set(flightKey, task)
      try { return await task } finally { if (flights.get(flightKey) === task) flights.delete(flightKey) }
    },
    async verify(commandId: string, digest: string): Promise<boolean> {
      const intent = await queue.run(() => read(commandId))
      if (!intent || intent.digest !== hash(digest)) fail("COMMAND_CONFLICT")
      if (intent.state !== "consumed" || !current(intent.ref) || !await input.validate(intent.ref.target)) return false
      try { return canonicalDigest(await input.driver.inspect(intent)) === canonicalDigest(intent.editor) && intent.editor !== null } catch { return false }
    },
    inspect(commandId: string) { return queue.run(() => read(commandId)) }
  }
}