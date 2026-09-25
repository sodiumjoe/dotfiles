#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const mode = process.env.AGENCY_CHECKOUT_GIT_FIXTURE
if (mode === "oversized") process.stdout.write(Buffer.alloc(100000, 97))
else if (mode === "invalid") process.stdout.write(Buffer.from([255, 10]))
else if (mode === "wait") {
  writeFileSync(join(process.cwd(), "git-child.json"), JSON.stringify({ pid: process.pid }))
  process.on("SIGTERM", () => undefined)
  setInterval(() => undefined, 1000)
} else if (mode === "changed") {
  const file = join(process.cwd(), "git-calls")
  let count = 0
  try { count = Number(readFileSync(file, "utf8")) } catch {}
  writeFileSync(file, String(count + 1))
  const arg = process.argv.at(-1)
  const output = arg === "--is-bare-repository" ? "false" : arg === "--show-toplevel" ? process.cwd() : join(process.cwd(), count < 4 ? ".git" : "other-git")
  process.stdout.write(output + "\n")
} else process.exitCode = 2