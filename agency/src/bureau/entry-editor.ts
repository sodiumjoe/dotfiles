import { createTmuxEditorMechanics } from "../entry/editor.js"
import type { EntryDriver } from "./entry.js"
export { entryEditorIdentity, type EntryCommand } from "../entry/editor.js"
export function createTmuxEntryDriver(input: Parameters<typeof createTmuxEditorMechanics>[0]): EntryDriver { return createTmuxEditorMechanics(input) }