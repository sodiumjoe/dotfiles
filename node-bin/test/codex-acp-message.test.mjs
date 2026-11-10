import assert from "node:assert/strict";
import test from "node:test";
import { peer, until } from "./fixtures/acp-peer.mjs";

for (const [name, delta, completed, expected] of [
  ["missing deltas", "", "whole", "whole"],
  ["partial deltas", "prefix", "prefix suffix", "prefix suffix"],
  ["full deltas", "whole", "whole", "whole"],
  ["divergent completion", "prefix", "replacement", "prefix"],
]) test("completed message preserves " + name + " exactly once", { timeout: 12000 }, async t => {
  const p = await peer(t), prompt = p.prompt(name); await p.acknowledge(0, "started");
  if (delta) { p.delta("message", delta); await until(() => p.text("message") === delta, "streamed text"); }
  p.message("message", completed); p.message("message", completed);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(p.text("message"), expected);
  p.complete(); await p.results([prompt]); p.assertReplies();
});

test("late completed text and deltas cannot recreate a finished message", { timeout: 12000 }, async t => {
  const p = await peer(t), first = p.prompt("first"); await p.acknowledge(0, "started");
  p.message("message", "whole"); await until(() => p.text("message") === "whole", "completed text");
  p.delta("message", "late"); p.message("message", "whole");
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(p.text("message"), "whole");
  p.complete(); await p.results([first]);
  const second = p.prompt("second"); await p.acknowledge(1, "second-started");
  p.delta("old", "stale", "turn-0"); p.message("old", "stale", "turn-0");
  p.message("next", "next", "turn-1"); await until(() => p.text("next") === "next", "new turn text");
  assert.equal(p.text("old"), ""); p.complete(); await p.results([second]); p.assertReplies();
});

test("terminal turns stay suppressed after more than 64 later completions", { timeout: 12000 }, async t => {
  const p = await peer(t);
  for (let index = 0; index < 66; index++) {
    const prompt = p.prompt("turn " + index); await p.acknowledge(index, "started");
    p.complete(); await p.results([prompt]);
  }
  p.delta("retired", "late", "turn-0"); p.message("retired", "late suffix", "turn-0");
  p.delta("barrier", "observed", "fresh-turn");
  await until(() => p.text("barrier") === "observed", "later notification processed");
  assert.equal(p.text("retired"), ""); p.assertReplies();
});

test("a citation split between delta and completed suffix is rendered once", { timeout: 12000 }, async t => {
  const p = await peer(t), prompt = p.prompt("citation"); await p.acknowledge(0, "started");
  p.delta("citation", 'See :codex-file-citation{path="src/');
  await until(() => p.text("citation") === "See ", "citation prefix");
  p.message("citation", 'See :codex-file-citation{path="src/example.ts"} next');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(p.text("citation"), `See [src/example.ts](${p.root}/src/example.ts) next`);
  p.complete(); await p.results([prompt]); p.assertReplies();
});

test("message identities stay independent across items and turns", { timeout: 12000 }, async t => {
  const p = await peer(t), first = p.prompt("first"); await p.acknowledge(0, "started");
  p.delta("shared", "one"); p.delta("other", "two");
  p.message("shared", "one suffix"); p.message("other", "two suffix");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(p.text("shared"), "one suffix"); assert.equal(p.text("other"), "two suffix");
  p.complete(); await p.results([first]);
  const second = p.prompt("second"); await p.acknowledge(1, "next-started");
  p.message("shared", "next");
  p.delta("foreign", "wrong", "turn-1", "unrelated-session");
  p.message("foreign", "wrong", "turn-1", "unrelated-session");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(p.text("shared"), "one suffixnext"); assert.equal(p.text("foreign"), "");
  p.complete(); await p.results([second]); p.assertReplies();
});

test("closed sessions suppress late message events", { timeout: 12000 }, async t => {
  const p = await peer(t), prompt = p.prompt("close"); await p.acknowledge(0, "started");
  const closed = p.request("session/close", { sessionId: "fixture-session" });
  await p.results([prompt, closed]);
  p.delta("late", "late", "turn-0"); p.message("late", "late", "turn-0");
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(p.text("late"), "");
  p.assertReplies();
});