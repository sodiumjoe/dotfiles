import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function normalizeClaudeModels(models) {
  return models.map((model) => ({
    provider: "claude-agent-acp",
    model_id: model.value,
    name: model.displayName,
    description: model.description,
  }));
}

export function normalizeCodexModels(models) {
  return models.map((model) => ({
    provider: "codex-acp",
    model_id: model.id,
    name: model.displayName,
    description: model.description,
  }));
}

async function* emptyPrompt() {}

export async function discoverClaudeModels({
  queryFactory = query,
  cwd = process.cwd(),
  claudePath = process.env.CLAUDE_CODE_EXECUTABLE,
} = {}) {
  const options = {
    cwd,
    settingSources: ["user", "project", "local"],
  };
  if (claudePath) {
    options.pathToClaudeCodeExecutable = claudePath;
  }

  const sdkQuery = queryFactory({ prompt: emptyPrompt(), options });
  try {
    return normalizeClaudeModels(await sdkQuery.supportedModels());
  } finally {
    sdkQuery.close();
  }
}

export async function discoverCodexModels(request) {
  const models = [];
  let cursor = null;

  do {
    const response = await request("model/list", { cursor, limit: null });
    models.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);

  return normalizeCodexModels(models);
}

export async function buildCatalog({ discoverClaude, discoverCodex }) {
  const providers = [
    { name: "Claude", discover: discoverClaude },
    { name: "Codex", discover: discoverCodex },
  ];
  const settled = await Promise.allSettled(
    providers.map((provider) => provider.discover()),
  );
  const result = { models: [], errors: [] };

  settled.forEach((value, index) => {
    if (value.status === "fulfilled") {
      result.models.push(...value.value);
      return;
    }

    result.errors.push({
      provider: providers[index].name,
      message:
        value.reason instanceof Error
          ? value.reason.message
          : String(value.reason),
    });
  });

  return result;
}

export function createJsonRpcRequester(process, timeoutMs = 30000) {
  let nextId = 0;
  let buffer = "";
  let failure;
  let stderr = "";
  const pending = new Map();

  const rejectPending = (message) => {
    failure = message;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pending.clear();
  };
  const onData = (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        rejectPending("Codex app-server returned invalid JSON-RPC");
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        rejectPending("Codex app-server returned invalid JSON-RPC");
        return;
      }
      const request = pending.get(message.id);
      if (!request) continue;

      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(
          new Error(message.error.message || JSON.stringify(message.error)),
        );
      } else {
        request.resolve(message.result);
      }
    }
  };
  const onError = (error) => rejectPending(error.message || String(error));
  const onExit = (code) => {
    const details = stderr.trim();
    rejectPending(
      `Codex app-server exited with code ${code}${details ? `: ${details}` : ""}`,
    );
  };
  const onStderr = (chunk) => {
    if (stderr.length < 8192) {
      stderr += chunk.toString().slice(0, 8192 - stderr.length);
    }
  };

  process.stdout.on("data", onData);
  process.stdout.on("error", onError);
  process.stdin.on("error", onError);
  process.stderr.on("data", onStderr);
  process.stderr.on("error", onError);
  process.on("error", onError);
  process.on("exit", onExit);

  return {
    request(method, params) {
      if (failure) {
        return Promise.reject(new Error(failure));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex app-server timed out during ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
        process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() {
      process.stdout.off("data", onData);
      process.stdout.off("error", onError);
      process.stdin.off("error", onError);
      process.stderr.off("data", onStderr);
      process.stderr.off("error", onError);
      process.off("error", onError);
      process.off("exit", onExit);
      process.kill();
    },
  };
}

export async function discoverCodexProvider({
  spawnProcess = spawn,
  codexPath = process.env.CODEX_PATH || "codex",
} = {}) {
  const child = spawnProcess(codexPath, ["app-server"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = createJsonRpcRequester(child);

  try {
    await rpc.request("initialize", {
      clientInfo: { name: "agentic.nvim", title: "Agentic.nvim", version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    return await discoverCodexModels(rpc.request);
  } finally {
    rpc.close();
  }
}

export async function main({
  discoverClaude = discoverClaudeModels,
  discoverCodex = discoverCodexProvider,
  write = (value) => process.stdout.write(value),
} = {}) {
  const catalog = await buildCatalog({ discoverClaude, discoverCodex });
  write(JSON.stringify(catalog));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
