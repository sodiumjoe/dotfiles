import assert from "node:assert/strict"
import { spawn, execFile as execFileCallback, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { createLinuxAdapter, type LinuxProcfs } from "../src/platform/linux.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../src/platform/launch-marker.js"
import { sameProcess, processBirthStart, type ProcessIdentity, type PlatformAdapter, type LaunchRecord } from "../src/platform/types.js"

export type DirectGroupAttempt = {
  attemptId: string
  batchId: string
  caseId: string | null
  expectedChildReceiptKey: string | null
  role: "handler" | "provider"
  launchAttemptId: string
  phase: "planned" | "failed_before_spawn" | "spawned" | "registered" | "complete"
  pid: number | null
  expectedDescendantPids: number[]
  registeredIdentityKeys: string[]
  fatalConditions: string[]
  spawnNotAttempted?: boolean
}
export type DirectGroupIdentityReceipt = {
  key: string
  role: "handler" | "provider" | "descendant"
  identity: ProcessIdentity
  starttime: string
  argv0: string
  statState: string
}
export type CaseInventory = { key: string; batchId: string; index: number; name: string; expectedAttemptIds: string[] }
export type CaseResult = { caseId: string; index: number; name: string; result: unknown }
export type ChildReceipt = { key: string; providerAttemptId: string; batchId: string; caseId: string; launchAttemptId: string; phase: string; pid: number | null; ownership: string; registered: boolean; fatalConditions: string[]; signalAttempt: string | null; delivered: boolean | null; outcome: string; error: string | null }
export type FailureClassification = "passed" | "assertion" | "timeout" | "cancelled" | "incomplete" | "infrastructure"
export type SourceEntry = { sourcePath: string; sourceSha256: string; compiledPath: string; compiledSha256: string }
export type DirectGroupBatchReceipt = {
  batchId: string
  target: string
  preflightFingerprint: string
  sourceManifestSha256: string
  sourceEntries: SourceEntry[]
  suitePassed: boolean
  failureClassification: FailureClassification
  execution: CommandResult | null
  cases: CaseInventory[]
  caseResults: CaseResult[]
  children: ChildReceipt[]
  attemptsComplete: boolean
  inventoryComplete: boolean
  readbackComplete: boolean
  attempts: DirectGroupAttempt[]
  identities: DirectGroupIdentityReceipt[]
  cleanupObservationErrors: string[]
  readbackErrors: string[]
  survivorKeys: string[]
  terminalUnreapedKeys: string[]
  fatalConditions: string[]
}
type EvidenceFS = {
  readFile(path: string): Promise<string>
  writeFile(path: string, value: string, options: { mode: number; flag?: string }): Promise<unknown>
  mkdir(path: string, options?: { mode: number }): Promise<unknown>
  readdir(path: string): Promise<string[]>
}
type Binding = Pick<DirectGroupBatchReceipt,"target" | "preflightFingerprint" | "sourceManifestSha256">
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const TARGET = "qa-mydev--02dbd33bb95212175.northwest.stripe.io"
const NODE = "/usr/stripe/nodenv/versions/24.13.0/bin/node"
const NODE_HASH = "53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc"
const VALIDATION_PARENT = "/pay/home/moon/.acp-attachment-validation"
export const CORRECTION_BATCH_ID = "direct-group-correction-batch-1"
const FROZEN_RECEIPT_HASH = "3af135923e56561a4b3b7eb55fc30aea93f13adefa019b2410d95a6638e72633"
const FROZEN_CLEANUP_HASH = "b5a33324a590a459b191e0add32155d2ff2ad22ba23aa333942a8f57a1f45888"
const FROZEN_DIAGNOSTIC_HASH = "32e3e05a3a8052a0d3347cdf360baef93fb483758341b45f4c65e79c6d51fd0c"
const execFile = promisify(execFileCallback)
const packageRoot = fileURLToPath(new URL("../../",import.meta.url))
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const isAbsent = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
const fs: EvidenceFS = { readFile: path => readFile(path,"utf8"), readdir, mkdir, writeFile: async (path,value,options) => {
  const parent = dirname(path)
  const metadata = await lstat(parent)
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid!() && (metadata.mode & 0o777) === 0o700 && await realpath(parent) === parent,"evidence parent must be private and canonical")
  const temporary = options.flag === "wx" ? path : join(parent,randomUUID()+".tmp")
  const handle = await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600)
  try { await handle.writeFile(value); await handle.sync() } finally { await handle.close() }
  if(temporary !== path) await rename(temporary,path)
  const directory = await open(parent,constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
} }

export const LINUX_REAL_CASES = [
  "Linux real procfs identity and group enumeration",
  "Linux production paths canonicalize implicit HOME",
  "Linux before-spawn Handler death releases the unattempted launch",
  "Linux after-attempt Handler death quarantines incomplete identity",
  "Linux identity-published Handler death cleans the exact process group",
  "Linux readiness Handler death cleans the exact process group",
  "Linux active Handler death cleans the exact process group",
  "Linux process-group ambiguity remains checkout-scoped",
  "Linux singleton contenders converge through flock",
] as const

export async function persistAttempt(root: string, batchId: string, role: DirectGroupAttempt["role"], launchAttemptId: string, filesystem = fs, caseId: string | null = null): Promise<DirectGroupAttempt> {
  assert.ok(evidenceBatchId(batchId),"attempt batch ID is invalid")
  assert.match(launchAttemptId,UUID)
  const attempt: DirectGroupAttempt = { attemptId: randomUUID(),batchId,caseId,expectedChildReceiptKey:role==="provider"?randomUUID():null,role,launchAttemptId,phase:"planned",pid:null,expectedDescendantPids:[],registeredIdentityKeys:[],fatalConditions:[] }
  if (caseId !== null) {
    assert.match(caseId, UUID)
    const path = join(dirname(root),"case-inventory",caseId+".json")
    const inventory = JSON.parse(await filesystem.readFile(path)) as CaseInventory
    assert.ok(validCase(inventory) && inventory.batchId === batchId)
    await filesystem.writeFile(path,JSON.stringify({...inventory,expectedAttemptIds:[...inventory.expectedAttemptIds,attempt.attemptId]}),{mode:0o600})
  }
  await filesystem.writeFile(join(root,attempt.attemptId+".json"),JSON.stringify(attempt),{mode:0o600,flag:"wx"})
  return attempt
}

export async function updateAttempt(root: string, attempt: DirectGroupAttempt, changes: Partial<DirectGroupAttempt>, filesystem = fs): Promise<DirectGroupAttempt> {
  assert.match(attempt.attemptId,UUID)
  const path=join(root,attempt.attemptId+".json")
  const previous=JSON.parse(await filesystem.readFile(path)) as DirectGroupAttempt
  assert.equal(previous.batchId,attempt.batchId)
  assert.equal(previous.launchAttemptId,attempt.launchAttemptId)
  assert.ok(validAttempt(previous),"previous attempt schema invalid")
  assert.equal(changes.caseId ?? previous.caseId, previous.caseId)
  assert.equal(changes.expectedChildReceiptKey ?? previous.expectedChildReceiptKey, previous.expectedChildReceiptKey)
  const result={...previous,...changes,attemptId:previous.attemptId,batchId:previous.batchId,launchAttemptId:previous.launchAttemptId,
    expectedDescendantPids:[...new Set([...previous.expectedDescendantPids,...changes.expectedDescendantPids??[]])],
    registeredIdentityKeys:[...new Set([...previous.registeredIdentityKeys,...changes.registeredIdentityKeys??[]])],
    fatalConditions:[...new Set([...previous.fatalConditions,...changes.fatalConditions??[]])]}
  if(previous.pid !== null && result.pid !== previous.pid) throw new Error("attempt PID cannot change")
  if(result.phase === "failed_before_spawn" && (previous.phase !== "planned" || result.pid !== null || result.spawnNotAttempted !== true)) throw new Error("failed-before-spawn needs explicit no-spawn evidence")
  await filesystem.writeFile(path,JSON.stringify(result),{mode:0o600})
  return result
}

export async function persistIdentity(root: string, role: DirectGroupIdentityReceipt["role"], identity: ProcessIdentity, filesystem = fs): Promise<DirectGroupIdentityReceipt> {
  const starttime=processBirthStart(identity.birth)
  assert.notEqual(starttime,null)
  let statState="S"
  if(filesystem===fs&&process.platform==="linux"){
    const {parseLinuxStat}=await import("../src/platform/linux.js")
    const sample=parseLinuxStat(await readFile(`/proc/${identity.pid}/stat`,"utf8"))
    assert.equal(sample.pid,identity.pid);assert.equal(sample.starttime,starttime)
    assert.notEqual(sample.state,"Z","cannot register a terminal-unreaped identity")
    statState=sample.state
  }
  const value: DirectGroupIdentityReceipt={key:randomUUID(),role,identity,starttime:starttime!,argv0:identity.birth.slice(identity.birth.indexOf(":")+1),statState}
  await filesystem.writeFile(join(root,value.key+".json"),JSON.stringify(value),{mode:0o600,flag:"wx"})
  return value
}

