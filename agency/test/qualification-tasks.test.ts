import { runningTaskSession } from "./task-readiness-support.js"
import test from "node:test"
import assert from "node:assert/strict"
import { readFile,writeFile,readdir } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import { qualificationFixture,type QualificationFixture } from "./qualification-support.js"
import { taskMcpPeer } from "./task-test-support.js"
import { createAcpPeer } from "./acp-support.js"
import { until } from "./control-support.js"
import { candidateDescriptor } from "../scripts/qualification/config.js"
import { createHostTaskClient } from "../src/tasks/client.js"
import { createHostRuntimeClient } from "../src/hosts/runtime.js"
import { waitForTask } from "../src/tasks/wait.js"
import { createBridgePeer } from "../src/bridge/codec.js"
import { requestBridgeRead } from "../src/bridge/paging.js"
import { createAgentStore } from "../src/agent/store.js"
import type { TaskCreateInput,TaskRef } from "../src/tasks/types.js"
const report={outcome:"completed",summary:"isolated-worker-report-λ"}
const input=(text:string):TaskCreateInput=>({taskId:randomUUID(),description:"Synthetic isolated task",cwd:"/allocated-by-fixture",backendId:"codex-acp",text})
const json=async(path:string)=>JSON.parse(await readFile(path,"utf8"))
const rows=async(f:QualificationFixture)=> (await readFile(join(f.root,"codex-acp.jsonl"),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))
async function exited(child:import("node:child_process").ChildProcess){if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(resolve=>child.once("close",()=>resolve()));assert.ok(child.exitCode!==null||child.signalCode!==null)}
async function supervisor(f:QualificationFixture){const descriptor=candidateDescriptor(f.config);assert.equal(descriptor.command,f.config.launcherPath);assert.deepEqual(descriptor.env,[]);const child=await f.spawn(descriptor.args as string[]),peer=taskMcpPeer(child.stdout,child.stdin);await peer.initialize();return {child,peer,async close(){peer.close();await exited(child)}}}
async function wrapper(f:QualificationFixture){const child=await f.spawn(["internal-runtime-bridge"]),peer=createBridgePeer({input:child.stdout,output:child.stdin});const hello=await peer.ready;assert.equal(hello.hostId,f.config.hostId);assert.equal(hello.handlerGeneration,(await f.owner()).generation);const route=(r:import("../src/hosts/router.js").HostRoute,signal?:AbortSignal)=>requestBridgeRead(peer,r.channel,r.payload,signal?{signal}:{});const tasks=createHostTaskClient({localHostId:f.config.hostId,route}),runtime=createHostRuntimeClient({localHostId:f.config.hostId,route});return {tasks,runtime,peer,async close(){tasks.close();peer.close();child.stdin.end();await exited(child)}}}
async function counts(f:QualificationFixture,ref:TaskRef){const tasks=await readdir(join(f.paths.persistentRoot,"tasks")),agents=await createAgentStore(f.paths.persistentRoot).inventory(),history=await rows(f),value={tasks:tasks.length,agents:agents.agents.length,starts:agents.commands.filter(c=>c.op==="start").length,sessions:history.filter(x=>x.method==="session/new").length,prompts:history.filter(x=>x.method==="session/prompt").length};assert.deepEqual(tasks,[ref.taskId]);assert.deepEqual(value,{tasks:1,agents:1,starts:1,sessions:1,prompts:1});await writeFile(join(f.root,"task-counts.json"),JSON.stringify(value),{mode:0o600})}

