import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { patchCodexAcp } from "../patch-codex-acp.mjs";

const installed = await readFile(new URL("../node_modules/@agentclientprotocol/codex-acp/dist/index.js", import.meta.url), "utf8");
const lateStart = installed
  .replace("    } finally {\n      if (sessionState) {\n        sessionState.agentMessageTextClosed = true;\n        sessionState.agentMessageTextByTurn?.clear();\n        sessionState.completedAgentMessageTurns?.clear();\n      }\n      if (this.getSessionGeneration(params.sessionId) === closeGeneration) {", "    } finally {\n      if (this.getSessionGeneration(params.sessionId) === closeGeneration) {")
  .replace("    if (resolveInterruptedTurn) {\n      completeAgentMessageTurn(sessionState, sessionState.sessionId, turnId);\n      this.codexAcpClient.markTurnStale({", "    if (resolveInterruptedTurn) {\n      this.codexAcpClient.markTurnStale({")
  .replace("  async interruptPromptTurn(turn, requestName) {\n    completeAgentMessageTurn(this.sessions.get(turn.threadId), turn.threadId, turn.turnId);\n    this.codexAcpClient.markTurnStale({", "  async interruptPromptTurn(turn, requestName) {\n    this.codexAcpClient.markTurnStale({")
  .replace("      case \"agentMessage\": {\n        this.rememberAgentMessagePhase(event.item);\n        const items = this.agentMessageItems(event);\n        if (!items || items.get(event.item.id) === null) return null;\n        const streamed = items.get(event.item.id) ?? \"\";\n        items.set(event.item.id, null);\n        if (!event.item.text.startsWith(streamed)) {\n          logger.log(\"Completed agent message diverged\", { threadId: event.threadId, turnId: event.turnId, itemId: event.item.id, streamedLength: streamed.length, completedLength: event.item.text.length });\n          return null;\n        }\n        const suffix = event.item.text.slice(streamed.length);\n        return suffix.length > 0 ? createAgentTextMessageChunk(suffix, event.item.id, createCodexMessagePhaseMeta(event.item.phase)) : null;\n      }\n      case \"plan\": {", "      case \"agentMessage\":\n        this.rememberAgentMessagePhase(event.item);\n        return null;\n      case \"plan\": {")
  .replace("  agentMessageItems(event) {\n    if (this.sessionState.agentMessageTextClosed) return null;\n    const key = JSON.stringify([event.threadId, event.turnId]);\n    if (this.sessionState.completedAgentMessageTurns?.has(key)) return null;\n    const turns = this.sessionState.agentMessageTextByTurn ??= new Map();\n    let items = turns.get(key);\n    if (!items) {\n      items = new Map();\n      turns.set(key, items);\n    }\n    return items;\n  }\n  async createTextEvent(event) {\n    const items = this.agentMessageItems(event);\n    if (!items || items.get(event.itemId) === null) return null;\n    items.set(event.itemId, (items.get(event.itemId) ?? \"\") + event.delta);\n    const phase = this.agentMessagePhases.get(event.itemId) ?? null;\n    return createAgentTextMessageChunk(event.delta, event.itemId, createCodexMessagePhaseMeta(phase));\n  }\n", "  async createTextEvent(event) {\n    const phase = this.agentMessagePhases.get(event.itemId) ?? null;\n    return createAgentTextMessageChunk(event.delta, event.itemId, createCodexMessagePhaseMeta(phase));\n  }\n")
  .replace("  async handleNotification(notification) {\n    if (notification.method === \"turn/completed\") {\n      completeAgentMessageTurn(this.sessionState, notification.params.threadId, notification.params.turn.id);\n    }\n    await this.flushPendingErrors();", "  async handleNotification(notification) {\n    await this.flushPendingErrors();")
  .replace("function completeAgentMessageTurn(sessionState, threadId, turnId) {\n  if (!sessionState || sessionState.agentMessageTextClosed) return;\n  const key = JSON.stringify([threadId, turnId]);\n  sessionState.agentMessageTextByTurn?.delete(key);\n  const completed = sessionState.completedAgentMessageTurns ??= new Set();\n  completed.add(key);\n  if (completed.size > 64) completed.delete(completed.values().next().value);\n}\nvar CodexEventHandler = class _CodexEventHandler {", "var CodexEventHandler = class _CodexEventHandler {");