function object(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
const uuidValue = (value: unknown): value is string => typeof value === "string" && UUID.test(value)
const pidValue = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 1
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === "string")
const uuids = (value: unknown): value is string[] => strings(value) && value.every(entry => UUID.test(entry)) && new Set(value).size === value.length
export const evidenceBatchId = (value: unknown): value is string => typeof value === "string" && (/^direct-group-batch-[12]$/.test(value) || value === CORRECTION_BATCH_ID)
export const retryBatchId = (value: unknown): value is string => typeof value === "string" && /^direct-group-batch-[12]$/.test(value)
const batch = evidenceBatchId
function validProcess(value: unknown): value is ProcessIdentity {
  return object(value) && typeof value.bootId === "string" && UUID.test(value.bootId) && pidValue(value.pid)
    && typeof value.birth === "string" && processBirthStart(value.birth) !== null
    && ["parentPid","uid","gid"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && pidValue(value.processGroupId) && pidValue(value.sessionId)
}
function validAttempt(value: unknown): value is DirectGroupAttempt {
  return object(value) && uuidValue(value.attemptId) && batch(value.batchId) && uuidValue(value.launchAttemptId)
    && (value.caseId === null || typeof value.caseId === "string" && uuidValue(value.caseId))
    && (value.role === "handler" && value.expectedChildReceiptKey === null || value.role === "provider" && uuidValue(value.expectedChildReceiptKey))
    && ["planned","failed_before_spawn","spawned","registered","complete"].includes(value.phase)
    && (value.pid === null || pidValue(value.pid)) && Array.isArray(value.expectedDescendantPids)
    && value.expectedDescendantPids.every(pidValue) && new Set(value.expectedDescendantPids).size === value.expectedDescendantPids.length
    && uuids(value.registeredIdentityKeys) && strings(value.fatalConditions)
    && (value.spawnNotAttempted === undefined || typeof value.spawnNotAttempted === "boolean")
}
function validIdentity(value: unknown): value is DirectGroupIdentityReceipt {
  return object(value) && uuidValue(value.key) && ["handler","provider","descendant"].includes(value.role) && validProcess(value.identity)
    && typeof value.starttime === "string" && value.starttime === processBirthStart(value.identity.birth)
    && typeof value.argv0 === "string" && value.argv0.length > 0 && value.identity.birth.slice(value.identity.birth.indexOf(":")+1) === value.argv0
    && typeof value.statState === "string" && /^[RSDTWtXxKWPIN]$/.test(value.statState)
}
function validCase(value: unknown): value is CaseInventory {
  return object(value) && uuidValue(value.key) && batch(value.batchId) && Number.isInteger(value.index)
    && value.index >= 0 && value.index < LINUX_REAL_CASES.length && value.name === LINUX_REAL_CASES[value.index] && uuids(value.expectedAttemptIds)
}
function validResult(value: unknown): value is CaseResult {
  return object(value) && uuidValue(value.caseId) && Number.isInteger(value.index) && value.index >= 0
    && value.index < LINUX_REAL_CASES.length && value.name === LINUX_REAL_CASES[value.index] && object(value.result)
}
function validChild(value: unknown): value is ChildReceipt {
  return object(value) && uuidValue(value.key) && uuidValue(value.providerAttemptId) && uuidValue(value.caseId)
    && uuidValue(value.launchAttemptId) && batch(value.batchId) && ["planned","spawned","registered"].includes(value.phase)
    && (value.pid === null || pidValue(value.pid)) && value.ownership === "direct-unreaped-child-handle" && typeof value.registered === "boolean"
    && strings(value.fatalConditions) && (value.signalAttempt === null || value.signalAttempt === "SIGKILL")
    && (value.delivered === null || typeof value.delivered === "boolean") && ["pending","exited","error"].includes(value.outcome)
    && (value.error === null || typeof value.error === "string")
}
function validExecution(value: unknown): value is CommandResult {
  return object(value) && (value.code === null || Number.isInteger(value.code))
    && (value.signal === null || typeof value.signal === "string") && typeof value.stdout === "string"
    && typeof value.stderr === "string" && typeof value.timedOut === "boolean"
}
function validExecutionEnvelope(value: unknown): value is ExecutionEnvelope {
  return object(value) && evidenceBatchId(value.batchId) && object(value.binding) && value.binding.target === TARGET
    && typeof value.binding.preflightFingerprint === "string" && HASH.test(value.binding.preflightFingerprint)
    && typeof value.binding.sourceManifestSha256 === "string" && HASH.test(value.binding.sourceManifestSha256)
    && validExecution(value.result)
}

export function inventoryStatus(attempts: unknown, identities: unknown, cases?: unknown, children?: unknown, batchId?: string): { complete: boolean; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(attempts) || attempts.length === 0 || !attempts.every(validAttempt) || !Array.isArray(identities) || !identities.every(validIdentity)) return {complete:false,errors:["invalid or empty inventory schema"]}
  const keys = new Map(identities.map(entry => [entry.key,entry]))
  if (keys.size !== identities.length) errors.push("duplicate identity key")
  const used = new Set<string>(), attemptKeys = new Set<string>()
  for (const attempt of attempts) {
    if (attemptKeys.has(attempt.attemptId)) errors.push("duplicate attempt UUID")
    attemptKeys.add(attempt.attemptId)
    if (attempt.fatalConditions.length) errors.push("fatal attempt")
    if (attempt.phase === "failed_before_spawn") {
      if (attempt.pid !== null || attempt.spawnNotAttempted !== true || attempt.registeredIdentityKeys.length || attempt.expectedDescendantPids.length) errors.push("invalid no-spawn evidence")
      continue
    }
    if ((attempt.phase !== "registered" && attempt.phase !== "complete") || !pidValue(attempt.pid)) errors.push("incomplete launch registration")
    const registered = attempt.registeredIdentityKeys.map(key => { used.add(key); return keys.get(key) })
    const leader = registered.find(entry => entry?.identity.pid === attempt.pid && entry.role === attempt.role)
    if (!leader || !exactAgencyBirth(leader.identity.birth,agencyLaunchMarker(attempt.role,attempt.launchAttemptId))) errors.push("missing exact leader acknowledgement")
    for (const pid of attempt.expectedDescendantPids) if (!registered.some(entry => entry?.role === "descendant" && entry.identity.pid === pid)) errors.push("missing descendant acknowledgement")
    if (registered.some(entry => entry === undefined)) errors.push("registration key missing")
  }
  for (const entry of identities) if (!used.has(entry.key)) errors.push("unbound identity")
  if (cases !== undefined || children !== undefined || batchId !== undefined) {
    if (!Array.isArray(cases) || !cases.every(validCase) || !Array.isArray(children) || !children.every(validChild)) return {complete:false,errors:[...errors,"invalid case or child schema"]}
    if (cases.length !== LINUX_REAL_CASES.length || !LINUX_REAL_CASES.every((name,index) => cases.filter(value => value.index === index && value.name === name && value.batchId === batchId).length === 1)) errors.push("incomplete case inventory")
    if (new Set(cases.map(value => value.key)).size !== cases.length || new Set(children.map(value => value.key)).size !== children.length) errors.push("duplicate case or child")
    for (const inventory of cases) {
      const launched = attempts.filter(attempt => inventory.expectedAttemptIds.includes(attempt.attemptId))
      const handlers = launched.filter(attempt => attempt.role === "handler").length
      const providers = launched.filter(attempt => attempt.role === "provider").length
      if (inventory.index === 1 ? launched.length !== 0 : handlers < 1 || (inventory.index === 2 || inventory.index === 8 ? providers !== 0 : providers !== 1)) errors.push("case launch obligation missing")
    }
    for (const inventory of cases) for (const id of inventory.expectedAttemptIds) if (!attempts.some(attempt => attempt.attemptId === id && attempt.caseId === inventory.key && attempt.batchId === inventory.batchId)) errors.push("expected attempt missing")
    for (const attempt of attempts) {
      if (attempt.batchId !== batchId || cases.filter(value => value.key === attempt.caseId && value.expectedAttemptIds.includes(attempt.attemptId)).length !== 1) errors.push("unbound or foreign attempt")
      if (attempt.role === "provider" && attempt.phase !== "failed_before_spawn") {
        const matches = children.filter(value => value.key === attempt.expectedChildReceiptKey && value.providerAttemptId === attempt.attemptId && value.launchAttemptId === attempt.launchAttemptId && value.batchId === attempt.batchId && value.caseId === attempt.caseId)
        if (matches.length !== 1) errors.push("expected child receipt missing or unbound")
        else if (!matches[0]!.registered || matches[0]!.pid === null || !attempt.expectedDescendantPids.includes(matches[0]!.pid!) || matches[0]!.fatalConditions.length) errors.push("child registration incomplete")
      }
    }
    for (const child of children) if (attempts.filter(attempt => attempt.expectedChildReceiptKey === child.key && attempt.attemptId === child.providerAttemptId && attempt.batchId === child.batchId && attempt.caseId === child.caseId && attempt.launchAttemptId === child.launchAttemptId).length !== 1) errors.push("foreign child receipt")
  }
  return {complete:errors.length===0,errors}
}

export async function independentIdentityReadback(retained: DirectGroupIdentityReceipt, procfs: LinuxProcfs = {readFile:path=>readFile(path,"utf8"),readdir}): Promise<{survivor:boolean;terminalUnreaped:boolean;markerChanged:boolean}> {
  function stat(value:string){
    const match=/^([1-9]\d*) \(/.exec(value), end=value.lastIndexOf(")")
    if(match===null||end<match[0].length)throw new Error("independent stat malformed")
    const fields=value.slice(end+1).trim().split(/\s+/)
    if(fields.length<20||!/^(0|[1-9]\d*)$/.test(fields[19]!)||!/^[RSDZTWtXxKWPIN]$/.test(fields[0]!))throw new Error("independent stat malformed")
    return {pid:match[1],state:fields[0],starttime:fields[19],group:fields[2],session:fields[3]}
  }
  function owner(value:string){
    const result=[]
    for(const name of ["Uid","Gid"]){
      const values=[...value.matchAll(new RegExp(`^${name}:\\s+(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+[ \\t]*$`,"gm"))]
      if(values.length!==1)throw new Error("independent status malformed")
      result.push(values[0]![1])
    }
    return result
  }
  const boot=(await procfs.readFile("/proc/sys/kernel/random/boot_id")).trim()
  if(!UUID.test(boot))throw new Error("independent boot malformed")
  if(boot!==retained.identity.bootId)return {survivor:false,terminalUnreaped:false,markerChanged:false}
  const base=`/proc/${retained.identity.pid}`
  try{
    const first=stat(await procfs.readFile(base+"/stat"))
    const owner1=owner(await procfs.readFile(base+"/status"))
    const cmd1=await procfs.readFile(base+"/cmdline")
    const second=stat(await procfs.readFile(base+"/stat"))
    const owner2=owner(await procfs.readFile(base+"/status"))
    const cmd2=await procfs.readFile(base+"/cmdline")
    const third=stat(await procfs.readFile(base+"/stat"))
    if(JSON.stringify(first)!==JSON.stringify(second)||JSON.stringify(second)!==JSON.stringify(third)||JSON.stringify(owner1)!==JSON.stringify(owner2)||cmd1!==cmd2)throw new Error("independent observation unstable")
    if(first.pid!==String(retained.identity.pid))throw new Error("independent PID mismatch")
    const survivor=first.starttime===retained.starttime
    const nul=cmd1.indexOf("\0"), argv0=nul<0?cmd1:cmd1.slice(0,nul)
    return {survivor,terminalUnreaped:survivor&&first.state==="Z",markerChanged:survivor&&first.state!=="Z"&&argv0!==retained.argv0}
  }catch(error){if(isAbsent(error))return {survivor:false,terminalUnreaped:false,markerChanged:false};throw error}
}

export function canRetry(value: unknown, binding: Binding): boolean {
  try{
    const r=value as DirectGroupBatchReceipt
    if(!retryBatchId(r.batchId)||r.batchId!=="direct-group-batch-1"||r.target!==TARGET||r.suitePassed!==false||r.attemptsComplete!==true||r.inventoryComplete!==true||r.readbackComplete!==true)return false
    if(!HASH.test(r.sourceManifestSha256)||!HASH.test(r.preflightFingerprint)||r.target!==binding.target||r.sourceManifestSha256!==binding.sourceManifestSha256||r.preflightFingerprint!==binding.preflightFingerprint)return false
    assertSourceManifest(r.sourceEntries,r.sourceManifestSha256)
    if(r.failureClassification!=="assertion"||!validExecution(r.execution)||classifyExecution(r.execution,r.caseResults)!=="assertion")return false
    for(const key of ["cleanupObservationErrors","readbackErrors","survivorKeys","terminalUnreapedKeys","fatalConditions"] as const)if(!Array.isArray(r[key])||r[key].length)return false
    if(r.attempts.some(attempt=>attempt.batchId!==r.batchId))return false
    if(!Array.isArray(r.cases)||!r.cases.every(validCase)||r.cases.some(value=>r.caseResults.filter(result=>result.caseId===value.key&&result.index===value.index&&result.name===value.name).length!==1))return false
    return inventoryStatus(r.attempts,r.identities,r.cases,r.children,r.batchId).complete
  }catch{return false}
}

export async function allocateBatch(root:string,binding:Binding,filesystem=fs):Promise<{batchId:string;directory:string}> {
  assert.equal(binding.target,TARGET)
  for(let number=1;number<=2;number++){
    const batchId=`direct-group-batch-${number}`, directory=join(root,batchId)
    assert.ok(retryBatchId(batchId))
    if(number===2){
      let receipt:unknown
      try{receipt=JSON.parse(await filesystem.readFile(join(root,"direct-group-batch-1","receipt.json")))}catch{throw new Error("batch 1 receipt missing or partial; no eligible retry")}
      if(!canRetry(receipt,binding))throw new Error("batch 1 is terminal or ineligible for retry")
    }
    try{await filesystem.mkdir(directory,{mode:0o700});return {batchId,directory}}catch(error){
      if(typeof error!=="object"||error===null||!("code" in error)||error.code!=="EEXIST")throw error
    }
  }
  throw new Error("direct-group batch allocation exhausted")
}

export async function allocateCorrectionBatch(root:string,binding:Binding,filesystem=fs,reader:typeof readFrozenEvidence=readFrozenEvidence):Promise<{batchId:string;directory:string}>{
  assert.equal(binding.target,TARGET);assert.match(binding.preflightFingerprint,HASH);assert.match(binding.sourceManifestSha256,HASH)
  const receipt=await reader(root,"direct-group-batch-1/receipt.json",4*1024*1024)
  const cleanup=await reader(root,"direct-group-batch-1/cleanup-receipt.json",64*1024)
  const diagnostic=await reader(root,"direct-group-batch-1/diagnostic-receipt.json",64*1024)
  validateFrozenCorrectionEvidence(receipt,cleanup,diagnostic)
  const entries=await filesystem.readdir(root)
  for(const name of ["direct-group-batch-2",CORRECTION_BATCH_ID,"task-6-qualified-receipt.json"])assert.ok(!entries.includes(name),`correction allocation refused existing ${name}`)
  const directory=join(root,CORRECTION_BATCH_ID)
  try{await filesystem.mkdir(directory,{mode:0o700})}catch(error){
    if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="EEXIST")throw new Error("correction batch allocation exhausted")
    throw error
  }
  return {batchId:CORRECTION_BATCH_ID,directory}
}