test("the worker executes its injected default-ref MCP after all supervisor links exit",{timeout:90000},async t=>{
  const request=input("qualification-report"),f=await qualificationFixture(t,{provider:"reporting",taskInput:request});request.cwd=f.workspace
  const s=await supervisor(f),created=await s.peer.call("agency_task_create",{hostId:f.config.hostId,input:request});assert.equal(created.isError,false,JSON.stringify(created))
  const ref={hostId:f.config.hostId,taskId:request.taskId};assert.deepEqual(JSON.parse(created.content[0].text).ref,ref)
  const relay=await wrapper(f);await relay.tasks.inspect(ref)
  await until(async()=>await json(join(f.root,"worker-ready.json")).catch(()=>undefined),15000)
  await relay.close();await s.close()
  await writeFile(join(f.root,"release-worker"),"release",{mode:0o600})
  const worker=await until(async()=>await json(join(f.root,"worker-result.json")).catch(()=>undefined),20000)
  assert.deepEqual(worker.ref,ref);assert.deepEqual(worker.argv,worker.descriptor.args);assert.equal(worker.descriptor.name,"agency_tasks");assert.equal(worker.report.isError,false);assert.equal(worker.wrong.isError,true);assert.equal(worker.extra.isError,true);assert.ok(worker.identity);assert.equal(worker.exitCode,0)
  assert.deepEqual(JSON.parse(worker.report.content[0].text).report,report)
  const reportPath=join(f.paths.persistentRoot,"tasks",ref.taskId,"report.json");assert.equal(await readFile(reportPath,"utf8"),JSON.stringify(report));assert.equal(worker.bytesBeforeWrong,JSON.stringify(report));assert.equal(worker.bytesAfterWrong,JSON.stringify(report))
  const record=await json(join(f.paths.persistentRoot,"tasks",ref.taskId,"record.json"));assert.deepEqual(record.ref,ref);assert.equal(record.resultPath,"tasks/"+ref.taskId+"/report.json")
  const replacement=await wrapper(f),a=await replacement.tasks.inspect(ref),b=await replacement.tasks.inspect(ref);assert.deepEqual(a,b);assert.deepEqual(a.report,report)
  const one=await waitForTask(replacement.tasks,ref,{timeoutMs:0}),two=await waitForTask(replacement.tasks,ref,{timeoutMs:0});assert.deepEqual(one,two);assert.equal(one.state,"reported")
  await counts(f,ref);assert.equal(await readFile(reportPath,"utf8"),JSON.stringify(report));await replacement.close();assert.deepEqual(await f.sentinel(),[])
})

test("end_turn without an explicit report remains unreported",{timeout:90000},async t=>{
  const request=input("no-report"),f=await qualificationFixture(t,{taskInput:request});request.cwd=f.workspace;const s=await supervisor(f);assert.equal((await s.peer.call("agency_task_create",{hostId:f.config.hostId,input:request})).isError,false)
  const ref={hostId:f.config.hostId,taskId:request.taskId},w=await wrapper(f)
  await until(async()=>{const value=await w.tasks.inspect(ref);return value.runtime==="idle"?value:undefined},15000)
  const waiting=await waitForTask(w.tasks,ref,{timeoutMs:0});assert.equal(waiting.state,"pending");assert.equal((await w.tasks.inspect(ref)).report,null)
  await assert.rejects(readFile(join(f.paths.persistentRoot,"tasks",ref.taskId,"report.json")),{code:"ENOENT"});await counts(f,ref);await w.close();await s.close();assert.deepEqual(await f.sentinel(),[])
})

test("wait timeout and cancellation leave the held worker running",{timeout:90000},async t=>{
  const request=input("held"),f=await qualificationFixture(t,{taskInput:request});request.cwd=f.workspace;const s=await supervisor(f);assert.equal((await s.peer.call("agency_task_create",{hostId:f.config.hostId,input:request})).isError,false)
  const ref={hostId:f.config.hostId,taskId:request.taskId},w=await wrapper(f);const running=await until(async()=>runningTaskSession(await w.tasks.inspect(ref)),15000)
  assert.ok(running.record.session)
  const agent=await createAgentStore(f.paths.persistentRoot).readAgent(running.record.session!.agentId);assert.ok(agent?.launch)
  assert.equal((await waitForTask(w.tasks,ref,{timeoutMs:0})).state,"pending");assert.equal((await w.tasks.inspect(ref)).runtime,"running")
  const controller=new AbortController(),waiting=waitForTask(w.tasks,ref,{timeoutMs:60000,signal:controller.signal});controller.abort();assert.equal((await waiting).state,"cancelled");assert.equal((await w.tasks.inspect(ref)).runtime,"running")
  const {inventoryLaunches}=await import("../src/handler/inventory.js"),provider=(await inventoryLaunches(join(f.paths.persistentRoot,"launches"))).find(x=>x.record.provider)?.record.provider;assert.ok(provider);assert.ok(await f.adapter.readProcess(provider.group.leader.pid))
  await counts(f,ref);await w.close();await s.close();assert.deepEqual(await f.sentinel(),[])
})

