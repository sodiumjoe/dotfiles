import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { Writable, type Readable } from "node:stream"
import type { ProbeRequest } from "../probes.js"
import { CatalogError, invalid, object } from "../types.js"

export type RegisteredChild = { stdin: Writable; stdout: Readable; terminal: Promise<void>; requestCleanup(): void }
export type DriverContext = { request: ProbeRequest; signal: AbortSignal; spawnNative(file: string, args: readonly string[]): RegisteredChild }
export class NativeFacade extends EventEmitter implements RegisteredChild {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly terminal: Promise<void>
  constructor(private readonly child: ChildProcess, registered: Promise<void>, readonly requestCleanup: () => void) {
    super()
    this.stdout = child.stdout!; this.stderr = child.stderr!
    this.on("error", () => undefined)
    let total = 0
    this.stdin = new Writable({ write: (bytes: Buffer, _encoding, callback) => {
      total += bytes.length
      if (total > 1048576) { callback(new CatalogError("PROBE_FAILED")); requestCleanup(); return }
      void registered.then(() => { if (!child.stdin?.writable) callback(new CatalogError("PROBE_FAILED")); else child.stdin.write(bytes, callback) }, () => callback(new CatalogError("PROBE_FAILED")))
    }, final: callback => { void registered.then(() => { child.stdin?.end(callback) }, () => callback(new CatalogError("PROBE_FAILED"))) } })
    this.stdin.on("error", () => undefined)
    child.stdin?.on("error", error => this.stdin.destroy(error))
    child.on("error", error => this.emit("error", error))
    child.on("exit", (code, signal) => this.emit("exit", code, signal))
    this.terminal = new Promise(resolve => child.once("close", (code, signal) => { this.emit("close", code, signal); resolve() }))
  }
  get pid() { return this.child.pid }
  get exitCode() { return this.child.exitCode }
  get signalCode() { return this.child.signalCode }
  get killed() { return false }
  kill(): boolean { this.requestCleanup(); return false }
}

export function aborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CatalogError("PROBE_FAILED"))
    if (signal.aborted) { void operation.catch(() => undefined); abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    void operation.then(resolve, () => reject(new CatalogError("PROBE_FAILED"))).finally(() => signal.removeEventListener("abort", abort))
  })
}

export function jsonRpc(child: RegisteredChild, signal: AbortSignal) {
  let nextId = 0, input = 0, buffer = "", error: CatalogError | undefined
  const decoder = new TextDecoder("utf-8", { fatal: true }), pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = () => { error ??= new CatalogError("PROBE_FAILED"); for (const p of pending.values()) p.reject(error); pending.clear() }
  const check = () => { if (error) throw error; if (signal.aborted) throw new CatalogError("PROBE_FAILED") }
  const data = (bytes: Buffer) => {
    try {
      input += bytes.length
      if (input > 1048576) invalid()
      buffer += decoder.decode(bytes, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        const v = object(JSON.parse(line))
        if (v.jsonrpc !== undefined && v.jsonrpc !== "2.0") invalid()
        if (typeof v.method === "string") { if (Object.hasOwn(v, "id")) invalid(); continue }
        if (typeof v.id !== "number" || !pending.has(v.id) || Object.hasOwn(v, "error") || !Object.hasOwn(v, "result")) invalid()
        if (Object.keys(v).some(key => !["jsonrpc", "id", "result"].includes(key))) invalid()
        const request = pending.get(v.id)!; pending.delete(v.id); request.resolve(v.result)
      }
    } catch { fail() }
  }
  const end = () => { try { buffer += decoder.decode(); if (buffer.length || pending.size) fail() } catch { fail() } }
  child.stdout.on("data", data); child.stdout.on("end", end); child.stdout.on("error", fail); child.stdin.on("error", fail)
  signal.addEventListener("abort", fail, { once: true })
  const write = (value: object) => { check(); child.stdin.write(JSON.stringify(value) + "\n", err => { if (err) fail() }) }
  return {
    async request(method: string, params: unknown): Promise<unknown> {
      check()
      const id = ++nextId
      const response = new Promise<unknown>((resolve, reject) => { pending.set(id, { resolve, reject }); try { write({ id, method, params }) } catch { fail() } })
      const result = await response
      check()
      return result
    },
    notify(method: string) { write({ method }) },
    check,
    close() { child.stdout.off("data", data); child.stdout.off("end", end); child.stdout.off("error", fail); child.stdin.off("error", fail); signal.removeEventListener("abort", fail) },
  }
}