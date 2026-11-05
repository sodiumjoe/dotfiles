import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { patchCodexAcp } from "../patch-codex-acp.mjs";

const packageRoot = process.env.AGENCY_CODEX_ACP_FIXTURE_PACKAGE ?? fileURLToPath(new URL("../node_modules/@agentclientprotocol/codex-acp/", import.meta.url));
const bundle = await readFile(path.join(packageRoot, "dist/index.js"), "utf8");
const start = bundle.indexOf("function mergeHistoryUpdates(");
const end = bundle.indexOf("function getRequestedMcpServerNames(", start);
assert.ok(start > 0 && end > start);
const source = bundle.slice(start, end);
const loadMerge = (json = JSON) => runInNewContext(source + "; mergeHistoryUpdates", { JSON: json });
const merge = loadMerge();
const message = (text, messageId, sessionUpdate = "agent_message_chunk") => ({ sessionUpdate, content: { type: "text", text }, ...(messageId === undefined ? {} : { messageId }) });
const tool = (toolCallId, sessionUpdate = "tool_call", status = "in_progress") => ({ sessionUpdate, toolCallId, status });
const metadata = () => ({ sessionUpdate: "session_info_update", title: "History" });
const assertOrder = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.equal(value, expected[index], "original update identity at " + index));
};

function legacyMerge(fallback, native) {
  const key = update => {
    if (["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate)) return update.sessionUpdate + ":" + (update.messageId ?? "") + ":" + JSON.stringify(update.content);
    if (update.sessionUpdate === "tool_call") return "tool_call:" + update.toolCallId + ":start";
    if (update.sessionUpdate === "tool_call_update") return "tool_call:" + update.toolCallId + ":update";
    return null;
  };
  const contentKey = update => ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate) ? update.sessionUpdate + ":" + JSON.stringify(update.content) : key(update);
  const merged = [], seen = new Set();
  let cursor = 0;
  const push = update => {
    const value = key(update);
    if (value && seen.has(value)) return;
    if (value) seen.add(value);
    merged.push(update);
  };
  for (const update of native) {
    const exact = key(update), content = contentKey(update);
    if (exact || content) {
      const match = fallback.findIndex((item, index) => index >= cursor && (exact !== null && key(item) === exact || content !== null && contentKey(item) === content));
      if (match !== -1) {
        while (cursor < match) push(fallback[cursor++]);
        cursor++;
      }
    }
    push(update);
  }
  while (cursor < fallback.length) push(fallback[cursor++]);
  return merged;
}

test("unmatched history does not repeatedly serialize all fallback messages", () => {
  const fallback = Array.from({ length: 1000 }, (_, i) => message("message-" + i, "fallback-" + i));
  const native = Array.from({ length: 1000 }, (_, i) => tool("absent-" + i));
  let serializations = 0;
  const measured = loadMerge({ stringify(...args) { serializations++; return JSON.stringify(...args); } });
  assertOrder(measured(fallback, native), [...native, ...fallback]);
  assert.ok(serializations <= 10 * (fallback.length + native.length), "history serialization count: " + serializations);
});

test("earlier content match takes precedence over a later exact match", () => {
  const old = message("same", "old"), gap = message("gap", undefined, "agent_thought_chunk"), exact = message("same", "new"), native = message("same", "new");
  assertOrder(merge([old, gap, exact], [native]), [native, gap]);
});

test("later occurrences remain eligible after consumed matches", () => {
  const first = message("same", "old"), gap = message("gap"), repeated = message("same", "old"), tail = message("tail");
  const one = message("same", "one"), absent = tool("absent"), two = message("same", "two");
  assertOrder(merge([first, gap, repeated, tail], [one, absent, two]), [one, absent, gap, two, tail]);
});

test("tool starts and results deduplicate separately while metadata is retained", () => {
  const start = tool("call"), duplicate = tool("call", "tool_call", "failed"), result = tool("call", "tool_call_update", "completed"), info = metadata();
  assertOrder(merge([start, duplicate, result, info, info], []), [start, result, info, info]);
  assertOrder(merge([], [start, duplicate, result, info, info]), [start, result, info, info]);
  assertOrder(merge([], []), []);
});

test("indexed merge preserves legacy sequence across deterministic mixed histories", () => {
  let seed = 271828;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const update = () => {
    const kind = random(6);
    if (kind < 3) return message("text-" + random(4), random(3) === 0 ? undefined : "id-" + random(3), ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"][kind]);
    if (kind < 5) return tool("call-" + random(4), kind === 3 ? "tool_call" : "tool_call_update", random(2) ? "completed" : "failed");
    return metadata();
  };
  for (let cohort = 0; cohort < 1000; cohort++) {
    const fallback = Array.from({ length: random(25) }, update), native = Array.from({ length: random(25) }, update);
    assertOrder(merge(fallback, native), legacyMerge(fallback, native));
  }
});

const installerSource = await readFile(new URL("../patch-codex-acp.mjs", import.meta.url), "utf8");
const stages = runInNewContext(installerSource.slice(installerSource.indexOf("const originalHash"), installerSource.indexOf("export async function patchCodexAcp")) + "; ({ replacements, lateStartReplacements, completedTextReplacements, historyReplacements })");
const digest = text => createHash("sha256").update(text).digest("hex");
const reverse = (text, replacements) => {
  for (const [before, after] of [...replacements].reverse()) {
    assert.equal(text.split(after).length, 2, "unambiguous fixture stage");
    text = text.replace(after, before);
  }
  return text;
};
const completed = reverse(bundle, stages.historyReplacements);
const late = reverse(completed, stages.completedTextReplacements);
const overlap = reverse(late, stages.lateStartReplacements);
const original = reverse(overlap, stages.replacements);
const priorStages = [
  ["completed-text", completed, "3f4ee4031599a2342a32f23b2e54f0b7fdb0dc09b4cb047cecbf242e37c34367"],
  ["late-start", late, "a792e8776fa77b4157ce5ee984b9b4027b25158da573554a7531044fa72c7ba1"],
  ["overlap", overlap, "c3f5b9212df7962fc7f95ccffe05841f31a9ca22d625cf5cf6c304d8bf9ffd78"],
  ["pristine", original, "afffcfeb6ae3a82f2b359a7d3d6a1a3ceee43898b59c34335eb1760974cc4ff8"],
];
for (const [name, input, hash] of priorStages) {
  test("installer upgrades exact " + name + " bytes idempotently", async t => {
    assert.equal(digest(input), hash);
    const root = await mkdtemp(path.join(tmpdir(), "acp-history-patch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }));
    const entry = path.join(root, "dist/index.js");
    await writeFile(entry, input, { mode: 0o755 });
    const mode = (await stat(entry)).mode & 0o777;
    await patchCodexAcp(root);
    assert.equal(await readFile(entry, "utf8"), bundle);
    assert.equal((await stat(entry)).mode & 0o777, mode);
    await patchCodexAcp(root);
    assert.equal(await readFile(entry, "utf8"), bundle);
  });
}

test("installer rejects unknown source and package without changing bytes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acp-history-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  const entry = path.join(root, "dist/index.js"), metadata = path.join(root, "package.json");
  for (const [version, input] of [["1.7.0", bundle + "\n"], ["1.7.1", completed]]) {
    await writeFile(metadata, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version }));
    await writeFile(entry, input);
    await assert.rejects(patchCodexAcp(root), /Unsupported codex-acp/);
    assert.equal(await readFile(entry, "utf8"), input);
  }
});