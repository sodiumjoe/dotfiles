import assert from "node:assert/strict";
import test from "node:test";
import { peer, until } from "./fixtures/acp-peer.mjs";

test("rapid FIFO prompts preserve every original callback without concurrent native starts", { timeout: 18000 }, async t => {
  const p = await peer(t);
  const first = p.prompt("rapid-A"); await p.acknowledge(0, "rapid-A");
  const second = p.prompt("rapid-B"), third = p.prompt("rapid-C");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(p.starts().length, 1);
  p.complete(); await p.results([first]);
  await p.acknowledge(1, "rapid-B"); p.complete(); await p.results([second]);
  await p.acknowledge(2, "rapid-C"); p.complete();
  const results = await p.results([first, second, third]);
  assert.deepEqual(results.map(value => value.stopReason), ["end_turn", "end_turn", "end_turn"]);
  assert.deepEqual(p.starts().map(frame => frame.params.input[0].text), ["rapid-A", "rapid-B", "rapid-C"]);
  assert.equal(p.nativeRequests.some(frame => frame.method === "turn/interrupt" || frame.method === "turn/steer"), false);
  p.assertReplies();
});

test("Cancel waits for a withheld native start and settles the original prompt", { timeout: 12000 }, async t => {
  const p = await peer(t), prompt = p.prompt("held-start");
  const release = await p.acknowledge(0, "held", { held: true });
  p.notify("session/cancel", { sessionId: "fixture-session" });
  await new Promise(resolve => setTimeout(resolve, 30)); release();
  const [result] = await p.results([prompt]);
  assert.equal(result.stopReason, "cancelled");
  await until(() => p.nativeRequests.find(frame => frame.method === "turn/interrupt"), "owned native interrupt");
  assert.equal(p.nativeRequests.find(frame => frame.method === "turn/interrupt").params.turnId, "turn-0");
  p.assertReplies();
});

test("Close while a native start is pending settles the original prompt without a replacement", { timeout: 12000 }, async t => {
  const p = await peer(t), prompt = p.prompt("held-close");
  const release = await p.acknowledge(0, "held", { held: true });
  const close = p.request("session/close", { sessionId: "fixture-session" });
  await new Promise(resolve => setTimeout(resolve, 30)); release();
  const [result, closed] = await p.results([prompt, close]);
  assert.equal(result.stopReason, "cancelled"); assert.deepEqual(closed, {});
  assert.equal(p.starts().length, 1); p.assertReplies();
});