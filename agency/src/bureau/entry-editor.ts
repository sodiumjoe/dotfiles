import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { canonicalDigest, fail } from "../orchestration/types.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { type EntryRef, type EntryIntent, type EntryDriver, type EditorReceipt, parseEditorReceipt } from "./entry.js"

const execute = promisify(execFile)
export type EntryCommand = (file: string, argv: string[]) => Promise<string>
export function entryEditorIdentity(ref: EntryRef) {
  const digest = canonicalDigest(ref), value = digest.slice(0, 32)
  return { digest, session: "agy-" + digest.slice(0, 24), socketName: "e-" + digest.slice(0, 24) + ".sock", editorId: value.slice(0, 8) + "-" + value.slice(8, 12) + "-4" + value.slice(13, 16) + "-8" + value.slice(17, 20) + "-" + value.slice(20) }
}
export function createTmuxEntryDriver(input: { runtimeRoot: string; run?: EntryCommand; socket?: typeof assertPrivateSocket; editor?: string }): EntryDriver {
  const run: EntryCommand = input.run ?? (async (file, args) => (await execute(file, args, { timeout: 10000, maxBuffer: 65536, env: { ...process.env, NVIM: undefined, NVIM_LISTEN_ADDRESS: undefined } })).stdout.trim())
  const socket = input.socket ?? assertPrivateSocket, editor = input.editor ?? "nvim", tmuxSocket = join(input.runtimeRoot, "entry-tmux.sock")
  const tmux = (...args: string[]) => run("tmux", ["-S", tmuxSocket, ...args])
  async function exists(session: string) { try { await tmux("has-session", "-t", "=" + session); return true } catch { return false } }
  async function owned(intent: EntryIntent): Promise<EditorReceipt | null> {
    const identity = entryEditorIdentity(intent.ref)
    if (!await exists(identity.session)) return null
    if ((await tmux("show-options", "-qv", "-t", "=" + identity.session, "@agy-entry-identity")).trim() !== identity.digest) fail("EDITOR_IDENTITY_CHANGED")
    const pane = (await tmux("list-panes", "-t", "=" + identity.session, "-F", "#{pane_id}")).trim()
    if (pane.includes("\n")) fail("EDITOR_IDENTITY_CHANGED")
    return parseEditorReceipt({ editorId: identity.editorId, session: identity.session, pane })
  }
  async function rpc(intent: EntryIntent, method: "bind" | "status") {
    const identity = entryEditorIdentity(intent.ref), address = await socket(input.runtimeRoot, identity.socketName)
    const args = JSON.stringify({ editorId: identity.editorId, target: intent.ref.target })
    const expression = `luaeval('require("sodium.agency.remote").${method}(_A)', json_decode('${args}'))`
    return run(editor, ["--server", address, "--remote-expr", expression])
  }
  async function inspect(intent: EntryIntent): Promise<EditorReceipt | null> {
    const receipt = await owned(intent)
    if (!receipt || intent.editor && canonicalDigest(receipt) !== canonicalDigest(intent.editor)) return null
    try {
      const result = JSON.parse(await rpc(intent, "status"))
      return result.editorId === receipt.editorId && canonicalDigest(result.target) === canonicalDigest(intent.ref.target) ? receipt : null
    } catch { return null }
  }
  return {
    async ensure(intent) {
      const prior = await owned(intent)
      if (prior) return prior
      const identity = entryEditorIdentity(intent.ref)
      const pane = (await tmux("new-session", "-d", "-s", identity.session, "-P", "-F", "#{pane_id}", editor, "--listen", join(input.runtimeRoot, identity.socketName))).trim()
      await tmux("set-option", "-t", "=" + identity.session, "@agy-entry-identity", identity.digest)
      return parseEditorReceipt({ editorId: identity.editorId, session: identity.session, pane })
    },
    async activate(intent, receipt) {
      if (canonicalDigest(await owned(intent)) !== canonicalDigest(receipt)) fail("EDITOR_IDENTITY_CHANGED")
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        try { await rpc(intent, "bind"); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
      }
      while (Date.now() < deadline) { if (await inspect(intent)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
      fail("EDITOR_ATTACHMENT_UNCERTAIN")
    },
    inspect
  }
}