export async function verifySourceManifest(receipt: DirectGroupBatchReceipt, mode:"index"|"commit", commit?:string, readers?:{index(path:string):Promise<string|Buffer>;working(path:string):Promise<string|Buffer>;commit(path:string,commit:string):Promise<string|Buffer>}):Promise<void>{
  const repository=dirname(packageRoot.replace(/\/$/,""))
  const gitReaders=readers??{
    index:async(path:string)=>(await execFile("/usr/bin/git",["show",`:${path}`],{cwd:repository,encoding:"buffer",maxBuffer:8*1024*1024})).stdout,
    working:async(path:string)=>readFile(join(repository,path)),
    commit:async(path:string,revision:string)=>(await execFile("/usr/bin/git",["show",`${revision}:${path}`],{cwd:repository,encoding:"buffer",maxBuffer:8*1024*1024})).stdout,
  }
  assertSourceManifest(receipt.sourceEntries,receipt.sourceManifestSha256)
  const paths=new Set<string>()
  for(const entry of receipt.sourceEntries){
    assert.ok(/^agency\/(src\/platform\/[a-z-]+\.ts|test\/(fixtures\/[a-z-]+|linux-platform\.test)\.ts|scripts\/qualify-linux\.ts|package\.json)$/.test(entry.sourcePath)&&!paths.has(entry.sourcePath),"source manifest path invalid or duplicate")
    paths.add(entry.sourcePath)
    assert.match(entry.sourceSha256,HASH)
    const bytes=mode==="index"?await gitReaders.index(entry.sourcePath):await gitReaders.commit(entry.sourcePath,commit??"")
    assert.equal(hash(bytes),entry.sourceSha256,`source manifest ${mode} mismatch: ${entry.sourcePath}`)
    if(mode==="index")assert.equal(hash(await gitReaders.working(entry.sourcePath)),entry.sourceSha256,`source manifest working-tree mismatch: ${entry.sourcePath}`)
  }
}

export async function executeWithReadback<T,U>(execute:()=>Promise<T>,readback:()=>Promise<U>):Promise<{execution:T|null;executionError:string|null;readback:U|null;readbackError:string|null}>{
  let execution:T|null=null,executionError:string|null=null,independent:U|null=null,readbackError:string|null=null
  try{execution=await execute()}catch(error){executionError=String(error)}
  finally{try{independent=await readback()}catch(error){readbackError=String(error)}}
  return {execution,executionError,readback:independent,readbackError}
}


export const STAGED_COMPILED_PATHS = [
  "package.json",
  "dist/src/platform/types.js",
  "dist/src/platform/private-state.js",
  "dist/src/platform/paths.js",
  "dist/src/platform/host-id.js",
  "dist/src/platform/launch-marker.js",
  "dist/src/platform/darwin.js",
  "dist/src/platform/linux.js",
  "dist/src/platform/reconcile.js",
  "dist/src/platform/singleton.js",
  "dist/src/platform/startup.js",
  "dist/src/platform/private-socket.js",
  "dist/test/fixtures/handler.js",
  "dist/test/fixtures/provider-tree.js",
  "dist/test/fixtures/singleton-handler.js",
  "dist/test/linux-platform.test.js",
  "dist/scripts/qualify-linux.js",
] as const
export const STAGED_RAW_PATHS = ["src/platform/linux.ts","src/platform/reconcile.ts","scripts/qualify-linux.ts"] as const
type StagedFile = { path:string;sha256:string;contents:string }
export type BatchInput = { batchId:string;sourceRoot:string;stateRoot:string;binding:Binding;sourceEntries:SourceEntry[];files:StagedFile[] }
type CommandResult = {code:number|null;signal:string|null;stdout:string;stderr:string;timedOut:boolean}
type ExecutionEnvelope = {batchId:string;binding:Binding;result:CommandResult}

