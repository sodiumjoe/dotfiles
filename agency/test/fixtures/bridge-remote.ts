import { connectHandlerBridge } from "../../src/bridge/handler-client.js"
import { runHostBridgeCli } from "../../src/bridge/remote.js"

const [root, hostId, handlerGeneration, agyPath, loginShell] = process.argv.slice(2)
if (!root || !hostId || !handlerGeneration || !agyPath || !loginShell) throw new Error("FIXTURE_INPUT")
await runHostBridgeCli(["--agy-path", agyPath, "--login-shell", loginShell], { input: process.stdin, output: process.stdout, environment: process.env, connect: () => connectHandlerBridge({ root, hostId, handlerGeneration }) })