test("two attached views converge after exactly one owner permission resolution",{timeout:90000},async t=>{
  const request=input("permission"),f=await qualificationFixture(t,{taskInput:request});request.cwd=f.workspace;const s=await supervisor(f);assert.equal((await s.peer.call("agency_task_create",{hostId:f.config.hostId,input:request})).isError,false)
  const ref={hostId:f.config.hostId,taskId:request.taskId},w=await wrapper(f),pending=await until(async()=>{const value=await w.runtime.human(f.config.hostId,{op:"agent_permissions"});return value.state==="permissions"&&value.snapshot.pending[0]?value.snapshot:undefined},15000),offer=pending.pending[0]!
  const views=[];for(let i=0;i<2;i++){const child=await f.spawn(["acp"]),peer=createAcpPeer(child.stdout,child.stdin);await peer.request("initialize",{protocolVersion:1});await peer.request("session/load",{sessionId:"agency:"+offer.ref.target.agentId,cwd:f.workspace,mcpServers:[]});const shown=await peer.next("session/request_permission");assert.deepEqual(shown.params.options,offer.options);views.push({child,peer,shown})}
  const stale=await w.runtime.human(f.config.hostId,{op:"agent_permission_decide",commandId:randomUUID(),ref:{...offer.ref,target:{...offer.ref.target,providerGeneration:randomUUID()}},optionId:String(offer.options[0]!.optionId)});assert.ok(stale.state==="permission"&&stale.receipt?.state==="stale")
  assert.equal((await rows(f)).filter(x=>x.result?.outcome).length,0)
  const decided=await w.runtime.human(f.config.hostId,{op:"agent_permission_decide",commandId:randomUUID(),ref:offer.ref,optionId:String(offer.options[0]!.optionId)});assert.ok(decided.state==="permission"&&decided.receipt?.state==="applied")
  views[1]!.peer.respond(views[1]!.shown.id,{outcome:{outcome:"selected",optionId:String(offer.options[1]!.optionId)}})
  await until(async()=>(await rows(f)).filter(x=>x.result?.outcome).length===1?true:undefined)
  for(const view of views){const refreshed=await w.runtime.human(f.config.hostId,{op:"agent_permissions"});assert.ok(refreshed.state==="permissions"&&refreshed.snapshot.pending.length===0);await view.peer.nextState("idle");view.peer.close();view.child.stdin.end();await exited(view.child)}
  assert.equal((await rows(f)).filter(x=>x.result?.outcome).length,1);await counts(f,ref);await w.close();await s.close();assert.deepEqual(await f.sentinel(),[])
})

