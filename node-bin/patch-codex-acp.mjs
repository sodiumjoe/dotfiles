import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const originalHash = "afffcfeb6ae3a82f2b359a7d3d6a1a3ceee43898b59c34335eb1760974cc4ff8";
const overlapHash = "c3f5b9212df7962fc7f95ccffe05841f31a9ca22d625cf5cf6c304d8bf9ffd78";
const lateStartHash = "a792e8776fa77b4157ce5ee984b9b4027b25158da573554a7531044fa72c7ba1";
const completedTextHash = "3f4ee4031599a2342a32f23b2e54f0b7fdb0dc09b4cb047cecbf242e37c34367";
const patchedHash = "f52d7ed4d2bbd2e3749f48b6d9a2187df9d52d9c20ebde50e94a5f02c2b798d0";
const replacements = [
  [
    `      threadResolvers.set(turnId, resolve);`,
    `      const resolvers = threadResolvers.get(turnId) ?? new Set();
      resolvers.add(resolve);
      threadResolvers.set(turnId, resolvers);`
  ],
  [
    `    const resolve = threadResolvers?.get(event.turn.id);
    if (resolve) {
      threadResolvers.delete(event.turn.id);
      if (threadResolvers.size === 0) {
        this.pendingTurnCompletionResolvers.delete(event.threadId);
      }
      resolve(event);
      return;
    }`,
    `    const resolvers = threadResolvers?.get(event.turn.id);
    if (resolvers) {
      threadResolvers.delete(event.turn.id);
      if (threadResolvers.size === 0) {
        this.pendingTurnCompletionResolvers.delete(event.threadId);
      }
      for (const resolve of resolvers) resolve(event);
    }`
  ],
  [
    `  async getInterruptibleTurnId(sessionState, requestName) {
    if (sessionState.currentTurnId) {
      return sessionState.currentTurnId;
    }
    const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
    if (!pendingTurnStart) {
      logger.log(\`\${requestName} request rejected: no current turn\`, { sessionId: sessionState.sessionId });
      return null;
    }
    if (requestName === "Close") {
      pendingTurnStart.resolve(null);
      return null;
    }
    const turnId = await pendingTurnStart.promise;
    if (!turnId) {
      logger.log(\`\${requestName} request rejected: no current turn\`, { sessionId: sessionState.sessionId });
    }
    return turnId;
  }
`,
    `  async getInterruptibleTurnId(sessionState, requestName) {
    const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
    if (requestName !== "Close" && pendingTurnStart) {
      const turnId = await pendingTurnStart.promise;
      if (turnId) return turnId;
    }
    if (sessionState.currentTurnId) {
      return sessionState.currentTurnId;
    }
    if (requestName === "Close") {
      pendingTurnStart?.resolve(null);
    }
    logger.log(\`\${requestName} request rejected: no current turn\`, { sessionId: sessionState.sessionId });
    return null;
  }
`
  ],
  [
    `    sessionState.currentTurnId = null;
    sessionState.lastTokenUsage = null;
    const activePrompt = this.trackActivePrompt(params.sessionId);`,
    `    sessionState.lastTokenUsage = null;
    const activePrompt = this.trackActivePrompt(params.sessionId);`
  ],
  [
    `      sessionState.currentTurnId = null;
      const registeredPendingTurnStart = this.pendingTurnStarts.get(params.sessionId);
      if (registeredPendingTurnStart !== void 0) {
        this.pendingTurnStarts.delete(params.sessionId);
        registeredPendingTurnStart.resolve(null);
      }`,
    `      if (sessionState.currentTurnId === activePrompt.currentTurn?.turnId) {
        sessionState.currentTurnId = null;
      }
      if (this.pendingTurnStarts.get(params.sessionId) === pendingTurnStart) {
        this.pendingTurnStarts.delete(params.sessionId);
      }
      pendingTurnStart?.resolve(null);`
  ],
  [
    `        this.clearPlanTurnState();
        this.sessionState.currentTurnId = null;
        return null;`,
    `        this.clearPlanTurnState();
        if (this.sessionState.currentTurnId === notification.params.turn.id) {
          this.sessionState.currentTurnId = null;
        }
        return null;`
  ]
];

