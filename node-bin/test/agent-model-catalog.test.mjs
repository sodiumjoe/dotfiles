import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

test("declares the Claude SDK as a direct dependency", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.dependencies["@anthropic-ai/claude-agent-sdk"],
    "0.3.232",
  );
});

test("normalizes Claude and Codex models", async () => {
  const catalog = await import("../agent-model-catalog.mjs").catch(() => null);
  assert.ok(catalog);

  assert.deepEqual(
    catalog.normalizeClaudeModels([
      { value: "sonnet", displayName: "Sonnet", description: "Claude Sonnet" },
    ]),
    [
      {
        provider: "claude-agent-acp",
        model_id: "sonnet",
        name: "Sonnet",
        description: "Claude Sonnet",
      },
    ],
  );
  assert.deepEqual(
    catalog.normalizeCodexModels([
      {
        id: "gpt-5.6-sol",
        displayName: "gpt-5.6-sol",
        description: "Codex",
        hidden: false,
      },
      { id: "old", displayName: "old", description: "Old", hidden: true },
    ]),
    [
      {
        provider: "codex-acp",
        model_id: "gpt-5.6-sol",
        name: "gpt-5.6-sol",
        description: "Codex",
      },
      {
        provider: "codex-acp",
        model_id: "old",
        name: "old",
        description: "Old",
      },
    ],
  );
});

test("discovers Claude models and closes the SDK query", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  let closed = false;
  const models = await catalog.discoverClaudeModels({
    queryFactory: () => ({
      supportedModels: async () => [
        { value: "opus", displayName: "Opus", description: "Claude Opus" },
      ],
      close: () => {
        closed = true;
      },
    }),
  });

  assert.equal(closed, true);
  assert.equal(models[0].model_id, "opus");
});

test("discovers every page of Codex models", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const cursors = [];
  const models = await catalog.discoverCodexModels(async (_method, params) => {
    cursors.push(params.cursor);
    if (params.cursor === null) {
      return {
        data: [
          {
            id: "gpt-5.6-sol",
            displayName: "gpt-5.6-sol",
            description: "Sol",
            hidden: false,
          },
        ],
        nextCursor: "page-2",
      };
    }
    return {
      data: [
        {
          id: "hidden",
          displayName: "hidden",
          description: "Hidden",
          hidden: true,
        },
      ],
      nextCursor: null,
    };
  });

  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(
    models.map((model) => model.model_id),
    ["gpt-5.6-sol", "hidden"],
  );
});

test("retains one provider catalog when the other provider fails", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const result = await catalog.buildCatalog({
    discoverClaude: async () => {
      throw new Error("Claude unavailable");
    },
    discoverCodex: async () => [
      {
        provider: "codex-acp",
        model_id: "gpt-5.6-sol",
        name: "gpt-5.6-sol",
        description: "Codex",
      },
    ],
  });

  assert.deepEqual(
    result.models.map((model) => model.model_id),
    ["gpt-5.6-sol"],
  );
  assert.deepEqual(result.errors, [
    { provider: "Claude", message: "Claude unavailable" },
  ]);
});

test("requests Codex app-server methods over newline JSON-RPC", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => {};
  process.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`,
    );
  });

  const rpc = catalog.createJsonRpcRequester(process, 1000);
  const response = await rpc.request("model/list", {
    cursor: null,
    limit: null,
  });
  rpc.close();

  assert.deepEqual(response, { data: [], nextCursor: null });
});

test("initializes Codex app-server before discovering models", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => {};
  const methods = [];
  process.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    methods.push(request.method);
    const result =
      request.method === "model/list"
        ? {
            data: [
              {
                id: "gpt-5.6-sol",
                displayName: "gpt-5.6-sol",
                description: "Sol",
                hidden: false,
              },
            ],
            nextCursor: null,
          }
        : {};
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });

  const models = await catalog.discoverCodexProvider({
    spawnProcess: () => process,
  });

  assert.deepEqual(methods, ["initialize", "model/list"]);
  assert.deepEqual(
    models.map((model) => model.model_id),
    ["gpt-5.6-sol"],
  );
});

test("rejects Codex discovery when the executable cannot spawn", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => {};

  const discovery = catalog.discoverCodexProvider({
    spawnProcess: () => {
      queueMicrotask(() => process.emit("error", new Error("spawn ENOENT")));
      return process;
    },
  });

  await assert.rejects(discovery, /spawn ENOENT/);
});

test("rejects malformed Codex JSON-RPC output", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => {};
  process.stdin.on("data", () => {
    process.stdout.write("not-json\n");
  });

  const rpc = catalog.createJsonRpcRequester(process, 1000);
  await assert.rejects(rpc.request("model/list", {}), /invalid JSON-RPC/);
  rpc.close();
});

test("rejects non-object Codex JSON-RPC output", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => {};
  process.stdin.on("data", () => {
    process.stdout.write("null\n");
  });

  const rpc = catalog.createJsonRpcRequester(process, 1000);
  await assert.rejects(rpc.request("model/list", {}), /invalid JSON-RPC/);
  rpc.close();
});

test("writes the combined catalog as JSON", async () => {
  const catalog = await import("../agent-model-catalog.mjs");
  let output;
  await catalog.main({
    discoverClaude: async () => [
      {
        provider: "claude-agent-acp",
        model_id: "opus",
        name: "Opus",
        description: "Claude",
      },
    ],
    discoverCodex: async () => [
      {
        provider: "codex-acp",
        model_id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        description: "Codex",
      },
    ],
    write: (value) => {
      output = value;
    },
  });

  assert.deepEqual(
    JSON.parse(output).models.map((model) => model.model_id),
    ["opus", "gpt-5.6-sol"],
  );
});
