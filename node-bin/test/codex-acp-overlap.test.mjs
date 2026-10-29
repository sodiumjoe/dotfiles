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
const adapterPackage = process.env.AGENCY_CODEX_ACP_FIXTURE_PACKAGE ??
  path.join(packageRoot, "node_modules/@agentclientprotocol/codex-acp");
const adapterEntry = path.join(adapterPackage, "dist/index.js");
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

async function peer(t) {
  assert.equal(JSON.parse(await readFile(path.join(adapterPackage, "package.json"), "utf8")).version, "1.7.0");
  const root = await mkdtemp(path.join(tmpdir(), "acp-overlap-"));
  const socketPath = path.join(root, "native.sock");
  let native, child, relayPid, wire, stderr = "", nextId = 0, active = null;
  const nativeRequests = [], outbound = [], inbound = [], deferred = new Map();
  const server = net.createServer(socket => {
    assert.equal(native, undefined);
    native = socket;
    createInterface({ input: socket }).on("line", line => {
      const message = JSON.parse(line);
      if (message.fixturePid) { relayPid = message.fixturePid; return; }
      nativeRequests.push(message);
      if (!Object.hasOwn(message, "id")) return;
      if (["turn/start", "review/start"].includes(message.method)) return;
      let result;
      switch (message.method) {
        case "initialize": result = { userAgent: "fake-app-server", platformFamily: "unix", platformOs: "darwin" }; break;
        case "account/read": result = { account: null, requiresOpenaiAuth: false }; break;
        case "config/read": result = { config: {}, origins: {}, layers: [] }; break;
        case "model/list": result = { data: [{ id: "model-a", model: "model-a", displayName: "Fixture", description: "Fixture", hidden: false, isDefault: true, supportedReasoningEfforts: ["high"].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: "high", inputModalities: ["text"], supportsPersonality: false }], nextCursor: null }; break;
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
    if (errors.length === 0) {
      await observe(() => rm(root, { recursive: true, force: true }));
    }
    if (errors.length) t.diagnostic(JSON.stringify({ root, stderr }));
    t.diagnostic(JSON.stringify({ root, providerPid: child?.pid, relayPid, providerExit: child?.exitCode, providerSignal: child?.signalCode, stdioClosed: child?.stdout.destroyed && child?.stderr.destroyed, socketClosed: native?.destroyed, errors }));
    assert.deepEqual(errors, [], "cleanup errors");
  });
  server.listen(socketPath);
  await once(server, "listening");
  const env = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: root, CODEX_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, CODEX_PATH: relay, AGENCY_FAKE_CODEX_SOCKET: socketPath, APP_SERVER_LOGS: root };
  child = spawn(process.execPath, [adapterEntry], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
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
  const request = (method, params) => {
    const id = ++nextId;
    const result = Promise.withResolvers(); deferred.set(id, result);
    result.promise.catch(() => {}); emit(method, params, id);
    return result.promise;
  };
  await bounded(request("initialize", { protocolVersion: 1, clientCapabilities: {} }), "ACP initialize");
  const opened = await bounded(request("session/new", { cwd: root, mcpServers: [] }), "ACP session");
  assert.equal(opened.sessionId, "fixture-session");
  const starts = () => nativeRequests.filter(frame => frame.method === "turn/start");
  return {
    nativeRequests, outbound, starts, complete,
    assertReplies() {
      const ids = outbound.filter(frame => frame.method && Object.hasOwn(frame, "id")).map(frame => frame.id);
      assert.deepEqual(inbound.filter(frame => !frame.method && Object.hasOwn(frame, "id")).map(frame => frame.id).sort(), ids.sort());
    },
    prompt(text) { return request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text }] }); },
    async acknowledge(index, marker, { held = false } = {}) {
      const turnId = "shared-turn";
      const requests = starts;
      await until(() => requests()[index], "native turn/start " + index + " " + stderr);
      const frame = requests()[index]; active = turnId;
      if (held) return () => reply(frame, { turn: turn("inProgress", turnId) });
      reply(frame, { turn: turn("inProgress", active) });
      sendNative({ method: "turn/started", params: { threadId: "fixture-session", turn: turn("inProgress", active) } });
      sendNative({ method: "item/agentMessage/delta", params: { threadId: "fixture-session", turnId: active, itemId: marker, delta: marker } });
      await until(() => inbound.some(event => event.params?.update?.content?.text === marker), "ACP marker " + marker + " " + stderr);
    },
    async results(promises) {
      const values = new Map();
      promises.forEach((promise, i) => promise.then(value => values.set(i, value), error => values.set(i, { error })));
      await until(() => values.size === promises.length, "missing original ACP callbacks: " + promises.length + " expected");
      return promises.map((_, i) => values.get(i));
    },
  };
}


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