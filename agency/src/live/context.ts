import type { HandlerStatus } from "../control/protocol.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { PlatformAdapter } from "../platform/types.js"

export type ProcessContext = { adapter: PlatformAdapter; state: Pick<HandlerStatus, "handlerGeneration" | "phase"> }
export type LiveContext = ProcessContext & { paths: PlatformPaths; shutdownPending(): boolean }