function assertSourceManifest(entries: SourceEntry[], fingerprint: string): void {
  assert.ok(Array.isArray(entries) && entries.length === STAGED_COMPILED_PATHS.length,"source manifest closure incomplete")
  for (const [index,compiledPath] of STAGED_COMPILED_PATHS.entries()) {
    const entry = entries[index]
    assert.ok(object(entry),"source manifest entry invalid")
    assert.equal(entry.compiledPath,compiledPath,"source manifest compiled path mismatch")
    assert.equal(entry.sourcePath,"agency/"+compiledPath.replace(/^dist\//,"").replace(/\.js$/,".ts"),"source manifest mapping mismatch")
    assert.match(entry.sourceSha256,HASH)
    assert.match(entry.compiledSha256,HASH)
    if(compiledPath==="package.json")assert.equal(entry.sourceSha256,entry.compiledSha256,"source manifest package mismatch")
  }
  assert.equal(hash(JSON.stringify(entries)),fingerprint,"source manifest fingerprint mismatch")
}

export async function qualificationArtifactInventory():Promise<{files:StagedFile[];sourceEntries:SourceEntry[];sourceManifestSha256:string}>{
  const files:StagedFile[]=[],sourceEntries:SourceEntry[]=[]
  for(const compiledPath of STAGED_COMPILED_PATHS){
    const source=compiledPath==="package.json" ? compiledPath : compiledPath.replace(/^dist\//,"").replace(/\.js$/,".ts")
    const sourceBytes=await readFile(join(packageRoot,source)),compiledBytes=await readFile(join(packageRoot,compiledPath))
    const entry={sourcePath:"agency/"+source,sourceSha256:hash(sourceBytes),compiledPath,compiledSha256:hash(compiledBytes)}
    sourceEntries.push(entry)
    files.push({path:compiledPath,sha256:entry.compiledSha256,contents:compiledBytes.toString("base64")})
  }
  for(const path of STAGED_RAW_PATHS){
    const bytes=await readFile(join(packageRoot,path))
    files.push({path,sha256:hash(bytes),contents:bytes.toString("base64")})
  }
  return {files,sourceEntries,sourceManifestSha256:hash(JSON.stringify(sourceEntries))}
}

async function remotePreflight():Promise<Record<string,unknown>>{
  const f=await import("node:fs/promises"),c=await import("node:crypto"),o=await import("node:os")
  const require=(condition:boolean,message:string)=>{if(!condition)throw new Error(message)}
  const target="qa-mydev--02dbd33bb95212175.northwest.stripe.io",node="/usr/stripe/nodenv/versions/24.13.0/bin/node",nodeHash="53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc",parent="/pay/home/moon/.acp-attachment-validation"
  require(process.platform==="linux"&&process.arch==="x64","remote platform drift")
  require(process.getuid!()===12683&&process.getgid!()===9000,"remote owner drift")
  require(o.hostname()===target||o.hostname()===target.split(".")[0],"remote target drift")
  require(process.execPath===node&&process.version==="v24.13.0","remote Node drift")
  const sha=(bytes:Buffer)=>c.createHash("sha256").update(bytes).digest("hex")
  require(sha(await f.readFile(node))===nodeHash,"remote Node hash drift")
  const helpers:Record<string,unknown>={}
  for(const path of [node,"/usr/bin/flock","/usr/bin/timeout"]){
    const s=await f.lstat(path)
    require(s.isFile()&&!s.isSymbolicLink()&&s.uid===(path===node?1001:0)&&s.gid===(path===node?1001:0)&&(s.mode&0o022)===0&&await f.realpath(path)===path,"helper metadata drift: "+path)
    helpers[path]={uid:s.uid,gid:s.gid,mode:s.mode&0o7777,sha256:sha(await f.readFile(path))}
  }
  const metadata=await f.lstat(parent),temp=await f.lstat("/tmp")
  require(metadata.isDirectory()&&!metadata.isSymbolicLink()&&metadata.uid===12683&&metadata.gid===9000&&(metadata.mode&0o777)===0o700&&await f.realpath(parent)===parent,"private validation parent drift")
  require(temp.isDirectory()&&!temp.isSymbolicLink()&&temp.uid===0&&(temp.mode&0o7777)===0o1777&&await f.realpath("/tmp")==="/tmp","temporary parent drift")
  const home=await f.realpath(process.env.HOME??"")
  require(home==="/pay/home/moon","canonical HOME drift")
  const bootId=(await f.readFile("/proc/sys/kernel/random/boot_id","utf8")).trim(),machineId=(await f.readFile("/etc/machine-id","utf8")).trim()
  require(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)&&/^[0-9a-f]{32}$/.test(machineId),"host identity malformed")
  require((await f.lstat("/proc")).isDirectory(),"procfs unavailable")
  await f.readFile("/proc/self/stat")
  return {target,platform:process.platform,arch:process.arch,uid:process.getuid!(),gid:process.getgid!(),node,nodeHash,helpers,bootId,machineId,home,validationParent:parent,runtimeParent:"/tmp",xdgStateHome:process.env.XDG_STATE_HOME??null}
}

export function validatePreflightResult(value:unknown):{metadata:Record<string,unknown>;fingerprint:string}{
  assert.ok(validExecution(value),"preflight command result schema invalid")
  assert.equal(value.code,0);assert.equal(value.signal,null);assert.equal(value.stderr,"");assert.equal(value.timedOut,false)
  const metadata:unknown=JSON.parse(value.stdout)
  assert.ok(object(metadata),"preflight metadata schema invalid")
  assert.equal(JSON.stringify(metadata),value.stdout,"preflight stdout is not one canonical metadata object")
  assert.deepEqual(Object.keys(metadata).sort(),["arch","bootId","gid","helpers","home","machineId","node","nodeHash","platform","runtimeParent","target","uid","validationParent","xdgStateHome"].sort())
  assert.equal(metadata.target,TARGET);assert.equal(metadata.platform,"linux");assert.equal(metadata.arch,"x64")
  assert.equal(metadata.uid,12683);assert.equal(metadata.gid,9000);assert.equal(metadata.node,NODE);assert.equal(metadata.nodeHash,NODE_HASH)
  assert.equal(metadata.home,"/pay/home/moon");assert.equal(metadata.validationParent,VALIDATION_PARENT);assert.equal(metadata.runtimeParent,"/tmp");assert.equal(metadata.xdgStateHome,null)
  assert.ok(typeof metadata.bootId==="string"&&UUID.test(metadata.bootId));assert.ok(typeof metadata.machineId==="string"&&/^[0-9a-f]{32}$/.test(metadata.machineId))
  assert.deepEqual(metadata.helpers,{
    [NODE]:{uid:1001,gid:1001,mode:0o755,sha256:NODE_HASH},
    "/usr/bin/flock":{uid:0,gid:0,mode:0o755,sha256:"e619344dc3eec4023498465679262f9ca27d1e8cef9cfc4c1ae72b428577b806"},
    "/usr/bin/timeout":{uid:0,gid:0,mode:0o755,sha256:"12690a043dfd555a6c14ccc1564f5649c18f1762c0d6ff66729948130898ec52"},
  })
  return {metadata,fingerprint:hash(value.stdout)}
}

type FrozenMetadata={isFile:boolean;isDirectory:boolean;isSymbolicLink:boolean;uid:number;mode:number;nlink:number;size:number}
type FrozenEvidenceDependencies={
  lstat(path:string):Promise<{isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean;uid:number;mode:number;nlink:number;size:number}>
  realpath(path:string):Promise<string>
  open(path:string,flags:number):Promise<{stat():Promise<{isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean;uid:number;mode:number;nlink:number;size:number}>;read(buffer:Buffer,offset:number,length:number,position:number):Promise<{bytesRead:number;buffer:Buffer}>;close():Promise<void>}>
}
export function validateFrozenMetadata(value:FrozenMetadata,kind:"directory"|"file",maxBytes=0):void{
  assert.equal(value.isSymbolicLink,false,"frozen evidence symlink refused")
  assert.equal(value.uid,process.getuid!(),"frozen evidence owner mismatch")
  if(kind==="directory"){
    assert.equal(value.isDirectory,true);assert.equal(value.isFile,false);assert.equal(value.mode&0o7777,0o700,"frozen evidence directory mode mismatch")
  }else{
    assert.equal(value.isFile,true);assert.equal(value.isDirectory,false);assert.equal(value.mode&0o7777,0o600,"frozen evidence file mode mismatch")
    assert.equal(value.nlink,1,"frozen evidence link count mismatch");assert.ok(value.size>0&&value.size<=maxBytes,"frozen evidence size mismatch")
  }
}

export async function readFrozenEvidence(root:string,relative:string,maxBytes:number,dependencies:FrozenEvidenceDependencies={lstat,realpath,open}):Promise<Buffer>{
  assert.ok(relative.startsWith("direct-group-batch-1/")&&!relative.includes(".."),"frozen evidence relative path invalid")
  for(const directory of [root,join(root,"direct-group-batch-1")]){
    const metadata=await dependencies.lstat(directory)
    validateFrozenMetadata({isFile:metadata.isFile(),isDirectory:metadata.isDirectory(),isSymbolicLink:metadata.isSymbolicLink(),uid:metadata.uid,mode:metadata.mode,nlink:metadata.nlink,size:metadata.size},"directory")
    assert.equal(await dependencies.realpath(directory),directory,"frozen evidence directory is not canonical")
  }
  const path=join(root,relative),handle=await dependencies.open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const metadata=await handle.stat()
    validateFrozenMetadata({isFile:metadata.isFile(),isDirectory:metadata.isDirectory(),isSymbolicLink:metadata.isSymbolicLink(),uid:metadata.uid,mode:metadata.mode,nlink:metadata.nlink,size:metadata.size},"file",maxBytes)
    const buffer=Buffer.alloc(maxBytes+1),result=await handle.read(buffer,0,buffer.length,0)
    assert.equal(result.bytesRead,metadata.size,"frozen evidence size changed during read")
    assert.ok(result.bytesRead<=maxBytes,"frozen evidence exceeded size bound during read")
    return result.buffer.subarray(0,result.bytesRead)
  }finally{await handle.close()}
}

export function validateFrozenCorrectionEvidence(receiptBytes:Buffer,cleanupBytes:Buffer,diagnosticBytes:Buffer):void{
  assert.equal(hash(receiptBytes),FROZEN_RECEIPT_HASH,"frozen batch receipt hash mismatch")
  assert.equal(hash(cleanupBytes),FROZEN_CLEANUP_HASH,"frozen cleanup receipt hash mismatch")
  assert.equal(hash(diagnosticBytes),FROZEN_DIAGNOSTIC_HASH,"frozen diagnostic receipt hash mismatch")
  validateFrozenCorrectionSemantics(receiptBytes,cleanupBytes,diagnosticBytes)
}

export function validateFrozenCorrectionSemantics(receiptBytes:Buffer,cleanupBytes:Buffer,diagnosticBytes:Buffer):void{
  const receipt=JSON.parse(receiptBytes.toString("utf8")) as DirectGroupBatchReceipt
  assert.equal(receipt.batchId,"direct-group-batch-1");assert.equal(receipt.target,TARGET);assert.equal(receipt.suitePassed,false);assert.equal(receipt.failureClassification,"incomplete")
  assert.equal(receipt.attemptsComplete,false);assert.equal(receipt.inventoryComplete,false);assert.equal(receipt.readbackComplete,false);assert.ok(receipt.fatalConditions.length>0)
  assert.equal(canRetry(receipt,{target:receipt.target,preflightFingerprint:receipt.preflightFingerprint,sourceManifestSha256:receipt.sourceManifestSha256}),false)
  const survivorKeys=["19f6aeea-c357-4645-a5bf-c7080c7747d1","1f490c5c-7037-4ed5-8eb9-6f105c0434d5"]
  assert.deepEqual([...receipt.survivorKeys].sort(),[...survivorKeys].sort())
  const expected={bootId:"54b315ff-6241-42a8-8d21-513300036c1d",pid:1895116,starttime:"3427045",uid:12683,gid:9000,argv0:"/usr/stripe/nodenv/versions/24.13.0/bin/node"}
  for(const key of survivorKeys){
    const entries=receipt.identities.filter(value=>value.key===key)
    assert.equal(entries.length,1)
    const entry=entries[0]
    assert.ok(entry&&validIdentity(entry));assert.equal(entry.role,"descendant");assert.equal(entry.identity.bootId,expected.bootId);assert.equal(entry.identity.pid,expected.pid);assert.equal(entry.starttime,expected.starttime);assert.equal(entry.identity.birth,expected.starttime+":"+expected.argv0);assert.equal(entry.identity.uid,expected.uid);assert.equal(entry.identity.gid,expected.gid);assert.equal(entry.argv0,expected.argv0)
  }
  const cleanup=JSON.parse(cleanupBytes.toString("utf8")) as Record<string,any>
  assert.equal(cleanup.target,TARGET);assert.deepEqual(cleanup.retainedIdentity,expected);assert.equal(cleanup.observation.present,true);assert.equal(cleanup.observation.identityStable,true);assert.equal(cleanup.observation.samples,3)
  assert.deepEqual(cleanup.observation.observed,{state:"S",parentPid:1,processGroupId:1895109,sessionId:1895109,starttime:expected.starttime,uid:expected.uid,gid:expected.gid,argv0:expected.argv0,cmdlineSha256:"93afebb0d6817beedd7ea51cb8f83177ca54f25809f4e9b19844fdbef0a139fc"})
  assert.equal(cleanup.cleanup.signal,"SIGKILL");assert.equal(cleanup.cleanup.signalTarget,"exact-pid");assert.equal(cleanup.cleanup.signalSent,true);assert.equal(cleanup.cleanup.polls,2);assert.equal(cleanup.cleanup.exactGenerationAbsent,true)
  assert.equal(cleanup.independentReadback.bootMatches,true);assert.equal(cleanup.independentReadback.observed,null);assert.equal(cleanup.independentReadback.exactGenerationAbsent,true)
  assert.equal(cleanup.qualificationEffect,"none");assert.equal(cleanup.batch1RemainsFailed,true);assert.equal(cleanup.batch2Eligible,false)
  const diagnostic=JSON.parse(diagnosticBytes.toString("utf8")) as Record<string,any>
  assert.equal(diagnostic.target,TARGET);assert.equal(diagnostic.stateRoot,"/tmp/agy-platform-cc7cfe98e3ca48ba");assert.equal(diagnostic.caseId,"c4277af6-dd99-4137-86d9-e9c493ff377c");assert.equal(diagnostic.remoteMutations,false)
  assert.deepEqual(diagnostic.authorizedPaths,[
    {name:"cleanup.json",outcome:"absent"},
    {name:"teardown.json",outcome:"read",uid:12683,gid:9000,mode:"600",phase:"quarantined",reason:"linux observation unavailable: procfs argv0 is empty or unterminated"},
  ])
}

async function runCommand(file:string,args:string[],input:string,timeoutMs:number):Promise<CommandResult>{
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:["pipe","pipe","pipe"]})
    let stdout="",stderr="",timedOut=false,settled=false
    const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL")},timeoutMs)
    const finish=(code:number|null,signal:string|null)=>{
      if(settled)return
      settled=true;clearTimeout(timer)
      resolve({code,signal,stdout,stderr,timedOut})
    }
    child.once("error",error=>{clearTimeout(timer);reject(error)})
    child.once("close",finish)
    child.stdout.on("data",chunk=>{stdout+=chunk.toString();if(Buffer.byteLength(stdout)>4*1024*1024){timedOut=true;stdout=stdout.slice(0,1024*1024)}})
    child.stderr.on("data",chunk=>{stderr+=chunk.toString();if(Buffer.byteLength(stderr)>1024*1024){timedOut=true;stderr=stderr.slice(0,256*1024)}})
    child.stdin.on("error",()=>undefined)
    child.stdin.end(input)
  })
}
const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
async function ssh(script:string):Promise<CommandResult>{
  return runCommand("/usr/bin/ssh",["-T","-o","BatchMode=yes","-o","ConnectTimeout=15",TARGET,`${shellQuote(NODE)} --input-type=module`],script,125000)
}

