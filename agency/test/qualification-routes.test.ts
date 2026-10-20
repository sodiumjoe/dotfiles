import { fixtureBridgeProcess } from "./fixtures/fixture-bridge.js"
import { workerScope } from "./fixtures/run-boundary.js"
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { qualificationFixture } from "./qualification-support.js"

test("status and shutdown use only the private Handler",{timeout:90000},async t=>{
  const f=await qualificationFixture(t), first=await f.command(["status","--json"])
  assert.equal(first.code,0,first.stderr+first.stdout)
  const owner=await f.owner(), second=await f.command(["status","--json"])
  assert.equal(second.code,0,second.stderr)
  assert.deepEqual(await f.owner(),owner)
  assert.equal((await f.command(["doctor","--json"])).code,0)
  assert.ok((await readFile(join(f.root,"hook-entered.jsonl"),"utf8")).includes(owner.generation))
  assert.deepEqual(await f.sentinel(),[])
  const stopped=await f.shutdown();assert.equal(stopped.code,0,stopped.stdout+stopped.stderr)
  await f.verifyCleanup()
})

test("ordinary-path sentinel counts caught filesystem socket URL and rename trips",{timeout:90000},async t=>{
  const f=await qualificationFixture(t),{execFile}=await import("node:child_process"),{promisify}=await import("node:util"),{ordinaryPaths}=await import("../scripts/qualification/config.js")
  const roots=ordinaryPaths(f.config.hostId),file=join(f.root,"sensitivity.jsonl"),preload=new URL("./fixtures/qualification-sentinel.js",import.meta.url).href
  const source=`import {lstatSync,renameSync} from 'node:fs';import {lstat} from 'node:fs/promises';import {Socket} from 'node:net';import {pathToFileURL} from 'node:url';let count=0;for(const fn of [()=>lstatSync(process.argv[1]),()=>renameSync(process.argv[2],process.argv[1]+'/rename'),()=>lstat(pathToFileURL(process.argv[1])),()=>new Socket().connect({path:process.argv[1]+'/socket'})]){try{await fn()}catch(error){if(error.message!=='ORDINARY_PATH_ACCESS')throw error;count++}}process.stdout.write(String(count));`
  const result=await promisify(execFile)(process.execPath,["--import",preload,"--input-type=module","-e",source,roots.runtimeRoot,join(f.root,"absent")],{env:{...process.env,QUALIFICATION_SENTINEL:JSON.stringify({file,roots:[roots.persistentRoot,roots.runtimeRoot]})}})
  assert.equal(result.stdout,"4")
  const trips=(await readFile(file,"utf8")).trim().split("\n").map(line=>JSON.parse(line)).filter(row=>!["bootstrap","identity"].includes(row.operation))
  assert.deepEqual(trips.map(row=>row.operation),["lstatSync","renameSync","lstat","net.connect"])
  assert.deepEqual(await f.sentinel(),[])
})
async function localBridge(f:Awaited<ReturnType<typeof qualificationFixture>>){
  const {connectBridge,buildSshCommand}=await import("../src/bridge/ssh.js"),{spawn}=await import("node:child_process"),{ordinaryPaths}=await import("../scripts/qualification/config.js"),{appendFile}=await import("node:fs/promises")
  const normal=ordinaryPaths(f.config.hostId),enrollment={inventoryId:randomUUID(),hostId:f.config.hostId,hostname:"synthetic-local",agyPath:f.config.launcherPath,loginShell:"/bin/sh"},built=buildSshCommand(enrollment)
  assert.equal(built.file,"ssh");assert.ok(built.argv.at(-1)!.includes(f.config.launcherPath));assert.ok(built.argv.at(-1)!.includes("internal-runtime-bridge"))
  const awaitedScope=await workerScope()
  const transport=await connectBridge(enrollment,{action:"internal-runtime-bridge",requiredCapabilities:["host-identity","runtime-read"],processFactory(file,argv,options){
    assert.equal(file,"ssh");assert.deepEqual(argv,built.argv);assert.equal(options.env.NODE_OPTIONS,undefined)
    const child=f.native("qualification-shell","/bin/sh",["-c","printf 'fixture login noise\\n' >&2; "+argv.at(-1)!],{env:{...options.env,HOME:join(f.root,"home"),QUALIFICATION_ROOT:f.root,QUALIFICATION_SENTINEL:JSON.stringify({file:join(f.root,"sentinel.jsonl"),roots:[normal.persistentRoot,normal.runtimeRoot]}),NODE_OPTIONS:"--import="+new URL("./fixtures/qualification-sentinel.js",import.meta.url).href,AGENCY_TEST_EVIDENCE_ROOT:f.root},stdio:["pipe","pipe","pipe"]},true)
    void appendFile(join(f.root,"ssh-bootstrap.jsonl"),JSON.stringify({pid:child.pid,file,argv,kind:"LOCAL SHELL; NO SSH"})+"\n",{mode:0o600});const scope=awaitedScope;const launch=scope.snapshot().launches.find(value=>value.pid===child.pid)!;return fixtureBridgeProcess(scope,launch.ref,child)
  }})
  return transport
}
test("bridge wrapper carries private hello request reply and cancellation",{timeout:90000},async t=>{
  const f=await qualificationFixture(t);assert.equal((await f.command(["status","--json"])).code,0)
  const owner=await f.owner(),transport=await localBridge(f);t.after(()=>transport.close())
  assert.equal(transport.hello.protocol,"agency-bridge/2");assert.equal(transport.hello.hostId,f.config.hostId);assert.equal(transport.hello.handlerGeneration,owner.generation);assert.equal(transport.hello.sourceRevision,f.config.binding.sourceRevision);assert.equal(transport.hello.nodeVersion,"v24.13.0")
  assert.match(transport.diagnostics,/fixture login noise/)
  assert.deepEqual(await transport.request("host-identity",{}),{hostId:f.config.hostId,handlerGeneration:owner.generation})
  const request={protocol:"agency-agent/3",requestId:randomUUID(),handlerGeneration:owner.generation,op:"agent_permissions"}
  const result:any=await transport.request("runtime-read",request)
  assert.equal(result.ok,true);assert.equal(result.result.snapshot.hostId,f.config.hostId)
  transport.close();await transport.closed
  assert.deepEqual(await f.sentinel(),[])
})
test("reverse relay crosses the wrapper and closes without replay",{timeout:90000},async t=>{
  const f=await qualificationFixture(t);assert.equal((await f.command(["status","--json"])).code,0)
  const {createPagedReads}=await import("../src/bridge/paging.js"),{mkdir}=await import("node:fs/promises"),{createHandlerBridge}=await import("../src/bridge/server.js"),{createHostRouter,registerHostRouter}=await import("../src/hosts/router.js")
  const sourceId="a".repeat(64),relayId="b".repeat(64),root=join(f.root,"source");await mkdir(root,{mode:0o700})
  const bridge=await createHandlerBridge({root,identity:{hostId:sourceId,handlerGeneration:randomUUID()},sourceRevision:f.config.binding.sourceRevision})
  t.after(()=>bridge.close())
  let sends=0,cancels=0;const entered=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<void>()
  bridge.register(["runtime-read","runtime-write"],async({channel,payload,signal})=>{if(channel==="runtime-write"){sends++;return {accepted:true}}if((payload as any).hold){entered.resolve();await new Promise<void>(resolve=>signal.addEventListener("abort",()=>{cancels++;cancelled.resolve();resolve()},{once:true}));return {cancelled:true}}return {source:sourceId,value:"reverse"}})
  const transport=await localBridge(f),router=createHostRouter({hostId:relayId,inventory:{list:async()=>[{hostId:f.config.hostId,inventoryId:randomUUID(),hostname:"private",agyPath:f.config.launcherPath,loginShell:"/bin/sh"}]},local:async()=>{throw new Error("relay local forbidden")},connect:async()=>transport}),sourceRouter=createHostRouter({hostId:sourceId,inventory:{list:async()=>[]},local:(channel,payload,signal)=>bridge.dispatch(channel,payload,signal??new AbortController().signal),connect:async()=>{throw new Error("source outbound forbidden")}})
  registerHostRouter({bridge,router:sourceRouter,hostId:sourceId,handlerGeneration:randomUUID()})
  const reads=createPagedReads((_channel,payload,signal)=>sourceRouter.request(payload as any,signal))
  t.after(()=>{reads.close();transport.close();router.close();sourceRouter.close()})
  transport.peer.onRequest((channel,payload,_requestId,signal)=>["read-open","read-page","read-close"].includes(channel)?reads.request(channel,payload,signal):sourceRouter.request(payload as any,signal))
  const local=await f.bridge()
  assert.deepEqual(await local.request("host-route-read",{hostId:sourceId,channel:"runtime-read",payload:{}}),{source:sourceId,value:"reverse"})
  const controller=new AbortController(),waiting=local.request("host-route-read",{hostId:sourceId,channel:"runtime-read",payload:{hold:true}},{signal:controller.signal,timeoutMs:0})
  await entered.promise;controller.abort(new Error("detached"));await assert.rejects(waiting,/detached/);await cancelled.promise;assert.equal(cancels,1)
  assert.deepEqual(await local.request("host-route",{hostId:sourceId,channel:"runtime-write",payload:{commandId:randomUUID()}}),{accepted:true})
  transport.close();await transport.closed
  const replacement=await localBridge(f)
  replacement.peer.onRequest((channel,payload,_requestId,signal)=>["read-open","read-page","read-close"].includes(channel)?reads.request(channel,payload,signal):sourceRouter.request(payload as any,signal))
  t.after(()=>replacement.close())
  assert.deepEqual(await local.request("host-route-read",{hostId:sourceId,channel:"runtime-read",payload:{}}),{source:sourceId,value:"reverse"})
  replacement.close();await replacement.closed
  assert.equal(sends,1)
  router.close();sourceRouter.close();await bridge.close();local.close()
  assert.deepEqual(await f.sentinel(),[])
})
async function acp(f:Awaited<ReturnType<typeof qualificationFixture>>){const {createAcpPeer}=await import("./acp-support.js"),child=await f.spawn(["acp"]),peer=createAcpPeer(child.stdout,child.stdin);await peer.request("initialize",{protocolVersion:1,clientCapabilities:{},clientInfo:{name:"qualification",version:"1"}});return {peer,child}}
test("ACP discovery and attachment select the private generation",{timeout:90000},async t=>{
  const f=await qualificationFixture(t);assert.equal((await f.command(["status","--json"])).code,0)
  const a=await acp(f),session=await a.peer.request("session/new",{cwd:f.workspace,mcpServers:[]}),b=await acp(f)
  await b.peer.request("session/load",{sessionId:session.sessionId!,cwd:f.workspace,mcpServers:[]})
  b.peer.close();b.child.stdin.end()
  const {createAgentStore}=await import("../src/agent/store.js"),{inventoryLaunches}=await import("../src/handler/inventory.js")
  const store=await createAgentStore(f.paths.persistentRoot).inventory();assert.equal(store.agents.length,1)
  const launches=await inventoryLaunches(join(f.paths.persistentRoot,"launches")),provider=launches.find(row=>row.record.provider)?.record.provider
  assert.ok(provider);assert.ok(await f.adapter.readProcess(provider.group.leader.pid))
  assert.equal((await a.peer.request("session/prompt",{sessionId:session.sessionId!,prompt:[{type:"text",text:"attachment"}]})).stopReason,"end_turn")
  a.peer.close();a.child.stdin.end();assert.deepEqual(await f.sentinel(),[])
})
test("entry open and helper use private editor and tmux paths",{timeout:90000},async t=>{
  const f=await qualificationFixture(t);assert.equal((await f.command(["status","--json"])).code,0)
  const a=await acp(f),session=await a.peer.request("session/new",{cwd:f.workspace,mcpServers:[]}),{createAgentStore}=await import("../src/agent/store.js")
  const record=await createAgentStore(f.paths.persistentRoot).readAgent(String(session.sessionId).slice(7));assert.ok(record?.launch)
  const ref={hostId:f.config.hostId,target:{agentId:record.definition.agentId,handlerGeneration:record.launch.handlerGeneration,providerGeneration:record.launch.providerGeneration}},commandId=randomUUID()
  const result=await f.command(["entry","open","--input-json",JSON.stringify({commandId,...ref}),"--local","--json"]);assert.equal(result.code,0,result.stdout+result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).result.receipt.ref,ref)
  assert.equal((await f.command(["internal-runtime-entry",commandId,"--target-json",JSON.stringify(ref)])).code,0)
  const entries=(await readFile(join(f.root,"entered.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.deepEqual(entries,[{file:"tmux",args:["-S",join(f.paths.runtimeRoot,"entry-tmux.sock"),"attach-session","-t","=qualification-editor"]}])
  for(const [id,target] of [[randomUUID(),ref],[commandId,{...ref,target:{...ref.target,providerGeneration:randomUUID()}}],[commandId,{...ref,target:{...ref.target,handlerGeneration:randomUUID()}}]] as const)assert.notEqual((await f.command(["internal-runtime-entry",id,"--target-json",JSON.stringify(target)])).code,0)
  assert.equal((await readFile(join(f.root,"entered.jsonl"),"utf8")).trim().split("\n").length,1)
  a.peer.close();a.child.stdin.end();assert.deepEqual(await f.sentinel(),[])
})
test("mismatched build or private generation stops before mutation",{timeout:90000},async t=>{
  const f=await qualificationFixture(t),{writeFile}=await import("node:fs/promises"),{launcherText}=await import("../scripts/qualification/config.js")
  for(const [key,value] of Object.entries({sourceRevision:"e".repeat(40),sourceDigest:"e".repeat(64),distDigest:"e".repeat(64),nodeVersion:"v22.0.0",protocol:"agency-bridge/1"})){
    const c={...f.config,configPath:join(f.paths.persistentRoot,key+".json"),binding:{...f.config.binding,[key]:value}}
    await writeFile(c.configPath,JSON.stringify(c),{mode:0o600});
    const {execFile}=await import("node:child_process"),{promisify}=await import("node:util");await assert.rejects(promisify(execFile)(f.config.node,[new URL("./fixtures/qualification-launcher.js",import.meta.url).pathname,"--config",c.configPath,"status","--json"],{env:{...process.env,HOME:join(f.root,"home"),QUALIFICATION_ROOT:f.root,QUALIFICATION_SENTINEL:JSON.stringify({file:join(f.root,"sentinel.jsonl"),roots:Object.values((await import("../scripts/qualification/config.js")).ordinaryPaths(f.config.hostId)).filter((value)=>typeof value==="string").slice(1,3)}),NODE_OPTIONS:"--import="+new URL("./fixtures/qualification-sentinel.js",import.meta.url).href}}))
  }
  await assert.rejects(readFile(join(f.paths.runtimeRoot,"handler.json")))
  const missing=await f.spawn(["acp"]);const {createAcpPeer}=await import("./acp-support.js"),peer=createAcpPeer(missing.stdout,missing.stdin)
  await assert.rejects(peer.request("initialize",{protocolVersion:1,clientCapabilities:{}}));peer.close();missing.stdin.end()
  await assert.rejects(readFile(join(f.paths.runtimeRoot,"handler.json")))
  assert.equal((await f.command(["status","--json"])).code,0)
  const current=await f.owner(),{connectHandlerBridge}=await import("../src/bridge/handler-client.js"),stale=randomUUID()
  await assert.rejects(connectHandlerBridge({root:f.paths.runtimeRoot,hostId:f.config.hostId,handlerGeneration:stale}),/STALE_HANDLER/)
  assert.notEqual((await f.command(["shutdown","--handler-generation",stale,"--command-id",randomUUID(),"--json"])).code,0)
  assert.deepEqual(await f.owner(),current)
  const {createConnection}=await import("node:net"),socket=createConnection(join(f.paths.runtimeRoot,"acp.sock")),stalePeer=createAcpPeer(socket,socket)
  socket.write(JSON.stringify({jsonrpc:"2.0",method:"agency/connect",params:{handlerGeneration:stale,environment:{}}})+"\n")
  await assert.rejects(stalePeer.request("initialize",{protocolVersion:1,clientCapabilities:{}}))
  stalePeer.close();socket.destroy()
  assert.deepEqual(await f.owner(),current)
  assert.deepEqual(await f.sentinel(),[])
})
test("headless private editor binds candidate ACP and detaches without stopping provider",{timeout:90000},async t=>{
  const f=await qualificationFixture(t,{editor:true});assert.ok(f.config.editor)
  assert.equal((await f.command(["status","--json"])).code,0)
  const {writeFile}=await import("node:fs/promises"),{execFile}=await import("node:child_process"),{promisify}=await import("node:util"),{ordinaryPaths}=await import("../scripts/qualification/config.js")
  const script=join(f.root,"headless.lua"),output=join(f.root,"headless.json"),normal=ordinaryPaths(f.config.hostId)
  await writeFile(script,`assert(vim.fn.exepath('agy')==${JSON.stringify(f.config.launcherPath)})
assert(require('agentic.config').acp_providers.agency.command==${JSON.stringify(f.config.launcherPath)})
local done=false
require('sodium.agency.control').command({'doctor'},{},function(err,result) assert(not err); assert(result.ok); done=true end)
assert(vim.wait(15000,function() return done end))
local manager=require('sodium.agency.agentic').new_session({cwd=vim.fn.getcwd(),backend_id='codex-acp'})
assert(vim.wait(20000,function() return manager.session_id~=nil end))
vim.fn.writefile({vim.json.encode({sessionId=manager.session_id,endpoint=manager.agent.transport and manager.agent.transport.pid or vim.NIL})},${JSON.stringify(output)})
require('agentic.session_registry').destroy_session()
vim.wait(500,function() return false end)
AgencyFixture.close_all()
AgencyFixture.complete()
vim.fn.writefile({vim.json.encode(AgencyFixture.registry())},${JSON.stringify(join(f.root,"editor-registry.json"))})`)
  const editor=f.native("editor",f.config.editor.shimPath,["--headless","-i","NONE","-l",script],{cwd:f.workspace,timeout:35000,env:{PATH:process.env.PATH,HOME:join(f.root,"home"),QUALIFICATION_ROOT:f.root,QUALIFICATION_SENTINEL:JSON.stringify({file:join(f.root,"sentinel.jsonl"),roots:[normal.persistentRoot,normal.runtimeRoot]}),NODE_OPTIONS:"--import="+new URL("./fixtures/qualification-sentinel.js",import.meta.url).href,AGENCY_TEST_EVIDENCE_ROOT:f.root,XDG_STATE_HOME:join(f.root,"state"),XDG_CACHE_HOME:join(f.root,"cache"),AGENCY_FIXTURE_PLUGIN_ROOT:f.config.editor.plugins[0]!.path,XDG_DATA_HOME:join(f.root,"data")}},true)
  let editorError="";editor.stderr.on("data",b=>editorError+=String(b));editor.stdout.resume()
  const closed=new Promise<void>(resolve=>editor.once("close",()=>resolve())),pid=editor.pid!,identity=await f.adapter.readProcess(pid)
  await closed;assert.equal(editor.exitCode,0,editorError)
  assert.equal(await f.adapter.readProcess(pid),null);assert.ok(identity)
  const readback=JSON.parse(await readFile(output,"utf8"));assert.match(readback.sessionId,/^agency:/)
  const {inventoryLaunches}=await import("../src/handler/inventory.js"),launches=await inventoryLaunches(join(f.paths.persistentRoot,"launches")),provider=launches.find(row=>row.record.provider)?.record.provider
  assert.ok(provider);assert.ok(await f.adapter.readProcess(provider.group.leader.pid));assert.deepEqual(await f.sentinel(),[])
})

test("a live private Handler must retain its exact startup source and dist binding",{timeout:90000},async t=>{
  const f=await qualificationFixture(t),{writeFile}=await import("node:fs/promises")
  assert.equal((await f.command(["status","--json"])).code,0)
  const current=await f.owner(),path=join(f.paths.runtimeRoot,"qualification-"+current.generation+".json"),bytes=await readFile(path),record=JSON.parse(bytes.toString())
  assert.deepEqual(record,{version:1,hostId:f.config.hostId,generation:current.generation,binding:f.config.binding})
  try{
    for(const patch of [{binding:{...record.binding,sourceDigest:"e".repeat(64)}},{binding:{...record.binding,distDigest:"e".repeat(64)}},{generation:randomUUID()}]){
      await writeFile(path,JSON.stringify({...record,...patch}))
      assert.notEqual((await f.command(["status","--json"])).code,0)
      assert.deepEqual(await f.owner(),current)
    }
  }finally{await writeFile(path,bytes)}
  assert.deepEqual(await f.sentinel(),[])
})

test("qualification launchers close before later providers and ignore foreign ownership files",{timeout:90000},async t=>{
  const scope=await workerScope(),firstLaunch=scope.snapshot().launches.length,f=await qualificationFixture(t),{writeFile}=await import("node:fs/promises")
  await writeFile(join(f.root,"ownership.jsonl"),JSON.stringify({pid:process.pid,identity:await f.adapter.readProcess(process.pid)})+"\n")
  await writeFile(join(f.root,"launches.jsonl"),JSON.stringify({type:"spawn",pid:process.pid})+"\n")
  assert.equal((await f.command(["status","--json"])).code,0)
  const before=scope.snapshot().launches.slice(firstLaunch),command=before.find(value=>value.role==="qualification-command"&&value.close)
  assert.ok(command?.exit);assert.equal(command.exit.code,0)
  const owner=await f.owner();assert.ok(before.some(value=>value.pid===owner.process.pid&&value.reporting==="detached-handler"))
  assert.equal(before.some(value=>value.role==="qualification-provider"),false)
  const a=await acp(f),session=await a.peer.request("session/new",{cwd:f.workspace,mcpServers:[]})
  assert.match(String(session.sessionId),/^agency:/)
  await (await import("./control-support.js")).until(async()=>scope.snapshot().launches.some(value=>value.role==="qualification-provider"&&value.identity)?true:undefined,15000)
  a.peer.close();a.child.stdin.end();await f.verifyCleanup()
  const result=JSON.parse(await readFile(join(f.root,"result.json"),"utf8"))
  assert.equal(result.cleanup,"verified");assert.ok(result.commands.some((value:any)=>value.code===0))
  assert.equal(scope.snapshot().launches.some(value=>value.pid===process.pid),false)
  assert.ok(await f.adapter.readProcess(process.pid))
})

test("failed qualification body retains nonzero command and verified cleanup", { timeout: 90000 }, async t => {
  const {mkdtemp,writeFile}=await import("node:fs/promises"),{execFile}=await import("node:child_process"),{promisify}=await import("node:util")
  const root=await mkdtemp("/tmp/agv-"),file=join(root,"qualification.test.mjs"),output=join(root,"fixture-root")
  await writeFile(file,`import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {qualificationFixture} from ${JSON.stringify(new URL("./qualification-support.js",import.meta.url).href)};test('deliberate failed body',async t=>{const f=await qualificationFixture(t);await writeFile(${JSON.stringify(output)},f.root);assert.equal((await f.command(['status','--json'])).code,0);assert.notEqual((await f.command(['invalid-command','--json'])).code,0);throw new Error('deliberate qualification failure')})`)
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.AGENCY_TEST_WORKER_RUN;delete env.AGENCY_FIXTURE_CONNECTION
  await assert.rejects(promisify(execFile)(process.execPath,["--test",file],{env,timeout:60000}),error=>{assert.equal((error as {code:number}).code,1);assert.match((error as {stdout:string}).stdout,/deliberate qualification failure/);return true})
  const result=JSON.parse(await readFile(join(await readFile(output,"utf8"),"result.json"),"utf8"))
  assert.equal(result.cleanup,"verified");assert.ok(result.commands.some((command:any)=>command.code!==0))
})

test("qualification cleanup does not export verified after a refused queued signal",{timeout:90000},async()=>{
  const {mkdtemp,writeFile}=await import("node:fs/promises"),{execFile}=await import("node:child_process"),{promisify}=await import("node:util")
  const root=await mkdtemp("/tmp/agv-"),file=join(root,"qualification.test.mjs"),output=join(root,"fixture-root")
  await writeFile(file,`import test from 'node:test';import {writeFile} from 'node:fs/promises';import {qualificationFixture} from ${JSON.stringify(new URL("./qualification-support.js",import.meta.url).href)};import {workerScope} from ${JSON.stringify(new URL("./fixtures/run-boundary.js",import.meta.url).href)};test('refused cleanup signal',async t=>{const f=await qualificationFixture(t);await writeFile(${JSON.stringify(output)},f.root);const scope=await workerScope();const ref=scope.intent('unspawned');void scope.signal(ref,'SIGTERM').catch(()=>{});await f.verifyCleanup()})`)
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.AGENCY_TEST_WORKER_RUN;delete env.AGENCY_FIXTURE_CONNECTION
  await assert.rejects(promisify(execFile)(process.execPath,["--test",file],{env,timeout:60000}))
  const result=JSON.parse(await readFile(join(await readFile(output,"utf8"),"result.json"),"utf8"))
  assert.equal(result.cleanup,"incomplete")
  assert.match(result.error,/signal/)
})