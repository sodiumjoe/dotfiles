import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const bin = path.join(packageRoot, "node_modules/.bin/codex-acp");
const relay = fileURLToPath(new URL("fixtures/codex-app-server.mjs", import.meta.url));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(read, description, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await tick();
  }
  throw new Error("Timeout: " + description);
}
async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timeout: " + description)), 3000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const turn = (status = "inProgress", id = "shared-turn") => ({ id, items: [], itemsView: "notLoaded", status, error: null, startedAt: null, completedAt: null, durationMs: null });

async function peer(t, { agency = false, load = false, holdUnsubscribe = false, holdInterrupt = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acp-overlap-"));
  const socketPath = path.join(root, "native.sock");
  let native, child, relayPid, connection, wire, stderr = "", nextId = 0, active = null, barrierId = 100;
  const nativeRequests = [], outbound = [], inbound = [], updates = [], deferred = new Map();
  const server = net.createServer(socket => {
    assert.equal(native, undefined);
    native = socket;
    createInterface({ input: socket }).on("line", line => {
      const message = JSON.parse(line);
      if (message.fixturePid) { relayPid = message.fixturePid; return; }
      nativeRequests.push(message);
      if (!Object.hasOwn(message, "id")) return;
      if (["turn/start", "review/start"].includes(message.method) || holdUnsubscribe && message.method === "thread/unsubscribe") return;
      let result;
      switch (message.method) {
        case "initialize": result = { userAgent: "fake-app-server", platformFamily: "unix", platformOs: "darwin" }; break;
        case "account/read": result = { account: null, requiresOpenaiAuth: false }; break;
        case "config/read": result = { config: {}, origins: {}, layers: [] }; break;
        case "model/list": result = { data: [{ id: "model-a", model: "model-a", displayName: "Fixture", description: "Fixture", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high", inputModalities: ["text"], supportsPersonality: false }], nextCursor: null }; break;
        case "thread/start":
        case "thread/resume": result = { thread: thread(), model: "model-a", modelProvider: "openai", reasoningEffort: "high", serviceTier: null }; break;
        case "thread/read": result = { thread: thread() }; break;
        case "skills/list": result = { data: [] }; break;
        case "mcpServerStatus/list": result = { data: [], nextCursor: null }; break;
        case "thread/goal/get": result = { goal: null }; break;
        case "turn/interrupt": reply(message, {}); if (!holdInterrupt) complete("interrupted", message.params.turnId); return;
        default: result = {};
      }
      reply(message, result);
    });
  });
  const thread = () => ({ id: "fixture-session", sessionId: "fixture-session", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 100, updatedAt: 100, status: { type: "idle" }, path: null, cwd: root, cliVersion: "fixture", source: "cli", agentNickname: null, agentRole: null, gitInfo: null, name: "Fixture", turns: [] });
  const sendNative = message => native.write(JSON.stringify(message) + "\n");
  const reply = (request, result) => sendNative({ id: request.id, result });
  function complete(status = "completed", id = active) {
    assert.ok(id, "native turn is active");
    sendNative({ method: "turn/completed", params: { threadId: "fixture-session", turn: turn(status, id) } });
    if (id === active) active = null;
  }
  t.after(async () => {
    connection?.close();
    wire?.end();
    child?.stdin.end();
    const errors = [];
    const observe = async action => {
      try { await action(); } catch (error) { errors.push(error.message); }
    };
    await observe(async () => {
      if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "provider exit", 4500);
    });
    native?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await observe(() => until(() => child.exitCode !== null || child.signalCode !== null, "provider exit after kill"));
    }
    await observe(async () => {
      if (child) await until(() => child.stdout.destroyed && child.stderr.destroyed, "provider stdio close");
    });
    await observe(async () => {
      if (child && !relayPid) throw new Error("missing owned relay identity");
      if (relayPid) await until(() => {
        try { process.kill(relayPid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
      }, "relay absence");
    });
    await observe(async () => {
      if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), "server close");
    });
    await rm(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ providerPid: child?.pid, relayPid, providerExit: child?.exitCode, providerSignal: child?.signalCode, stdioClosed: child?.stdout.destroyed && child?.stderr.destroyed, socketClosed: native?.destroyed, errors }));
    assert.deepEqual(errors, [], "cleanup errors");
  });
  server.listen(socketPath);
  await once(server, "listening");
  const env = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: root, CODEX_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, CODEX_PATH: relay, AGENCY_FAKE_CODEX_SOCKET: socketPath, APP_SERVER_LOGS: root };
  child = spawn(bin, [], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", error => { stderr += String(error); });
  child.stderr.on("data", bytes => { stderr += bytes; });
  wire = new PassThrough();
  wire.pipe(child.stdin);
  createInterface({ input: wire }).on("line", line => outbound.push(JSON.parse(line)));
  createInterface({ input: child.stdout }).on("line", line => {
    const frame = JSON.parse(line); inbound.push(frame);
    if (Object.hasOwn(frame, "id")) {
      const pending = deferred.get(frame.id);
      if (pending) { deferred.delete(frame.id); frame.error ? pending.reject(frame.error) : pending.resolve(frame.result); }
    }
  });
  const emit = (method, params, id) => {
    const frame = { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params };
    wire.write(JSON.stringify(frame) + "\n");
  };
  let request, notify;
  if (agency) {
    const { createAcpConnection } = await import("../../agency/dist/src/agent/acp.js");
    const { normalizeAgentRecord, AGENT_LIMITS } = await import("../../agency/dist/src/agent/types.js");
    const { sampleAgent, sampleContract } = await import("../../agency/dist/test/agent-support.js");
    const record = normalizeAgentRecord(sampleAgent()); record.definition.cwd = root; record.settings = {};
    connection = createAcpConnection({ readable: child.stdout, writable: wire, limits: AGENT_LIMITS, onUpdate: update => updates.push(structuredClone(update)) });
    const result = await bounded(connection.initialize(record, sampleContract(), load ? { kind: "load", sessionId: "fixture-session", params: {} } : { kind: "new", params: {} }, new AbortController().signal), "Agency initialize");
    assert.equal(result.sessionId, "fixture-session");
    request = (method, params) => connection.request(method, params);
    notify = (method, params) => connection.notify(method, params);
  } else {
    request = (method, params) => {
      const id = ++nextId;
      const result = Promise.withResolvers(); deferred.set(id, result);
      result.promise.catch(() => {}); emit(method, params, id);
      return result.promise;
    };
    notify = (method, params) => emit(method, params);
    assert.equal((await bounded(request("initialize", { protocolVersion: 1, clientCapabilities: {} }), "ACP initialize")).protocolVersion, 1);
    const opened = await bounded(request(load ? "session/load" : "session/new", { cwd: root, mcpServers: [], ...(load ? { sessionId: "fixture-session" } : {}) }), "ACP session");
    if (!load) assert.equal(opened.sessionId, "fixture-session");
  }
  const starts = () => nativeRequests.filter(frame => frame.method === "turn/start");
  return {
    nativeRequests, outbound, inbound, updates, starts, request, notify, complete, sendNative, reply, root,
    async log() { return await readFile(path.join(root, "app-server.log"), "utf8"); },
    text(delta, itemId = "message", turnId = active) {
      sendNative({ method: "item/agentMessage/delta", params: { threadId: "fixture-session", turnId, itemId, delta } });
    },
    completedText(text, itemId = "message", turnId = active) {
      sendNative({ method: "item/completed", params: { threadId: "fixture-session", turnId, item: { type: "agentMessage", id: itemId, text, phase: "final_answer" } } });
    },
    assertReplies() {
      const ids = outbound.filter(frame => frame.method && Object.hasOwn(frame, "id")).map(frame => frame.id);
      assert.deepEqual(inbound.filter(frame => !frame.method && Object.hasOwn(frame, "id")).map(frame => frame.id).sort(), ids.sort());
    },
    async barrier(turnId = active) {
      const count = ++barrierId;
      const counts = { totalTokens: count, inputTokens: count, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
      sendNative({ method: "thread/tokenUsage/updated", params: { threadId: "fixture-session", turnId, tokenUsage: { last: counts, total: counts, modelContextWindow: 1000 } } });
      await until(() => inbound.some(frame => frame.params?.update?.sessionUpdate === "usage_update" && frame.params.update.used === count), "unique ACP processing barrier " + count);
    },
    async delta(marker, turnId = active) {
      sendNative({ method: "item/agentMessage/delta", params: { threadId: "fixture-session", turnId, itemId: marker, delta: marker } });
      await until(() => inbound.some(frame => frame.params?.update?.content?.text === marker), "ACP delta " + marker);
      if (agency) await until(() => updates.some(event => event.update?.content?.text === marker), "Agency delta " + marker);
    },
    async approvePlan() {
      const frame = await until(() => inbound.find(frame => frame.method === "session/request_permission"), "plan permission");
      wire.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: "implement_plan" } } }) + "\n");
    },
    async usage() {
      const counts = { totalTokens: 42, inputTokens: 30, cachedInputTokens: 5, outputTokens: 12, reasoningOutputTokens: 7 };
      sendNative({ method: "thread/tokenUsage/updated", params: { threadId: "fixture-session", turnId: active, tokenUsage: { last: counts, total: counts, modelContextWindow: 1000 } } });
      await until(() => inbound.some(frame => frame.params?.update?.sessionUpdate === "usage_update" && frame.params.update.used === 42), "ACP usage metadata");
    },
    prompt(text) { return request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text }] }); },
    async acknowledge(index, marker, { held = false, turnId = "shared-turn", method = "turn/start", markerDelta = true } = {}) {
      const requests = () => nativeRequests.filter(frame => frame.method === method);
      await until(() => requests()[index], "native turn/start " + index + " " + stderr);
      const frame = requests()[index]; active = turnId;
      if (held) return () => reply(frame, { turn: turn("inProgress", turnId), ...(method === "review/start" ? { reviewThreadId: "fixture-session" } : {}) });
      reply(frame, { turn: turn("inProgress", active), ...(method === "review/start" ? { reviewThreadId: "fixture-session" } : {}) });
      sendNative({ method: "turn/started", params: { threadId: "fixture-session", turn: turn("inProgress", active) } });
      if (!markerDelta) { await this.barrier(active); return; }
      sendNative({ method: "item/agentMessage/delta", params: { threadId: "fixture-session", turnId: active, itemId: marker, delta: marker } });
      await until(() => inbound.some(event => event.params?.update?.content?.text === marker), "ACP marker " + marker + " " + stderr);
    },
    rejectStart(index) { sendNative({ id: starts()[index].id, error: { code: -32001, message: "fixture turn rejected", data: { reason: "fixture" } } }); },
    async results(promises) {
      const values = new Map();
      promises.forEach((promise, i) => promise.then(value => values.set(i, value), error => values.set(i, { error })));
      await until(() => values.size === promises.length, "missing original ACP callbacks: " + promises.length + " expected");
      return promises.map((_, i) => values.get(i));
    },
  };
}

