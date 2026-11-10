import assert from "node:assert/strict";
import test from "node:test";
import { peer } from "./fixtures/acp-peer.mjs";

const user = (id, text) => ({ type: "userMessage", id, content: [{ type: "text", text }] });
const agent = (id, text) => ({ type: "agentMessage", id, text, phase: "final_answer" });
const command = { type: "commandExecution", id: "tool", command: "echo fixture", cwd: "/fixture", processId: null, status: "completed", commandActions: [], aggregatedOutput: "fixture", exitCode: 0, durationMs: 1 };
const replay = p => p.inbound.map(frame => frame.params?.update).filter(update => ["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update"].includes(update?.sessionUpdate)).map(update => [update.sessionUpdate, update.messageId ?? update.toolCallId, update.content?.text ?? update.status]);
const pages = p => p.nativeRequests.filter(frame => frame.method === "thread/items/list");

test("paged load preserves message and tool order while deduplicating entities", { timeout: 12000 }, async t => {
  const p = await peer(t, { load: true, history: [user("u1", "question"), agent("a1", "answer"), command, agent("a1", "answer"), user("u2", "next"), agent("a2", "last")] });
  assert.deepEqual(replay(p), [["user_message_chunk", "u1", "question"], ["agent_message_chunk", "a1", "answer"], ["tool_call", "tool", "completed"], ["tool_call_update", "tool", undefined], ["user_message_chunk", "u2", "next"], ["agent_message_chunk", "a2", "last"]]);
  assert.deepEqual(pages(p).map(frame => [frame.params.sortDirection, frame.params.cursor]), [["desc", "snapshot"], ["asc", null], ["asc", "2"], ["asc", "4"]]);
  assert.equal(p.starts().length, 0); p.assertReplies();
});

test("load ends at its captured last item when native history grows during paging", { timeout: 12000 }, async t => {
  const p = await peer(t, { load: true, history: [user("u1", "first"), agent("a1", "captured")], afterSnapshot: [agent("a2", "later"), user("u2", "later question")], pageSize: 3 });
  assert.deepEqual(replay(p), [["user_message_chunk", "u1", "first"], ["agent_message_chunk", "a1", "captured"]]);
  assert.equal(pages(p).length, 2); assert.equal(p.starts().length, 0); p.assertReplies();
});

test("long history requests each page once in native order", { timeout: 18000 }, async t => {
  const history = Array.from({ length: 1000 }, (_, index) => agent("a" + index, "text-" + index));
  const p = await peer(t, { load: true, history, pageSize: 100 });
  const updates = replay(p);
  assert.equal(updates.length, 1000);
  assert.deepEqual(updates.slice(0, 2), [["agent_message_chunk", "a0", "text-0"], ["agent_message_chunk", "a1", "text-1"]]);
  assert.deepEqual(updates.slice(-2), [["agent_message_chunk", "a998", "text-998"], ["agent_message_chunk", "a999", "text-999"]]);
  assert.deepEqual(updates.map(update => update[1]), history.map(item => item.id));
  assert.equal(pages(p).length, 11); assert.equal(p.starts().length, 0); p.assertReplies();
});
