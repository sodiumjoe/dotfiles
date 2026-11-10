import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const originalHash = "733b7521c2a437a34ed016d45a6f46bebff2bac123a172467574ee827db98b99";
const patchedHash = "45a79a25de7579e188fbd1c018e92bc209a0cebba1668b2e0df0224c14ace691";
const replacements = [
  [
    `var CodexEventHandler = class {`,
    `function completeAgentMessageTurn(sessionState, threadId, turnId) {
  if (!sessionState || sessionState.agentMessageTextClosed) return;
  const key = JSON.stringify([threadId, turnId]);
  sessionState.agentMessageTextByTurn?.delete(key);
  const completed = sessionState.completedAgentMessageTurns ??= new Set();
  completed.add(key);
}
var CodexEventHandler = class {`
  ],
  [
    `  async handleNotification(notification) {
    const threadId = notification.params.threadId;`,
    `  async handleNotification(notification) {
    if (notification.method === "turn/completed" && notification.params.turn.status !== "inProgress") {
      completeAgentMessageTurn(this.sessionState, notification.params.threadId, notification.params.turn.id);
    }
    const threadId = notification.params.threadId;`
  ],
  [
    `  async createTextEvent(event) {
    const streams = this.streamsFor(event.threadId);
    let citations = streams.agentMessageCitations.get(event.itemId);
    if (citations === void 0) {
      citations = new FileCitationStream(this.sessionState.cwd);
      streams.agentMessageCitations.set(event.itemId, citations);
    }
    return this.createAgentMessageText(citations.push(event.delta), event.itemId, event.threadId);
  }
  /**
   * Sends the text a file citation held back, once the message is complete. A message that
   * arrives whole, without deltas (an async question, for one), is sent in full.
   */
  flushAgentMessageText(item, threadId) {
    const streams = this.streamsFor(threadId);
    const citations = streams.agentMessageCitations.get(item.id);
    streams.agentMessageCitations.delete(item.id);
    const text = citations ? citations.flush() : renderFileCitations(item.text, this.sessionState.cwd);
    return this.createAgentMessageText(text, item.id, threadId);
  }
`,
    `  agentMessageItems(threadId, turnId) {
    if (this.sessionState.agentMessageTextClosed) return null;
    const key = JSON.stringify([threadId, turnId]);
    if (this.sessionState.completedAgentMessageTurns?.has(key)) return null;
    const turns = this.sessionState.agentMessageTextByTurn ??= new Map();
    let items = turns.get(key);
    if (!items) { items = new Map(); turns.set(key, items); }
    return items;
  }
  async createTextEvent(event) {
    const items = this.agentMessageItems(event.threadId, event.turnId);
    if (!items) return null;
    let state = items.get(event.itemId);
    if (!state) {
      state = { text: "", done: false, citations: new FileCitationStream(this.sessionState.cwd) };
      items.set(event.itemId, state);
    }
    if (state.done) return null;
    state.text += event.delta;
    return this.createAgentMessageText(state.citations.push(event.delta), event.itemId, event.threadId);
  }
  flushAgentMessageText(item, threadId, turnId) {
    const items = this.agentMessageItems(threadId, turnId);
    if (!items) return null;
    const state = items.get(item.id);
    if (state?.done) return null;
    if (!state) {
      items.set(item.id, { text: "", done: true });
      return this.createAgentMessageText(renderFileCitations(item.text, this.sessionState.cwd), item.id, threadId);
    }
    state.done = true;
    const suffix = item.text.startsWith(state.text) ? item.text.slice(state.text.length) : "";
    const text = state.citations.push(suffix) + state.citations.flush();
    state.text = "";
    state.citations = null;
    return this.createAgentMessageText(text, item.id, threadId);
  }
`
  ],
  [
    `return this.flushAgentMessageText(event.item, event.threadId);`,
    `return this.flushAgentMessageText(event.item, event.threadId, event.turnId);`
  ],
  [
    `    const sessionState = this.sessions.get(params.sessionId);
    const childSessions = [`,
    `    const sessionState = this.sessions.get(params.sessionId);
    if (sessionState) {
      sessionState.agentMessageTextClosed = true;
      sessionState.agentMessageTextByTurn?.clear();
      sessionState.completedAgentMessageTurns?.clear();
    }
    const childSessions = [`
  ],
  [
    `  replayUpdate(update, initialized) {
    return this.v2Connection ?`,
    `  replayUpdate(update, initialized) {
    if (!this.v2Connection && ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate) && update.messageId !== void 0) {
      const key = JSON.stringify([update.sessionUpdate, update.messageId, update.content]);
      if (initialized.has(key)) return Promise.resolve();
      initialized.add(key);
    }
    return this.v2Connection ?`
  ]
];

export async function patchCodexAcp(packageRoot = fileURLToPath(new URL("node_modules/@agentclientprotocol/codex-acp/", import.meta.url))) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "@agentclientprotocol/codex-acp" || metadata.version !== "2.6.0") {
    throw new Error("Unsupported codex-acp package: expected @agentclientprotocol/codex-acp 2.6.0");
  }
  const bundle = path.join(packageRoot, "dist/index.js");
  const source = await readFile(bundle, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash === patchedHash) return;
  if (hash !== originalHash) throw new Error("Unsupported codex-acp source: expected pristine 2.6.0 or an exact supported patch");
  let patched = source;
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error("Unsupported codex-acp source: ambiguous patch");
    patched = patched.replace(before, after);
  }
  if (createHash("sha256").update(patched).digest("hex") !== patchedHash) throw new Error("Unsupported codex-acp source: unexpected patch result");
  const temporary = bundle + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, patched, { flag: "wx", mode: 0o600 });
    await chmod(temporary, (await stat(bundle)).mode & 0o777);
    await rename(temporary, bundle);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  await patchCodexAcp();
}