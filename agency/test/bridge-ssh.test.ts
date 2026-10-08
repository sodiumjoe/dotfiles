import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { connectHost, buildSshCommand, parseHostSnapshot } from "../src/bridge/ssh.js"
import { invokeDestination, parseHostCall, runHostCall, sanitizedBootstrapEnvironment } from "../src/bridge/invocation.js"
import { parseHostBridgeArguments, runHostBridgeCli, runHostCallCli, serveHostBridge } from "../src/bridge/remote.js"
import { PassThrough } from "node:stream"
import { createBridgePeer } from "../src/bridge/codec.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { bridgeFixture } from "./bridge-support.js"
export { bridgeFixture } from "./bridge-support.js"

test("SSH pins host identity and configures bounded noninteractive transport", async t => {
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn)
  t.after(() => connection.close())
  assert.equal(connection.hello.hostId, f.enrollment.hostId)
  assert.equal(connection.snapshot.agents[0]?.agent.agentId, f.agentId)
  assert.equal(f.calls[0]?.file, "ssh")
  const argv = f.calls[0]!.argv
  for (const arg of ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=2"]) assert.ok(argv.includes(arg))
  assert.equal(argv.at(-2), "devbox-a"); assert.equal(f.startCount, 0)
})

test("changed host identity and unsupported runtime reject before any dispatch", async t => {
  const f = bridgeFixture(t)
  await assert.rejects(connectHost({ ...f.enrollment, hostId: f.second.hostId }, f.spawn), /HOST_IDENTITY_CHANGED/)
  f.setRuntime("v22.0.0"); await assert.rejects(connectHost(f.enrollment, f.spawn), /UNSUPPORTED_RUNTIME/)
  assert.equal(f.startCount, 0)
})

test("a changed Handler generation blocks dispatch on an established bridge", async t => {
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn)
  t.after(() => connection.close()); f.retire()
  await assert.rejects(connection.request("launch", {}), /STALE_HANDLER/); assert.equal(f.startCount, 0)
})

test("SSH command rejects shell options and unsafe paths before process creation", t => {
  const f = bridgeFixture(t)
  for (const change of [{ hostname: "-oProxyCommand=bad" }, { hostname: "box\nother" }, { agyPath: "relative" }, { agyPath: "/opt/../agy" }, { loginShell: "/bin/bash\0" }]) assert.throws(() => buildSshCommand({ ...f.enrollment, ...change }))
})

