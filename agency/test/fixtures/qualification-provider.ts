import assert from "node:assert/strict"
import { readFile,writeFile,appendFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { spawn,type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { taskMcpPeer } from "../task-test-support.js"
import { until } from "../control-support.js"
import { fixtureLaunch,fixtureSpawn } from "./ownership.js"
import { candidateDescriptor,parsePrivateConfig } from "../../scripts/qualification/config.js"
import { parseTaskRef } from "../../src/tasks/types.js"
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
  const launch=fixtureLaunch("worker-task-mcp")
  await appendFile(join(root,"worker-launch.jsonl"),JSON.stringify({type:"intent",...launch,ref,descriptor})+"\n",{mode:0o600})
  helper=spawn(descriptor.command,args,{cwd:process.cwd(),env:{...process.env,NODE_OPTIONS:process.env.NODE_OPTIONS!,QUALIFICATION_SENTINEL:process.env.QUALIFICATION_SENTINEL!,AGENCY_TEST_EVIDENCE_ROOT:root},stdio:["pipe","pipe","pipe"]})
  const current=helper,exit=new Promise<number|null>((resolve,reject)=>{current.once("close",resolve);current.once("error",reject)});let stderr="";current.stderr.on("data",b=>stderr+=String(b))
  const identity=await until(async()=>{try{return await fixtureSpawn(launch,current.pid)??undefined}catch{return undefined}},3000)
  const peer=taskMcpPeer(current.stdout,current.stdin),abort=()=>current.kill("SIGTERM");signal.addEventListener("abort",abort,{once:true})
  try{
    await peer.initialize();signal.throwIfAborted()
    const result=await peer.call("agency_task_report",{report});assert.equal(result.isError,false,JSON.stringify(result));assert.deepEqual(JSON.parse(result.content[0].text).ref,ref);assert.deepEqual(JSON.parse(result.content[0].text).report,report)
    const path=join(config.persistentRoot,"tasks",ref.taskId,"report.json"),bytesBeforeWrong=await readFile(path,"utf8")
    const wrong=await peer.call("agency_task_report",{ref:{...ref,taskId:randomUUID()},report:{outcome:"completed",summary:"wrong"}});assert.equal(wrong.isError,true)
    const bytesAfterWrong=await readFile(path,"utf8");assert.equal(bytesAfterWrong,bytesBeforeWrong)
    const extra=await peer.call("agency_task_create",{hostId:ref.hostId,input:{taskId:randomUUID(),description:"forbidden second worker",cwd:process.cwd(),backendId:"codex-acp",text:"altered"}});assert.equal(extra.isError,true)
    peer.close();const exitCode=await exit;assert.equal(exitCode,0,stderr)
    await writeFile(join(root,"worker-result.json"),JSON.stringify({ref,descriptor,argv:args,identity,report:result,wrong,extra,bytesBeforeWrong,bytesAfterWrong,exitCode,stderr}),{mode:0o600,flag:"wx"})
  }finally{signal.removeEventListener("abort",abort);peer.close();if(current.exitCode===null&&current.signalCode===null)current.kill("SIGTERM");await exit;helper=undefined}
}
async function dispatch(frame:any){
  const params=frame.params??{}
  if(frame.method==="initialize")reply(frame.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true,audio:false,embeddedContext:true}},authMethods:[]})
  else if(frame.method==="session/new"||frame.method==="session/load"){
    assert.equal(params.cwd,process.cwd());assert.ok(Array.isArray(params.mcpServers));descriptors=structuredClone(params.mcpServers);await writeFile(join(root,"worker-descriptors.json"),JSON.stringify(descriptors),{mode:0o600});reply(frame.id,{sessionId,configOptions:options})
  }else if(frame.method==="session/set_config_option"){
    const option=options.find(o=>o.id===params.configId);assert.ok(option);assert.ok(option.options.some(o=>o.value===params.value));option.currentValue=params.value;reply(frame.id,{configOptions:options})
  }else if(frame.method==="session/cancel"){controller?.abort();helper?.kill("SIGTERM")}
  else if(frame.method==="session/prompt"){
    assert.equal(params.sessionId,sessionId);assert.deepEqual(params.prompt,[{type:"text",text:"qualification-report"}]);controller=new AbortController();const signal=controller.signal
    await writeFile(join(root,"worker-ready.json"),JSON.stringify({pid:process.pid,sessionId,descriptors}),{mode:0o600,flag:"wx"})
    await until(async()=>{signal.throwIfAborted();return await readFile(join(root,"release-worker")).then(()=>true,()=>undefined)},30000)
    await executeDescriptor(signal);reply(frame.id,{stopReason:"end_turn"})
  }else if(frame.method)throw new Error("UNSUPPORTED_QUALIFICATION_METHOD")
}
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  const frame=JSON.parse(line);await appendFile(log,JSON.stringify(frame)+"\n",{mode:0o600});void dispatch(frame).catch(async error=>{await writeFile(join(root,"worker-error.json"),JSON.stringify({error:String(error),stack:error.stack}),{mode:0o600});send({jsonrpc:"2.0",id:frame.id,error:{code:-32000,message:String(error)}})})
}
controller?.abort();helper?.kill("SIGTERM")