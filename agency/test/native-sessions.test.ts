import assert from "node:assert/strict"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { discoverCodexSessions } from "../src/agent/native-sessions.js"
import { privateRoot } from "./control-support.js"

const metadata = (id: string, cwd: unknown = "/workspace") => JSON.stringify({ type: "session_meta", payload: { id, cwd } })

test("Codex discovery reads the rollout metadata without parsing transcript bodies", async t => {
  const root = await privateRoot(t), day = join(root, "2026/10/05")
  await mkdir(day, { recursive: true, mode: 0o700 })
  await writeFile(join(day, "rollout.jsonl"), metadata("native-a") + "\n" + "not JSON\n".repeat(100000))
  const found = await discoverCodexSessions(root)
  assert.equal(found.length, 1)
  assert.equal(found[0]!.nativeSessionId, "native-a")
  assert.equal(found[0]!.backendId, "codex-acp")
  assert.equal(found[0]!.cwd, "/workspace")
  assert.equal(found[0]!.title, null)
  assert.ok(found[0]!.updatedAt)
})

test("invalid metadata and unrecognized first-line formats are not listed", async t => {
  const root = await privateRoot(t)
  const invalid = [metadata("missing", undefined), metadata("relative", "relative"), metadata("noncanonical", "/workspace/../other"), metadata("logical", "/workspace").replace('"logical"', '"agency:logical"'), JSON.stringify({ type: "event_msg", payload: { id: "unknown", cwd: "/workspace" } }), "{}", "not JSON", "x".repeat(65537)]
  invalid[0] = JSON.stringify({ type: "session_meta", payload: { id: "missing" } })
  for (const [index, bytes] of invalid.entries()) await writeFile(join(root, index + ".jsonl"), bytes + "\n")
  assert.deepEqual(await discoverCodexSessions(root), [])
})

test("Codex discovery does not follow linked files, linked directories or a linked root", async t => {
  const root = await privateRoot(t), history = join(root, "history"), external = join(root, "external")
  await mkdir(history); await mkdir(external)
  await writeFile(join(external, "rollout.jsonl"), metadata("external") + "\n")
  await symlink(join(external, "rollout.jsonl"), join(history, "file.jsonl"))
  await symlink(external, join(history, "directory"))
  await symlink(external, join(root, "linked"))
  assert.deepEqual(await discoverCodexSessions(history), [])
  assert.deepEqual(await discoverCodexSessions(join(root, "linked")), [])
})

test("duplicate native IDs with the same cwd collapse while conflicting cwd metadata is omitted", async t => {
  const root = await privateRoot(t)
  for (const [name, bytes] of [["a", metadata("same")], ["b", metadata("same")], ["c", metadata("conflict")], ["d", metadata("conflict", "/other")]]) await writeFile(join(root, name + ".jsonl"), bytes + "\n")
  assert.deepEqual((await discoverCodexSessions(root)).map(value => value.nativeSessionId), ["same"])
})

test("absent Codex history is an empty metadata inventory", async t => {
  const root = await privateRoot(t)
  assert.deepEqual(await discoverCodexSessions(join(root, "absent")), [])
})