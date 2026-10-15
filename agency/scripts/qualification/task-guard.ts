import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { dirname,join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { Readable,Writable } from "node:stream"
import { object,keys,id,hash,timestamp } from "../../src/catalog/types.js"
import { parseTaskCreateInput } from "../../src/tasks/service.js"
import { parseTaskRequest,type TaskReply } from "../../src/tasks/protocol.js"
import { taskMessages,type TaskCreateInput,type TaskRef } from "../../src/tasks/types.js"
import { openHostAccess } from "../../src/hosts/cli.js"
import type { HostRoute } from "../../src/hosts/router.js"
import type { ControlDependencies } from "../../src/cli/control.js"
import { runTaskToolsCli } from "../../src/tasks/tools-cli.js"
import { parseBinding,privateFile,type PrivateConfig,type CandidateBinding } from "./config.js"
export type TaskAllowance={version:1;batchId:string;operationId:string;sourceHostId:string;hostId:string;handlerGeneration:string;binding:CandidateBinding;input:TaskCreateInput;notBefore:number;deadline:number}
export type TaskClaim={version:1;allowanceSha256:string;operationId:string;requestId:string;hostId:string;handlerGeneration:string;input:TaskCreateInput;claimedAt:number}
export function parseTaskAllowance(raw:unknown):TaskAllowance {
  const v=object(raw);keys(v,["version","batchId","operationId","sourceHostId","hostId","handlerGeneration","binding","input","notBefore","deadline"])
  if(v.version!==1)throw new Error("ALLOWANCE_VERSION")
  const result:TaskAllowance={version:1,batchId:id(v.batchId),operationId:id(v.operationId),sourceHostId:hash(v.sourceHostId),hostId:hash(v.hostId),handlerGeneration:id(v.handlerGeneration),binding:parseBinding(v.binding),input:parseTaskCreateInput(v.input),notBefore:timestamp(v.notBefore),deadline:timestamp(v.deadline)}
  if(result.deadline<=result.notBefore||result.deadline-result.notBefore>900000)throw new Error("ALLOWANCE_WINDOW")
  return result
}
export function taskClaimPath(path:string,operationId:string):string{return join(dirname(path),id(operationId)+".claim.json")}
export function createTaskGuard(c:PrivateConfig,forward:(route:HostRoute,signal?:AbortSignal)=>Promise<unknown>,defaultRef?:TaskRef){
  return async(route:HostRoute,signal?:AbortSignal):Promise<unknown>=>{
    if(route.channel!=="task-read"&&route.channel!=="task-write")return forward(route,signal)
    const request=parseTaskRequest(route.payload)
    const denied=():TaskReply=>({protocol:request.protocol,requestId:request.requestId,hostId:request.hostId,handlerGeneration:request.handlerGeneration,op:request.op,ok:false,error:{code:"INVALID_INPUT",message:taskMessages.INVALID_INPUT}})
    if(route.hostId!==request.hostId||(request.op==="inspect")!==(route.channel==="task-read"))return denied()
    if(request.op!=="create")return forward(route,signal)
    try{
      if(defaultRef||!c.taskCreate)return denied()
      const bytes=await privateFile(c.taskCreate.allowancePath),sha=createHash("sha256").update(bytes).digest("hex"),a=parseTaskAllowance(JSON.parse(bytes.toString("utf8")))
      const now=Date.now()
      if(sha!==c.taskCreate.sha256||a.batchId!==c.batchId||a.sourceHostId!==c.hostId||a.hostId!==request.hostId||a.handlerGeneration!==request.handlerGeneration||!isDeepStrictEqual(a.binding,c.binding)||!isDeepStrictEqual(a.input,request.input)||now<a.notBefore||now>a.deadline||signal?.aborted)return denied()
      const claim:TaskClaim={version:1,allowanceSha256:sha,operationId:a.operationId,requestId:request.requestId,hostId:request.hostId,handlerGeneration:request.handlerGeneration,input:request.input,claimedAt:now}
      const file=await open(taskClaimPath(c.taskCreate.allowancePath,a.operationId),"wx",0o600)
      try{await file.writeFile(JSON.stringify(claim))}finally{await file.close()}
      if(signal?.aborted||Date.now()>a.deadline)return denied()
    }catch{return denied()}
    return forward(route,signal)
  }
}
export async function runPrivateTaskTools(config:PrivateConfig,control:ControlDependencies,streams:{input:Readable;output:Writable},defaultRef?:TaskRef):Promise<void>{
  const access=await openHostAccess(control)
  try{const guard=createTaskGuard(config,access.route,defaultRef);await runTaskToolsCli([],{...streams,control:{...control,hostRoute:(_env,route,signal)=>guard(route,signal)},...(defaultRef?{defaultRef}:{})})}finally{access.close()}
}