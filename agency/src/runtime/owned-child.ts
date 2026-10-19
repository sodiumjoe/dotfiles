import type { ChildProcess } from "node:child_process"

export type ChildTerminal =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "spawn-error"; error: Error }
export type ChildLifecycleEvent =
  | { kind: "error"; error: Error }
  | { kind: "exit" | "close"; code: number | null; signal: NodeJS.Signals | null }
export type OwnedChild = {
  readonly launchAttemptId: string
  readonly child: ChildProcess
  readonly terminal: Promise<ChildTerminal>
  readonly closed: Promise<void>
  snapshot(): { terminal: ChildTerminal | null; closed: boolean; abandoned: boolean }
  stop(operation: () => Promise<void>): Promise<void>
  retryStop(operation: () => Promise<void>): Promise<void>
  release(): boolean
  abandon(reason: string): void
}

const registered = new WeakSet<OwnedChild>()
export function isOwnedChild(value: OwnedChild): boolean { return registered.has(value) }

export function spawnOwnedChild(input: { launchAttemptId: string; spawn(): ChildProcess; onEvent?(event: ChildLifecycleEvent): void }): OwnedChild {
  const child = input.spawn()
  let terminal: ChildTerminal | null = null, closed = false, abandonment: string | undefined
  let stopping: Promise<void> | undefined, stopState: "pending" | "fulfilled" | "rejected" = "pending", lastError: unknown
  let resolveTerminal!: (value: ChildTerminal) => void, resolveClose!: () => void
  const terminalEvent = new Promise<ChildTerminal>(resolve => { resolveTerminal = resolve })
  const closedEvent = new Promise<void>(resolve => { resolveClose = resolve })
  const capture = (event: ChildLifecycleEvent): void => {
    if (!terminal && (event.kind === "exit" || event.kind === "error" && child.pid === undefined)) {
      terminal = Object.freeze(event.kind === "error" ? { kind: "spawn-error", error: event.error } : { kind: "exit", code: event.code, signal: event.signal })
      resolveTerminal(terminal)
    }
    if (event.kind === "close") { closed = true; resolveClose() }
    try { input.onEvent?.(event) } catch { }
  }
  child.on("error", (error: Error) => capture({ kind: "error", error }))
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => capture({ kind: "exit", code, signal }))
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => capture({ kind: "close", code, signal }))
  const streams = () => [child.stdin, child.stdout, child.stderr].filter(value => value !== null)
  const discharge = (): void => { for (const stream of streams()) stream.destroy(); child.unref() }
  const attempt = (operation: () => Promise<void>): Promise<void> => {
    stopState = "pending"
    stopping = Promise.resolve().then(() => {
      if (abandonment !== undefined) throw new Error("abandoned: " + abandonment)
      return operation()
    })
    void stopping.then(() => { stopState = "fulfilled" }, error => { stopState = "rejected"; lastError = error })
    return stopping
  }
  const owner: OwnedChild = Object.freeze({
    launchAttemptId: input.launchAttemptId, child, terminal: terminalEvent, closed: closedEvent,
    snapshot: () => ({ terminal, closed, abandoned: abandonment !== undefined }),
    stop: (operation: () => Promise<void>) => stopping ?? attempt(operation),
    retryStop: (operation: () => Promise<void>) => stopping && stopState !== "rejected" ? stopping : attempt(operation),
    release() {
      if (!terminal || abandonment !== undefined || !closed && !streams().every(stream => stream.destroyed)) return false
      discharge(); return true
    },
    abandon(reason: string) { abandonment ??= reason; discharge() },
  })
  registered.add(owner)
  return owner
}