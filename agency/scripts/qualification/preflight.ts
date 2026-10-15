import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, realpath, open, readdir } from "node:fs/promises"
import { join, relative, parse } from "node:path"
import { homedir, hostname } from "node:os"
import { isDeepStrictEqual, promisify } from "node:util"
import { execFile } from "node:child_process"
import { absolutePath, object, keys, hash, id, timestamp } from "../../src/catalog/types.js"
import { readHostId } from "../../src/platform/host-id.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { readHandlerRecord } from "../../src/platform/private-state.js"
import { sameProcess, sameProcessGeneration, type PlatformAdapter } from "../../src/platform/types.js"
import type { CandidateBinding } from "./config.js"
import type { FileObservation, HandlerObservation, PreflightRequest, PreflightObservation, TargetIntent } from "./batch.js"
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex")
const missing=(error:unknown)=>typeof error==="object"&&error!==null&&"code"in error&&error.code==="ENOENT"
export async function inspectPath(path:string):Promise<import("node:fs").Stats|null>{
  absolutePath(path)
  let current=parse(path).root,absent=false
  for(const part of relative(current,path).split("/").filter(Boolean)){
    current=join(current,part)
    if(absent)continue
    const info=await lstat(current).catch(error=>{if(missing(error))return null;throw new Error("PATH_UNAVAILABLE")})
    if(!info){absent=true;continue}
    if(info.isSymbolicLink())throw new Error("SYMLINK_COMPONENT")
    if(current!==path&&!info.isDirectory())throw new Error("PATH_COMPONENT")
  }
  return absent?null:lstat(path)
}
export async function boundedBytes(path:string,max=16*1024*1024):Promise<Buffer>{
  const info=await inspectPath(path)
  if(!info?.isFile()||info.size>max)throw new Error("FILE_TYPE_OR_SIZE")
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const before=await handle.stat();if(!before.isFile()||before.size>max)throw new Error("FILE_TYPE_OR_SIZE");const bytes=Buffer.alloc(max+1),{bytesRead}=await handle.read(bytes,0,max+1,0),after=await handle.stat();if(bytesRead>max||before.size!==bytesRead||before.ino!==info.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new Error("FILE_CHANGED");return bytes.subarray(0,bytesRead)}finally{await handle.close()}
}
export async function observeFile(path:string):Promise<FileObservation>{
  const before=await inspectPath(path)
  if(!before?.isFile()||(before.mode&0o022)!==0||![0,process.getuid!()].includes(before.uid))throw new Error("FILE_AUTHORITY")
  const bytes=await boundedBytes(path,128*1024*1024),after=await lstat(path)
  if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new Error("FILE_CHANGED")
  return {path,realpath:await realpath(path),uid:after.uid,gid:after.gid,mode:after.mode&0o777,size:bytes.length,sha256:sha(bytes)}
}
async function socketState(path:string):Promise<HandlerObservation["socketFirst"]>{try{const s=await inspectPath(path);return s===null?"absent":s.isSocket()?"present":"unavailable"}catch{return "unavailable"}}
export async function observeHandler(root:string,adapter:PlatformAdapter):Promise<HandlerObservation>{
  const path=join(root,"handler.json"),socket=join(root,"handler.sock")
  async function record(){try{const info=await inspectPath(path);if(!info)return {state:"missing" as const,value:null};return {state:"valid" as const,value:await readHandlerRecord(path)}}catch(error){return {state:missing(error)?"unavailable" as const:"invalid" as const,value:null}}}
  const a=await record(),bootId=await adapter.bootId(),socketFirst=await socketState(socket)
  const first=a.value?.process?await adapter.readProcess(a.value.process.pid):null
  const b=await record(),second=b.value?.process?await adapter.readProcess(b.value.process.pid):null,socketSecond=await socketState(socket),bootAfter=await adapter.bootId()
  let disposition:HandlerObservation["disposition"]="ambiguous"
  if(bootId===bootAfter&&a.state===b.state&&isDeepStrictEqual(a.value,b.value)){
    if(a.state==="missing"&&socketFirst==="absent"&&socketSecond==="absent"&&!first&&!second)disposition="absent"
    const expected=a.value?.process
    if(expected&&a.value?.phase==="ready"&&a.value.socketPath===socket&&socketFirst===socketSecond&&socketFirst!=="unavailable"){
      if(a.value.launchBootId!==bootId&&expected.bootId!==bootId)disposition="replaced"
      else if(!first&&!second&&socketFirst==="absent")disposition="absent"
      else if(first&&second&&sameProcess(expected,first)&&sameProcess(expected,second)&&socketFirst==="present")disposition="live"
      else if(first&&second&&!sameProcessGeneration(expected,first)&&!sameProcessGeneration(expected,second)&&sameProcess(first,second))disposition="replaced"
    }
  }
  return {record:a.value,recordState:a.state,socketFirst,socketSecond,first,second,bootId,disposition}
}
export function parsePreflightRequest(raw:unknown):PreflightRequest{
  const v=object(raw);keys(v,["version","requestId","purpose","target","expectedBinding","issuedAt","deadline"])
  if(v.version!==1||!(["install","observe","cleanup"] as unknown[]).includes(v.purpose))throw new Error("REQUEST_VERSION")
  id(v.requestId);timestamp(v.issuedAt);timestamp(v.deadline)
  const t=object(v.target);keys(t,["role","hostname","expectedHostId","platform","node","home","xdgStateHome","sourceAllocationRoot","packageRoot","persistentRoot","runtimeRoot","providerFiles","toolFiles"])
  if(!["laptop","A","B"].includes(String(t.role))||!["darwin","linux"].includes(String(t.platform))||typeof t.hostname!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(t.hostname))throw new Error("TARGET")
  hash(t.expectedHostId)
  for(const key of ["node","home","sourceAllocationRoot","packageRoot","persistentRoot","runtimeRoot"])absolutePath(t[key])
  if(t.xdgStateHome!==null)absolutePath(t.xdgStateHome)
  for(const key of ["providerFiles","toolFiles"]){if(!Array.isArray(t[key])||t[key].length>256)throw new Error("TARGET_FILES");t[key].forEach(absolutePath);if(new Set(t[key]).size!==t[key].length)throw new Error("TARGET_FILES")}
  if(t.packageRoot!==join(t.sourceAllocationRoot as string,"agency"))throw new Error("ALLOCATION_LAYOUT")
  const b=object(v.expectedBinding);keys(b,["sourceRevision","sourceDigest","distDigest","nodeVersion","protocol"])
  if(typeof b.sourceRevision!=="string"||!/^[a-f0-9]{40}$/.test(b.sourceRevision)||b.nodeVersion!=="v24.13.0"||b.protocol!=="agency-bridge/2")throw new Error("BINDING")
  hash(b.sourceDigest);hash(b.distDigest)
  return structuredClone(v) as PreflightRequest
}
export async function verifyCandidateBuild(root:string,binding:CandidateBinding):Promise<CandidateBinding>{
  const entries=["src","test","scripts","package.json","package-lock.json","tsconfig.json","../tests/neovim","../home/.config/nvim"],manifest=JSON.parse((await boundedBytes(join(root,"dist/build-manifest.json"),65536)).toString("utf8"))
  for(const entry of [...entries,"dist"])if(!await inspectPath(join(root,entry)))throw new Error("BUILD_ROOT_MISSING")
  let count=0,total=0
  async function digest(names:string[]){const h=createHash("sha256");async function visit(path:string,depth=0):Promise<void>{if(relative(root,path)==="dist/build-manifest.json")return;if(++count>30000||depth>40)throw new Error("BUILD_LIMIT");const info=await inspectPath(path);if(!info)throw new Error("BUILD_MISSING");if(info.isDirectory()){for(const name of(await readdir(path)).sort())await visit(join(path,name),depth+1)}else{const bytes=await boundedBytes(path);total+=bytes.length;if(total>512*1024*1024)throw new Error("BUILD_LIMIT");h.update(JSON.stringify([relative(root,path),bytes.length])+"\0").update(bytes)}}for(const name of names)await visit(join(root,name));return h.digest("hex")}
  const sourceDigest=await digest(entries),distDigest=await digest(["dist"])
  if(manifest.version!==1||manifest.sourceRevision!==binding.sourceRevision||manifest.nodeVersion!==binding.nodeVersion||binding.nodeVersion!==process.version||manifest.sourceDigest!==sourceDigest||manifest.distDigest!==distDigest||binding.sourceDigest!==sourceDigest||binding.distDigest!==distDigest||binding.protocol!=="agency-bridge/2")throw new Error("BUILD_CHANGED")
  return {...binding}
}
export function claimAbsencePath(target:TargetIntent,path:string):boolean{return path.startsWith(join(target.persistentRoot,"qualification/allowances")+"/")&&/^[a-f0-9-]{36}\.claim\.json$/.test(relative(join(target.persistentRoot,"qualification/allowances"),path))}
async function collect(request:PreflightRequest):Promise<PreflightObservation>{
  const target=request.target
  if(request.issuedAt>Date.now()||request.deadline< Date.now()||request.deadline-request.issuedAt>30000||request.deadline<=request.issuedAt)throw new Error("REQUEST_WINDOW")
  if(process.platform!==target.platform||process.version!=="v24.13.0"||hostname()!==target.hostname||(process.env.HOME??homedir())!==target.home||(process.env.XDG_STATE_HOME??null)!==target.xdgStateHome||await realpath(process.execPath)!==target.node)throw new Error("TARGET_CHANGED")
  const hostId=await readHostId(target.platform,{lstat,realpath,readFile:async path=>(await boundedBytes(path,65536)).toString("utf8"),execFile:async(file,args)=>promisify(execFile)(file,args,{timeout:2000,maxBuffer:1024*1024,encoding:"utf8",env:{LANG:"C",TZ:"UTC"}})})
  if(hostId!==target.expectedHostId)throw new Error("HOST_CHANGED")
  const adapter=target.platform==="darwin"?createDarwinAdapter():createLinuxAdapter(),bootId=await adapter.bootId(),node=await observeFile(target.node),persistentRoot=join(target.xdgStateHome??join(target.home,".local/state"),"agency/hosts",hostId),runtimeRoot=join(target.platform==="darwin"?"/private/tmp":"/tmp",`agy-${process.getuid!()}-${hostId.slice(0,12)}`)
  const productionPaths={hostKey:hostId,persistentRoot,runtimeRoot,handlerSocketPath:join(runtimeRoot,"handler.sock")},candidatePaths={hostKey:hostId,persistentRoot:target.persistentRoot,runtimeRoot:target.runtimeRoot,handlerSocketPath:join(target.runtimeRoot,"handler.sock")},proposedPathsAbsent:string[]=[],files:FileObservation[]=[]
  const roots=[target.sourceAllocationRoot,target.persistentRoot,target.runtimeRoot]
  const inside=(a:string,b:string)=>a===b||b.startsWith(a+"/")
  for(const [i,root]of roots.entries()){for(const other of roots.slice(i+1))if(inside(root,other)||inside(other,root))throw new Error("ROOT_OVERLAP");for(const other of [persistentRoot,runtimeRoot,join(target.home,"bin/agy")])if(inside(root,other)||inside(other,root))throw new Error("ORDINARY_ROOT");const info=await inspectPath(root);if(!info)proposedPathsAbsent.push(root);else if(!info.isDirectory()||info.uid!==process.getuid!()||(info.mode&0o022)!==0)throw new Error("ROOT_AUTHORITY")}
  if(request.purpose==="install"&&proposedPathsAbsent.length!==3)throw new Error("INSTALL_ROOT_EXISTS")
  for(const path of [...target.providerFiles,...target.toolFiles]){
    if(claimAbsencePath(target,path)){if(await inspectPath(path))throw new Error("CLAIM_EXISTS");proposedPathsAbsent.push(path)}else files.push(await observeFile(path))
  }
  const production=await observeHandler(productionPaths.runtimeRoot,adapter),candidate=await observeHandler(target.runtimeRoot,adapter)
  let candidateBinding:CandidateBinding|null=null
  if(request.purpose!=="install"){
    try{candidateBinding=await verifyCandidateBuild(target.packageRoot,request.expectedBinding)}catch(error){if(request.purpose!=="cleanup")throw error}
    if(candidateBinding&&candidate.disposition==="live"&&candidate.record){const metadata=JSON.parse((await boundedBytes(join(target.runtimeRoot,`qualification-${candidate.record.generation}.json`),65536)).toString("utf8"));keys(object(metadata),["version","hostId","generation","binding"]);if(metadata.version!==1||metadata.hostId!==hostId||metadata.generation!==candidate.record.generation||!isDeepStrictEqual(metadata.binding,candidateBinding))throw new Error("OWNER_BINDING_CHANGED")}
  }
  if(await adapter.bootId()!==bootId||Date.now()>request.deadline)throw new Error("OBSERVATION_EXPIRED")
  return {request,observedAt:Date.now(),hostname:hostname(),hostId,node,nodeVersion:"v24.13.0",bootId,productionPaths,production,candidatePaths,candidate,candidateBinding,files,proposedPathsAbsent}
}
export async function collectPreflight(raw:PreflightRequest):Promise<PreflightObservation>{
  try{return await collect(parsePreflightRequest(raw))}catch(error){const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:"OBSERVATION_UNAVAILABLE";throw new Error(reason)}
}