for (const agency of [false, true]) test("shared native turn completes every overlapping ACP request: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const promises = [];
  for (const marker of ["A", "B", "C"]) {
    promises.push(p.prompt(marker));
    await p.acknowledge(promises.length - 1, marker);
  }
  await p.usage();
  p.complete();
  const results = await p.results(promises);
  assert.deepEqual(results.map(result => result.stopReason), ["end_turn", "end_turn", "end_turn"]);
  for (const result of results) {
    assert.deepEqual(result.usage, { totalTokens: 42, inputTokens: 25, cachedReadTokens: 5, outputTokens: 12, thoughtTokens: 7 });
    assert.deepEqual(result._meta.quota.token_count, { totalTokens: 42, inputTokens: 25, cachedInputTokens: 5, outputTokens: 12, reasoningOutputTokens: 7 });
  }
  assert.deepEqual(p.starts().map(frame => frame.params.input[0].text), ["A", "B", "C"]);
  assert.equal(p.nativeRequests.some(frame => ["turn/interrupt", "turn/steer"].includes(frame.method)), false);
  assert.equal(p.outbound.some(frame => frame.method === "session/cancel"), false);
  p.assertReplies();
});

test("completion reaches a shared-turn request whose start response is still pending", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const first = p.prompt("first"); await p.acknowledge(0, "first");
  const second = p.prompt("second");
  const release = await p.acknowledge(1, "second", { held: true });
  p.complete();
  await p.results([first]);
  release();
  assert.deepEqual((await p.results([second])).map(value => value.stopReason), ["end_turn"]);
});

