import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"

type Options = { cwd: string; settingSources: string[]; mcpServers: object; tools: unknown[]; persistSession: boolean; pathToClaudeCodeExecutable: string; spawnClaudeCodeProcess(input: unknown): { stdin: Writable; stdout: Readable } }
export function query({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) {
  const child = options.spawnClaudeCodeProcess({ command: options.pathToClaudeCodeExecutable, args: ["--agency-fixture-sdk"], cwd: options.cwd, env: {}, signal: new AbortController().signal })
  return { async supportedModels(): Promise<unknown> {
    let prompts = 0
    for await (const _ of prompt) prompts++
    await writeFile(join(options.cwd, "sdk-observed.json"), JSON.stringify({ prompts, cwd: options.cwd, settingSources: options.settingSources, mcpServers: options.mcpServers, tools: options.tools, persistSession: options.persistSession }), { mode: 0o600 })
    return new Promise((resolve, reject) => {
      let buffer = ""
      child.stdout.on("data", (bytes: Buffer) => {
        buffer += bytes.toString()
        if (buffer.length > 1048576) { reject(new Error("fixture bound")); return }
        if (buffer.includes("\n")) {
          try { const value = JSON.parse(buffer); if (value.error) reject(new Error("fixture error")); else resolve(value.models) } catch (error) { reject(error) }
        }
      })
      child.stdout.on("error", reject)
      child.stdin.write("sdk-models\n")
    })
  } }
}