export function assertBatchInput(input:BatchInput):void{
  assert.ok(evidenceBatchId(input.batchId),"batch input ID is invalid")
  assert.match(input.sourceRoot,/^\/pay\/home\/moon\/\.acp-attachment-validation\/agency-platform-[0-9a-f-]{36}$/)
  assert.match(input.stateRoot,/^\/tmp\/agy-platform-[0-9a-f]{16}$/)
  assert.equal(input.binding.target,TARGET)
  assertSourceManifest(input.sourceEntries,input.binding.sourceManifestSha256)
  assert.deepEqual(input.files.map(file=>file.path),[...STAGED_COMPILED_PATHS,...STAGED_RAW_PATHS])
  for(const file of input.files) {
    assert.equal(hash(Buffer.from(file.contents,"base64")),file.sha256)
    const entry = input.sourceEntries.find(entry=>entry.compiledPath===file.path)
    if(entry) assert.equal(file.sha256,entry.compiledSha256,"staged compiled manifest mismatch")
    else assert.equal(file.sha256,input.sourceEntries.find(entry=>entry.sourcePath==="agency/"+file.path)?.sourceSha256,"staged source manifest mismatch")
  }
}

export async function remoteRun(input:BatchInput):Promise<CommandResult>{
  process.umask(0o077)
  assertBatchInput(input)
  assert.equal(hash(JSON.stringify(await remotePreflight())),input.binding.preflightFingerprint,"preflight drift")
  for(const file of input.files)assert.equal(hash(await readFile(join(input.sourceRoot,file.path))),file.sha256,"staged source drift")
  await mkdir(input.stateRoot,{mode:0o700})
  for(const name of ["attempts","identities","children","signals","results","cases","case-inventory"])await mkdir(join(input.stateRoot,name),{mode:0o700})
  for (const [index,name] of LINUX_REAL_CASES.entries()) {
    const inventory: CaseInventory = {key:randomUUID(),batchId:input.batchId,index,name,expectedAttemptIds:[]}
    await fs.writeFile(join(input.stateRoot,"case-inventory",inventory.key+".json"),JSON.stringify(inventory),{mode:0o600,flag:"wx"})
  }
  await fs.writeFile(join(input.stateRoot,"input.json"),JSON.stringify(input),{mode:0o600,flag:"wx"})
  return new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/timeout",["--kill-after=10s","90s",NODE,"--test","--test-concurrency=1","--test-reporter=tap","dist/test/linux-platform.test.js"],{
      cwd:input.sourceRoot,env:qualificationProcessEnvironment(input),stdio:["ignore","pipe","pipe"],
    })
    let stdout="",stderr="",timedOut=false
    const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL")},105000)
    child.stdout.on("data",data=>{stdout+=data.toString()})
    child.stderr.on("data",data=>{stderr+=data.toString()})
    child.once("error",error=>{clearTimeout(timer);reject(error)})
    child.once("close",async(code,signal)=>{
      clearTimeout(timer)
      const result={code,signal,stdout,stderr,timedOut}
      const envelope=createExecutionEnvelope(input,result)
      try{await fs.writeFile(join(input.stateRoot,"execution.json"),JSON.stringify(envelope),{mode:0o600});resolve(result)}catch(error){reject(error)}
    })
  })
}

export function qualificationProcessEnvironment(input:BatchInput,current:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  assertBatchInput(input)
  return {...current,PATH:"/usr/stripe/nodenv/versions/24.13.0/bin:/usr/bin:/bin",AGENCY_LINUX_REAL:"1",AGENCY_LINUX_PROCFS_UNIT:"",AGENCY_DIRECT_GROUP_ROOT:input.stateRoot,AGENCY_DIRECT_GROUP_BATCH:input.batchId}
}

export function createExecutionEnvelope(input:BatchInput,result:CommandResult):ExecutionEnvelope{
  assertBatchInput(input);assert.ok(validExecution(result))
  return {batchId:input.batchId,binding:input.binding,result}
}

async function inspectEvidence(path: string): Promise<void> {
  const metadata = await lstat(path)
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid!() && (metadata.mode & 0o777) === 0o600 && metadata.nlink === 1 && metadata.size < 1024*1024,"evidence metadata mismatch")
}
async function readEvidence<T>(root: string, errors?: string[], filesystem = fs, inspect = inspectEvidence, knownPids?: Set<number>): Promise<T[]> {
  const result: T[] = []
  const guard = { attempts: validAttempt, identities: validIdentity, children: validChild, "case-inventory": validCase, results: validResult }[basename(root)]
  assert.ok(guard,"unknown evidence directory")
  for (const name of (await filesystem.readdir(root)).sort()) {
    try {
      assert.ok(name.endsWith(".json") && UUID.test(name.slice(0,-5)),"invalid evidence filename")
      const path = join(root,name)
      await inspect(path)
      const value: unknown = JSON.parse(await filesystem.readFile(path))
      if (object(value)) {
        if (pidValue(value.pid)) knownPids?.add(value.pid)
        if (object(value.identity) && pidValue(value.identity.pid)) knownPids?.add(value.identity.pid)
        if (basename(root) === "attempts" && Array.isArray(value.expectedDescendantPids)) {
          for (const pid of value.expectedDescendantPids) if (pidValue(pid)) knownPids?.add(pid)
        }
      }
      assert.ok(guard(value),"evidence schema invalid")
      const key: string = "attemptId" in value ? value.attemptId : "key" in value ? value.key : value.caseId
      assert.equal(name,key+".json","evidence filename binding mismatch")
      result.push(value as T)
    } catch (error) {
      if (errors === undefined) throw error
      errors.push(name+": "+String(error))
    }
  }
  return result
}

export function realSuitePassed(execution:CommandResult,cases:Array<{index:number;name:string}>):boolean{
  if(execution.code!==0||execution.signal!==null||execution.stderr!==""||execution.timedOut||cases.length!==9)return false
  if(!LINUX_REAL_CASES.every((name,index)=>cases.filter(value=>value.index===index&&value.name===name).length===1))return false
  const lines=execution.stdout.split("\n")
  if(!lines.includes("# tests 9")||!lines.includes("# fail 0")||!lines.includes("# skipped 0"))return false
  return LINUX_REAL_CASES.every(name=>lines.filter(line=>/^ok [1-9] - /.test(line)&&line.slice(line.indexOf(" - ")+3)===name).length===1)
}