for (const agency of [false, true]) test("explicit cancellation settles shared requests and permits reuse: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const pending = [];
  for (const marker of ["cancel-A", "cancel-B", "cancel-C"]) {
    pending.push(p.prompt(marker)); await p.acknowledge(pending.length - 1, marker);
  }
  p.notify("session/cancel", { sessionId: "fixture-session" });
  assert.deepEqual((await p.results(pending)).map(value => value.stopReason), ["cancelled", "cancelled", "cancelled"]);
  assert.equal(p.nativeRequests.filter(frame => frame.method === "turn/interrupt").length, 1);
  const next = p.prompt("reuse"); await p.acknowledge(3, "reuse", { turnId: "reused-turn" });
  p.complete();
  assert.equal((await p.results([next]))[0].stopReason, "end_turn");
  p.assertReplies();
});

test("rapid overlapping starts preserve every original callback", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const first = p.prompt("rapid-A"); await p.acknowledge(0, "rapid-A");
  const second = p.prompt("rapid-B"), third = p.prompt("rapid-C");
  await until(() => p.starts().some(frame => frame.params.input[0].text === "rapid-C"), "latest rapid native start");
  const releases = [];
  for (let index = 1; index < p.starts().length; index++) releases.push(await p.acknowledge(index, "rapid", { held: true }));
  for (const release of releases) release();
  p.complete();
  const results = await p.results([first, second, third]);
  assert.ok(results.every(value => ["end_turn", "cancelled"].includes(value.stopReason)));
  const nativeInputs = p.starts().map(frame => frame.params.input[0].text);
  assert.equal(new Set(nativeInputs).size, nativeInputs.length);
  assert.ok(nativeInputs.includes("rapid-A") && nativeInputs.includes("rapid-C"));
  assert.deepEqual(p.outbound.filter(frame => frame.method === "session/prompt").map(frame => frame.params.prompt[0].text), ["rapid-A", "rapid-B", "rapid-C"]);
  t.diagnostic(JSON.stringify({ nativeInputs, stopReasons: results.map(value => value.stopReason) }));
  assert.equal(p.outbound.some(frame => frame.method === "session/cancel"), false);
  assert.equal(p.nativeRequests.some(frame => frame.method === "turn/steer"), false);
  p.assertReplies();
});