test("remote login-shell startup noise stays outside protocol stdout", async t => {
  const root = await mkdtemp(join(realpathSync("/tmp"), "agy-shell-")); t.after(() => rm(root, { recursive: true, force: true }))
  const shell = join(root, "login's shell"), agy = join(root, "agy's command")
  await writeFile(shell, '#!/bin/sh\nprintf "login noise\\n"\nexec /bin/sh "$@"'); await chmod(shell, 0o700)
  await writeFile(agy, `#!/bin/sh\nprintf '{"protocol":"agency-bridge/1"}\\n'`); await chmod(agy, 0o700)
  const f = bridgeFixture(t), command = buildSshCommand({ ...f.enrollment, loginShell: shell, agyPath: agy })
  const result = await promisify(execFile)("/bin/sh", ["-c", command.argv.at(-1)!], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
  assert.equal(result.stdout, '{"protocol":"agency-bridge/1"}\n'); assert.match(result.stderr, /login noise/)
})

test("two starts use distinct destination login invocations with current configuration", async t => {
  const root = await mkdtemp(join(realpathSync("/tmp"), "agy-env-")); t.after(() => rm(root, { recursive: true, force: true }))
  const shell = join(root, "shell"), agy = join(root, "agy"), config = join(root, "config")
  await writeFile(shell, `#!/bin/sh\nexport CURRENT_CONFIG="$(cat '${config}')"\nprintf 'startup noise\\n'\nexec /bin/sh "$@"`); await chmod(shell, 0o700)
  await writeFile(agy, `#!${process.execPath}\nconst fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync('${root}/observed', JSON.stringify({ env:process.env, request })+'\\n'); process.stdout.write(JSON.stringify({ ok:true, result:{ state:'started' } })+'\\n')`); await chmod(agy, 0o700)
  const f = bridgeFixture(t), enrollment = { ...f.enrollment, loginShell: shell, agyPath: agy }, request = { channel: "launch" as const, payload: { command: { commandId: f.enrollment.inventoryId }, nativeParams: {} } }
  const bootstrap = { HOME: root, USER: "destination", PATH: "/usr/bin:/bin", CURRENT_CONFIG: "stale", SOURCE_TOKEN: "source-secret", NVIM: "/old/editor", AGENCY_TOOLS_TOKEN: "old-credential" }
  await writeFile(config, "first"); assert.deepEqual(await invokeDestination(enrollment, request, { environment: bootstrap }), { state: "started" })
  await writeFile(config, "second"); await invokeDestination(enrollment, request, { environment: bootstrap })
  const records = (await readFile(join(root, "observed"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.deepEqual(records.map(row => row.env.CURRENT_CONFIG), ["first", "second"])
  for (const row of records) for (const name of ["SOURCE_TOKEN", "NVIM", "AGENCY_TOOLS_TOKEN"]) assert.equal(row.env[name], undefined)
  assert.deepEqual(records[0].request, request); assert.equal(sanitizedBootstrapEnvironment(bootstrap).HOME, root)
})

test("host-call parser rejects source environments and removes local bridge credentials", async () => {
  const request = { channel: "launch", payload: { command: {}, nativeParams: {} } }
  assert.deepEqual(parseHostCall(request), request)
  for (const raw of [{ ...request, environment: {} }, { ...request, payload: { ...request.payload, environment: { TOKEN: "leak" } } }, { channel: "submit", payload: {} }]) assert.throws(() => parseHostCall(raw))
  let observed: any
  const receipt = await runHostCall(request, { environment: { HOME: "/home/destination", PATH: "/usr/bin", CONFIG: "current", NVIM: "/stale", AGENCY_TOOLS_TOKEN: "secret", AGENCY_BRIDGE_PRIVATE: "private" }, call: async (channel, payload, invocation) => { observed = { channel, payload, invocation }; return { state: "started" } } })
  assert.deepEqual(receipt, { state: "started" }); assert.deepEqual(observed.invocation.environment, { HOME: "/home/destination", PATH: "/usr/bin", CONFIG: "current" })
})

test("remote helper EOF closes bridge transport without stopping its local Handler", async t => {
  const f = bridgeFixture(t), input = new PassThrough(), output = new PassThrough(), handler = { stopped: false }
  const running = serveHostBridge({ input, output, hello: { protocol: "agency-bridge/1", hostId: f.enrollment.hostId, handlerGeneration: f.enrollment.inventoryId, connectionId: f.second.inventoryId, sourceRevision: "c".repeat(40), nodeVersion: "v24.13.0", capabilities: ["snapshot"], outboxCursor: 0 }, call: async () => handler })
  input.end(); await running; assert.equal(handler.stopped, false)
})

test("internal bridge CLI accepts only the enrolled destination executable and login shell", () => {
  assert.deepEqual(parseHostBridgeArguments(["--agy-path", "/opt/agency/agy", "--login-shell", "/bin/bash"]), { agyPath: "/opt/agency/agy", loginShell: "/bin/bash" })
  for (const argv of [[], ["--agy-path", "relative", "--login-shell", "/bin/bash"], ["--agy-path", "/opt/agy", "--login-shell", "/bin/bash", "--token", "secret"], ["--agy-path", "/opt/agy", "--agy-path", "/bin/bash"]]) assert.throws(() => parseHostBridgeArguments(argv))
})

test("local Handler IPC pins the exact generation before forwarding calls", async t => {
  const root = await mkdtemp(join(realpathSync("/tmp"), "agy-ipc-")); t.after(() => rm(root, { recursive: true, force: true }))
  const generation = randomUUID(), hello = { protocol: "agency-bridge/1" as const, hostId: "a".repeat(64), handlerGeneration: generation, connectionId: randomUUID(), sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["snapshot", "invoke"], outboxCursor: 0 }
  const peers: Array<ReturnType<typeof createBridgePeer>> = []
  const server = await bindPrivateSocket(root, "bridge.sock", socket => {
    const peer = createBridgePeer({ input: socket, output: socket, hello }); peers.push(peer)
    peer.onRequest(async () => ({ state: "started" })); peer.sendHello()
  })
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise<void>(resolve => server.close(() => resolve())) })
  await assert.rejects(connectHandlerBridge({ root, hostId: hello.hostId, handlerGeneration: randomUUID() }), /STALE_HANDLER/)
  const peer = await connectHandlerBridge({ root, hostId: hello.hostId, handlerGeneration: generation }); t.after(() => peer.close())
  assert.deepEqual(await peer.request("invoke", {}), { state: "started" })
})

test("short-lived destination CLI sends environment only to its local Handler", async t => {
  const f = bridgeFixture(t), child = f.spawn("unused", [], { env: {}, stdio: ["pipe", "pipe", "pipe"] })
  const local = createBridgePeer({ input: child.stdout, output: child.stdin }), input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = []
  output.on("data", chunk => chunks.push(chunk))
  let observed: any
  f.processes.at(-1)!.peer.onRequest(async (channel, payload) => { observed = { channel, payload }; return { state: "started" } })
  const running = runHostCallCli([], { input, output, environment: { HOME: "/home/destination", CONFIG: "new", NVIM: "stale" }, connect: async () => local })
  input.end(JSON.stringify({ channel: "launch", payload: { command: {}, nativeParams: {} } }) + "\n")
  await running
  assert.equal(observed.channel, "invoke")
  assert.deepEqual(observed.payload.invocation.environment, { HOME: "/home/destination", CONFIG: "new" })
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { ok: true, result: { state: "started" } })
})

test("remote bridge CLI uses one local channel and closes only that channel on EOF", async t => {
  const f = bridgeFixture(t), child = f.spawn("unused", [], { env: {}, stdio: ["pipe", "pipe", "pipe"] }), local = createBridgePeer({ input: child.stdout, output: child.stdin }), input = new PassThrough(), output = new PassThrough()
  let connects = 0
  const running = runHostBridgeCli(["--agy-path", f.enrollment.agyPath, "--login-shell", f.enrollment.loginShell], { input, output, environment: {}, connect: async () => { connects++; return local } })
  const ready = new Promise<void>(resolve => output.once("data", () => resolve()))
  await ready; input.end(); await running
  assert.equal(connects, 1); assert.match((await local.closed).message, /BRIDGE_CLOSED|BRIDGE_EOF/)
})

test("native remote helper preserves framed requests and exits after bridge EOF", async t => {
  const root = await mkdtemp(join(realpathSync("/tmp"), "agy-bridge-")), f = bridgeFixture(t), hello = { protocol: "agency-bridge/1" as const, hostId: f.enrollment.hostId, handlerGeneration: randomUUID(), connectionId: randomUUID(), sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["snapshot"], outboxCursor: 0 }
  const peers: Array<ReturnType<typeof createBridgePeer>> = []
  const server = await bindPrivateSocket(root, "bridge.sock", socket => {
    const peer = createBridgePeer({ input: socket, output: socket, hello: { ...hello, connectionId: randomUUID() } }); peers.push(peer)
    peer.onRequest(async () => ({ hostId: hello.hostId, handlerGeneration: hello.handlerGeneration, backendChoices: ["codex-acp"], agents: [], receipts: [], replayFences: [] })); peer.sendHello()
  })
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/bridge-remote.js", import.meta.url)), root, hello.hostId, hello.handlerGeneration, f.enrollment.agyPath, f.enrollment.loginShell], { stdio: ["pipe", "pipe", "pipe"], env: { HOME: root, PATH: "/usr/bin:/bin" } })
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes.toString() })
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  const client = createBridgePeer({ input: child.stdout, output: child.stdin })
  t.after(async () => { client.close(); child.stdin.end(); await exited; for (const peer of peers) peer.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const observed = await client.ready
  assert.equal(observed.hostId, hello.hostId)
  assert.deepEqual(await client.request("snapshot", {}), { hostId: hello.hostId, handlerGeneration: hello.handlerGeneration, backendChoices: ["codex-acp"], agents: [], receipts: [], replayFences: [] })
  client.close(); assert.equal(await exited, 0); assert.equal(stderr, "")
})

test("internal helper entrypoints reject malformed input without entering public CLI", async () => {
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url))
  for (const argv of [[main, "internal-host-bridge"], [main, "internal-host-call", "unexpected"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, argv), (error: any) => error.code === 70 && error.stderr === "Agency host helper failed\n" && error.stdout === "")
  }
})

test("fresh host snapshots preserve historical executions for fenced retirement replay", async t => {
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn); t.after(() => connection.close())
  const snapshot = connection.snapshot, agent = snapshot.agents[0]!
  const execution = { ...agent.agent, handlerGeneration: randomUUID(), providerGeneration: randomUUID() }
  const historical = { ...snapshot, agents: [{ ...agent, execution, phase: "recoverable" }] }
  assert.deepEqual(parseHostSnapshot(historical, connection.hello).agents[0]?.execution, execution)
  assert.throws(() => parseHostSnapshot({ ...historical, agents: [{ ...agent, execution: { ...execution, hostId: f.second.hostId } }] }, connection.hello), /INVALID_HOST_SNAPSHOT/)
})

test("laptop SSH preserves its authentication agent without transmitting source environment", async t => {
  const previous = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = "/local/private/ssh-agent.sock"
  t.after(() => { if (previous === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previous })
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn)
  t.after(() => connection.close())
  assert.equal(f.calls[0]!.env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK)
  assert.equal(sanitizedBootstrapEnvironment(process.env).SSH_AUTH_SOCK, undefined)
  assert.ok(f.calls[0]!.argv.every(arg => !arg.includes(process.env.SSH_AUTH_SOCK!)))
})