export function createHandlerTermination(options: { drain(): Promise<void>; close(): Promise<void>; timeoutMs?: number }): () => Promise<Error | null> {
  let operation: Promise<Error | null> | undefined
  return () => operation ??= new Promise(resolve => {
    const failures: unknown[] = []
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(failures.length ? new AggregateError(failures, "Handler termination incomplete") : null)
    }
    const timer = setTimeout(() => {
      failures.push(new Error("Handler termination deadline exceeded; cleanup remains unverified"))
      finish()
    }, options.timeoutMs ?? 15000)
    void (async () => {
      try { await options.drain() } catch (error) { failures.push(error) }
      if (settled) return
      try { await options.close() } catch (error) { failures.push(error) }
      finish()
    })()
  })
}

export function formatTerminationFailure(error: Error): Buffer {
  const pending: unknown[] = [error], messages: string[] = []
  for (let index = 0; index < pending.length && index < 8; index++) {
    const cause = pending[index]
    messages.push(String(cause).slice(0, 256))
    if (cause instanceof AggregateError) pending.push(...cause.errors.slice(0, 8))
  }
  return Buffer.from(messages.join("\n") + "\n").subarray(0, 2048)
}