assert.equal(createHash("sha256").update(lateStart).digest("hex"), "a792e8776fa77b4157ce5ee984b9b4027b25158da573554a7531044fa72c7ba1");
const legacy = lateStart
  .replaceAll("if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId) || this.sessions.get(params.sessionId) !== sessionState) {", "if (this.promptShouldStop(params.sessionId, activePrompt)) {")
  .replace(/([ ]*)if \(this\.activePrompts\.get\(params\.sessionId\) === activePrompt \|\| sessionState\.currentTurnId === null\) \{\n[ ]*sessionState\.currentTurnId = turnId;\n[ ]*\}/g, "$1sessionState.currentTurnId = turnId;")
  .replace("          pendingTurnStart = null;\n          ensurePendingTurnStart();\n          const implementationPromise", "          const implementationPromise")
  .replace("                pendingTurnStart?.resolve(turnId);\n                recoverableSessionFailure", "                recoverableSessionFailure");
assert.equal(createHash("sha256").update(legacy).digest("hex"), "c3f5b9212df7962fc7f95ccffe05841f31a9ca22d625cf5cf6c304d8bf9ffd78");
const original = legacy
  .replace(/      const resolvers = threadResolvers\.get\(turnId\) \?\? new Set\(\);\n      resolvers\.add\(resolve\);\n      threadResolvers\.set\(turnId, resolvers\);/, "      threadResolvers.set(turnId, resolve);")
  .replace("    const resolvers = threadResolvers?.get(event.turn.id);\n    if (resolvers)", "    const resolve = threadResolvers?.get(event.turn.id);\n    if (resolve)")
  .replace("      for (const resolve of resolvers) resolve(event);", "      resolve(event);\n      return;")
  .replace("  async getInterruptibleTurnId(sessionState, requestName) {\n    const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);\n    if (requestName !== \"Close\" && pendingTurnStart) {\n      const turnId = await pendingTurnStart.promise;\n      if (turnId) return turnId;\n    }\n    if (sessionState.currentTurnId) {\n      return sessionState.currentTurnId;\n    }\n    if (requestName === \"Close\") {\n      pendingTurnStart?.resolve(null);\n    }\n    logger.log(`${requestName} request rejected: no current turn`, { sessionId: sessionState.sessionId });\n    return null;\n  }\n", "  async getInterruptibleTurnId(sessionState, requestName) {\n    if (sessionState.currentTurnId) {\n      return sessionState.currentTurnId;\n    }\n    const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);\n    if (!pendingTurnStart) {\n      logger.log(`${requestName} request rejected: no current turn`, { sessionId: sessionState.sessionId });\n      return null;\n    }\n    if (requestName === \"Close\") {\n      pendingTurnStart.resolve(null);\n      return null;\n    }\n    const turnId = await pendingTurnStart.promise;\n    if (!turnId) {\n      logger.log(`${requestName} request rejected: no current turn`, { sessionId: sessionState.sessionId });\n    }\n    return turnId;\n  }\n")
  .replace("    sessionState.lastTokenUsage = null;\n    const activePrompt = this.trackActivePrompt(params.sessionId);", "    sessionState.currentTurnId = null;\n    sessionState.lastTokenUsage = null;\n    const activePrompt = this.trackActivePrompt(params.sessionId);")
  .replace("      if (sessionState.currentTurnId === activePrompt.currentTurn?.turnId) {\n        sessionState.currentTurnId = null;\n      }\n      if (this.pendingTurnStarts.get(params.sessionId) === pendingTurnStart) {\n        this.pendingTurnStarts.delete(params.sessionId);\n      }\n      pendingTurnStart?.resolve(null);", "      sessionState.currentTurnId = null;\n      const registeredPendingTurnStart = this.pendingTurnStarts.get(params.sessionId);\n      if (registeredPendingTurnStart !== void 0) {\n        this.pendingTurnStarts.delete(params.sessionId);\n        registeredPendingTurnStart.resolve(null);\n      }")
  .replace("        this.clearPlanTurnState();\n        if (this.sessionState.currentTurnId === notification.params.turn.id) {\n          this.sessionState.currentTurnId = null;\n        }\n        return null;", "        this.clearPlanTurnState();\n        this.sessionState.currentTurnId = null;\n        return null;");
assert.equal(createHash("sha256").update(original).digest("hex"), "afffcfeb6ae3a82f2b359a7d3d6a1a3ceee43898b59c34335eb1760974cc4ff8");