for (const agency of [false, true]) test("native start rejection preserves ACP error and other overlapping requests: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const first = p.prompt("first"); await p.acknowledge(0, "first");
  const rejected = p.prompt("reject");
  await until(() => p.starts()[1], "rejected native start");
  p.rejectStart(1);
  const [failure] = await p.results([rejected]);
  assert.deepEqual(agency ? failure.error.providerError : failure.error, { code: -32603, message: "Internal error", data: { details: "fixture turn rejected" } });
  const third = p.prompt("third"); await p.acknowledge(2, "third");
  p.complete();
  assert.deepEqual((await p.results([first, third])).map(value => value.stopReason), ["end_turn", "end_turn"]);
  p.assertReplies();
});

test("distinct native completions settle only their matching ACP requests", { timeout: 18000 }, async t => {
  const p = await peer(t);
  let firstSettled = false;
  const first = p.prompt("first").finally(() => { firstSettled = true; });
  await p.acknowledge(0, "first", { turnId: "first-turn" });
  const second = p.prompt("second"); await p.acknowledge(1, "second", { turnId: "second-turn" });
  p.complete();
  assert.equal((await p.results([second]))[0].stopReason, "end_turn");
  assert.equal(firstSettled, false);
  p.complete("completed", "first-turn");
  assert.equal((await p.results([first]))[0].stopReason, "end_turn");
  p.complete("completed", "first-turn");
  const next = p.prompt("after-duplicate"); await p.acknowledge(2, "after-duplicate", { turnId: "next-turn" });
  p.complete(); await p.results([next]);
  p.assertReplies();
});

