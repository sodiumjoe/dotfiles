import type { JsonObject } from "../agent/session-config.js"

const sources = new WeakMap<object, { text: string; bytes: number }>()
const whitespace = /[ \t\r\n]*/y
const stringRun = /[^"\\\u0000-\u001f]+/y
const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const hex = /^[0-9a-fA-F]{4}$/
const invalid = (): never => { throw new SyntaxError("Invalid ACP JSON") }
const space = (source: string, index: number): number => { whitespace.lastIndex = index; whitespace.exec(source); return whitespace.lastIndex }

function stringEnd(source: string, index: number): number {
  if (source[index++] !== '"') invalid()
  while (index < source.length) {
    stringRun.lastIndex = index
    if (stringRun.exec(source)) index = stringRun.lastIndex
    if (source[index] === '"') return index + 1
    if (source[index++] !== "\\") invalid()
    const escape = source[index++]
    if (escape === "u") { if (!hex.test(source.slice(index, index + 4))) invalid(); index += 4 }
    else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) invalid()
  }
  return invalid()
}

function valueEnd(source: string, start: number): number {
  type State = "value" | "object-first" | "object-next" | "object-after" | "array-first" | "array-next" | "array-after"
  const states: State[] = ["value"]
  let index = start
  while (states.length) {
    const state = states.pop()!
    index = space(source, index)
    const char = source[index]
    if (state === "value") {
      if (char === "{") { index++; states.push("object-first") }
      else if (char === "[") { index++; states.push("array-first") }
      else if (char === '"') index = stringEnd(source, index)
      else if (source.startsWith("true", index)) index += 4
      else if (source.startsWith("false", index)) index += 5
      else if (source.startsWith("null", index)) index += 4
      else { number.lastIndex = index; if (!number.exec(source)) invalid(); index = number.lastIndex }
    } else if (state === "object-first" || state === "object-next") {
      if (state === "object-first" && char === "}") { index++; continue }
      index = space(source, stringEnd(source, index))
      if (source[index++] !== ":") invalid()
      states.push("object-after", "value")
    } else if (state === "array-first" || state === "array-next") {
      if (state === "array-first" && char === "]") { index++; continue }
      states.push("array-after", "value")
    } else {
      if (char === (state === "object-after" ? "}" : "]")) index++
      else if (char === ",") { index++; states.push(state === "object-after" ? "object-next" : "array-next") }
      else invalid()
    }
  }
  return index
}

export function parseWireJson(source: string): JsonObject {
  try {
    let index = space(source, 0)
    if (source[index++] !== "{") invalid()
    const fields = new Map<string, [number, number]>()
    index = space(source, index)
    if (source[index] !== "}") {
      while (true) {
        const keyEnd = stringEnd(source, index), key = JSON.parse(source.slice(index, keyEnd)) as string
        index = space(source, keyEnd)
        if (source[index++] !== ":") invalid()
        const start = space(source, index), end = valueEnd(source, start)
        fields.set(key, [start, end]); index = space(source, end)
        if (source[index] === "}") break
        if (source[index++] !== ",") invalid()
        index = space(source, index)
      }
    }
    if (space(source, index + 1) !== source.length) invalid()
    const value: JsonObject = {}
    for (const [key, [start, end]] of fields) Object.defineProperty(value, key, { enumerable: true, get() {
      const raw = source.slice(start, end)
      return raw[0] === "{" ? parseWireJson(Buffer.from(raw).toString("utf8")) : JSON.parse(raw)
    } })
    Object.freeze(value)
    sources.set(value, { text: source, bytes: Buffer.byteLength(source) })
    return value
  } finally { whitespace.lastIndex = 0; whitespace.exec("") }
}

export function cloneWireJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || sources.has(value)) return value
  if (Array.isArray(value)) return value.map(cloneWireJson) as T
  const copy = {}
  for (const key of Object.keys(value)) Object.defineProperty(copy, key, { value: cloneWireJson((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true })
  return copy as T
}

export function encodeWireJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value)
  const source = sources.get(value)
  if (source) return source.text
  if (Array.isArray(value)) return "[" + value.map(item => item === undefined ? "null" : encodeWireJson(item)).join(",") + "]"
  return "{" + Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => JSON.stringify(key) + ":" + encodeWireJson(item)).join(",") + "}"
}

export function wireJsonBytes(value: unknown): number {
  if (typeof value !== "object" || value === null) return Buffer.byteLength(JSON.stringify(value))
  const source = sources.get(value)
  if (source) return source.bytes
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + wireJsonBytes(item === undefined ? null : item), 0)
  const fields = Object.entries(value).filter(([, item]) => item !== undefined)
  return 2 + Math.max(0, fields.length - 1) + fields.reduce((sum, [key, item]) => sum + Buffer.byteLength(JSON.stringify(key)) + 1 + wireJsonBytes(item), 0)
}