test("a dropped accepted create reply consumes its allowance across helper restart",{timeout:90000},async t=>{
  const request=input("held"),f=await qualificationFixture(t,{taskInput:request});request.cwd=f.workspace
  const child=await f.spawn(candidateDescriptor(f.config).args as string[]),stream=new PassThrough(),peer=taskMcpPeer(stream,child.stdin),accepted=Promise.withResolvers<any>();let buffer="",drop=false
  child.stdout.on("data",bytes=>{buffer+=String(bytes);let at;while((at=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const frame=JSON.parse(line);if(drop&&frame.id===2){accepted.resolve(frame);continue}stream.write(line+"\n")}});child.stdout.on("end",()=>stream.end())
  await peer.initialize();drop=true;const pending=peer.call("agency_task_create",{hostId:f.config.hostId,input:request});const rejected=assert.rejects(pending,/MCP peer closed/),lost=await accepted.promise;assert.equal(lost.result.isError,false)
  await writeFile(join(f.root,"lost-create-reply.json"),JSON.stringify(lost),{mode:0o600});peer.close();await exited(child);await rejected
  const ref={hostId:f.config.hostId,taskId:request.taskId},w=await wrapper(f);await until(async()=>(await w.tasks.inspect(ref)).runtime==="running"?true:undefined,15000)
  const replacement=await supervisor(f);for(const changed of [request,{...request,taskId:randomUUID(),text:"altered"}])assert.equal((await replacement.peer.call("agency_task_create",{hostId:f.config.hostId,input:changed})).isError,true)
  assert.deepEqual(JSON.parse((await replacement.peer.call("agency_task_inspect",{ref})).content[0].text).ref,ref);assert.equal(JSON.parse((await replacement.peer.call("agency_task_wait",{ref,timeoutMs:0})).content[0].text).state,"pending")
  await counts(f,ref);await replacement.close();w.peer.close();assert.equal((await waitForTask(w.tasks,ref,{timeoutMs:0})).state,"unavailable");await w.close();assert.deepEqual(await f.sentinel(),[])
})
test("an old provider generation cannot decide a replacement session permission",{timeout:90000},async t=>{
  const f=await qualificationFixture(t);assert.equal((await f.command(["status","--json"])).code,0)
  const firstChild=await f.spawn(["acp"]),first=createAcpPeer(firstChild.stdout,firstChild.stdin);await first.request("initialize",{protocolVersion:1});const session=await first.request("session/new",{cwd:f.workspace,mcpServers:[]}),w=await wrapper(f)
  const prompt=first.request("session/prompt",{sessionId:session.sessionId!,prompt:[{type:"text",text:"permission"}]}).catch(error=>({error:String(error)}));await first.next("session/request_permission")
  const before=await w.runtime.human(f.config.hostId,{op:"agent_permissions"});assert.ok(before.state==="permissions");const old=before.snapshot.pending[0]!.ref.target
  const stopId=randomUUID();await w.runtime.session(f.config.hostId,{op:"agent_stop",input:{...old,commandId:stopId}});await until(async()=>{const value=await w.runtime.session(f.config.hostId,{op:"agent_session_command",commandId:stopId,commandGeneration:old.handlerGeneration});return value.state==="session_command"&&value.receipt?.command.result?.outcome==="stopped"?true:undefined},15000);await prompt;first.close();await exited(firstChild)
  const restored=await f.command(["agent","restore",old.agentId,"--expected-handler-generation",old.handlerGeneration,"--command-id",randomUUID(),"--json"]);assert.equal(restored.code,0,restored.stdout+restored.stderr)
  const secondChild=await f.spawn(["acp"]),second=createAcpPeer(secondChild.stdout,secondChild.stdin);await second.request("initialize",{protocolVersion:1});await second.request("session/load",{sessionId:session.sessionId!,cwd:f.workspace,mcpServers:[]})
  const nextPrompt=second.request("session/prompt",{sessionId:session.sessionId!,prompt:[{type:"text",text:"permission"}]});await second.next("session/request_permission")
  const live=await w.runtime.human(f.config.hostId,{op:"agent_permissions"});assert.ok(live.state==="permissions");const offer=live.snapshot.pending[0]!;assert.notEqual(offer.ref.target.providerGeneration,old.providerGeneration)
  const responses=(await rows(f)).filter(x=>x.result?.outcome).length,stale=await w.runtime.human(f.config.hostId,{op:"agent_permission_decide",commandId:randomUUID(),ref:{...offer.ref,target:old},optionId:String(offer.options[0]!.optionId)});assert.ok(stale.state==="permission"&&stale.receipt?.state==="stale");assert.equal((await rows(f)).filter(x=>x.result?.outcome).length,responses)
  const current=await w.runtime.human(f.config.hostId,{op:"agent_permission_decide",commandId:randomUUID(),ref:offer.ref,optionId:String(offer.options[0]!.optionId)});assert.ok(current.state==="permission"&&current.receipt?.state==="applied");await nextPrompt;assert.equal((await rows(f)).filter(x=>x.result?.outcome).length,responses+1)
  second.close();await exited(secondChild);await w.close();assert.deepEqual(await f.sentinel(),[])
})