for (const agency of [false, true]) test("load retains native session identity for overlapping requests: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency, load: true });
  const first = p.prompt("loaded-A"); await p.acknowledge(0, "loaded-A");
  const second = p.prompt("loaded-B"); await p.acknowledge(1, "loaded-B");
  p.complete();
  assert.deepEqual((await p.results([first, second])).map(value => value.stopReason), ["end_turn", "end_turn"]);
  assert.ok(p.nativeRequests.some(frame => frame.method === "thread/resume" && frame.params.threadId === "fixture-session"));
  assert.ok(p.starts().every(frame => frame.params.threadId === "fixture-session"));
  p.assertReplies();
});

for (const agency of [false, true]) test("cancel retains the active native target after overlapping start rejection: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const first = p.prompt("active"); await p.acknowledge(0, "active");
  const rejected = p.prompt("reject");
  await until(() => p.starts()[1], "rejected native start"); p.rejectStart(1);
  const failure = (await p.results([rejected]))[0].error;
  assert.equal(agency ? failure.providerCode : failure.code, -32603);
  p.notify("session/cancel", { sessionId: "fixture-session" });
  assert.equal((await p.results([first]))[0].stopReason, "cancelled");
  assert.equal(p.nativeRequests.filter(frame => frame.method === "turn/interrupt").length, 1);
  const next = p.prompt("reuse"); await p.acknowledge(2, "reuse", { turnId: "reused-turn" });
  p.complete(); assert.equal((await p.results([next]))[0].stopReason, "end_turn");
  p.assertReplies();
});

for (const outcome of ["start", "reject", "older-completes"]) test("cancel during pending start retains ownership: " + outcome, { timeout: 18000 }, async t => {
  const p = await peer(t);
  const first = p.prompt("active"); await p.acknowledge(0, "active", { turnId: "first-turn" });
  const second = p.prompt("pending");
  const release = await p.acknowledge(1, "pending", { held: true, turnId: outcome === "older-completes" ? "second-turn" : "first-turn" });
  if (outcome === "older-completes") {
    p.complete("completed", "first-turn");
    assert.equal((await p.results([first]))[0].stopReason, "end_turn");
  }
  p.notify("session/cancel", { sessionId: "fixture-session" });
  await bounded(p.request("session/set_mode", { sessionId: "fixture-session", modeId: "agent-full-access" }), "ACP barrier after pending cancel");
  if (outcome === "reject") p.rejectStart(1); else release();
  const results = await p.results([first, second]);
  assert.equal(results[0].stopReason, outcome === "older-completes" ? "end_turn" : "cancelled");
  if (outcome === "reject") assert.equal(results[1].error.code, -32603);
  else assert.equal(results[1].stopReason, "cancelled");
  assert.equal(p.nativeRequests.filter(frame => frame.method === "turn/interrupt").length, 1);
  const next = p.prompt("reuse"); await p.acknowledge(2, "reuse", { turnId: "reused-turn" });
  p.complete(); assert.equal((await p.results([next]))[0].stopReason, "end_turn");
  p.assertReplies();
});

test("older completion preserves the newer native cancellation target", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const first = p.prompt("older"); await p.acknowledge(0, "older", { turnId: "first-turn" });
  const second = p.prompt("newer"); await p.acknowledge(1, "newer", { turnId: "second-turn" });
  p.complete("completed", "first-turn");
  assert.equal((await p.results([first]))[0].stopReason, "end_turn");
  p.notify("session/cancel", { sessionId: "fixture-session" });
  assert.equal((await p.results([second]))[0].stopReason, "cancelled");
  assert.deepEqual(p.nativeRequests.filter(frame => frame.method === "turn/interrupt").map(frame => frame.params.turnId), ["second-turn"]);
  p.assertReplies();
});

for (const agency of [false, true]) test("late admitted shared start preserves deltas and every callback: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const a = p.prompt("A"); const release = await p.acknowledge(0, "A", { held: true });
  const b = p.prompt("B"); await p.acknowledge(1, "B");
  const c = p.prompt("C"); await p.acknowledge(2, "C");
  release(); await p.barrier();
  await p.delta("after-late-start"); p.complete();
  assert.deepEqual((await p.results([a, b, c])).map(x => x.stopReason), ["end_turn", "end_turn", "end_turn"]);
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt"), []);
  p.assertReplies();
});

