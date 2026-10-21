import assert from "node:assert/strict"
import { readFile,writeFile,appendFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { spawn,type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { taskMcpPeer } from "../task-test-support.js"
import { until } from "../control-support.js"
import { fixtureRuntime, registerFixtureChild, cleanFixtureEnvironment, finishFixtureSource } from "./fixture-spawn.js"
import { nativeFixtureAccess, type LaunchRef } from "./run-scope.js"
import { candidateDescriptor,parsePrivateConfig } from "../../scripts/qualification/config.js"
import { parseTaskRef } from "../../src/tasks/types.js"
const runtime=await fixtureRuntime(),scope=runtime.scope
let helperRef:LaunchRef|undefined,stopping=Promise.resolve()
const stop=()=>{stopping=stopping.then(async()=>{if(helperRef&&helper&&helper.exitCode===null&&helper.signalCode===null){await runtime.client?.checkpoint();await nativeFixtureAccess(scope).signalPid(helperRef,"SIGTERM")}});void stopping.catch(error=>nativeFixtureAccess(scope).fault(error));return stopping}
const root=process.env.QUALIFICATION_ROOT!
assert.ok(root?.startsWith("/"))
const config=parsePrivateConfig(JSON.parse(await readFile(join(root,"p/config.json"),"utf8")))
const log=join(root,"codex-acp.jsonl"),sessionId="qualification-native",report={outcome:"completed",summary:"isolated-worker-report-λ"}
const options=[{id:"model",name:"Model",type:"select",category:"model",currentValue:"model-a",options:[{value:"model-a",name:"A"},{value:"model-b",name:"B"}]},{id:"reasoning_effort",name:"Reasoning",type:"select",currentValue:"high",options:[{value:"high",name:"High"},{value:"low",name:"Low"}]},{id:"mode",name:"Mode",type:"select",category:"mode",currentValue:"plan",options:[{value:"plan",name:"Plan"},{value:"review",name:"Review"}]}]
let descriptors:unknown,helper:ChildProcessWithoutNullStreams|undefined,controller:AbortController|undefined
const send=(frame:unknown)=>process.stdout.write(JSON.stringify(frame)+"\n")
const reply=(id:unknown,result:unknown)=>send({jsonrpc:"2.0",id,result})
async function executeDescriptor(signal:AbortSignal){
  assert.ok(Array.isArray(descriptors)&&descriptors.length===1)
  const descriptor=descriptors[0];assert.ok(descriptor&&typeof descriptor==="object")
  const args=descriptor.args;assert.ok(Array.isArray(args)&&args.length===3&&args[0]==="internal-task-tools"&&args[1]==="--default-ref-json"&&typeof args[2]==="string")
  const ref=parseTaskRef(JSON.parse(args[2]));assert.deepEqual(descriptor,candidateDescriptor(config,ref))
  assert.equal(descriptor.command,config.launcherPath);assert.deepEqual(descriptor.env,[])
  const launch=scope.intent("worker-task-mcp");helperRef=launch
  const command=descriptor.command;assert.equal(typeof command,"string");assert.ok(typeof command==="string")
  helper=registerFixtureChild(runtime,launch,()=>spawn(command,args,{cwd:process.cwd(),env:cleanFixtureEnvironment(),stdio:"pipe"}),undefined,{observeAfterExec:true})
  const current=helper,exit=new Promise<number|null>((resolve,reject)=>{current.once("close",resolve);current.once("error",reject)});let stderr="";current.stderr.on("data",b=>stderr+=String(b))
  let identity
  const peer=taskMcpPeer(current.stdout,current.stdin),abort=()=>{void stop()};signal.addEventListener("abort",abort,{once:true})
  try{
    await peer.initialize();identity=await scope.observe(launch);signal.throwIfAborted()
    const result=await peer.call("agency_task_report",{report});assert.equal(result.isError,false,JSON.stringify(result));assert.deepEqual(JSON.parse(result.content[0].text).ref,ref);assert.deepEqual(JSON.parse(result.content[0].text).report,report)
    const path=join(config.persistentRoot,"tasks",ref.taskId,"report.json"),bytesBeforeWrong=await readFile(path,"utf8")
    const wrong=await peer.call("agency_task_report",{ref:{...ref,taskId:randomUUID()},report:{outcome:"completed",summary:"wrong"}});assert.equal(wrong.isError,true)
    const bytesAfterWrong=await readFile(path,"utf8");assert.equal(bytesAfterWrong,bytesBeforeWrong)
    const extra=await peer.call("agency_task_create",{hostId:ref.hostId,input:{taskId:randomUUID(),description:"forbidden second worker",cwd:process.cwd(),backendId:"codex-acp",text:"altered"}});assert.equal(extra.isError,true)
    peer.close();const exitCode=await exit;assert.equal(exitCode,0,stderr)
    await writeFile(join(root,"worker-result.json"),JSON.stringify({ref,descriptor,argv:args,identity,report:result,wrong,extra,bytesBeforeWrong,bytesAfterWrong,exitCode,stderr}),{mode:0o600,flag:"wx"})
  }finally{signal.removeEventListener("abort",abort);peer.close();if(current.exitCode===null&&current.signalCode===null)await stop();await exit;helper=undefined;helperRef=undefined}
}
async function dispatch(frame:any){
  const params=frame.params??{}
  if(frame.method==="initialize")reply(frame.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true,audio:false,embeddedContext:true}},authMethods:[]})
  else if(frame.method==="session/new"||frame.method==="session/load"){
    assert.equal(params.cwd,process.cwd());assert.ok(Array.isArray(params.mcpServers));descriptors=structuredClone(params.mcpServers);await writeFile(join(root,"worker-descriptors.json"),JSON.stringify(descriptors),{mode:0o600});reply(frame.id,{sessionId,configOptions:options})
  }else if(frame.method==="session/set_config_option"){
    const option=options.find(o=>o.id===params.configId);assert.ok(option);assert.ok(option.options.some(o=>o.value===params.value));option.currentValue=params.value;reply(frame.id,{configOptions:options})
  }else if(frame.method==="session/cancel"){controller?.abort();void stop()}
  else if(frame.method==="session/prompt"){
    assert.equal(params.sessionId,sessionId);assert.deepEqual(params.prompt,[{type:"text",text:"qualification-report"}]);controller=new AbortController();const signal=controller.signal
    await writeFile(join(root,"worker-ready.json"),JSON.stringify({pid:process.pid,sessionId,descriptors}),{mode:0o600,flag:"wx"})
    await until(async()=>{signal.throwIfAborted();return await readFile(join(root,"release-worker")).then(()=>true,()=>undefined)},30000)
    await executeDescriptor(signal);reply(frame.id,{stopReason:"end_turn"})
  }else if(frame.method)throw new Error("UNSUPPORTED_QUALIFICATION_METHOD")
}
const operations=new Set<Promise<void>>()
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})
process.once("SIGTERM",()=>{controller?.abort();lines.close();process.stdin.destroy()})
process.stdout.on("error",error=>{if((error as NodeJS.ErrnoException).code!=="EPIPE")throw error})
for await(const line of lines){
  const frame=JSON.parse(line);await appendFile(log,JSON.stringify(frame)+"\n",{mode:0o600});const work=scope.operation("provider dispatch",()=>dispatch(frame)).catch(async error=>{await writeFile(join(root,"worker-error.json"),JSON.stringify({error:String(error),stack:error.stack}),{mode:0o600});send({jsonrpc:"2.0",id:frame.id,error:{code:-32000,message:String(error)}})});operations.add(work);void work.finally(()=>operations.delete(work))
}
controller?.abort();await stop();await Promise.allSettled(operations);await finishFixtureSource()