export function classifyExecution(execution: CommandResult, cases: CaseResult[]): FailureClassification {
  if (!validExecution(execution)) return "infrastructure"
  if (execution.timedOut || execution.code === 124 || execution.code === 137) return "timeout"
  if (execution.signal !== null) return "cancelled"
  if (execution.stderr !== "" || execution.code !== 0 && execution.code !== 1) return "infrastructure"
  if (!Array.isArray(cases) || cases.length !== 9 || !cases.every(validResult) || !LINUX_REAL_CASES.every((name,index) => cases.filter(value => value.index === index && value.name === name).length === 1)) return "incomplete"
  const lines = execution.stdout.split("\n")
  const results = lines.filter(line => /^(?:not )?ok [1-9] - /.test(line))
  if (results.length !== 9 || !LINUX_REAL_CASES.every((name,index) => results.filter(line => line === "ok "+(index+1)+" - "+name || line === "not ok "+(index+1)+" - "+name).length === 1)
    || !["1..9","# tests 9","# cancelled 0","# skipped 0","# todo 0"].every(line => lines.filter(value => value === line).length === 1)) return "incomplete"
  const failures = results.filter(line => line.startsWith("not ok")).length
  if (!lines.includes("# pass "+(9-failures)) || !lines.includes("# fail "+failures)) return "incomplete"
  if (failures === 0) return execution.code === 0 ? "passed" : "infrastructure"
  if (execution.code !== 1) return "infrastructure"
  const blocks = execution.stdout.split(/(?=^(?:not )?ok [1-9] - )/m).filter(block => block.startsWith("not ok "))
  if (blocks.some(block => !/^\s+code: ['"]?ERR_ASSERTION['"]?\s*$/m.test(block) || !/^\s+failureType: ['"]?testCodeFailure['"]?\s*$/m.test(block))) return "infrastructure"
  return "assertion"
}

export function validateQualifiedReceipt(receipt:DirectGroupBatchReceipt,input:BatchInput):void{
  assertBatchInput(input)
  assert.equal(receipt.batchId,input.batchId);assert.equal(receipt.target,input.binding.target);assert.equal(receipt.preflightFingerprint,input.binding.preflightFingerprint);assert.equal(receipt.sourceManifestSha256,input.binding.sourceManifestSha256)
  assert.deepEqual(receipt.sourceEntries,input.sourceEntries);assertSourceManifest(receipt.sourceEntries,receipt.sourceManifestSha256)
  assert.ok(validExecution(receipt.execution),"qualified receipt execution invalid")
  assert.equal(receipt.failureClassification,"passed");assert.equal(classifyExecution(receipt.execution,receipt.caseResults),"passed");assert.equal(receipt.suitePassed,true);assert.equal(realSuitePassed(receipt.execution,receipt.cases),true)
  assert.ok(Array.isArray(receipt.cases)&&receipt.cases.every(validCase));assert.ok(Array.isArray(receipt.caseResults)&&receipt.caseResults.every(validResult));assert.equal(receipt.cases.length,LINUX_REAL_CASES.length);assert.equal(receipt.caseResults.length,LINUX_REAL_CASES.length)
  for(const inventory of receipt.cases)assert.equal(receipt.caseResults.filter(result=>result.caseId===inventory.key&&result.index===inventory.index&&result.name===inventory.name).length,1)
  assert.equal(inventoryStatus(receipt.attempts,receipt.identities,receipt.cases,receipt.children,receipt.batchId).complete,true)
  assert.equal(receipt.attemptsComplete,true);assert.equal(receipt.inventoryComplete,true);assert.equal(receipt.readbackComplete,true)
  for(const key of ["cleanupObservationErrors","readbackErrors","survivorKeys","terminalUnreapedKeys","fatalConditions"] as const)assert.deepEqual(receipt[key],[])
}

type ReadbackDependencies = {
  filesystem?: EvidenceFS
  inspectEvidence?: (path: string) => Promise<void>
  preflight?: () => Promise<Record<string,unknown>>
  observe?: typeof independentIdentityReadback
  readPid?: (pid: number) => Promise<boolean>
}
export async function remoteReadback(input: BatchInput, dependencies: ReadbackDependencies = {}): Promise<DirectGroupBatchReceipt> {
  const filesystem = dependencies.filesystem ?? fs, inspect = dependencies.inspectEvidence ?? inspectEvidence
  const observe = dependencies.observe ?? independentIdentityReadback
  const readPid = dependencies.readPid ?? (async (pid: number) => { try { await readFile("/proc/"+pid+"/stat"); return true } catch(error) { if(isAbsent(error)) return false; throw error } })
  const r: DirectGroupBatchReceipt = { batchId:input.batchId,...input.binding,sourceEntries:input.sourceEntries,suitePassed:false,failureClassification:"infrastructure",execution:null,cases:[],caseResults:[],children:[],attemptsComplete:false,inventoryComplete:false,readbackComplete:false,attempts:[],identities:[],cleanupObservationErrors:[],readbackErrors:[],survivorKeys:[],terminalUnreapedKeys:[],fatalConditions:[] }
  try { assertBatchInput(input) } catch(error) { r.fatalConditions.push(String(error)) }
  try { if(hash(JSON.stringify(await (dependencies.preflight ?? remotePreflight)())) !== input.binding.preflightFingerprint) r.fatalConditions.push("preflight drift") } catch(error) { r.fatalConditions.push(String(error)) }
  for (const file of input.files) try { if(hash(await filesystem.readFile(join(input.sourceRoot,file.path))) !== file.sha256) r.fatalConditions.push("source drift: "+file.path) } catch(error) { r.fatalConditions.push(String(error)) }
  const knownPids = new Set<number>()
  const read = async <T>(directory: string): Promise<T[]> => {
    try { return await readEvidence<T>(join(input.stateRoot,directory),r.readbackErrors,filesystem,inspect,knownPids) }
    catch(error) { r.readbackErrors.push(directory+": "+String(error)); return [] }
  }
  r.attempts = await read<DirectGroupAttempt>("attempts")
  r.identities = await read<DirectGroupIdentityReceipt>("identities")
  r.children = await read<ChildReceipt>("children")
  r.cases = await read<CaseInventory>("case-inventory")
  r.caseResults = await read<CaseResult>("results")
  const status = inventoryStatus(r.attempts,r.identities,r.cases,r.children,input.batchId)
  r.attemptsComplete = status.complete && r.readbackErrors.length === 0
  r.inventoryComplete = r.attemptsComplete
  r.fatalConditions.push(...status.errors)
  for (const child of r.children) {
    r.fatalConditions.push(...child.fatalConditions)
    if (!child.registered) r.fatalConditions.push("child registration incomplete")
    if (child.outcome === "error") r.cleanupObservationErrors.push("owned-child cleanup error")
  }
  if (r.caseResults.length !== 9 || r.cases.some(value => r.caseResults.filter(result => result.caseId === value.key && result.index === value.index && result.name === value.name).length !== 1)) {
    r.fatalConditions.push("incomplete or unbound case execution")
    r.inventoryComplete = false
  }
  try {
    const fatal: unknown = JSON.parse(await filesystem.readFile(join(input.stateRoot,"fatal.json")))
    assert.ok(strings(fatal),"fatal evidence schema invalid")
    r.fatalConditions.push(...fatal)
  } catch(error) { if(!isAbsent(error)) r.readbackErrors.push(String(error)) }
  try {
    const envelope: unknown = JSON.parse(await filesystem.readFile(join(input.stateRoot,"execution.json")))
    assert.ok(validExecutionEnvelope(envelope),"execution evidence schema invalid")
    assert.equal(envelope.batchId,input.batchId,"execution batch mismatch")
    assert.deepEqual(envelope.binding,input.binding,"execution binding mismatch")
    r.execution = envelope.result
    r.failureClassification = classifyExecution(envelope.result,r.caseResults)
    r.suitePassed = r.failureClassification === "passed"
    if (r.failureClassification !== "passed" && r.failureClassification !== "assertion") r.fatalConditions.push("execution "+r.failureClassification)
  } catch(error) { r.fatalConditions.push(String(error)) }
  for (const entry of r.identities) {
    try {
      const result = await observe(entry)
      if(result.survivor) r.survivorKeys.push(entry.key)
      if(result.terminalUnreaped) r.terminalUnreapedKeys.push(entry.key)
      if(result.markerChanged) r.fatalConditions.push("marker mutation: "+entry.key)
    } catch(error) { r.readbackErrors.push(entry.key+": "+String(error)) }
  }
  for (const pid of knownPids) if(!r.identities.some(entry => entry.identity.pid === pid)) {
    try { if(await readPid(pid)) r.survivorKeys.push("unregistered-pid-"+pid) } catch(error) { r.readbackErrors.push("pid "+pid+": "+String(error)) }
    r.fatalConditions.push("recorded PID lacks durable generation: "+pid)
  }
  r.readbackComplete = r.inventoryComplete && r.readbackErrors.length === 0
  return r
}

export type QualificationOperation="original-preflight"|"original-batch"|"correction-preflight"|"correction-batch"
export type QualificationCommand={kind:"qualify";operation:QualificationOperation}|{kind:"verify-index";receipt:string}|{kind:"verify-commit";receipt:string;commit:string}
export function parseQualificationArgs(args:string[]):QualificationCommand{
  if(args.length===0)return {kind:"qualify",operation:"original-batch"}
  if(args.length===1&&args[0]==="--preflight-only")return {kind:"qualify",operation:"original-preflight"}
  if(args.length===1&&args[0]==="--correction-preflight-only")return {kind:"qualify",operation:"correction-preflight"}
  if(args.length===1&&args[0]==="--correction-batch-1")return {kind:"qualify",operation:"correction-batch"}
  if(args[0]==="--verify-index-manifest"&&args.length===2)return {kind:"verify-index",receipt:args[1]!}
  if(args[0]==="--verify-commit-manifest"&&args.length===3)return {kind:"verify-commit",receipt:args[1]!,commit:args[2]!}
  throw new Error("usage: qualify-linux [--preflight-only | --correction-preflight-only | --correction-batch-1 | --verify-index-manifest RECEIPT | --verify-commit-manifest RECEIPT COMMIT]")
}
export async function qualifyLinux(options:{operation?:QualificationOperation;reportDirectory?:string}={}, dependencies: { filesystem?: EvidenceFS; inventory?: typeof qualificationArtifactInventory; transport?: typeof ssh; frozenReader?: typeof readFrozenEvidence } = {}):Promise<unknown>{
  const filesystem=dependencies.filesystem??fs, transport=dependencies.transport??ssh
  const operation=options.operation??"original-batch"
  const reportDirectory=options.reportDirectory??(await execFile("/usr/bin/git",["rev-parse","--path-format=absolute","--git-path","sdd"],{cwd:packageRoot})).stdout.trim()
  const probe=`const result=await (${remotePreflight.toString()})();process.stdout.write(JSON.stringify(result))`
  const correction=operation==="correction-preflight"||operation==="correction-batch"
  const preflightName=correction?"task-6-direct-group-correction-preflight.json":"task-6-direct-group-preflight.json"
  if(operation==="original-preflight"||operation==="correction-preflight"){
    assert.ok(!(await filesystem.readdir(reportDirectory)).includes(preflightName),"preflight receipt already exists")
    const result=await transport(probe)
    const validated=validatePreflightResult(result)
    await filesystem.writeFile(join(reportDirectory,preflightName),JSON.stringify(result),{mode:0o600,flag:"wx"})
    return validated.metadata
  }
  const prior:unknown=JSON.parse(await filesystem.readFile(join(reportDirectory,preflightName)))
  const preflightFingerprint=validatePreflightResult(prior).fingerprint
  const inventory=await (dependencies.inventory??qualificationArtifactInventory)()
  const binding={target:TARGET,preflightFingerprint,sourceManifestSha256:inventory.sourceManifestSha256}
  const allocation=correction?await allocateCorrectionBatch(reportDirectory,binding,filesystem,dependencies.frozenReader??readFrozenEvidence):await allocateBatch(reportDirectory,binding,filesystem),token=randomUUID()
  const input:BatchInput={batchId:allocation.batchId,sourceRoot:VALIDATION_PARENT+"/agency-platform-"+token,stateRoot:"/tmp/agy-platform-"+token.replaceAll("-","").slice(0,16),binding,...inventory}
  await filesystem.writeFile(join(allocation.directory,"allocation.json"),JSON.stringify(input),{mode:0o600,flag:"wx"})
  const stageScript=`
    process.umask(0o077);\n    const fs=await import("node:fs/promises"),crypto=await import("node:crypto"),path=await import("node:path");
    const input=${JSON.stringify(input)};
    const preflight=JSON.stringify(await (${remotePreflight.toString()})());
    if(crypto.createHash("sha256").update(preflight).digest("hex")!==input.binding.preflightFingerprint)throw new Error("preflight drift");
    const allow=${JSON.stringify([...STAGED_COMPILED_PATHS,...STAGED_RAW_PATHS])};
    if(JSON.stringify(input.files.map(f=>f.path))!==JSON.stringify(allow))throw new Error("staging allowlist mismatch");
    await fs.mkdir(input.sourceRoot,{mode:448});
    for(const file of input.files){
      const bytes=Buffer.from(file.contents,"base64");
      if(crypto.createHash("sha256").update(bytes).digest("hex")!==file.sha256)throw new Error("source hash mismatch");
      await fs.mkdir(path.dirname(path.join(input.sourceRoot,file.path)),{recursive:true,mode:448});
      await fs.writeFile(path.join(input.sourceRoot,file.path),bytes,{mode:384,flag:"wx"});
    }
    const driver=await import("file://"+input.sourceRoot+"/dist/scripts/qualify-linux.js");
    const result=await driver.remoteRun(input);process.stdout.write(JSON.stringify(result));
  `
  const readbackScript=`const input=${JSON.stringify(input)};const crypto=await import("node:crypto");const preflight=JSON.stringify(await (${remotePreflight.toString()})());if(crypto.createHash("sha256").update(preflight).digest("hex")!==input.binding.preflightFingerprint)throw new Error("preflight drift");const driver=await import("file://"+input.sourceRoot+"/dist/scripts/qualify-linux.js");process.stdout.write(JSON.stringify(await driver.remoteReadback(input)))`
  const result=await executeWithReadback(()=>transport(stageScript),()=>transport(readbackScript))
  await filesystem.writeFile(join(allocation.directory,"transport.json"),JSON.stringify(result),{mode:0o600})
  assert.ok(result.readback&&validExecution(result.readback)&&result.readback.code===0&&result.readback.signal===null&&result.readback.stderr===""&&!result.readback.timedOut,"independent readback transport failed")
  const parsed:unknown=JSON.parse(result.readback.stdout),receiptPath=join(allocation.directory,"receipt.json")
  await filesystem.writeFile(receiptPath,JSON.stringify(parsed),{mode:0o600})
  if((result.executionError||result.execution?.code!==0||result.execution?.stderr!==""||result.execution?.timedOut)&&object(parsed)&&Array.isArray(parsed.fatalConditions)){
    parsed.fatalConditions.push("original execution transport failed: "+(result.executionError??JSON.stringify(result.execution)))
    await filesystem.writeFile(receiptPath,JSON.stringify(parsed),{mode:0o600})
  }
  const receipt=parsed as DirectGroupBatchReceipt
  validateQualifiedReceipt(receipt,input)
  await filesystem.writeFile(join(reportDirectory,"task-6-qualified-receipt.json"),JSON.stringify(receipt),{mode:0o600,flag:"wx"})
  return receipt
}


async function waitFor<T>(read:()=>Promise<T|null>,timeout=5000):Promise<T>{
  const end=Date.now()+timeout
  while(true){
    const value=await read()
    if(value!==null)return value
    if(Date.now()>=end)throw new Error("fixture observation deadline")
    await new Promise(resolve=>setTimeout(resolve,25))
  }
}
function line(stream:NodeJS.ReadableStream,timeout=5000):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    let buffer=""
    const timer=setTimeout(()=>finish(new Error("fixture frame deadline")),timeout)
    const data=(chunk:Buffer|string)=>{buffer+=chunk.toString();if(Buffer.byteLength(buffer)>65536)finish(new Error("oversized fixture frame"));else if(buffer.includes("\n")){try{finish(undefined,JSON.parse(buffer.slice(0,buffer.indexOf("\n"))))}catch(error){finish(error as Error)}}}
    const end=()=>finish(new Error("fixture frame ended"))
    const finish=(error?:Error,value?:unknown)=>{clearTimeout(timer);stream.off("data",data);stream.off("error",finish);stream.off("end",end);if(error)reject(error);else resolve(value)}
    stream.on("data",data);stream.once("error",finish);stream.once("end",end)
  })
}
export function combineFixtureFailures(primary:unknown|null,teardown:unknown):unknown{
  return primary===null?teardown:new AggregateError([primary,teardown],"fixture execution and teardown failed")
}
async function observeMarked(adapter:PlatformAdapter,pid:number,marker:string):Promise<ProcessIdentity>{
  return waitFor(async()=>{
    try{
      const current=await adapter.readProcess(pid)
      return current!==null&&exactAgencyBirth(current.birth,marker)&&current.pid===current.processGroupId&&current.sessionId===current.pid&&current.uid===process.getuid!()&&current.gid===process.getgid!()?current:null
    }catch(error){if(error instanceof Error&&error.name==="LinuxObservationUnavailable")return null;throw error}
  })
}
async function exactGroupSignal(root:string,adapter:PlatformAdapter,leader:ProcessIdentity,signal:NodeJS.Signals):Promise<void>{
  if(await adapter.bootId()!==leader.bootId)throw new Error("fixture boot changed")
  const firstLeader=await adapter.readProcess(leader.pid),first=await adapter.readGroup(leader.processGroupId)
  const secondLeader=await adapter.readProcess(leader.pid),second=await adapter.readGroup(leader.processGroupId)
  if(firstLeader===null&&secondLeader===null&&first.length===0&&second.length===0)return
  assert.ok(firstLeader&&secondLeader&&sameProcess(leader,firstLeader)&&sameProcess(leader,secondLeader),"fixture leader changed")
  assert.ok(first.length>0&&first.length===second.length&&first.every(member=>second.some(other=>sameProcess(member,other))),"fixture snapshots disagree")
  assert.ok(second.every(member=>member.bootId===leader.bootId&&member.processGroupId===leader.pid&&member.sessionId===leader.pid&&member.uid===leader.uid&&member.gid===leader.gid),"fixture group escaped")
  await fs.writeFile(join(root,"signals",randomUUID()+".json"),JSON.stringify({leader,first,second,signal}),{mode:0o600,flag:"wx"})
  await adapter.signalGroup(leader.processGroupId,signal)
}
async function cleanupProvider(root:string,provider:{leader:ProcessIdentity;members:ProcessIdentity[]},recordPath:string):Promise<{disposition:string;reason:string|null;signals:NodeJS.Signals[];leaderExited:boolean}>{
  const {writeLaunchRecord}=await import("../src/platform/private-state.js")
  const {reconcileRecord}=await import("../src/platform/reconcile.js")
  const adapter=createLinuxAdapter(),signals:NodeJS.Signals[]=[]
  let snapshots:ProcessIdentity[][]=[],leaderExited=false
  const recorded=provider.leader.birth.slice(provider.leader.birth.indexOf(":")+1)
  const launchAttemptId=recorded.slice("agy-provider:".length)
  const launch:LaunchRecord={version:1,checkoutId:"fixture-"+launchAttemptId,leaseId:randomUUID(),agentId:randomUUID(),handlerGeneration:randomUUID(),launchAttemptId,launchBootId:provider.leader.bootId,launchAttempted:true,phase:"active",provider:{kind:"process-group",group:{leader:provider.leader,observed:provider.members}},reason:null}
  await writeLaunchRecord(recordPath,launch)
  const observed:PlatformAdapter={...adapter,readGroup:async group=>{const members=await adapter.readGroup(group);snapshots.push(members);return members},signalGroup:async(group,signal)=>{
    await fs.writeFile(join(root,"signals",randomUUID()+".json"),JSON.stringify({launchAttemptId,group,signal,snapshots}),{mode:0o600,flag:"wx"})
    snapshots=[]
    if(signal==="SIGKILL")leaderExited=await adapter.readProcess(provider.leader.pid)===null
    await adapter.signalGroup(group,signal);signals.push(signal)
  }}
  const result=await reconcileRecord(recordPath,observed)
  return {disposition:result.disposition,reason:result.record.reason,signals,leaderExited}
}
async function registerStructural(root:string,structural:{leaderPid:number;descendantPid:number},adapter:PlatformAdapter):Promise<void>{
  assert.ok(Number.isSafeInteger(structural.descendantPid)&&structural.descendantPid>1&&structural.descendantPid!==structural.leaderPid,"invalid structural descendant")
  const attempt=await waitFor(async()=>(await readEvidence<DirectGroupAttempt>(join(root,"attempts"))).find(value=>value.pid===structural.leaderPid&&value.role==="provider")??null)
  await updateAttempt(join(root,"attempts"),attempt,{expectedDescendantPids:[structural.descendantPid]})
  const leader=await observeMarked(adapter,structural.leaderPid,agencyLaunchMarker("provider",attempt.launchAttemptId))
  const members=await waitFor(async()=>{const group=await adapter.readGroup(leader.pid);return group.some(member=>member.pid===structural.descendantPid)?group:null})
  assert.ok(members.some(member=>sameProcess(leader,member)))
  assert.ok(members.every(member=>member.bootId===leader.bootId&&member.processGroupId===leader.pid&&member.sessionId===leader.pid&&member.uid===leader.uid&&member.gid===leader.gid))
  const entries=[]
  for(const member of members)entries.push(await persistIdentity(join(root,"identities"),member.pid===leader.pid?"provider":"descendant",member))
  await updateAttempt(join(root,"attempts"),attempt,{phase:"registered",expectedDescendantPids:[structural.descendantPid],registeredIdentityKeys:entries.map(entry=>entry.key)})
}