async function fixture(t, { version = "1.7.0", name = "@agentclientprotocol/codex-acp", source = original } = {}) {
  const project = await mkdtemp(path.join(tmpdir(), "acp-patch-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const root = path.join(project, "node_modules/@agentclientprotocol/codex-acp");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name, version }));
  const bundle = path.join(root, "dist/index.js");
  await writeFile(bundle, source); await chmod(bundle, 0o751);
  return { root, bundle, project };
}

test("patch changes pinned bundle once and preserves executable mode", async t => {
  const { root, bundle } = await fixture(t);
  await patchCodexAcp(root);
  const patched = await readFile(bundle);
  assert.notDeepEqual(patched, Buffer.from(original));
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  await patchCodexAcp(root);
  assert.deepEqual(await readFile(bundle), patched);
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(root, "dist")), ["index.js"]);
});

for (const [label, options] of [
  ["version", { version: "2.3.0" }],
  ["package name", { name: "unrelated" }],
  ["unknown source", { source: original.replace("threadResolvers.set(turnId, resolve);", "threadResolvers.set(turnId, () => {});") }],
  ["mixed patch state", { source: original.replace("      resolve(event);\n      return;", "      for (const resolve of resolvers) resolve(event);") }],
]) test("patch rejects " + label + " without modifying bundle", async t => {
  const { root, bundle } = await fixture(t, options);
  const before = await readFile(bundle);
  await assert.rejects(patchCodexAcp(root), /Unsupported codex-acp/);
  assert.deepEqual(await readFile(bundle), before);
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(root, "dist")), ["index.js"]);
});

for (const [label, executable] of [["test Node", process.execPath], ...(process.env.CODEX_ACP_TEST_INSTALL_NODE ? [["install Node", process.env.CODEX_ACP_TEST_INSTALL_NODE]] : [])]) test("postinstall executable resolves its own package directory: " + label, async t => {
  const { project, bundle } = await fixture(t);
  const script = path.join(project, "patch-codex-acp.mjs");
  await writeFile(script, await readFile(new URL("../patch-codex-acp.mjs", import.meta.url)));
  const result = spawnSync(executable, [script], { cwd: tmpdir(), env: {}, timeout: 3000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.notDeepEqual(await readFile(bundle), Buffer.from(original));
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
});

test("manifest and lock retain the exact supported provider graph", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(await readFile(new URL("../node_modules/@agentclientprotocol/codex-acp/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies[metadata.name], "1.7.0");
  assert.equal(lock.packages[""].dependencies[metadata.name], "1.7.0");
  assert.equal(lock.packages["node_modules/" + metadata.name].version, "1.7.0");
  assert.equal(metadata.version, "1.7.0");
  assert.equal(manifest.scripts.postinstall, "node patch-codex-acp.mjs");
});

test("patch upgrades exact previous overlap bundle to the full correction", async t => {
  const previous = await fixture(t, { source: legacy });
  const pristine = await fixture(t);
  await patchCodexAcp(previous.root); await patchCodexAcp(pristine.root);
  assert.notDeepEqual(await readFile(previous.bundle), Buffer.from(legacy));
  assert.deepEqual(await readFile(previous.bundle), await readFile(pristine.bundle));
  assert.equal((await stat(previous.bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(previous.root, "dist")), ["index.js"]);
});

test("patch rejects partial late-start correction without mutation", async t => {
  const mixed = legacy.replace("          if (this.promptShouldStop(params.sessionId, activePrompt)) {", "          if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId) || this.sessions.get(params.sessionId) !== sessionState) {");
  const { root, bundle } = await fixture(t, { source: mixed });
  await assert.rejects(patchCodexAcp(root), /Unsupported codex-acp/);
  assert.deepEqual(await readFile(bundle), Buffer.from(mixed));
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(root, "dist")), ["index.js"]);
});

test("patch upgrades exact late-start bundle to completed-text correction", async t => {
  const previous = await fixture(t, { source: lateStart });
  await patchCodexAcp(previous.root);
  assert.deepEqual(await readFile(previous.bundle), Buffer.from(installed));
  assert.equal((await stat(previous.bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(previous.root, "dist")), ["index.js"]);
});

test("patch rejects partial completed-text correction without mutation", async t => {
  const mixed = lateStart.replace("var CodexEventHandler = class _CodexEventHandler {", "function completeAgentMessageTurn() {}\nvar CodexEventHandler = class _CodexEventHandler {");
  const { root, bundle } = await fixture(t, { source: mixed });
  await assert.rejects(patchCodexAcp(root), /Unsupported codex-acp/);
  assert.deepEqual(await readFile(bundle), Buffer.from(mixed));
  assert.equal((await stat(bundle)).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(root, "dist")), ["index.js"]);
});