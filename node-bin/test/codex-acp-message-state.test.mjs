import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../node_modules/@agentclientprotocol/codex-acp/dist/index.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const context = vm.createContext({ logger: { log() {} } });
vm.runInContext(section("function createCodexMessagePhaseMeta(", "// src/GoalExtension.ts") + section(source.includes("function completeAgentMessageTurn(") ? "function completeAgentMessageTurn(" : "var CodexEventHandler =", "// src/permissions/option-ids.ts"), context);
const Handler = vm.runInContext("CodexEventHandler", context);
const serverMethod = (start, end) => vm.runInContext("({" + section(start, end) + "})", context);
const { closeSession } = serverMethod("  async closeSession(params) {\n    logger.log(\"Closing session...\"", "  async deleteSession(params)");
const { interruptPromptTurn } = serverMethod("  async interruptPromptTurn(turn, requestName)", "  async requestTurnInterrupt(turn, requestName)");
const { interruptSessionTurn } = serverMethod("  async interruptSessionTurn(sessionState, requestName, resolveInterruptedTurn)", "  async getInterruptibleTurnId(sessionState, requestName)");
function handler(state = {}) {
  const instance = Object.create(Handler.prototype);
  Object.assign(instance, { sessionState: state, agentMessagePhases: new Map(), flushPendingErrors: async () => {}, subagents: { handle: async () => true, takeBufferedNotifications: () => [] } });
  return instance;
}
const event = (text, threadId = "root", turnId = "turn", itemId = "item") => ({ delta: text, threadId, turnId, itemId, item: { type: "agentMessage", id: itemId, text, phase: "final_answer" } });
const terminal = (threadId = "root", turnId = "turn") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId } } });

test("packaged handler isolates native thread, turn and item identities", async () => {
  const h = handler();
  await h.createTextEvent(event("a"));
  await h.createTextEvent(event("b", "child"));
  await h.createTextEvent(event("c", "root", "other"));
  await h.createTextEvent(event("d", "root", "turn", "other"));
  const values = [];
  for (const [text, threadId, turnId, itemId] of [["a1", "root", "turn", "item"], ["b2", "child", "turn", "item"], ["c3", "root", "other", "item"], ["d4", "root", "turn", "other"]]) {
    values.push((await h.completeItemEvent(event(text, threadId, turnId, itemId)))?.content.text);
  }
  assert.deepEqual(values, ["1", "2", "3", "4"]);
});

test("completed items release strings and consumed child terminals release item state", async () => {
  const h = handler();
  await h.createTextEvent(event("retained until completion", "child"));
  await h.completeItemEvent(event("retained until completion", "child"));
  const items = h.sessionState.agentMessageTextByTurn?.get('["child","turn"]');
  assert.ok(items, "active turn has retained item markers");
  assert.equal(items.get("item"), null);
  await h.handleNotification(terminal("child"));
  assert.equal(h.sessionState.agentMessageTextByTurn.size, 0);
  assert.equal(await h.createTextEvent(event("late", "child")), null);
  assert.equal((await h.createTextEvent(event("root independent"))).content.text, "root independent");
});

test("terminal suppression has a bounded FIFO window and duplicate terminals do not evict entries", async () => {
  const h = handler();
  await h.handleNotification(terminal("root", "turn0"));
  for (let i = 1; i < 64; i++) await h.handleNotification(terminal("root", "turn" + i));
  for (let i = 0; i < 70; i++) await h.handleNotification(terminal("root", "turn63"));
  assert.equal(await h.createTextEvent(event("suppressed", "root", "turn0")), null);
  assert.equal(h.sessionState.completedAgentMessageTurns?.size, 64);
  await h.handleNotification(terminal("root", "turn64"));
  assert.equal((await h.createTextEvent(event("outside retained window", "root", "turn0"))).content.text, "outside retained window");
  assert.equal(await h.createTextEvent(event("still suppressed", "root", "turn1")), null);
  assert.equal(h.sessionState.completedAgentMessageTurns?.size, 64);
});

for (const changedGeneration of [false, true]) test("closed old handler cannot recreate text state: generation changed=" + changedGeneration, async () => {
  const old = { sessionId: "root" }, replacement = { sessionId: "root" };
  const h = handler(old); await h.createTextEvent(event("old text")); await h.handleNotification(terminal("root", "old"));
  const sessions = new Map([["root", old]]);
  const server = {
    sessions, bumpSessionGeneration: () => 1, getSessionGeneration: () => changedGeneration ? 2 : 1,
    beginSessionCloseFence() {}, endSessionCloseFence() {}, interruptSessionTurn: async () => {},
    activePrompts: new Map(), pendingMcpStartupSessions: new Set(), pendingTurnStarts: new Map(), steeringQueues: new Map(), goalControlGenerations: new Map(),
    runWithProcessCheck: fn => fn(), codexAcpClient: { closeSession: async () => { if (changedGeneration) sessions.set("root", replacement); } }
  };
  await closeSession.call(server, { sessionId: "root" });
  assert.equal(await h.createTextEvent(event("late delta")), null);
  assert.equal(await h.completeItemEvent(event("late completion")), null);
  await h.handleNotification(terminal("root", "queued"));
  assert.equal(old.agentMessageTextByTurn?.size ?? 0, 0);
  assert.equal(old.completedAgentMessageTurns?.size ?? 0, 0);
  if (changedGeneration) assert.equal(sessions.get("root"), replacement);
  const fresh = handler(replacement);
  assert.equal((await fresh.completeItemEvent(event("fresh same identity"))).content.text, "fresh same identity");
});

for (const kind of ["prompt", "session"]) test("stale " + kind + " interruption releases text before filtering native terminal", async () => {
  const state = { sessionId: "root" }; const h = handler(state);
  await h.createTextEvent(event("active"));
  const server = {
    sessions: new Map([["root", state]]), getInterruptibleTurnId: async () => "turn", requestTurnInterrupt: async () => {}, runWithProcessCheck: fn => fn(),
    codexAcpClient: { markTurnStale() { assert.equal(state.agentMessageTextByTurn?.size, 0); }, resolveTurnInterrupted() {}, turnInterrupt: async () => {} }
  };
  if (kind === "prompt") await interruptPromptTurn.call(server, { threadId: "root", turnId: "turn" }, "Close");
  else await interruptSessionTurn.call(server, state, "Close", true);
  assert.equal(await h.createTextEvent(event("queued delta")), null);
  assert.equal(await h.completeItemEvent(event("queued completion")), null);
});