export async function runRealCase(index:number):Promise<Record<string,unknown>>{
  const root=process.env.AGENCY_DIRECT_GROUP_ROOT
  assert.ok(root)
  try{
    try{await lstat(join(root,"fatal.json"));throw new Error("batch has a prior fatal condition")}catch(error){if(!isAbsent(error))throw error}
    return await executeRealCase(index)
  }catch(error){
    let previous:string[]=[]
    try{previous=JSON.parse(await readFile(join(root,"fatal.json"),"utf8")) as string[]}catch(readError){if(!isAbsent(readError))previous.push(String(readError))}
    await fs.writeFile(join(root,"fatal.json"),JSON.stringify([...previous,String(error)]),{mode:0o600})
    throw error
  }
}

async function executeRealCase(index:number):Promise<Record<string,unknown>>{
  const root=process.env.AGENCY_DIRECT_GROUP_ROOT,batchId=process.env.AGENCY_DIRECT_GROUP_BATCH
  assert.ok(root&&batchId&&process.platform==="linux")
  assert.ok(index>=0&&index<9)
  const inventory=(await readEvidence<CaseInventory>(join(root,"case-inventory"))).find(value=>value.index===index&&value.batchId===batchId)
  assert.ok(inventory,"case inventory missing")
  const directory=join(root,"cases",inventory.key)
  await mkdir(directory,{mode:0o700})
  let result:Record<string,unknown>
  if(index===1){
    const {resolvePlatformPaths}=await import("../src/platform/paths.js")
    const {readHostId}=await import("../src/platform/host-id.js")
    const paths=await resolvePlatformPaths({platform:"linux",uid:process.getuid!(),hostKey:await readHostId("linux"),home:process.env.HOME!})
    result={...paths,stateRoot:paths.persistentRoot}
  }else if(index===8){
    result=await singletonRealCase(root,batchId,directory,{},inventory.key)
  }else{
    const phase=index===0?"active":index===2?"before-spawn":index===3?"after-attempt":index===4?"identity-published":index===5?"readiness":"active"
    const recordPath=join(directory,"launch.json"),configPath=join(directory,"config.json")
    await fs.writeFile(configPath,JSON.stringify({phase,recordPath,providerReadyPath:join(directory,"ready.json"),providerMode:index===0?"leader-exits-on-term":"normal",timeoutMs:5000,evidenceRoot:root,batchId,caseId:inventory.key}),{mode:0o600})
    const adapter=createLinuxAdapter(),launchAttemptId=randomUUID()
    let attempt=await persistAttempt(join(root,"attempts"),batchId,"handler",launchAttemptId,fs,inventory.key)
    const child=spawn(process.execPath,[join(packageRoot,"dist/test/fixtures/handler.js"),configPath],{argv0:agencyLaunchMarker("handler",launchAttemptId),detached:true,stdio:["ignore","pipe","pipe","pipe","pipe"]})
    child.on("error",()=>undefined)
    assert.ok(child.pid!==undefined)
    attempt=await updateAttempt(join(root,"attempts"),attempt,{phase:"spawned",pid:child.pid})
    let handler:ProcessIdentity|null=null,provider:{leader:ProcessIdentity;members:ProcessIdentity[]}|null=null,handlerStopped=false,providerCleaned=false
    let primaryFailure:unknown|null=null
    let stderr=""
    child.stderr!.on("data",data=>stderr+=data.toString())
    const phaseFrame=line(child.stdout!) as Promise<{handler:ProcessIdentity;provider:{leader:ProcessIdentity;members:ProcessIdentity[]}|null}>
    try{
      handler=await observeMarked(adapter,child.pid,agencyLaunchMarker("handler",launchAttemptId))
      const entry=await persistIdentity(join(root,"identities"),"handler",handler)
      await updateAttempt(join(root,"attempts"),attempt,{phase:"registered",registeredIdentityKeys:[entry.key]})
      if(phase!=="before-spawn"){
        const structural=await line(child.stdio[3] as NodeJS.ReadableStream) as {leaderPid:number;descendantPid:number}
        await registerStructural(root,structural,adapter)
        ;(child.stdio[4] as NodeJS.WritableStream).end("registered\n")
      }
      const frame=await phaseFrame
      assert.ok(sameProcess(handler,frame.handler))
      provider=frame.provider
      await exactGroupSignal(root,adapter,handler,"SIGKILL")
      await waitFor(async()=>await adapter.readProcess(handler!.pid)===null?true:null)
      handlerStopped=true
      const {readLaunchRecord,writeLaunchRecord}=await import("../src/platform/private-state.js")
      const {reconcileRecord}=await import("../src/platform/reconcile.js")
      const retained=await readLaunchRecord(recordPath)
      let productionSignals=0
      const production:PlatformAdapter={...adapter,signalGroup:async(group,signal)=>{
        const first=await adapter.readGroup(group),second=await adapter.readGroup(group)
        assert.deepEqual(first,second)
        await fs.writeFile(join(root,"signals",randomUUID()+".json"),JSON.stringify({group,signal,first,second}),{mode:0o600,flag:"wx"})
        productionSignals++;await adapter.signalGroup(group,signal)
      }}
      if(index===7){
        assert.ok(provider)
        const altered={...retained,provider:{kind:"process-group" as const,group:{leader:{...provider.leader,birth:provider.leader.birth+"-changed"},observed:provider.members.map(member=>member.pid===provider!.leader.pid?{...member,birth:member.birth+"-changed"}:member)}}}
        await writeLaunchRecord(recordPath,altered)
        const ambiguous=await reconcileRecord(recordPath,production)
        const unrelatedPath=join(directory,"unrelated.json")
        await writeLaunchRecord(unrelatedPath,{...retained,checkoutId:"unrelated",launchAttempted:false,provider:null,phase:"launch_pending"})
        const unrelated=await reconcileRecord(unrelatedPath,production)
        result={ambiguous:ambiguous.disposition,unrelated:unrelated.disposition,productionSignals}
      }else if(index===0){
        assert.ok(provider)
        const cleanup=await cleanupProvider(root,provider,join(directory,"cleanup.json"))
        assert.equal(cleanup.disposition,"cleaned")
        providerCleaned=true
        result={...cleanup,absent:true}
      }else{
        const reconciled=await reconcileRecord(recordPath,production)
        providerCleaned=provider!==null&&reconciled.disposition==="cleaned"
        result={disposition:reconciled.disposition,productionSignals,absent:true}
      }
      assert.equal(stderr,"")
    }catch(error){
      primaryFailure=error
      throw error
    }finally{
      let teardownFailure:unknown|null=null
      try{
        child.stdio[3]?.destroy();child.stdio[4]?.destroy()
        if(!handlerStopped&&handler!==null)await exactGroupSignal(root,adapter,handler,"SIGKILL")
        if(provider===null){
          const entries=await readEvidence<DirectGroupIdentityReceipt>(join(root,"identities"))
          const retainedProvider=entries.find(entry=>entry.role==="provider"&&entry.identity.parentPid===child.pid)
          if(retainedProvider)provider={leader:retainedProvider.identity,members:entries.filter(entry=>entry.identity.processGroupId===retainedProvider.identity.pid).map(entry=>entry.identity)}
        }
        if(provider!==null&&!providerCleaned){
          const cleanup=await cleanupProvider(root,provider,join(directory,"teardown.json"))
          assert.ok(cleanup.disposition==="cleaned"||cleanup.disposition==="released",`fixture teardown remained ambiguous: ${cleanup.reason??cleanup.disposition}`)
        }
      }catch(error){teardownFailure=error}
      finally{await phaseFrame.catch(()=>undefined)}
      if(teardownFailure!==null)throw combineFixtureFailures(primaryFailure,teardownFailure)
    }
    if(provider!==null)for(const identity of provider.members)assert.equal(await adapter.readProcess(identity.pid),null)
  }
  await fs.writeFile(join(root,"results",inventory.key+".json"),JSON.stringify({caseId:inventory.key,index,name:LINUX_REAL_CASES[index],result}),{mode:0o600,flag:"wx"})
  return result
}

