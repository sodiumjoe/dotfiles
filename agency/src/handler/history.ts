import { join } from "node:path"
import { decodeJson, readBoundedFile } from "../catalog/config.js"

export async function historyDiagnostic(root: string): Promise<(path: string) => string | null> {
  try {
    const bytes = await readBoundedFile(join(root, "retention/pending.json"), 1048576, true)
    if (bytes === null) return () => null
    const intent = decodeJson(bytes) as { version?: unknown; entries?: unknown }
    if (intent?.version !== 1 || !Array.isArray(intent.entries) || intent.entries.some(entry => !entry || typeof entry.path !== "string")) return () => "INCOMPLETE_HISTORY: unreadable retirement intent"
    const paths = intent.entries.map(entry => entry.path as string)
    return path => paths.some(target => path === target || path.startsWith(target + "/")) ? "INCOMPLETE_HISTORY: pending retirement" : null
  } catch { return () => "INCOMPLETE_HISTORY: unreadable retirement intent" }
}

export async function incompleteHistory(root: string, path: string): Promise<string | null> {
  return (await historyDiagnostic(root))(path)
}