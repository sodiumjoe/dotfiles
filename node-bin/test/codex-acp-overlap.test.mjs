import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

async function peer(t, { agency = false, load = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acp-overlap-"));
  const socketPath = path.join(root, "native.sock");
  let native, child, relayPid, connection, wire, stderr = "", nextId = 0, active = null;
  const nativeRequests = [], outbound = [], inbound = [], deferred = new Map();
  const server = net.createServer(socket => {
    assert.equal(native, undefined);
    native = socket;
    createInterface({ input: socket }).on("line", line => {
      const message = JSON.parse(line);
      if (message.fixturePid) { relayPid = message.fixturePid; return; }
      nativeRequests.push(message);
      if (!Object.hasOwn(message, "id")) return;
      if (message.method === "turn/start") return;
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
        case "turn/interrupt": reply(message, {}); complete("interrupted", message.params.turnId); return;
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
    let cleanupError;
    try {
      if (child) {
        await until(() => child.exitCode !== null || child.signalCode !== null, "provider exit", 4500);
        await until(() => child.stdout.destroyed && child.stderr.destroyed, "provider stdio close");
      }
      if (relayPid) await until(() => {
        try { process.kill(relayPid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
      }, "relay absence");
    } catch (error) {
      cleanupError = error;
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); }
    } finally {
      native?.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
    t.diagnostic(JSON.stringify({ providerPid: child?.pid, relayPid, providerExit: child?.exitCode, providerSignal: child?.signalCode, stdioClosed: child?.stdout.destroyed && child?.stderr.destroyed, socketClosed: native?.destroyed }));
  });
  server.listen(socketPath);
  await once(server, "listening");
  const env = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: root, CODEX_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, CODEX_PATH: relay, AGENCY_FAKE_CODEX_SOCKET: socketPath };
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
    connection = createAcpConnection({ readable: child.stdout, writable: wire, limits: AGENT_LIMITS, onUpdate: () => {} });
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
    nativeRequests, outbound, inbound, starts, request, notify, complete,
    assertReplies() {
      const ids = outbound.filter(frame => Object.hasOwn(frame, "id")).map(frame => frame.id);
      assert.deepEqual(inbound.filter(frame => Object.hasOwn(frame, "id")).map(frame => frame.id).sort(), ids.sort());
    },
    async usage() {
      const counts = { totalTokens: 42, inputTokens: 30, cachedInputTokens: 5, outputTokens: 12, reasoningOutputTokens: 7 };
      sendNative({ method: "thread/tokenUsage/updated", params: { threadId: "fixture-session", turnId: active, tokenUsage: { last: counts, total: counts, modelContextWindow: 1000 } } });
      await until(() => inbound.some(frame => frame.params?.update?.sessionUpdate === "usage_update" && frame.params.update.used === 42), "ACP usage metadata");
    },
    prompt(text) { return request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text }] }); },
    async acknowledge(index, marker, { held = false, turnId = "shared-turn" } = {}) {
      await until(() => starts()[index], "native turn/start " + index + " " + stderr);
      const frame = starts()[index]; active = turnId;
      if (held) return () => reply(frame, { turn: turn("inProgress", turnId) });
      reply(frame, { turn: turn("inProgress", active) });
      sendNative({ method: "turn/started", params: { threadId: "fixture-session", turn: turn("inProgress", active) } });
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