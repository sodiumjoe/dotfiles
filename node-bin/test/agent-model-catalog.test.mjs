import assert from "node:assert/strict";
import test from "node:test";

test("streams one provider error without discarding successful models", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const writes = [];

  await catalog.streamCatalog({
    discoverClaude: async () => {
      throw new Error("Claude unavailable");
    },
    discoverCodex: async () => [],
    write: (value) => writes.push(JSON.parse(value)),
  });

  assert.deepEqual(
    writes.find((event) => event.provider === "claude-agent-acp"),
    {
      provider: "claude-agent-acp",
      error: { provider: "Claude", message: "Claude unavailable" },
    },
  );
  assert.deepEqual(
    writes.find((event) => event.provider === "codex-acp"),
    { provider: "codex-acp", models: [] },
  );
});