const lateStartReplacements = [
  [
    `          activePrompt.currentTurn = turn;
          if (this.promptShouldStop(params.sessionId, activePrompt)) {
            this.interruptLateStartedTurn(turn);
            return;
          }
          sessionState.currentTurnId = turnId;`,
    `          activePrompt.currentTurn = turn;
          if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId) || this.sessions.get(params.sessionId) !== sessionState) {
            this.interruptLateStartedTurn(turn);
            return;
          }
          if (this.activePrompts.get(params.sessionId) === activePrompt || sessionState.currentTurnId === null) {
            sessionState.currentTurnId = turnId;
          }`
  ],
  [
    `            activePrompt.currentTurn = turn;
            if (this.promptShouldStop(params.sessionId, activePrompt)) {
              this.interruptLateStartedTurn(turn);
              return;
            }
            sessionState.currentTurnId = turnId;`,
    `            activePrompt.currentTurn = turn;
            if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId) || this.sessions.get(params.sessionId) !== sessionState) {
              this.interruptLateStartedTurn(turn);
              return;
            }
            if (this.activePrompts.get(params.sessionId) === activePrompt || sessionState.currentTurnId === null) {
              sessionState.currentTurnId = turnId;
            }`
  ],
  [
    `                activePrompt.currentTurn = turn;
                if (this.promptShouldStop(params.sessionId, activePrompt)) {
                  this.interruptLateStartedTurn(turn);
                  return;
                }
                sessionState.currentTurnId = turnId;`,
    `                activePrompt.currentTurn = turn;
                if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId) || this.sessions.get(params.sessionId) !== sessionState) {
                  this.interruptLateStartedTurn(turn);
                  return;
                }
                if (this.activePrompts.get(params.sessionId) === activePrompt || sessionState.currentTurnId === null) {
                  sessionState.currentTurnId = turnId;
                }`
  ],
  [
    `          sessionState.currentTurnId = null;
          const implementationPromise`,
    `          sessionState.currentTurnId = null;
          pendingTurnStart = null;
          ensurePendingTurnStart();
          const implementationPromise`
  ],
  [
    `                recoverableSessionFailure = sessionState.sessionFailure;
                promptNotificationsActive = true;`,
    `                pendingTurnStart?.resolve(turnId);
                recoverableSessionFailure = sessionState.sessionFailure;
                promptNotificationsActive = true;`
  ]
];

const completedTextReplacements = [
  [
    `var CodexEventHandler = class _CodexEventHandler {`,
    `function completeAgentMessageTurn(sessionState, threadId, turnId) {
  if (!sessionState || sessionState.agentMessageTextClosed) return;
  const key = JSON.stringify([threadId, turnId]);
  sessionState.agentMessageTextByTurn?.delete(key);
  const completed = sessionState.completedAgentMessageTurns ??= new Set();
  completed.add(key);
  if (completed.size > 64) completed.delete(completed.values().next().value);
}
var CodexEventHandler = class _CodexEventHandler {`
  ],
  [
    `  async handleNotification(notification) {
    await this.flushPendingErrors();`,
    `  async handleNotification(notification) {
    if (notification.method === "turn/completed") {
      completeAgentMessageTurn(this.sessionState, notification.params.threadId, notification.params.turn.id);
    }
    await this.flushPendingErrors();`
  ],
  [
    `  async createTextEvent(event) {
    const phase = this.agentMessagePhases.get(event.itemId) ?? null;
    return createAgentTextMessageChunk(event.delta, event.itemId, createCodexMessagePhaseMeta(phase));
  }
`,
    `  agentMessageItems(event) {
    if (this.sessionState.agentMessageTextClosed) return null;
    const key = JSON.stringify([event.threadId, event.turnId]);
    if (this.sessionState.completedAgentMessageTurns?.has(key)) return null;
    const turns = this.sessionState.agentMessageTextByTurn ??= new Map();
    let items = turns.get(key);
    if (!items) {
      items = new Map();
      turns.set(key, items);
    }
    return items;
  }
  async createTextEvent(event) {
    const items = this.agentMessageItems(event);
    if (!items || items.get(event.itemId) === null) return null;
    items.set(event.itemId, (items.get(event.itemId) ?? "") + event.delta);
    const phase = this.agentMessagePhases.get(event.itemId) ?? null;
    return createAgentTextMessageChunk(event.delta, event.itemId, createCodexMessagePhaseMeta(phase));
  }
`
  ],
  [
    `      case "agentMessage":
        this.rememberAgentMessagePhase(event.item);
        return null;
      case "plan": {`,
    `      case "agentMessage": {
        this.rememberAgentMessagePhase(event.item);
        const items = this.agentMessageItems(event);
        if (!items || items.get(event.item.id) === null) return null;
        const streamed = items.get(event.item.id) ?? "";
        items.set(event.item.id, null);
        if (!event.item.text.startsWith(streamed)) {
          logger.log("Completed agent message diverged", { threadId: event.threadId, turnId: event.turnId, itemId: event.item.id, streamedLength: streamed.length, completedLength: event.item.text.length });
          return null;
        }
        const suffix = event.item.text.slice(streamed.length);
        return suffix.length > 0 ? createAgentTextMessageChunk(suffix, event.item.id, createCodexMessagePhaseMeta(event.item.phase)) : null;
      }
      case "plan": {`
  ],
  [
    `  async interruptPromptTurn(turn, requestName) {
    this.codexAcpClient.markTurnStale({`,
    `  async interruptPromptTurn(turn, requestName) {
    completeAgentMessageTurn(this.sessions.get(turn.threadId), turn.threadId, turn.turnId);
    this.codexAcpClient.markTurnStale({`
  ],
  [
    `    if (resolveInterruptedTurn) {
      this.codexAcpClient.markTurnStale({`,
    `    if (resolveInterruptedTurn) {
      completeAgentMessageTurn(sessionState, sessionState.sessionId, turnId);
      this.codexAcpClient.markTurnStale({`
  ],
  [
    `    } finally {
      if (this.getSessionGeneration(params.sessionId) === closeGeneration) {`,
    `    } finally {
      if (sessionState) {
        sessionState.agentMessageTextClosed = true;
        sessionState.agentMessageTextByTurn?.clear();
        sessionState.completedAgentMessageTurns?.clear();
      }
      if (this.getSessionGeneration(params.sessionId) === closeGeneration) {`
  ]
];

