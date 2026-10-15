import { createHash } from "node:crypto"
import { mkdir, writeFile, readdir } from "node:fs/promises"
import { constants } from "node:fs"
import { join, dirname, relative, resolve, isAbsolute } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, object, keys, hash, id, timestamp, text, providerId, parseProviderSnapshot, type ProviderId, type ProviderSnapshot } from "../../src/catalog/types.js"
import { canonicalJson, parseRequestedSettings, type RequestedSettings, type JsonObject } from "../../src/agent/session-config.js"
import { parseTuple, type AgentTuple } from "../../src/agent/types.js"
import { parsePermissionOffer, parsePermissionSnapshot, type PermissionOffer } from "../../src/agent/permission-types.js"
import { parseTaskRef, type TaskRef } from "../../src/tasks/types.js"
import { sameProcess, sameProcessGeneration, type HandlerGenerationRecord, type ProcessIdentity } from "../../src/platform/types.js"
import type { PlatformPaths } from "../../src/platform/paths.js"
import { parseBinding, parsePrivateConfig, inside, type CandidateBinding } from "./config.js"
import { parseTaskAllowance, taskClaimPath, type TaskAllowance, type TaskClaim } from "./task-guard.js"
import { posixQuote } from "../../src/bridge/bootstrap.js"
export type Role = "laptop" | "A" | "B"
export type Phase = "install" | "synthetic" | "discovery" | "real" | "decision" | "cleanup"
export type FileObservation = {
  path: string; realpath: string; uid: number; gid: number; mode: number
  size: number; sha256: string
}
export type HandlerObservation = {
  record: HandlerGenerationRecord | null
  recordState: "missing" | "valid" | "invalid" | "unavailable"
  socketFirst: "absent" | "present" | "unavailable"
  socketSecond: "absent" | "present" | "unavailable"
  first: ProcessIdentity | null; second: ProcessIdentity | null
  bootId: string; disposition: "absent" | "live" | "replaced" | "ambiguous"
}
export type TargetIntent = {
  role: Role; hostname: string; expectedHostId: string; platform: "darwin" | "linux"
  node: string; home: string; xdgStateHome: string | null
  sourceAllocationRoot: string; packageRoot: string; persistentRoot: string; runtimeRoot: string
  providerFiles: string[]; toolFiles: string[]
}
export type PreflightRequest = {
  version: 1; requestId: string; purpose: "install" | "observe"; target: TargetIntent
  expectedBinding: CandidateBinding; issuedAt: number; deadline: number
}
export type PreflightObservation = {
  request: PreflightRequest; observedAt: number; hostname: string; hostId: string
  node: FileObservation; nodeVersion: "v24.13.0"; bootId: string
  productionPaths: PlatformPaths; production: HandlerObservation
  candidatePaths: PlatformPaths; candidate: HandlerObservation
  candidateBinding: CandidateBinding | null
  files: FileObservation[]; proposedPathsAbsent: string[]
}
export type NativeSelection = {
  providerId: ProviderId; modelId: string; modeId: string; reasoning: string
  settings: RequestedSettings; nativeParams: JsonObject
}
export type DiscoveryEvidence = {
  hostId: string; observedAt: number; commandIds: string[]
  publicTranscriptFile: string; publicTranscriptDigest: string; policyFile: string
  executable: FileObservation; adapterPackage: FileObservation; configFingerprint: string
  provider: ProviderSnapshot; selections: NativeSelection[]
  policyDigest: string; maximumCommands: number; consumedCommands: number
}
export type PromptBudget = {
  role: "supervisor" | "worker"; hostId: string; taskRef: TaskRef | null
  cwd: string; text: string; selection: NativeSelection
  allowedPaths: string[]; allowedEdits: string[]; deadline: number
}
export type Command = {
  operationId: string; hostId: string; file: string; argv: string[]
  stdinFile: null | { path: string; sha256: string }
  kind: "read" | "install" | "start" | "synthetic" | "discovery" | "prompt" | "decision" | "cleanup"
  originalRef: null | { task: TaskRef | null; target: AgentTuple | null; commandId: string | null; submissionId: string | null }
  deadline: number; maximumInvocations: 1
}
export type EvidenceFile = { path: string; sha256: string }
export type CommandReceipt = {
  operationId: string; invocations: 0 | 1; startedAt: number | null; finishedAt: number | null
  outcome: "passed" | "failed" | "ambiguous" | "not-run"; exitCode: number | null
  stdout: EvidenceFile; stderr: EvidenceFile; originalRef: Command["originalRef"]
}
export type ProcessReadback = {
  hostId: string; expected: ProcessIdentity
  firstAt: number; secondAt: number; firstBootId: string; secondBootId: string
  first: ProcessIdentity | null; second: ProcessIdentity | null
  firstGroup: ProcessIdentity[]; secondGroup: ProcessIdentity[]
}
export type PhaseEvidence = {
  version: 1; batchId: string; phase: Phase; artifactDigest: string
  evidenceKind: "fixture" | "live"; outcome: "passed" | "failed" | "ambiguous"
  commands: CommandReceipt[]
  guardClaim: null | { file: EvidenceFile; value: TaskClaim }
  productionBefore: Array<{ hostId: string; observation: HandlerObservation }>
  productionAfter: Array<{ hostId: string; observation: HandlerObservation }>
  candidateBefore: Array<{ hostId: string; observation: HandlerObservation }>
  candidateAfter: Array<{ hostId: string; observation: HandlerObservation; binding: CandidateBinding | null }>
  cleanupReadbacks: ProcessReadback[]
}
export type PhaseResult = {
  phase: Phase; artifactDigest: string; evidenceFile: string; evidenceDigest: string
  artifactFile: string; evidenceKind: "fixture" | "live"
  outcome: "passed" | "failed" | "ambiguous"
  productionBefore: Array<{ hostId: string; observation: HandlerObservation }>
  productionAfter: Array<{ hostId: string; observation: HandlerObservation }>
  candidateBefore: Array<{ hostId: string; observation: HandlerObservation }>
  candidateAfter: Array<{ hostId: string; observation: HandlerObservation; binding: CandidateBinding | null }>
}
export type OwnedCleanup = {
  hostId: string; paths: PlatformPaths; handler: HandlerObservation
  sessions: AgentTuple[]; processes: ProcessIdentity[]
  editors: Array<{ process: ProcessIdentity; serverPath: string; tmuxSocket: string; session: string }>
  allocatedRoots: string[]; exportDirectory: string; deadline: number
}
export type PhaseInput = {
  version: 1; evidenceKind: "fixture" | "live"; batchId: string; phase: Phase
  createdAt: number; expiresAt: number; intent: TargetIntent[]
  preflight: PreflightObservation[]; binding: CandidateBinding
  archives: Array<{ name: string; sha256: string; bytes: number }>
  files: FileObservation[]; commands: Command[]; cleanup: OwnedCleanup[]
  previous: PhaseResult[]; discovery: DiscoveryEvidence[]; prompts: PromptBudget[]
  taskId: string
  taskAllowance: null | { value: TaskAllowance; file: FileObservation; supervisorConfig: FileObservation; claimPath: string }
  permission: null | { parentRealFile: string; parentRealDigest: string; offerFile: EvidenceFile; offer: PermissionOffer; observedAt: number; decisionId: string; optionId: string }
}
export type FrozenPhase = { input: PhaseInput; digest: string }
import { parsePreflightRequest, boundedBytes, inspectPath, claimAbsencePath } from "./preflight.js"
type Validator=(value:unknown)=>unknown
type Schema=Validator|{[key:string]:Schema}
function fail(reason:string):never{throw new Error(reason)}
const check=(v:unknown,s:Schema):void=>{if(typeof s==="function"){s(v);return}const o=object(v);keys(o,Object.keys(s));for(const k of Object.keys(s))check(o[k],s[k]!)}
const one=(...values:unknown[]):Validator=>v=>{if(!values.includes(v))fail("ENUM")}
const list=(s:Schema):Validator=>v=>{if(!Array.isArray(v)||v.length>1024)fail("ARRAY");for(const item of v)check(item,s)}
const nullable=(s:Schema):Validator=>v=>{if(v!==null)check(v,s)}
const string:Validator=v=>{if(typeof v!=="string"||v.includes("\0")||!v.isWellFormed()||Buffer.byteLength(v)>65536)fail("STRING")}
const integer:Validator=v=>{timestamp(v)}
const positive:Validator=v=>{if(timestamp(v)<1)fail("POSITIVE")}
const bool=one(true,false)
const json:Validator=v=>{if(Buffer.byteLength(canonicalJson(object(v)))>65536)fail("JSON_SIZE")}
const processSchema:Schema={bootId:text,pid:positive,birth:text,parentPid:integer,processGroupId:positive,sessionId:positive,uid:integer,gid:integer}
const pathsSchema:Schema={hostKey:hash,persistentRoot:absolutePath,runtimeRoot:absolutePath,handlerSocketPath:absolutePath}
const recordSchema:Schema={version:one(1),hostId:hash,launchBootId:text,generation:id,launchAttemptId:id,launchAttempted:bool,phase:one("launch_pending","identity_published","socket_bound","reconciling","ready","exited_unverified"),process:nullable(processSchema),socketPath:absolutePath,writer:one("launcher","handler","reconciler"),reconciliation:nullable({classified:integer,total:integer,quarantined:integer}),reason:nullable(string)}
const handlerSchema:Schema={record:nullable(recordSchema),recordState:one("missing","valid","invalid","unavailable"),socketFirst:one("absent","present","unavailable"),socketSecond:one("absent","present","unavailable"),first:nullable(processSchema),second:nullable(processSchema),bootId:text,disposition:one("absent","live","replaced","ambiguous")}
const fileSchema:Schema={path:absolutePath,realpath:absolutePath,uid:integer,gid:integer,mode:integer,size:integer,sha256:hash}
const evidenceFileSchema:Schema={path:text,sha256:hash}
const refSchema:Schema={task:nullable(parseTaskRef),target:nullable(parseTuple),commandId:nullable(id),submissionId:nullable(id)}
const selectionSchema:Schema={providerId,modelId:text,modeId:text,reasoning:text,settings:parseRequestedSettings,nativeParams:json}
const beforeSchema:Schema={hostId:hash,observation:handlerSchema},afterSchema:Schema={hostId:hash,observation:handlerSchema,binding:nullable(parseBinding)}
const outcome=one("passed","failed","ambiguous")
const resultSchema:Schema={phase:one("install","synthetic","discovery","real","decision","cleanup"),artifactDigest:hash,evidenceFile:text,evidenceDigest:hash,artifactFile:text,evidenceKind:one("fixture","live"),outcome,productionBefore:list(beforeSchema),productionAfter:list(beforeSchema),candidateBefore:list(beforeSchema),candidateAfter:list(afterSchema)}
const commandSchema:Schema={operationId:id,hostId:hash,file:absolutePath,argv:list(string),stdinFile:nullable(evidenceFileSchema),kind:one("read","install","start","synthetic","discovery","prompt","decision","cleanup"),originalRef:nullable(refSchema),deadline:integer,maximumInvocations:one(1)}
const cleanupSchema:Schema={hostId:hash,paths:pathsSchema,handler:handlerSchema,sessions:list(parseTuple),processes:list(processSchema),editors:list({process:processSchema,serverPath:absolutePath,tmuxSocket:absolutePath,session:text}),allocatedRoots:list(absolutePath),exportDirectory:absolutePath,deadline:integer}
const discoverySchema:Schema={hostId:hash,observedAt:integer,commandIds:list(id),publicTranscriptFile:text,publicTranscriptDigest:hash,policyFile:text,policyDigest:hash,executable:fileSchema,adapterPackage:fileSchema,configFingerprint:hash,provider:parseProviderSnapshot,selections:list(selectionSchema),maximumCommands:positive,consumedCommands:integer}
const promptSchema:Schema={role:one("supervisor","worker"),hostId:hash,taskRef:nullable(parseTaskRef),cwd:absolutePath,text:text,selection:selectionSchema,allowedPaths:list(absolutePath),allowedEdits:list(absolutePath),deadline:integer}
const inputSchema:Schema={version:one(1),evidenceKind:one("fixture","live"),batchId:id,phase:one("install","synthetic","discovery","real","decision","cleanup"),createdAt:integer,expiresAt:integer,intent:list(v=>{const t=object(v);parsePreflightRequest({version:1,requestId:"00000000-0000-4000-8000-000000000000",purpose:"install",target:t,expectedBinding:{sourceRevision:"a".repeat(40),sourceDigest:"a".repeat(64),distDigest:"a".repeat(64),nodeVersion:"v24.13.0",protocol:"agency-bridge/2"},issuedAt:0,deadline:1})}),preflight:list({request:parsePreflightRequest,observedAt:integer,hostname:text,hostId:hash,node:fileSchema,nodeVersion:one("v24.13.0"),bootId:text,productionPaths:pathsSchema,production:handlerSchema,candidatePaths:pathsSchema,candidate:handlerSchema,candidateBinding:nullable(parseBinding),files:list(fileSchema),proposedPathsAbsent:list(absolutePath)}),binding:parseBinding,archives:list({name:text,sha256:hash,bytes:positive}),files:list(fileSchema),commands:list(commandSchema),cleanup:list(cleanupSchema),previous:list(resultSchema),discovery:list(discoverySchema),prompts:list(promptSchema),taskId:id,taskAllowance:nullable({value:parseTaskAllowance,file:fileSchema,supervisorConfig:fileSchema,claimPath:absolutePath}),permission:nullable({parentRealFile:text,parentRealDigest:hash,offerFile:evidenceFileSchema,offer:parsePermissionOffer,observedAt:integer,decisionId:id,optionId:text})}
const claimSchema:Schema={version:one(1),allowanceSha256:hash,operationId:id,requestId:id,hostId:hash,handlerGeneration:id,input:v=>{const a={version:1,batchId:"00000000-0000-4000-8000-000000000000",operationId:"00000000-0000-4000-8000-000000000000",sourceHostId:"a".repeat(64),hostId:"a".repeat(64),handlerGeneration:"00000000-0000-4000-8000-000000000000",binding:{sourceRevision:"a".repeat(40),sourceDigest:"a".repeat(64),distDigest:"a".repeat(64),nodeVersion:"v24.13.0",protocol:"agency-bridge/2"},input:v,notBefore:0,deadline:1};parseTaskAllowance(a)},claimedAt:integer}
const readbackSchema:Schema={hostId:hash,expected:processSchema,firstAt:integer,secondAt:integer,firstBootId:text,secondBootId:text,first:nullable(processSchema),second:nullable(processSchema),firstGroup:list(processSchema),secondGroup:list(processSchema)}
const phaseEvidenceSchema:Schema={version:one(1),batchId:id,phase:one("install","synthetic","discovery","real","decision","cleanup"),artifactDigest:hash,evidenceKind:one("fixture","live"),outcome,commands:list({operationId:id,invocations:one(0,1),startedAt:nullable(integer),finishedAt:nullable(integer),outcome:one("passed","failed","ambiguous","not-run"),exitCode:nullable(v=>{if(typeof v!=="number"||!Number.isSafeInteger(v))fail("EXIT_CODE")}),stdout:evidenceFileSchema,stderr:evidenceFileSchema,originalRef:nullable(refSchema)}),guardClaim:nullable({file:evidenceFileSchema,value:claimSchema}),productionBefore:list(beforeSchema),productionAfter:list(beforeSchema),candidateBefore:list(beforeSchema),candidateAfter:list(afterSchema),cleanupReadbacks:list(readbackSchema)}
const equal=(a:unknown,b:unknown,reason="EVIDENCE_MISMATCH")=>{if(!isDeepStrictEqual(a,b))fail(reason)}
const unique=(values:unknown[],reason="DUPLICATE")=>{if(new Set(values).size!==values.length)fail(reason)}
const digest=(v:unknown)=>createHash("sha256").update(canonicalJson(v)).digest("hex")
const fresh=(at:number,now:number)=>{if(at>now||now-at>300000)fail("STALE_OBSERVATION")}
const window=(at:number,input:PhaseInput)=>{if(at<input.createdAt||at>input.expiresAt)fail("ACTION_WINDOW")}
function validateHandler(h:HandlerObservation):void{
  if((h.recordState==="valid")!==(h.record!==null))fail("HANDLER_RECORD")
  if(h.disposition==="absent"&&(h.first||h.second||h.socketFirst!=="absent"||h.socketSecond!=="absent"||h.recordState!=="missing"&&h.recordState!=="valid"))fail("HANDLER_ABSENCE")
  if(h.disposition==="live"){
    const p=h.record?.process
    if(!p||!h.first||!h.second||h.record?.phase!=="ready"||h.socketFirst!=="present"||h.socketSecond!=="present"||h.bootId!==p.bootId||h.record.launchBootId!==h.bootId||!sameProcess(p,h.first)||!sameProcess(p,h.second))fail("HANDLER_IDENTITY")
  }
}
function frozenFile(input:PhaseInput,file:FileObservation):void{
  const matches=input.files.filter(f=>f.path===file.path)
  if(matches.length!==1)fail("FROZEN_FILE_MISSING")
  equal(matches[0],file,"FILE_CHANGED")
  if(file.realpath!==file.path||(file.mode&0o022)!==0||file.mode>0o777)fail("FILE_AUTHORITY")
}
function nativeSelection(d:DiscoveryEvidence,s:NativeSelection):void{
  const model=d.provider.models.find(m=>m.providerId===s.providerId&&m.modelId===s.modelId)
  if(d.provider.error||d.provider.providerId!==s.providerId||!model||model.reasoning.state!=="values"||!model.reasoning.values.includes(s.reasoning)||model.modes.state!=="values"||!model.modes.values.includes(s.modeId)||!d.selections.some(value=>isDeepStrictEqual(value,s)))fail("NATIVE_SELECTION")
}
const allowed:Record<Phase,string[]>={install:["install","start","read"],synthetic:["synthetic","read"],discovery:["discovery","read"],real:["prompt","read"],decision:["decision","read"],cleanup:["cleanup","read"]}
export function freezePhase(raw:unknown,now:number):FrozenPhase{
  check(raw,inputSchema)
  const input=structuredClone(raw) as PhaseInput
  if(!Number.isSafeInteger(now)||input.createdAt>now||input.expiresAt<=now||input.expiresAt<=input.createdAt||input.expiresAt-input.createdAt>900000)fail("PHASE_WINDOW")
  if(input.intent.length!==3||input.preflight.length!==3||input.cleanup.length!==3)fail("THREE_ENDPOINTS")
  equal([...input.intent.map(t=>t.role)].sort(),["A","B","laptop"])
  unique(input.intent.map(t=>t.expectedHostId));unique(input.intent.map(t=>t.hostname));unique(input.preflight.map(p=>p.hostId));unique(input.files.map(f=>f.path));unique(input.commands.map(c=>c.operationId));unique(input.cleanup.map(c=>c.hostId));unique(input.previous.map(p=>p.phase));unique(input.discovery.map(d=>d.hostId));unique(input.archives.map(a=>a.name))
  if(input.archives.length!==3)fail("ARCHIVES")
  for(const target of input.intent){
    const p=input.preflight.find(p=>p.hostId===target.expectedHostId),cleanup=input.cleanup.find(c=>c.hostId===target.expectedHostId)
    if(!p||!cleanup)fail("TARGET_EVIDENCE")
    equal(p.request.target,target);equal(p.request.expectedBinding,input.binding);fresh(p.observedAt,now)
    if(p.request.issuedAt>p.observedAt||p.request.deadline<p.observedAt||p.request.deadline-p.request.issuedAt>30000||p.request.deadline<=p.request.issuedAt||p.hostname!==target.hostname||p.node.path!==target.node||p.nodeVersion!==input.binding.nodeVersion||p.node.realpath!==target.node)fail("PREFLIGHT_CHANGED")
    frozenFile(input,p.node);for(const file of p.files)frozenFile(input,file)
    equal(p.candidatePaths,{hostKey:p.hostId,persistentRoot:target.persistentRoot,runtimeRoot:target.runtimeRoot,handlerSocketPath:join(target.runtimeRoot,"handler.sock")})
    const runtimePrefix=join(target.platform==="darwin"?"/private/tmp":"/tmp","agy-"),runtimeSuffix="-"+p.hostId.slice(0,12),runtime=p.productionPaths.runtimeRoot
    if(!runtime.startsWith(runtimePrefix)||!runtime.endsWith(runtimeSuffix))fail("CALLER_UID")
    const uidText=runtime.slice(runtimePrefix.length,-runtimeSuffix.length),uid=Number(uidText)
    if(!/^(0|[1-9][0-9]*)$/.test(uidText)||!Number.isSafeInteger(uid))fail("CALLER_UID")
    if([p.node,...p.files].some(f=>f.uid!==0&&f.uid!==uid)||[p.production,p.candidate].some(h=>[h.record?.process,h.first,h.second].some(v=>v&&v.uid!==uid)))fail("CALLER_UID")
    const productionPersistent=join(target.xdgStateHome??join(target.home,".local/state"),"agency/hosts",p.hostId),productionRuntime=join(target.platform==="darwin"?"/private/tmp":"/tmp",`agy-${uid}-${p.hostId.slice(0,12)}`)
    equal(p.productionPaths,{hostKey:p.hostId,persistentRoot:productionPersistent,runtimeRoot:productionRuntime,handlerSocketPath:join(productionRuntime,"handler.sock")})
    const roots=[target.sourceAllocationRoot,target.persistentRoot,target.runtimeRoot]
    for(const [n,root]of roots.entries()){
      for(const other of roots.slice(n+1))if(inside(root,other)||inside(other,root))fail("ROOT_OVERLAP")
      for(const normal of [productionPersistent,productionRuntime,join(target.home,"bin/agy")])if(inside(root,normal)||inside(normal,root))fail("ORDINARY_ROOT")
    }
    for(const h of [p.production,p.candidate]){validateHandler(h);if(h.bootId!==p.bootId)fail("BOOT_CHANGED");if(h.record&&h.record.hostId!==p.hostId)fail("HANDLER_HOST")}
    if(p.production.record?.process&&p.candidate.record?.process&&sameProcessGeneration(p.production.record.process,p.candidate.record.process))fail("PRODUCTION_GENERATION")
    const uncertain=p.production.disposition==="ambiguous"||p.candidate.disposition==="ambiguous"
    if(uncertain&&(input.phase!=="cleanup"||input.commands.some(c=>c.kind!=="read")))fail("AMBIGUOUS_OWNER")
    if(input.phase==="install"){
      if(p.request.purpose!=="install"||p.candidate.record||p.candidate.disposition!=="absent"||p.candidateBinding!==null||!roots.every(root=>p.proposedPathsAbsent.includes(root)))fail("INSTALL_NOT_ABSENT")
    }else{
      if(p.request.purpose!=="observe")fail("OBSERVATION_PURPOSE")
      equal(p.candidateBinding,input.binding)
      if(!uncertain&&input.phase!=="cleanup"&&p.candidate.disposition!=="live")fail("CANDIDATE_NOT_LIVE")
    }
    for(const path of [...target.providerFiles,...target.toolFiles])if(!claimAbsencePath(target,path)&&p.files.filter(f=>f.path===path).length!==1)fail("REQUESTED_FILE_MISSING")
    if(p.files.some(f=>![...target.providerFiles,...target.toolFiles].includes(f.path)))fail("UNREQUESTED_FILE")
    equal(cleanup.paths,p.candidatePaths);equal(cleanup.handler,p.candidate)
    unique(cleanup.allocatedRoots)
    if(cleanup.allocatedRoots.length!==3||cleanup.allocatedRoots.some(root=>!roots.includes(root)))fail("CLEANUP_ALLOCATION")
    if(cleanup.deadline<=input.expiresAt||cleanup.deadline>input.expiresAt+900000)fail("CLEANUP_WINDOW")
    for(const process of [...cleanup.processes,...cleanup.editors.map(e=>e.process)]){
      if(process.bootId!==p.bootId||process.uid!==uid||p.production.record?.process&&sameProcessGeneration(process,p.production.record.process))fail("CLEANUP_AUTHORITY")
    }
    for(const session of cleanup.sessions)if(session.handlerGeneration!==p.candidate.record?.generation)fail("SESSION_GENERATION")
    for(const editor of cleanup.editors)if(!inside(target.runtimeRoot,editor.serverPath)||!inside(target.runtimeRoot,editor.tmuxSocket))fail("EDITOR_AUTHORITY")
  }
  for(const c of input.commands){
    const target=input.intent.find(t=>t.expectedHostId===c.hostId)
    if(!target||!allowed[input.phase].includes(c.kind))fail("COMMAND_PHASE")
    window(c.deadline,input);if(c.deadline<now)fail("COMMAND_EXPIRED")
    if(![target.node,...target.toolFiles].includes(c.file)||!input.preflight.find(p=>p.hostId===c.hostId)!.files.some(f=>f.path===c.file)&&c.file!==target.node)fail("COMMAND_FILE")
    if(c.originalRef){if(c.originalRef.task&&(!input.intent.some(t=>t.expectedHostId===c.originalRef!.task!.hostId)||c.originalRef.task.taskId!==input.taskId))fail("COMMAND_TASK");if(c.originalRef.target&&!input.cleanup.find(x=>x.hostId===c.hostId)?.sessions.some(t=>isDeepStrictEqual(t,c.originalRef!.target)))fail("COMMAND_TARGET")}
  }
  const required:Phase[]=input.phase==="install"?[]:input.phase==="synthetic"?["install"]:input.phase==="discovery"?["install","synthetic"]:["install","synthetic","discovery"]
  equal([...input.previous.map(p=>p.phase)].sort(),[...required].sort(),"PREDECESSORS")
  for(const previous of input.previous){
    if(previous.outcome!=="passed"||previous.evidenceKind!==input.evidenceKind)fail("PREDECESSOR_FAILED")
    equal(previous.productionBefore,previous.productionAfter,"PRODUCTION_CHANGED")
    equal(previous.productionAfter,input.preflight.map(p=>({hostId:p.hostId,observation:p.production})))
    unique(previous.candidateAfter.map(c=>c.hostId))
    if(previous.candidateAfter.length!==3)fail("PREDECESSOR_CANDIDATES")
    for(const c of previous.candidateAfter){equal(c.binding,input.binding);if(!input.intent.some(t=>t.expectedHostId===c.hostId))fail("PREDECESSOR_HOST");validateHandler(c.observation);if(c.observation.record&&c.observation.record.hostId!==c.hostId)fail("CANDIDATE_HOST")}
  }
  const latest=required.at(-1)
  if(latest&&input.phase!=="cleanup")equal(input.previous.find(p=>p.phase===latest)!.candidateAfter,input.preflight.map(p=>({hostId:p.hostId,observation:p.candidate,binding:p.candidateBinding})),"PREDECESSOR_GENERATION")
  const needsDiscovery=["discovery","real","decision"].includes(input.phase)
  if(needsDiscovery&&input.discovery.length!==3||!needsDiscovery&&input.discovery.length)fail("DISCOVERY_EVIDENCE")
  for(const d of input.discovery){
    const p=input.preflight.find(p=>p.hostId===d.hostId),target=input.intent.find(t=>t.expectedHostId===d.hostId)
    if(!p||!target)fail("DISCOVERY_HOST")
    fresh(d.observedAt,now);unique(d.commandIds)
    if(!d.commandIds.length||d.maximumCommands!==d.commandIds.length||d.consumedCommands>d.maximumCommands||input.phase!=="discovery"&&d.consumedCommands!==d.maximumCommands||d.provider.verifiedHandlerGeneration!==p.candidate.record?.generation||d.configFingerprint!==d.provider.fingerprint)fail("DISCOVERY_BUDGET_OR_OWNER")
    frozenFile(input,d.executable);frozenFile(input,d.adapterPackage)
    if(!target.providerFiles.includes(d.executable.path)||!target.providerFiles.includes(d.adapterPackage.path))fail("DISCOVERY_FILES")
    if(input.phase==="discovery")equal(input.commands.filter(c=>c.kind==="discovery"&&c.hostId===d.hostId).map(c=>c.operationId),d.commandIds)
    for(const selection of d.selections)nativeSelection(d,selection)
  }
  if(input.phase==="real"){
    if(input.prompts.length!==2||input.prompts.filter(p=>p.role==="supervisor").length!==1||input.prompts.filter(p=>p.role==="worker").length!==1||input.commands.filter(c=>c.kind==="prompt").length!==1||!input.taskAllowance||input.permission)fail("REAL_BUDGET")
    const supervisor=input.prompts.find(p=>p.role==="supervisor")!,worker=input.prompts.find(p=>p.role==="worker")!,a=input.taskAllowance,source=input.intent.find(t=>t.expectedHostId===supervisor.hostId)!,destination=input.preflight.find(p=>p.hostId===worker.hostId)!
    for(const p of input.prompts){const d=input.discovery.find(d=>d.hostId===p.hostId);if(!d)fail("PROMPT_HOST");nativeSelection(d,p.selection);window(p.deadline,input);if(p.deadline<now||!p.allowedPaths.length||!p.allowedPaths.some(root=>inside(root,p.cwd))||p.allowedEdits.some(path=>!p.allowedPaths.some(root=>inside(root,path))))fail("PROMPT_AUTHORITY")}
    if(supervisor.taskRef!==null)fail("SUPERVISOR_REF")
    equal(worker.taskRef,{hostId:worker.hostId,taskId:input.taskId})
    if(input.commands.find(c=>c.kind==="prompt")!.hostId!==supervisor.hostId)fail("PROMPT_HOST")
    frozenFile(input,a.file);frozenFile(input,a.supervisorConfig)
    equal(a.value.binding,input.binding)
    if(a.value.batchId!==input.batchId||a.value.sourceHostId!==supervisor.hostId||a.value.hostId!==worker.hostId||a.value.handlerGeneration!==destination.candidate.record?.generation||a.value.input.taskId!==input.taskId||a.value.input.cwd!==worker.cwd||a.value.input.text!==worker.text||a.value.input.backendId!==worker.selection.providerId)fail("ALLOWANCE_INPUT")
    equal(a.value.input.settings,worker.selection.settings);equal(a.value.input.nativeParams,worker.selection.nativeParams)
    window(a.value.notBefore,input);window(a.value.deadline,input)
    if(a.value.deadline>worker.deadline||a.claimPath!==taskClaimPath(a.file.path,a.value.operationId)||!inside(join(source.persistentRoot,"qualification/allowances"),a.file.path)||!source.toolFiles.includes(a.claimPath)||!input.preflight.find(p=>p.hostId===source.expectedHostId)!.proposedPathsAbsent.includes(a.claimPath))fail("ALLOWANCE_CLAIM")
    if(!inside(source.persistentRoot,a.supervisorConfig.path))fail("SUPERVISOR_CONFIG")
  }else if(input.prompts.length||input.taskAllowance)fail("UNEXPECTED_PROMPT")
  if(input.phase==="decision"){
    const p=input.permission
    if(!p||input.commands.filter(c=>c.kind==="decision").length>1)fail("DECISION_ANNEX")
    fresh(p.observedAt,now)
    const ref=p.offer.ref,current=input.preflight.find(x=>x.hostId===ref.hostId),command=input.commands.find(c=>c.kind==="decision")
    if(!current||current.candidate.record?.generation!==ref.target.handlerGeneration||!input.cleanup.find(c=>c.hostId===ref.hostId)?.sessions.some(t=>isDeepStrictEqual(t,ref.target))||!p.offer.options.some(o=>o.optionId===p.optionId)||command&&(command.operationId!==p.decisionId||command.hostId!==ref.hostId||command.originalRef?.commandId!==p.decisionId||!isDeepStrictEqual(command.originalRef.target,ref.target)))fail("DECISION_OWNER")
  }else if(input.permission)fail("UNEXPECTED_OFFER")
  return {input,digest:digest(input)}
}
async function evidenceBytes(root:string,file:EvidenceFile,max=1024*1024):Promise<Buffer>{
  if(isAbsolute(file.path)||file.path.split("/").some(c=>c===".."||c===""||c==="."))fail("EVIDENCE_PATH")
  const path=resolve(root,file.path)
  if(!inside(resolve(root),path))fail("EVIDENCE_PATH")
  const bytes=await boundedBytes(path,max)
  if(createHash("sha256").update(bytes).digest("hex")!==file.sha256)fail("EVIDENCE_BYTES_CHANGED")
  return bytes
}
async function evidenceJson(root:string,file:EvidenceFile):Promise<unknown>{return JSON.parse((await evidenceBytes(root,file)).toString("utf8"))}
function assertClaim(input:PhaseInput,e:PhaseEvidence):void{
  if(input.phase!=="real"){if(e.guardClaim)fail("UNEXPECTED_CLAIM");return}
  const a=input.taskAllowance,c=e.guardClaim?.value
  if(!a||!c||c.allowanceSha256!==a.file.sha256||c.operationId!==a.value.operationId||c.hostId!==a.value.hostId||c.handlerGeneration!==a.value.handlerGeneration||c.claimedAt<a.value.notBefore||c.claimedAt>a.value.deadline)fail("MISSING_OR_CHANGED_CLAIM")
  equal(c.input,a.value.input)
}
function validateReadbacks(input:PhaseInput,e:PhaseEvidence):void{
  const expected=input.cleanup.flatMap(c=>[...c.processes,...c.editors.map(e=>e.process),...(c.handler.record?.process?[c.handler.record.process]:[])].map(process=>({hostId:c.hostId,process})))
  const names=new Set<string>(),all=expected.filter(x=>{const key=canonicalJson(x);if(names.has(key))return false;names.add(key);return true})
  if(e.cleanupReadbacks.length!==all.length)fail("CLEANUP_READBACKS")
  const seen=new Set<string>()
  for(const r of e.cleanupReadbacks){
    const match=all.find(x=>x.hostId===r.hostId&&isDeepStrictEqual(x.process,r.expected)),key=canonicalJson({hostId:r.hostId,process:r.expected})
    if(!match||seen.has(key)||r.firstAt<Math.max(input.createdAt,...e.commands.map(c=>c.finishedAt??input.createdAt))||r.secondAt<=r.firstAt||r.secondAt>input.cleanup.find(c=>c.hostId===r.hostId)!.deadline||r.firstBootId!==r.secondBootId)fail("CLEANUP_READBACKS")
    seen.add(key)
    for(const [boot,process,group]of [[r.firstBootId,r.first,r.firstGroup],[r.secondBootId,r.second,r.secondGroup]] as const){
      if(process&&process.bootId!==boot||group.some(p=>p.bootId!==boot||p.processGroupId!==r.expected.processGroupId))fail("READBACK_BOOT_OR_GROUP")
      if(boot!==r.expected.bootId)continue
      if(process&&sameProcessGeneration(r.expected,process))fail("PROCESS_STILL_PRESENT_OR_DRIFTED")
      if(group.some(p=>sameProcessGeneration(r.expected,p))||group.length&&(!process||process.processGroupId!==r.expected.processGroupId))fail("PROCESS_GROUP_PRESENT")
    }
  }
}
export async function verifyPhaseEvidence(input:PhaseInput,root:string):Promise<void>{
  check(input,inputSchema)
  async function verifyFiles(i:PhaseInput,depth=0):Promise<void>{
    if(depth>8)fail("EVIDENCE_DEPTH")
    for(const c of i.commands)if(c.stdinFile)await evidenceBytes(root,c.stdinFile)
    for(const d of i.discovery){const transcript=await evidenceJson(root,{path:d.publicTranscriptFile,sha256:d.publicTranscriptDigest});check(transcript,{hostId:hash,commandIds:list(id),provider:parseProviderSnapshot,selections:list(selectionSchema)});equal(transcript,{hostId:d.hostId,commandIds:d.commandIds,provider:d.provider,selections:d.selections});await evidenceBytes(root,{path:d.policyFile,sha256:d.policyDigest})}
    if(i.taskAllowance){
      const a=i.taskAllowance
      const source=i.intent.find(t=>t.expectedHostId===a.value.sourceHostId)!
      const allowance=await evidenceJson(root,{path:"files/"+a.file.sha256,sha256:a.file.sha256}),config=await evidenceJson(root,{path:"files/"+a.supervisorConfig.sha256,sha256:a.supervisorConfig.sha256})
      equal(parseTaskAllowance(allowance),a.value)
      const c=parsePrivateConfig(config)
      equal(c.taskCreate,{allowancePath:a.file.path,sha256:a.file.sha256});equal(c.binding,i.binding)
      if(c.batchId!==i.batchId||c.hostId!==source.expectedHostId||c.persistentRoot!==source.persistentRoot||c.runtimeRoot!==source.runtimeRoot||c.packageRoot!==source.packageRoot||c.node!==source.node||c.configPath!==a.supervisorConfig.path)fail("SUPERVISOR_CONFIG")
    }
    for(const result of i.previous){
      const path=result.artifactFile
      if(isAbsolute(path)||path.split("/").some(p=>p===".."||p==="."||!p))fail("EVIDENCE_PATH")
      const artifact=JSON.parse((await boundedBytes(join(root,path))).toString("utf8"));check(artifact,{input:inputSchema,digest:hash})
      const frozen=artifact as FrozenPhase
      const validated=freezePhase(frozen.input,frozen.input.createdAt)
      equal(validated,frozen)
      if(frozen.digest!==result.artifactDigest||frozen.input.phase!==result.phase||frozen.input.evidenceKind!==result.evidenceKind||frozen.input.batchId!==i.batchId)fail("ARTIFACT_CHANGED")
      equal(frozen.input.binding,i.binding)
      if(result.phase==="discovery"&&["real","decision"].includes(i.phase))for(const d of i.discovery)equal(d.commandIds,frozen.input.commands.filter(c=>c.kind==="discovery"&&c.hostId===d.hostId).map(c=>c.operationId),"DISCOVERY_COMMANDS")
      const raw=await evidenceJson(root,{path:result.evidenceFile,sha256:result.evidenceDigest});check(raw,phaseEvidenceSchema)
      const e=raw as PhaseEvidence
      if(e.batchId!==i.batchId||e.phase!==result.phase||e.artifactDigest!==result.artifactDigest||e.evidenceKind!==result.evidenceKind||e.outcome!==result.outcome)fail("PHASE_EVIDENCE_CHANGED")
      for(const k of ["productionBefore","productionAfter","candidateBefore","candidateAfter"] as const)equal(e[k],result[k])
      equal(e.productionBefore,frozen.input.preflight.map(p=>({hostId:p.hostId,observation:p.production})))
      equal(e.candidateBefore,frozen.input.preflight.map(p=>({hostId:p.hostId,observation:p.candidate})))
      if(e.outcome==="passed"){
        equal(e.productionBefore,e.productionAfter)
        if(e.candidateAfter.length!==3)fail("CANDIDATE_AFTER")
        for(const c of e.candidateAfter){if(!i.intent.some(t=>t.expectedHostId===c.hostId))fail("CANDIDATE_AFTER");equal(c.binding,i.binding);validateHandler(c.observation);if(c.observation.record&&c.observation.record.hostId!==c.hostId)fail("CANDIDATE_HOST")}
      }
      unique(e.commands.map(c=>c.operationId));equal([...e.commands.map(c=>c.operationId)].sort(),[...frozen.input.commands.map(c=>c.operationId)].sort(),"COMMAND_RECEIPTS")
      for(const c of e.commands){
        const planned=frozen.input.commands.find(p=>p.operationId===c.operationId)!
        equal(c.originalRef,planned.originalRef)
        if(e.outcome==="passed"&&(c.invocations!==1||c.outcome!=="passed"||c.exitCode!==0||c.startedAt===null||c.finishedAt===null||c.startedAt<frozen.input.createdAt||c.finishedAt<c.startedAt||c.finishedAt>planned.deadline||c.finishedAt>i.createdAt))fail("COMMAND_RESULT")
        await evidenceBytes(root,c.stdout);await evidenceBytes(root,c.stderr)
      }
      if(e.guardClaim){
        check(e.guardClaim.value,claimSchema);equal(await evidenceJson(root,e.guardClaim.file),e.guardClaim.value)
        const path=e.guardClaim.file.path,names=(await readdir(join(root,dirname(path)))).filter(name=>name.endsWith(".claim.json"))
        if(names.length!==1||names[0]!==e.guardClaim.value.operationId+".claim.json"||!path.endsWith("/"+names[0]))fail("CLAIM_EXPORT_SET")
      }
      if(e.outcome==="passed"){assertClaim(frozen.input,e);if(frozen.input.phase==="cleanup")validateReadbacks(frozen.input,e);else if(e.cleanupReadbacks.length)fail("UNEXPECTED_READBACKS")}
      await verifyFiles(frozen.input,depth+1)
    }
    if(i.permission){
      const p=i.permission,path=p.parentRealFile
      if(isAbsolute(path)||path.split("/").some(c=>c===".."||c==="."||!c))fail("PARENT_PATH")
      const raw=JSON.parse((await boundedBytes(join(root,path))).toString("utf8"));check(raw,{input:inputSchema,digest:hash})
      const parent=raw as FrozenPhase
      equal(freezePhase(parent.input,parent.input.createdAt),parent)
      if(parent.digest!==p.parentRealDigest||parent.input.phase!=="real"||parent.input.batchId!==i.batchId||parent.input.evidenceKind!==i.evidenceKind||p.observedAt<parent.input.createdAt||p.observedAt>parent.input.expiresAt||i.expiresAt>parent.input.expiresAt)fail("PARENT_REAL")
      equal(parent.input.binding,i.binding)
      const snapshot=parsePermissionSnapshot(await evidenceJson(root,p.offerFile))
      if(!snapshot.pending.some(o=>isDeepStrictEqual(o,p.offer))||snapshot.receipts.some(r=>isDeepStrictEqual(r.ref,p.offer.ref)))fail("OFFER_NOT_PENDING")
      await verifyFiles(parent.input,depth+1)
    }
  }
  await inspectPath(root);await verifyFiles(input)
}
export function renderRunbook(phase:FrozenPhase):string{
  const i=phase.input,lines=[i.evidenceKind==="fixture"?"# SYNTHETIC INPUT — Agency qualification":"# Agency qualification",`Phase: ${i.phase}`,`Artifact digest: ${phase.digest}`,`Batch: ${i.batchId}`,`Window: ${i.createdAt}..${i.expiresAt}`,`Binding: ${canonicalJson(i.binding)}`,`Intent digest: ${digest(i.intent)}`,`Observation digest: ${digest(i.preflight)}`,"","This artifact records authored inputs. Its existence grants no execution authorization. Command kind is a declaration; the operator reviews exact effects.","","## Commands"]
  for(const c of i.commands)lines.push(`Operation: ${c.operationId}; host: ${c.hostId}; deadline: ${c.deadline}; maximum invocations: 1`,"```sh",[c.file,...c.argv].map(posixQuote).join(" "),"```",`Raw argv: ${JSON.stringify(c.argv)}`,`Stdin: ${canonicalJson(c.stdinFile)}`,`Original reference: ${canonicalJson(c.originalRef)}`,"")
  lines.push("## Stop conditions","Stop on host, generation, binding, path, native policy or deadline drift. Preserve ambiguous results. A discovery failure consumes its invocation. Do not replay a submission or create after a lost reply. A normal end_turn does not establish completion. A missing or unexpected human permission offer ends the real exercise.","","## Prompt budget",canonicalJson(i.prompts),"","## Cleanup ownership",canonicalJson(i.cleanup),"Export reports, diagnostics and spend evidence before exact-session stop and exact-generation shutdown --stop-agents. Require two independent boot, birth and group absence readbacks. Preserve ambiguous roots. Production observations must remain unchanged.")
  return lines.join("\n")
}
export async function writeFrozenPhase(directory:string,phase:FrozenPhase):Promise<void>{
  await mkdir(directory,{mode:0o700})
  const marker=join(directory,"incomplete-output.json")
  await writeFile(marker,JSON.stringify({state:"incomplete"}),{flag:"wx",mode:0o600})
  try{
    await writeFile(join(directory,"phase.json"),JSON.stringify(phase),{flag:"wx",mode:0o600})
    await writeFile(join(directory,"runbook.md"),renderRunbook(phase),{flag:"wx",mode:0o600})
    await import("node:fs/promises").then(fs=>fs.unlink(marker))
  }catch{throw new Error("INCOMPLETE_OUTPUT")}
}