for (const kind of ["prompt", "review", "implementation"]) test("late " + kind + " acknowledgement preserves newer distinct cancellation target", { timeout: 18000 }, async t => {
  const p = await peer(t);
  if (kind === "implementation") await bounded(p.request("session/set_config_option", { sessionId: "fixture-session", configId: "collaboration_mode", value: "plan" }), "plan mode");
  const a = p.prompt(kind === "review" ? "/review" : "older");
  let index = 0;
  if (kind === "implementation") {
    await p.acknowledge(0, "plan", { turnId: "plan-turn" });
    p.sendNative({ method: "item/completed", params: { threadId: "fixture-session", turnId: "plan-turn", item: { id: "plan-item", type: "plan", text: "Controlled plan" } } });
    p.complete("completed", "plan-turn"); await p.approvePlan(); index = 1;
  }
  const release = await p.acknowledge(index, "older", { held: true, turnId: "older-turn", method: kind === "review" ? "review/start" : "turn/start" });
  p.sendNative({ method: "turn/started", params: { threadId: "fixture-session", turn: turn("inProgress", "older-turn") } });
  await p.barrier("older-turn");
  const b = p.prompt("newer"); await p.acknowledge(kind === "review" ? 0 : index + 1, "newer", { turnId: "newer-turn" });
  release(); await p.barrier("newer-turn");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt"), []);
  p.notify("session/cancel", { sessionId: "fixture-session" });
  assert.equal((await p.results([b]))[0].stopReason, "cancelled");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt").map(x => x.params.turnId), ["newer-turn"]);
  p.complete("completed", "older-turn"); assert.equal((await p.results([a]))[0].stopReason, "end_turn");
  p.assertReplies();
});

for (const outcome of ["reject", "complete"]) test("older late start becomes target after newer " + outcome, { timeout: 18000 }, async t => {
  const p = await peer(t);
  const a = p.prompt("older"); const release = await p.acknowledge(0, "older", { held: true, turnId: "older-turn" });
  const b = p.prompt("newer");
  if (outcome === "reject") { await until(() => p.starts()[1], "rejected newer start"); p.rejectStart(1); }
  else { await p.acknowledge(1, "newer", { turnId: "newer-turn" }); p.complete("completed", "newer-turn"); }
  await p.results([b]); release(); await p.barrier("older-turn");
  p.notify("session/cancel", { sessionId: "fixture-session" });
  assert.equal((await p.results([a]))[0].stopReason, "cancelled");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt").map(x => x.params.turnId), ["older-turn"]);
  p.assertReplies();
});

test("single-target cancellation has no fallback after newer distinct turn completes", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const a = p.prompt("older"); const release = await p.acknowledge(0, "older", { held: true, turnId: "older-turn" });
  const b = p.prompt("newer"); await p.acknowledge(1, "newer", { turnId: "newer-turn" });
  release(); await p.barrier("newer-turn");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt"), []);
  p.complete("completed", "newer-turn"); await p.results([b]);
  p.notify("session/cancel", { sessionId: "fixture-session" }); await p.barrier("older-turn");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt"), []);
  p.complete("completed", "older-turn"); assert.equal((await p.results([a]))[0].stopReason, "end_turn");
  p.assertReplies();
});

for (const afterClose of [false, true]) test("older admitted start is interrupted " + (afterClose ? "after close returns" : "during close"), { timeout: 18000 }, async t => {
  const p = await peer(t, { holdUnsubscribe: !afterClose });
  const a = p.prompt("older"); const release = await p.acknowledge(0, "older", { held: true, turnId: "older-turn" });
  const b = p.prompt("newer"); const releaseB = await p.acknowledge(1, "newer", { held: true, turnId: "newer-turn" });
  const closing = p.request("session/close", { sessionId: "fixture-session" });
  const unsubscribe = await until(() => p.nativeRequests.find(x => x.method === "thread/unsubscribe"), "close unsubscribe");
  if (afterClose) await bounded(closing, "session closed");
  release(); releaseB();
  await until(() => p.nativeRequests.filter(x => x.method === "turn/interrupt").length === 2, "late close interrupts");
  if (!afterClose) { p.reply(unsubscribe, {}); await bounded(closing, "session closed"); }
  assert.deepEqual((await p.results([a, b])).map(x => x.stopReason), ["cancelled", "cancelled"]);
  p.assertReplies();
});