type SingletonDependencies = {
  filesystem?: EvidenceFS
  adapter?: PlatformAdapter
  start?: typeof import("../src/platform/singleton.js").startOrConnect
  readRecord?: typeof import("../src/platform/private-state.js").readHandlerRecord
  discoverAndStop?: (attempts: DirectGroupAttempt[], handlers: ProcessIdentity[]) => Promise<void>
}
export async function singletonRealCase(root: string, batchId: string, directory: string, dependencies: SingletonDependencies = {}, caseId: string | null = null): Promise<Record<string,unknown>> {
  const {startOrConnect} = await import("../src/platform/singleton.js")
  const {readHandlerRecord} = await import("../src/platform/private-state.js")
  const filesystem = dependencies.filesystem ?? fs, adapter = dependencies.adapter ?? createLinuxAdapter()
  const retainedDirectory = join(directory,"retained")
  await filesystem.mkdir(retainedDirectory,{mode:0o700})
  const configPath = join(directory,"config.json")
  await filesystem.writeFile(configPath,JSON.stringify({root:directory,hostId:"linux-real",bootId:await adapter.bootId(),adapterMode:"linux-real",handlerLog:join(directory,"handlers.jsonl"),retainedDirectory,response:"pong",timeoutMs:5000}),{mode:0o600})
  const attempts = new Map<string,DirectGroupAttempt>(), handlers = new Map<number,ProcessIdentity>()
  const starts = Array.from({length:32},async () => {
    let attempt: DirectGroupAttempt | null = null
    return (dependencies.start ?? startOrConnect)({
      root:directory,hostId:"linux-real",adapter,handler:{file:process.execPath,args:[join(packageRoot,"dist/test/fixtures/singleton-handler.js"),"handler",configPath]},timeoutMs:5000,lockTimeoutSeconds:15,
      onTransition:async (transition,pid) => {
        if(transition === "launch_attempt_recorded") {
          const record = await (dependencies.readRecord ?? readHandlerRecord)(join(directory,"handler.json"))
          attempt = await persistAttempt(join(root,"attempts"),batchId,"handler",record.launchAttemptId,filesystem,caseId)
          attempts.set(attempt.attemptId,attempt)
        }
        if(transition === "handler_spawned") {
          assert.ok(attempt && pid !== undefined)
          attempt = await updateAttempt(join(root,"attempts"),attempt,{phase:"spawned",pid},filesystem)
          attempts.set(attempt.attemptId,attempt)
        }
        if(transition === "identity_published") {
          const record = await (dependencies.readRecord ?? readHandlerRecord)(join(directory,"handler.json"))
          assert.ok(record.process && attempt)
          handlers.set(record.process.pid,record.process)
          const entry = await persistIdentity(join(root,"identities"),"handler",record.process,filesystem)
          attempt = await updateAttempt(join(root,"attempts"),attempt,{phase:"registered",registeredIdentityKeys:[entry.key]},filesystem)
          attempts.set(attempt.attemptId,attempt)
        }
      },
    })
  })
  const settled = await Promise.allSettled(starts)
  const errors: unknown[] = settled.filter(value => value.status === "rejected").map(value => value.reason)
  const discoverAndStop = dependencies.discoverAndStop ?? (async () => {
    const failures: unknown[] = []
    for(const attempt of attempts.values()) {
      if(attempt.pid === null) continue
      try {
        if(!handlers.has(attempt.pid)) {
          const observed = await adapter.readProcess(attempt.pid)
          if(observed === null) continue
          assert.ok(exactAgencyBirth(observed.birth,agencyLaunchMarker("handler",attempt.launchAttemptId)) && observed.pid === observed.processGroupId && observed.pid === observed.sessionId && observed.uid === process.getuid!() && observed.gid === process.getgid!(),"unpublished Handler discovery is ambiguous")
          handlers.set(observed.pid,observed)
          const entry = await persistIdentity(join(root,"identities"),"handler",observed,filesystem)
          await updateAttempt(join(root,"attempts"),attempt,{phase:"registered",registeredIdentityKeys:[entry.key]},filesystem)
        }
        await exactGroupSignal(root,adapter,handlers.get(attempt.pid)!,"SIGKILL")
        await waitFor(async () => await adapter.readProcess(attempt.pid!) === null ? true : null)
      } catch(error) { failures.push(error) }
    }
    if(failures.length) throw new AggregateError(failures,"singleton teardown failed: "+failures.map(String).join("; "))
  })
  try { await discoverAndStop([...attempts.values()],[...handlers.values()]) } catch(error) { errors.push(error) }
  if(errors.length) throw new AggregateError(errors,"singleton contenders failed: "+errors.map(String).join("; "))
  const results = settled.filter(value => value.status === "fulfilled").map(value => value.value)
  const generations = new Set(results.map(value => value.record.generation)).size
  assert.ok(handlers.size > 0)
  const launches = (await filesystem.readFile(join(directory,"handlers.jsonl"))).trim().split("\n").length
  return {count:results.length,generations,handlers:launches,absent:true}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  process.umask(0o077)
  const command=parseQualificationArgs(process.argv.slice(2))
  if(command.kind==="verify-index")await verifySourceManifest(JSON.parse(await readFile(command.receipt,"utf8")),"index")
  else if(command.kind==="verify-commit")await verifySourceManifest(JSON.parse(await readFile(command.receipt,"utf8")),"commit",command.commit)
  else process.stdout.write(JSON.stringify(await qualifyLinux({operation:command.operation}))+"\n")
}