const historyReplacements = [
  [
    `function mergeHistoryUpdates(responseItemFallbackUpdates, threadUpdates) {
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  let fallbackIndex = 0;`,
    `function mergeHistoryUpdates(responseItemFallbackUpdates, threadUpdates) {
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  let fallbackIndex = 0;
  const keyIndices = new Map(), contentIndices = new Map();
  const addIndex = (map, key, index) => {
    if (key === null) return;
    const indices = map.get(key) ?? [];
    indices.push(index);
    map.set(key, indices);
  };
  responseItemFallbackUpdates.forEach((update, index) => {
    addIndex(keyIndices, historyUpdateKey(update), index);
    addIndex(contentIndices, historyUpdateContentKey(update), index);
  });
  const nextIndex = (map, key) => {
    const indices = map.get(key) ?? [];
    let low = 0, high = indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indices[middle] < fallbackIndex) low = middle + 1;
      else high = middle;
    }
    return indices[low] ?? Infinity;
  };`
  ],
  [
    `    const matchIndex = responseItemFallbackUpdates.findIndex((update, index) => index >= fallbackIndex && (targetKey !== null && historyUpdateKey(update) === targetKey || targetContentKey !== null && historyUpdateContentKey(update) === targetContentKey));
    if (matchIndex === -1) {`,
    `    const matchIndex = Math.min(nextIndex(keyIndices, targetKey), nextIndex(contentIndices, targetContentKey));
    if (matchIndex === Infinity) {`
  ]
];

export async function patchCodexAcp(packageRoot = fileURLToPath(new URL("node_modules/@agentclientprotocol/codex-acp/", import.meta.url))) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "@agentclientprotocol/codex-acp" || metadata.version !== "1.7.0") {
    throw new Error("Unsupported codex-acp package: expected @agentclientprotocol/codex-acp 1.7.0");
  }
  const bundle = path.join(packageRoot, "dist/index.js");
  const source = await readFile(bundle, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash === patchedHash) return;
  if (hash !== originalHash && hash !== overlapHash && hash !== lateStartHash && hash !== completedTextHash) throw new Error("Unsupported codex-acp source: expected pristine 1.7.0 or an exact supported patch");
  let patched = source;
  for (const [before, after] of [...(hash === originalHash ? replacements : []), ...([originalHash, overlapHash].includes(hash) ? lateStartReplacements : []), ...(hash !== completedTextHash ? completedTextReplacements : []), ...historyReplacements]) {
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