test("cancel during pending approved implementation targets implementation turn", { timeout: 18000 }, async t => {
  const p = await peer(t);
  await bounded(p.request("session/set_config_option", { sessionId: "fixture-session", configId: "collaboration_mode", value: "plan" }), "plan mode");
  const a = p.prompt("plan then implement"); await p.acknowledge(0, "plan", { turnId: "plan-turn" });
  p.sendNative({ method: "item/completed", params: { threadId: "fixture-session", turnId: "plan-turn", item: { id: "plan-item", type: "plan", text: "Controlled plan" } } });
  p.complete("completed", "plan-turn"); await p.approvePlan();
  const release = await p.acknowledge(1, "implementation", { held: true, turnId: "implementation-turn" });
  p.notify("session/cancel", { sessionId: "fixture-session" });
  await bounded(p.request("session/set_mode", { sessionId: "fixture-session", modeId: "agent-full-access" }), "cancel admitted");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt"), []);
  release();
  assert.equal((await p.results([a]))[0].stopReason, "cancelled");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt").map(x => x.params.turnId), ["implementation-turn"]);
  p.assertReplies();
});

test("request abort still interrupts its late native start and permits reuse", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const a = p.prompt("abort pending"); const release = await p.acknowledge(0, "aborted", { held: true, turnId: "aborted-turn" });
  const requestId = p.outbound.find(x => x.method === "session/prompt").id;
  p.notify("$/cancel_request", { requestId });
  await p.results([a]);
  release();
  await until(() => p.nativeRequests.some(x => x.method === "turn/interrupt" && x.params.turnId === "aborted-turn"), "aborted late start interrupted");
  const next = p.prompt("reuse"); await p.acknowledge(1, "reuse", { turnId: "reuse-turn" });
  p.complete(); assert.equal((await p.results([next]))[0].stopReason, "end_turn");
  assert.deepEqual(p.nativeRequests.filter(x => x.method === "turn/interrupt").map(x => x.params.turnId), ["aborted-turn"]);
  p.assertReplies();
});

const assistantTexts = frames => frames.flatMap(frame => {
  const update = frame.params?.update ?? frame.update;
  return update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" ? [update.content.text] : [];
});

for (const agency of [false, true]) for (const scenario of [
  { name: "completed only", deltas: [], completed: "complete response", want: ["complete response"] },
  { name: "missing suffix", deltas: ["hello", " "], completed: "hello world", want: ["hello", " ", "world"] },
  { name: "identical", deltas: ["same"], completed: "same", want: ["same"] },
  { name: "divergent", deltas: ["streamed secret"], completed: "different secret", want: ["streamed secret"], divergent: true },
  { name: "empty completion", deltas: [], completed: "", want: [] },
  { name: "short completion", deltas: ["longer"], completed: "", want: ["longer"], divergent: true },
  { name: "unicode suffix", deltas: ["\ud83d\ude00"], completed: "\ud83d\ude00 suffix", want: ["\ud83d\ude00", " suffix"] },
  { name: "split surrogate", deltas: ["\ud83d"], completed: "\ud83d\ude00 suffix", want: ["\ud83d", "\ude00 suffix"] },
].filter(scenario => !agency || scenario.name !== "split surrogate")) test("completed text " + scenario.name + ": " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const pending = p.prompt("text case"); await p.acknowledge(0, "unused", { markerDelta: false });
  for (const delta of scenario.deltas) p.text(delta);
  p.completedText(scenario.completed);
  p.completedText(scenario.completed);
  p.text("late duplicate");
  await p.barrier();
  assert.deepEqual(assistantTexts(p.inbound), scenario.want);
  if (agency) assert.deepEqual(assistantTexts(p.updates), scenario.want);
  if (scenario.completed.startsWith(scenario.deltas.join("")) && scenario.completed.length > scenario.deltas.join("").length) {
    const fallback = p.inbound.filter(frame => frame.params?.update?.sessionUpdate === "agent_message_chunk").at(-1).params.update;
    assert.equal(fallback.messageId, "message");
    assert.deepEqual(fallback._meta, { codex: { phase: "final_answer" } });
  }
  const logs = (await p.log()).split("\n").filter(line => line.includes("Completed agent message diverged"));
  assert.equal(logs.length, scenario.divergent ? 1 : 0);
  if (scenario.divergent) {
    const context = JSON.parse(logs[0].slice(logs[0].indexOf("{")));
    assert.deepEqual({ ...context, pid: 0 }, { pid: 0, threadId: "fixture-session", turnId: "shared-turn", itemId: "message", streamedLength: scenario.deltas.join("").length, completedLength: scenario.completed.length });
    assert.ok(!logs[0].includes("secret"));
  }
  p.complete(); assert.equal((await p.results([pending]))[0].stopReason, "end_turn");
  p.completedText(scenario.completed, "message", "shared-turn"); p.text("post-terminal", "other", "shared-turn");
  await p.barrier("shared-turn");
  assert.deepEqual(assistantTexts(p.inbound), scenario.want);
  p.assertReplies();
});

