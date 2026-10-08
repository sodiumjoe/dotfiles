import { timestamp } from "../catalog/types.js"
export type ReadinessState = "ready" | "unavailable" | "unknown"
export type Readiness = { observedAt: number; ready: boolean; checks: Record<"cwd" | "model" | "tools" | "git", ReadinessState> }
export async function inspectReadiness(input: { observedAt: number } & Record<"cwd" | "model" | "tools" | "git", () => Promise<ReadinessState>>): Promise<Readiness> {
  const observedAt = timestamp(input.observedAt), names = ["cwd", "model", "tools", "git"] as const
  const values = await Promise.all(names.map(async name => { try { const state = await input[name](); return ["ready", "unavailable", "unknown"].includes(state) ? state : "unknown" } catch { return "unknown" } }))
  const checks = Object.fromEntries(names.map((name, i) => [name, values[i]!])) as Readiness["checks"]
  return { observedAt, ready: values.every(value => value === "ready"), checks }
}