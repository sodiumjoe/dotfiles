import { runRuntimeBridgeCli } from "../../src/bridge/runtime-remote.js"
import { connectHandlerBridge } from "../../src/bridge/handler-client.js"
const input = JSON.parse(process.argv[2]!) as Parameters<typeof connectHandlerBridge>[0]
await runRuntimeBridgeCli([], { input: process.stdin, output: process.stdout, connect: () => connectHandlerBridge(input) })