for (const agency of [false, true]) test("completed text survives overlapping handler replacement: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency });
  const a = p.prompt("A"); await p.acknowledge(0, "unused", { markerDelta: false });
  p.text("prefix"); await p.barrier();
  const b = p.prompt("B"); await p.acknowledge(1, "unused", { markerDelta: false });
  p.completedText("prefix suffix"); p.completedText("second item", "second"); await p.barrier();
  assert.deepEqual(assistantTexts(p.inbound), ["prefix", " suffix", "second item"]);
  if (agency) assert.deepEqual(assistantTexts(p.updates), ["prefix", " suffix", "second item"]);
  p.complete(); assert.deepEqual((await p.results([a,b])).map(x => x.stopReason), ["end_turn", "end_turn"]);
  const c = p.prompt("C"); await p.acknowledge(2, "unused", { turnId: "another-turn", markerDelta: false });
  p.completedText("reused item"); await p.barrier(); p.complete(); await p.results([c]);
  assert.deepEqual(assistantTexts(p.inbound), ["prefix", " suffix", "second item", "reused item"]);
  p.assertReplies();
});

for (const agency of [false, true]) test("completed text suffix arrives after cancel acknowledgement: " + (agency ? "Agency" : "direct"), { timeout: 18000 }, async t => {
  const p = await peer(t, { agency, holdInterrupt: true });
  const a = p.prompt("cancel"); await p.acknowledge(0, "unused", { markerDelta: false });
  p.text("before cancel"); await p.barrier();
  p.notify("session/cancel", { sessionId: "fixture-session" });
  await until(() => p.nativeRequests.some(x => x.method === "turn/interrupt"), "cancel interrupt acknowledged");
  await p.barrier(); p.completedText("before cancel final"); await p.barrier();
  assert.deepEqual(assistantTexts(p.inbound), ["before cancel", " final"]);
  if (agency) assert.deepEqual(assistantTexts(p.updates), ["before cancel", " final"]);
  p.complete("interrupted"); assert.equal((await p.results([a]))[0].stopReason, "cancelled");
  const b = p.prompt("reuse"); await p.acknowledge(1, "unused", { turnId: "reuse", markerDelta: false });
  p.completedText("fresh"); await p.barrier(); p.complete(); await p.results([b]);
  assert.deepEqual(assistantTexts(p.inbound), ["before cancel", " final", "fresh"]);
  p.assertReplies();
});

test("completed text starts fresh after close and load", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const a = p.prompt("close"); await p.acknowledge(0, "unused", { markerDelta: false });
  p.text("old"); await p.barrier();
  await bounded(p.request("session/close", { sessionId: "fixture-session" }), "close old text state"); await p.results([a]);
  await bounded(p.request("session/load", { sessionId: "fixture-session", cwd: p.root, mcpServers: [] }), "reload text session");
  const b = p.prompt("new"); await p.acknowledge(1, "unused", { turnId: "restored", markerDelta: false });
  p.completedText("new text"); await p.barrier(); p.complete(); await p.results([b]);
  assert.deepEqual(assistantTexts(p.inbound), ["old", "new text"]);
  p.assertReplies();
});