import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createRuntimeEntryDriver, entryEditorIdentity } from "../src/entry/editor.js"

function intent() {
  return { hostId: "b".repeat(64), target: { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() } }
}
test("reused tmux session names never authorize entry into a foreign editor", async () => {
  const value = intent(), calls: string[][] = []
  const driver = createRuntimeEntryDriver({ runtimeRoot: "/fixture", run: async (file, args) => {
    calls.push([file, ...args]); if (args.includes("has-session")) return ""; return "foreign"
  } })
  await assert.rejects(driver.ensure(value), /EDITOR_IDENTITY_CHANGED/)
  assert.equal(calls.some(call => call.includes("new-session") || call.includes("kill-session")), false)
})
test("inspection requires full ownership and the exact actual provider binding", async () => {
  const value = intent(), identity = entryEditorIdentity(value), calls: string[][] = []
  const driver = createRuntimeEntryDriver({ runtimeRoot: "/fixture", socket: async () => "/fixture/socket", run: async (file, args) => {
    calls.push([file, ...args])
    if (file === "nvim") return JSON.stringify({ editorId: identity.editorId, target: { ...value.target, providerGeneration: randomUUID() } })
    if (args.includes("has-session")) return ""
    if (args.includes("show-options")) return identity.digest
    return "%3"
  } })
  assert.equal(await driver.inspect(value), null)
  assert.equal(calls.some(call => call.includes("new-session")), false)
})
test("new editor commands pass argv and stable IDs without task or shell interpolation", async () => {
  const value = intent(), identity = entryEditorIdentity(value), calls: string[][] = []
  let exists = false
  const driver = createRuntimeEntryDriver({ runtimeRoot: "/fixture", socket: async () => "/fixture/socket", run: async (file, args) => {
    calls.push([file, ...args])
    if (args.includes("has-session") && !exists) throw new Error("absent")
    if (args.includes("new-session")) { exists = true; return "%3" }
    if (args.includes("show-options")) return identity.digest
    if (file === "nvim") return JSON.stringify({ editorId: identity.editorId, target: value.target })
    return "%3"
  } })
  const editor = await driver.ensure(value); await driver.activate(value, editor)
  assert.deepEqual(await driver.inspect(value), editor)
  assert.equal(calls.filter(call => call.includes("new-session")).length, 1)
  assert.equal(calls.some(call => call.includes("-c") || call.includes("kill-session")), false)
  assert.equal(calls.some(call => call.includes("--listen")), true)
})

test("runtime editors use host plus exact session identity without inventory or task state", async () => {
  const ref = { hostId: "a".repeat(64), target: { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() } }, identity = entryEditorIdentity(ref), calls: string[][] = []
  let exists = false
  const driver = createRuntimeEntryDriver({ runtimeRoot: "/fixture", socket: async () => "/fixture/nvim.sock", run: async (file, args) => {
    calls.push([file, ...args]); if (args.includes("has-session") && !exists) throw new Error("absent")
    if (args.includes("new-session")) { exists = true; return "%2" }
    if (args.includes("show-options")) return identity.digest
    if (file === "nvim") return JSON.stringify({ editorId: identity.editorId, target: ref.target })
    return "%2"
  } })
  const receipt = await driver.ensure(ref); await driver.activate(ref, receipt)
  assert.deepEqual(await driver.inspect(ref), receipt); assert.equal(receipt.tmuxSocketPath, "/fixture/entry-tmux.sock")
  assert.equal(calls.filter(call => call.includes("new-session")).length, 1)
  assert.equal(calls.some(call => call.includes("--remote-expr")), true)
})