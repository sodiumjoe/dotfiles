import { canonicalJson, type JsonObject } from "../agent/session-config.js"
import type { AcpObservation } from "../agent/session-events.js"

export type Echo = { blocks: JsonObject[]; index: number; offset: number; bytes: number }
export type EchoFilter = { expect(blocks: JsonObject[]): Echo; settle(echo: Echo): AcpObservation[]; filter(event: AcpObservation, ready: boolean): AcpObservation[] }

export function createEchoFilter(): EchoFilter {
  const pending = new Set<Echo>()
  let held: Array<{ echo: Echo; event: AcpObservation }> = []
  const flush = (): AcpObservation[] => {
    for (const { echo } of held) pending.delete(echo)
    const events = held.map(value => value.event)
    held = []
    return events
  }
  return {
    expect(blocks) { const echo = { blocks, index: 0, offset: 0, bytes: 0 }; pending.add(echo); return echo },
    settle(echo) { const events = held.some(value => value.echo === echo) ? flush() : []; pending.delete(echo); return events },
    filter(event, ready) {
      if (!pending.size) return [event]
      const actual = event.update.content as JsonObject | undefined
      const echo = !event.replay && ready && event.update.sessionUpdate === "user_message_chunk" ? [...pending].find(candidate => {
        const expected = candidate.blocks[candidate.index]
        if (!expected || !actual) return false
        if (expected.type === "text" && actual.type === "text" && typeof expected.text === "string" && typeof actual.text === "string") {
          const { text: _expectedText, ...expectedFields } = expected, { text: _actualText, ...actualFields } = actual
          return actual.text.length > 0 && expected.text.slice(candidate.offset).startsWith(actual.text) && canonicalJson(expectedFields) === canonicalJson(actualFields)
        }
        return canonicalJson(expected) === canonicalJson(actual)
      }) : undefined
      if (!echo) return [...flush(), event]
      const expected = echo.blocks[echo.index]!
      if (expected.type === "text" && typeof expected.text === "string") {
        echo.offset += String(actual!.text).length
        held.push({ echo, event }); echo.bytes += Buffer.byteLength(JSON.stringify(event))
        if (echo.offset === expected.text.length) { echo.index++; echo.offset = 0; held = held.filter(value => value.echo !== echo); echo.bytes = 0 }
        else if (held.length >= 8192 || echo.bytes >= 4194304) return flush()
      } else echo.index++
      return []
    },
  }
}