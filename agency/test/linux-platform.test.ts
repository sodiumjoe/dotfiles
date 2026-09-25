import assert from "node:assert/strict"
import test from "node:test"
import { createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { type ProcessIdentity } from "../src/platform/types.js"

export const DIRECT_GROUP_FOCUSED_CASES = [
  "rejects legacy Linux namespace launch records",
  "validates marker-bound provider records on both platforms",
  "reconciles retained-member escape without unauthorized signaling",
  "Linux procfs preserves exact byte-zero argv0 identity",
  "Linux procfs waits for zombie reaping and rejects persistent zombies",
  "Linux process groups require paired complete scans",
  "Linux process groups reject unsafe signal targets",
  "Darwin process groups reject unsafe signal targets",
  "singleton fixtures require exact Handler and provider markers",
  "direct-group receipts encode slash and colon identities safely",
  "direct-group inventory rejects incomplete launch registration",
  "direct-group allocation enforces terminal retry policy",
] as const

const enabled = process.env.AGENCY_LINUX_PROCFS_UNIT === "1"
const synthetic = enabled ? test : ((..._args: unknown[]) => undefined) as unknown as typeof test
const boot = "123e4567-e89b-12d3-a456-426614174000"
const marker = `agy-provider:${boot}`
const missing = () => Object.assign(new Error("absent"), { code: "ENOENT" })
const procIdentity = (overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({ bootId: boot, pid: 41, birth: `99999999999999999999:${marker}`, parentPid: 1, processGroupId: 41, sessionId: 41, uid: 501, gid: 20, ...overrides })
function stat(pid = 41, group = 41, start = "99999999999999999999", state = "S"): string {
  return `${pid} (comm (nested)) ${[state, "1", String(group), "41", ...Array(15).fill("0"), start].join(" ")}\n`
}
function proc(options: { command?: string | ((pid: number) => string); stat?: (pid: number) => string; listing?: () => string[]; failure?: string; status?: string } = {}) {
  return {
    readlink: async () => "pid:[1]",
    readdir: async () => options.listing?.() ?? ["41"],
    readFile: async (path: string) => {
      if (path.endsWith("boot_id")) return boot
      if (options.failure && path.endsWith(options.failure)) throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      const pid = Number(path.split("/")[2])
      if (path.endsWith("/stat")) return options.stat?.(pid) ?? stat(pid)
      if (path.endsWith("/status")) return options.status ?? "Uid:\t501 501 501 501\nGid:\t20 20 20 20\n"
      if (path.endsWith("/cmdline")) return typeof options.command === "function" ? options.command(pid) : options.command ?? `${marker}\0arg\0`
      throw missing()
    },
  }
}
async function unavailable(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, error => error instanceof Error && error.name === "LinuxObservationUnavailable")
}

synthetic("Linux procfs preserves exact byte-zero argv0 identity", async t => {
  await t.test("exact argv0 contains slash and colon without searching arguments", async () => {
    const value = await createLinuxAdapter(proc({ command: "/usr/bin/node:fixture\0" + marker + "\0" })).readProcess(41)
    assert.equal(value?.birth, "99999999999999999999:/usr/bin/node:fixture")
  })
  for (const command of ["", "\0" + marker + "\0", marker, "x".repeat(4097) + "\0", "a\nb\0"]) await t.test(JSON.stringify(command.slice(0,70)), () => unavailable(createLinuxAdapter(proc({ command })).readProcess(41)))
  for (const failure of ["/stat", "/status", "/cmdline"]) await t.test(failure, () => unavailable(createLinuxAdapter(proc({ failure })).readProcess(41)))
  await t.test("malformed stat", () => unavailable(createLinuxAdapter(proc({ stat: () => "broken" })).readProcess(41)))
  await t.test("malformed status", () => unavailable(createLinuxAdapter(proc({ status: "Uid: none" })).readProcess(41)))
  await t.test("PID reuse between reads", () => {
    let n = 0
    return unavailable(createLinuxAdapter(proc({ stat: () => stat(41,41,String(++n)) })).readProcess(41))
  })
})

synthetic("Linux procfs waits for zombie reaping and rejects persistent zombies", async t => {
  await t.test("live to zombie to absent", async () => {
    let n = 0
    const adapter = createLinuxAdapter(proc({ command: "", stat: () => { if (++n > 5) throw missing(); return stat(41,41,"12",n === 1 ? "S" : "Z") } }))
    assert.equal(await adapter.readProcess(41), null)
    assert.ok(n > 5)
  })
  await t.test("cleared cmdline before zombie transition retries to absence", async () => {
    let n = 0
    const adapter = createLinuxAdapter(proc({ command: "", stat: () => { if (++n > 5) throw missing(); return stat(41,41,"12",n <= 3 ? "S" : "Z") } }))
    assert.equal(await adapter.readProcess(41), null)
    assert.ok(n > 5)
  })
  for(const [name,commands] of [
    ["empty to different live argv0",["",`${marker}\0`,`changed-live\0`,`changed-live\0`]],
    ["valid to empty to different live argv0",[`${marker}\0`,"",`changed-live\0`,`changed-live\0`]],
  ] as const) await t.test(name,async()=>{
    let index=0
    await unavailable(createLinuxAdapter(proc({command:()=>commands[index++]??commands.at(-1)!})).readProcess(41))
    assert.equal(index,4)
  })
  await t.test("persistent zombie is not absence", () => unavailable(createLinuxAdapter(proc({ command: "", stat: () => stat(41,41,"12","Z") })).readProcess(41)))
  await t.test("unstable zombie is not absence", () => {
    let n = 0
    return unavailable(createLinuxAdapter(proc({ command: "", stat: () => stat(41,41,String(++n),"Z") })).readProcess(41))
  })
})

synthetic("Linux process groups require paired complete scans", async t => {
  for (const scenario of ["appearing", "disappearing", "identity"]) await t.test(scenario, async () => {
    let scan = 0
    const adapter = createLinuxAdapter(proc({
      listing: () => { scan++; return scenario === "appearing" && scan === 1 || scenario === "disappearing" && scan > 1 ? ["41"] : ["41","42"] },
      stat: pid => stat(pid,41,scenario === "identity" && scan === 1 ? "10" : String(pid)),
    }))
    const members = await adapter.readGroup(41)
    assert.deepEqual(members.map(value => value.pid), scenario === "disappearing" ? [41] : [41,42])
    assert.ok(scan >= 3 && scan <= 6)
    assert.ok(members.every(value => value.birth.startsWith(String(value.pid) + ":")))
  })
  await t.test("group changes after candidate stat", async () => {
    let n = 0
    const adapter = createLinuxAdapter(proc({ stat: () => stat(41,++n === 1 ? 41 : 99) }))
    const result = await adapter.readGroup(41)
    assert.deepEqual(result, [])
  })
  await t.test("persistent churn", async () => {
    let scan = 0
    const adapter = createLinuxAdapter(proc({ listing: () => { scan++; return scan % 2 ? ["41"] : ["41","42"] } }))
    await unavailable(adapter.readGroup(41))
    assert.equal(scan, 6)
  })
  await t.test("initial candidate permission failure", () => unavailable(createLinuxAdapter(proc({ failure: "/stat" })).readGroup(41)))
  await t.test("initial candidate disappearance", async () => assert.deepEqual(await createLinuxAdapter(proc({ stat: () => { throw missing() } })).readGroup(41), []))
  await t.test("malformed nonmember cannot be excluded", () => unavailable(createLinuxAdapter(proc({ stat: () => "invalid" })).readGroup(41)))
})

synthetic("Linux process groups reject unsafe signal targets", async t => {
  const calls: unknown[] = []
  t.mock.method(process,"kill", (...args: unknown[]) => { calls.push(args); return true })
  const adapter = createLinuxAdapter(proc())
  for (const group of [0,1,-1,-42,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(adapter.signalGroup(group,"SIGTERM"), /group|integer/i)
  assert.deepEqual(calls, [])
  await adapter.signalGroup(41,"SIGKILL")
  assert.deepEqual(calls,[[-41,"SIGKILL"]])
})

async function driver(): Promise<any> {
  return import("../scripts/qualify-linux.js")
}
function memory() {
  const files = new Map<string,string>()
  const directories = new Set<string>()
  return {
    files, directories,
    readFile: async (path: string) => { const value = files.get(path); if(value === undefined) throw missing(); return value },
    writeFile: async (path: string, value: string, options: { mode: number; flag?: string }) => { assert.equal(options.mode,0o600); if(options.flag === "wx" && files.has(path)) throw Object.assign(new Error("exists"),{code:"EEXIST"}); files.set(path,value) },
    mkdir: async (path: string) => { if(directories.has(path)) throw Object.assign(new Error("exists"),{code:"EEXIST"}); directories.add(path) },
    readdir: async (path: string) => [...new Set([...files.keys(),...directories].filter(key => key.startsWith(path+"/")).map(key => key.slice(path.length+1)).filter(key => key.length>0&&!key.includes("/")))],
  }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
function preflightMetadata(){
  const node="/usr/stripe/nodenv/versions/24.13.0/bin/node",nodeHash="53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc"
  return {target:"qa-mydev--02dbd33bb95212175.northwest.stripe.io",platform:"linux",arch:"x64",uid:12683,gid:9000,node,nodeHash,helpers:{
    [node]:{uid:1001,gid:1001,mode:0o755,sha256:nodeHash},
    "/usr/bin/flock":{uid:0,gid:0,mode:0o755,sha256:"e619344dc3eec4023498465679262f9ca27d1e8cef9cfc4c1ae72b428577b806"},
    "/usr/bin/timeout":{uid:0,gid:0,mode:0o755,sha256:"12690a043dfd555a6c14ccc1564f5649c18f1762c0d6ff66729948130898ec52"},
  },bootId:boot,machineId:"a".repeat(32),home:"/pay/home/moon",validationParent:"/pay/home/moon/.acp-attachment-validation",runtimeParent:"/tmp",xdgStateHome:null}
}
const preflightResult=()=>({code:0,signal:null,stdout:JSON.stringify(preflightMetadata()),stderr:"",timedOut:false})
const manifestPaths = ["package.json", ...["types","private-state","paths","host-id","launch-marker","darwin","linux","reconcile","singleton","startup","private-socket"].map(name => "dist/src/platform/"+name+".js"), ...["handler","provider-tree","singleton-handler"].map(name => "dist/test/fixtures/"+name+".js"), "dist/test/linux-platform.test.js", "dist/scripts/qualify-linux.js"]
function completeReceipt(): any {
  const key = randomUUID(), attemptId = randomUUID(), childKey = randomUUID()
  const sourceEntries = manifestPaths.map(compiledPath => ({ sourcePath: "agency/"+compiledPath.replace(/^dist\//,"").replace(/\.js$/,".ts"), sourceSha256: sha("source"), compiledPath, compiledSha256: sha(compiledPath==="package.json"?"source":"compiled") }))
  const cases = LINUX_REAL_CASES.map((name,index) => ({ key: randomUUID(), batchId: "direct-group-batch-1", index, name, expectedAttemptIds: index === 0 ? [attemptId] : [] }))
  const caseResults = cases.map(value => ({ caseId: value.key, index: value.index, name: value.name, result: {} }))
  const stdout = LINUX_REAL_CASES.map((name,index) => (index === 0 ? "not ok " : "ok ")+(index+1)+" - "+name+(index === 0 ? "\n  ---\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  ...":"")).join("\n")+"\n1..9\n# tests 9\n# pass 8\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n"
  const result: any = {
    batchId: "direct-group-batch-1", target: "qa-mydev--02dbd33bb95212175.northwest.stripe.io",
    preflightFingerprint: sha("preflight"), sourceManifestSha256: sha(JSON.stringify(sourceEntries)), sourceEntries,
    failureClassification: "assertion", execution: { code: 1, signal: null, stdout, stderr: "", timedOut: false },
    suitePassed: false, attemptsComplete: true, inventoryComplete: true, readbackComplete: true, cases, caseResults,
    attempts: [{ attemptId, batchId: "direct-group-batch-1", caseId: cases[0]!.key, role: "provider", launchAttemptId: boot, phase: "complete", pid: 41, expectedChildReceiptKey: childKey, expectedDescendantPids: [42], registeredIdentityKeys: [key, childKey], fatalConditions: [] }],
    identities: [{ key, role: "provider", identity: procIdentity(), starttime: "99999999999999999999", argv0: marker, statState: "S" }, { key: childKey, role: "descendant", identity: procIdentity({ pid: 42, parentPid: 41, birth: "42:node" }), starttime: "42", argv0: "node", statState: "S" }],
    children: [{ key: childKey, providerAttemptId: attemptId, batchId: "direct-group-batch-1", caseId: cases[0]!.key, launchAttemptId: boot, phase: "registered", pid: 42, ownership: "direct-unreaped-child-handle", registered: true, fatalConditions: [], signalAttempt: null, delivered: null, outcome: "pending", error: null }],
    cleanupObservationErrors: [], readbackErrors: [], survivorKeys: [], terminalUnreapedKeys: [], fatalConditions: [],
  }
  let nextPid = 1000
  for (const inventory of cases) {
    if (inventory.index === 1) continue
    for (const role of inventory.index === 2 || inventory.index === 8 || inventory.index === 0 ? ["handler"] : ["handler","provider"]) {
      const pid = nextPid++, id = randomUUID(), identityKey = randomUUID(), childKey = randomUUID(), launchAttemptId = randomUUID()
      const argv0 = "agy-"+role+":"+launchAttemptId
      result.attempts.push({ attemptId:id,batchId:result.batchId,caseId:inventory.key,role,launchAttemptId,phase:"complete",pid,expectedChildReceiptKey:role==="provider"?childKey:null,expectedDescendantPids:role==="provider"?[nextPid]:[],registeredIdentityKeys:role==="provider"?[identityKey,childKey]:[identityKey],fatalConditions:[] })
      inventory.expectedAttemptIds.push(id)
      result.identities.push({ key:identityKey,role,identity:procIdentity({pid,processGroupId:pid,sessionId:pid,birth:pid+":"+argv0}),starttime:String(pid),argv0,statState:"S" })
      if (role === "provider") {
        result.identities.push({key:childKey,role:"descendant",identity:procIdentity({pid:nextPid,parentPid:pid,processGroupId:pid,sessionId:pid,birth:nextPid+":node"}),starttime:String(nextPid),argv0:"node",statState:"S"})
        result.children.push({key:childKey,providerAttemptId:id,batchId:result.batchId,caseId:inventory.key,launchAttemptId,phase:"registered",pid:nextPid++,ownership:"direct-unreaped-child-handle",registered:true,fatalConditions:[],signalAttempt:null,delivered:null,outcome:"pending",error:null})
      }
    }
  }
  return result
}
function passingReceipt(input:any):any{
  const result=completeReceipt()
  result.batchId=input.batchId;result.target=input.binding.target;result.preflightFingerprint=input.binding.preflightFingerprint;result.sourceManifestSha256=input.binding.sourceManifestSha256;result.sourceEntries=input.sourceEntries
  for(const value of result.cases)value.batchId=input.batchId
  for(const value of result.attempts)value.batchId=input.batchId
  for(const value of result.children)value.batchId=input.batchId
  result.execution={code:0,signal:null,stdout:LINUX_REAL_CASES.map((name,index)=>`ok ${index+1} - ${name}`).join("\n")+"\n1..9\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",stderr:"",timedOut:false}
  result.failureClassification="passed";result.suitePassed=true
  result.attemptsComplete=true;result.inventoryComplete=true;result.readbackComplete=true
  result.cleanupObservationErrors=[];result.readbackErrors=[];result.survivorKeys=[];result.terminalUnreapedKeys=[];result.fatalConditions=[]
  return result
}
async function readbackFixture(batchId="direct-group-batch-1") {
  const d = await driver(), filesystem = memory(), receipt = completeReceipt()
  receipt.batchId=batchId
  for(const value of receipt.cases)value.batchId=batchId
  for(const value of receipt.attempts)value.batchId=batchId
  for(const value of receipt.children)value.batchId=batchId
  const input = { batchId: receipt.batchId, sourceRoot: "/pay/home/moon/.acp-attachment-validation/agency-platform-"+boot, stateRoot: "/tmp/agy-platform-1234567890abcdef",
    binding: { target: receipt.target, preflightFingerprint: sha(JSON.stringify(preflightMetadata())), sourceManifestSha256: receipt.sourceManifestSha256 }, sourceEntries: receipt.sourceEntries,
    files: [...d.STAGED_COMPILED_PATHS,...d.STAGED_RAW_PATHS].map((path: string) => { const content=path==="package.json"||d.STAGED_RAW_PATHS.includes(path)?"source":"compiled"; return { path, sha256: sha(content), contents: Buffer.from(content).toString("base64") } }) }
  for (const file of input.files) filesystem.files.set(input.sourceRoot+"/"+file.path,Buffer.from(file.contents,"base64").toString())
  for (const [directory, values, key] of [["attempts",receipt.attempts,"attemptId"],["identities",receipt.identities,"key"],["children",receipt.children,"key"],["case-inventory",receipt.cases,"key"],["results",receipt.caseResults,"caseId"]] as const) {
    for (const value of values) filesystem.files.set(input.stateRoot+"/"+directory+"/"+value[key]+".json",JSON.stringify(value))
  }
  filesystem.files.set(input.stateRoot+"/execution.json",JSON.stringify({batchId:input.batchId,binding:input.binding,result:receipt.execution}))
  const observed: number[] = [], pids: number[] = []
  const dependencies = { filesystem, inspectEvidence: async () => undefined, preflight: async () => preflightMetadata(),
    observe: async (entry: any) => { observed.push(entry.identity.pid); return { survivor: false, terminalUnreaped: false, markerChanged: false } },
    readPid: async (pid: number) => { pids.push(pid); return false },
  }
  return { d, filesystem, receipt, input, dependencies, observed, pids }
}
async function frozenEvidenceBytes(){
  const pointer=(await readFile(new URL("../../../.git",import.meta.url),"utf8")).trim()
  assert.match(pointer,/^gitdir: /)
  const root=join(pointer.slice("gitdir: ".length),"sdd","direct-group-batch-1")
  return {
    receipt:await readFile(join(root,"receipt.json")),
    cleanup:await readFile(join(root,"cleanup-receipt.json")),
    diagnostic:await readFile(join(root,"diagnostic-receipt.json")),
  }
}
const jsonBytes=(value:unknown)=>Buffer.from(JSON.stringify(value))
function correctionReader(evidence:{receipt:Buffer;cleanup:Buffer;diagnostic:Buffer}){
  return async (_root:string,relative:string) => relative.endsWith("cleanup-receipt.json")?evidence.cleanup:relative.endsWith("diagnostic-receipt.json")?evidence.diagnostic:evidence.receipt
}

synthetic("direct-group receipts encode slash and colon identities safely", async t => {
  const d = await driver()
  assert.equal(typeof d.persistIdentity,"function")
  await t.test("UUID filename contains no birth data", async () => {
    const fs = memory()
    const value = await d.persistIdentity("/evidence","provider",procIdentity({birth:"12:/usr/bin/node:a/b"}),fs)
    assert.match(value.key,/^[0-9a-f-]{36}$/)
    assert.equal([...fs.files.keys()][0],`/evidence/${value.key}.json`)
    assert.equal(JSON.parse([...fs.files.values()][0]!).argv0,"/usr/bin/node:a/b")
  })
  for (const [name, command, state] of [["marker mutation","other\0","S"],["empty argv0","","S"],["terminal unreaped","","Z"]] as const) await t.test(name, async () => {
    const result = await d.independentIdentityReadback(completeReceipt().identities[0],proc({command,stat:()=>stat(41,41,"99999999999999999999",state)}))
    assert.equal(result.survivor,true)
    if(state === "Z") assert.equal(result.terminalUnreaped,true)
    else assert.equal(result.markerChanged,true)
  })
  await t.test("conclusive replacement discharges", async () => {
    const result = await d.independentIdentityReadback(completeReceipt().identities[0],proc({stat:()=>stat(41,41,"22")}))
    assert.equal(result.survivor,false)
  })
  await t.test("successful suite requires nine exact non-skipped cases",()=>{
    assert.equal(typeof d.realSuitePassed,"function")
    const cases=d.LINUX_REAL_CASES.map((name:string,index:number)=>({name,index,result:{}}))
    const stdout=d.LINUX_REAL_CASES.map((name:string,index:number)=>`ok ${index+1} - ${name}`).join("\n")+"\n# tests 9\n# fail 0\n# skipped 0\n"
    const execution={code:0,signal:null,stdout,stderr:"",timedOut:false}
    assert.equal(d.realSuitePassed(execution,cases),true)
    assert.equal(d.realSuitePassed({...execution,stdout:stdout.replace("# skipped 0","# skipped 1")},cases),false)
    assert.equal(d.realSuitePassed({...execution,stderr:"warning"},cases),false)
    assert.equal(d.realSuitePassed({...execution,code:1},cases),false)
    assert.equal(d.realSuitePassed(execution,cases.slice(1)),false)
    assert.equal(d.realSuitePassed(execution,[...cases,cases[0]]),false)
  })
  await t.test("all staged artifacts have raw source hashes",async()=>{
    const inventory=await d.qualificationArtifactInventory()
    assert.equal(inventory.sourceEntries.length,d.STAGED_COMPILED_PATHS.length)
    assert.deepEqual(inventory.files.map((file:any)=>file.path),[...d.STAGED_COMPILED_PATHS,...d.STAGED_RAW_PATHS])
    for(const entry of inventory.sourceEntries)assert.match(entry.sourceSha256,/^[0-9a-f]{64}$/)
    for(const fixture of ["handler","singleton-handler","provider-tree"])assert.ok(d.STAGED_COMPILED_PATHS.includes(`dist/test/fixtures/${fixture}.js`))
  })
  await t.test("index, working tree, and commit mismatches", async () => {
    const receipt=completeReceipt()
    const readers = { index: async () => "source", working: async () => "source", commit: async () => "source" }
    await d.verifySourceManifest(receipt,"index",undefined,readers)
    await d.verifySourceManifest(receipt,"commit","abc",readers)
    for(const name of ["index","working","commit"]) await assert.rejects(d.verifySourceManifest(receipt,name === "commit" ? "commit":"index","abc",{...readers,[name]:async()=>"changed"}), /hash|manifest|source/i)
  })
  await t.test("finally readback retains original SSH error", async () => {
    const calls:string[]=[]
    const result = await d.executeWithReadback(async()=>{calls.push("execute");throw new Error("original")},async()=>{calls.push("readback");return completeReceipt()})
    assert.deepEqual(calls,["execute","readback"])
    assert.match(result.executionError,/original/)
    assert.equal(result.readback.readbackComplete,true)
    const failed=await d.executeWithReadback(async()=>{throw new Error("original")},async()=>{throw new Error("independent")})
    assert.match(failed.executionError,/original/)
    assert.match(failed.readbackError,/independent/)
  })
})

synthetic("direct-group inventory rejects incomplete launch registration", async t => {
  const d = await driver()
  assert.equal(typeof d.inventoryStatus,"function")
  await t.test("teardown preserves the primary failure",() => {
    assert.equal(typeof d.combineFixtureFailures,"function")
    const primary=new Error("primary failure"),teardown=new Error("teardown failure")
    const combined=d.combineFixtureFailures(primary,teardown)
    assert.ok(combined instanceof AggregateError)
    assert.deepEqual(combined.errors,[primary,teardown])
    assert.equal(d.combineFixtureFailures(null,teardown),teardown)
  })
  for(const scenario of ["empty","planned","spawned","descendant","fatal"]) await t.test(scenario,()=>{
    const r=completeReceipt()
    if(scenario === "empty") r.attempts=[]
    else if(scenario === "planned"){r.attempts[0]!.phase="planned";r.attempts[0]!.pid=null as any}
    else if(scenario === "spawned"){r.attempts[0]!.phase="spawned";r.attempts[0]!.registeredIdentityKeys=[]}
    else if(scenario === "descendant")r.attempts[0]!.expectedDescendantPids=[43] as any
    else r.attempts[0]!.fatalConditions=["incomplete registration"] as any
    assert.equal(d.inventoryStatus(r.attempts,r.identities).complete,false)
  })
  await t.test("planned-before-spawn and PID-before-observation are durable",async()=>{
    const fs=memory()
    const a=await d.persistAttempt("/attempts","direct-group-batch-1","provider",boot,fs)
    assert.equal(JSON.parse(fs.files.get(`/attempts/${a.attemptId}.json`)!).phase,"planned")
    const b=await d.updateAttempt("/attempts",a,{phase:"spawned",pid:41},fs)
    assert.equal(JSON.parse(fs.files.get(`/attempts/${a.attemptId}.json`)!).pid,41)
    assert.equal(d.inventoryStatus([b],[]).complete,false)
    await assert.rejects(d.updateAttempt("/attempts",a,{phase:"failed_before_spawn",fatalConditions:[],spawnNotAttempted:true},fs),/spawn|PID/i)
    const unspawned=await d.persistAttempt("/attempts","direct-group-batch-1","provider",boot,fs)
    const failed=await d.updateAttempt("/attempts",unspawned,{phase:"failed_before_spawn",fatalConditions:[],spawnNotAttempted:true},fs)
    assert.equal(d.inventoryStatus([failed],[]).complete,true)
  })
  for(const failure of ["descriptor","acknowledgement","already-exited","accepted-timeout","accepted-error"]) await t.test(failure,async t=>{
    const {leader}=await import("./fixtures/provider-tree.js")
    const root=await mkdtemp(join(await realpath(tmpdir()),"agency-owned-child-"))
    t.after(()=>rm(root,{recursive:true,force:true}))
    const child = new EventEmitter() as any
    child.pid=12345;child.exitCode=failure==="already-exited"?0:null;child.signalCode=null;child.stdio=[null,null,null,new PassThrough()]
    const signals:string[]=[]
    child.kill=(signal:string)=>{signals.push(signal);if(failure==="accepted-timeout")return true;if(failure==="accepted-error"){queueMicrotask(()=>child.emit("error",new Error("post-delivery failure")));return true}queueMicrotask(()=>{child.signalCode=signal;child.emit("exit",null,signal)});return true}
    const status=new PassThrough(), ack=new PassThrough()
    const receiptPath=join(root,randomUUID()+".json")
    const promise=(leader as any)(join(root,"ready.json"),"normal",50,{
      receiptPath,
      spawnDescendant:()=>child,
      socketForFd:(fd:number)=>{if(failure==="descriptor"&&fd===3)throw new Error("descriptor failure");return fd===3?status:ack},
    })
    await assert.rejects(promise)
    assert.deepEqual(signals,failure==="already-exited"?[]:["SIGKILL"])
    const evidence=JSON.parse(await readFile(receiptPath,"utf8"))
    assert.equal(evidence.pid,12345)
    assert.equal(evidence.ownership,"direct-unreaped-child-handle")
    assert.equal(evidence.signalAttempt,"SIGKILL")
    assert.equal(evidence.outcome,failure.startsWith("accepted-")?"error":"exited")
    assert.equal(evidence.delivered,failure!=="already-exited")
    assert.equal(evidence.registered,false)
    assert.ok(evidence.fatalConditions.length>0)
  })
})

synthetic("direct-group allocation enforces terminal retry policy", async t => {
  const d=await driver()
  assert.equal(typeof d.canRetry,"function")
  const expected=completeReceipt()
  const binding={target:expected.target,preflightFingerprint:expected.preflightFingerprint,sourceManifestSha256:expected.sourceManifestSha256}
  assert.equal(d.canRetry(expected,binding),true)
  for(const scenario of ["success","partial","readback","survivor","zombie","cleanup","fatal","target","source","preflight","exhausted","registration","empty"]) await t.test(scenario,()=>{
    const r:any=completeReceipt()
    if(scenario==="success")r.suitePassed=true
    if(scenario==="partial")delete r.attemptsComplete
    if(scenario==="readback")r.readbackErrors=["readback failure"]
    if(scenario==="survivor")r.survivorKeys=[r.identities[0].key]
    if(scenario==="zombie")r.terminalUnreapedKeys=[r.identities[0].key]
    if(scenario==="cleanup")r.cleanupObservationErrors=["error"]
    if(scenario==="fatal")r.fatalConditions=["ambiguity"]
    if(scenario==="target")r.target="other"
    if(scenario==="source")r.sourceManifestSha256=sha("other")
    if(scenario==="preflight")r.preflightFingerprint=sha("other")
    if(scenario==="exhausted")r.batchId="direct-group-batch-2"
    if(scenario==="registration")r.attempts[0].registeredIdentityKeys=[]
    if(scenario==="empty")r.attempts=[]
    assert.equal(d.canRetry(r,binding),false)
  })
  await t.test("concurrent exclusive allocation and terminal result",async()=>{
    const fs=memory()
    const results=await Promise.allSettled([d.allocateBatch("/report",binding,fs),d.allocateBatch("/report",binding,fs)])
    assert.equal(results.filter(value=>value.status==="fulfilled").length,1)
    fs.files.set("/report/direct-group-batch-1/receipt.json",JSON.stringify(expected))
    assert.equal((await d.allocateBatch("/report",binding,fs)).batchId,"direct-group-batch-2")
    await assert.rejects(d.allocateBatch("/report",binding,fs),/exhaust|batch|eligible/i)
    const fresh=memory()
    fresh.directories.add("/report/direct-group-batch-1")
    fresh.files.set("/report/direct-group-batch-1/receipt.json",JSON.stringify({...expected,suitePassed:true}))
    await assert.rejects(d.allocateBatch("/report",binding,fresh),/terminal|eligible|batch/i)
  })
})

synthetic("correction evidence accepts only the exact separate batch name", async t => {
  const d=await driver(), exact=d.CORRECTION_BATCH_ID
  assert.equal(d.evidenceBatchId(exact),true)
  assert.equal(d.retryBatchId(exact),false)
  for(const value of ["direct-group-correction-batch-2","direct-group-correction-batch-1-extra","x-direct-group-correction-batch-1","DIRECT-GROUP-CORRECTION-BATCH-1","direct-group-batch-3",""]) {
    assert.equal(d.evidenceBatchId(value),false)
    assert.equal(d.retryBatchId(value),false)
  }
  await t.test("attempt, case, child, inventory, and receipt bind the correction ID",async()=>{
    const fs=memory(),caseId=randomUUID()
    fs.files.set("/root/case-inventory/"+caseId+".json",JSON.stringify({key:caseId,batchId:exact,index:2,name:LINUX_REAL_CASES[2],expectedAttemptIds:[]}))
    const attempt=await d.persistAttempt("/root/attempts",exact,"handler",randomUUID(),fs,caseId)
    assert.equal(attempt.batchId,exact)
    const receipt=passingReceipt({...((await readbackFixture()).input),batchId:exact})
    assert.equal(receipt.cases.every((value:any)=>value.batchId===exact),true)
    assert.equal(receipt.attempts.every((value:any)=>value.batchId===exact),true)
    assert.equal(receipt.children.every((value:any)=>value.batchId===exact),true)
    assert.equal(d.canRetry(receipt,{target:receipt.target,preflightFingerprint:receipt.preflightFingerprint,sourceManifestSha256:receipt.sourceManifestSha256}),false)
  })
})

synthetic("correction frozen prerequisites require exact bytes and semantics", async t => {
  const d=await driver(),frozen=await frozenEvidenceBytes()
  d.validateFrozenCorrectionEvidence(frozen.receipt,frozen.cleanup,frozen.diagnostic)
  for(const [name,key] of [["receipt","receipt"],["cleanup","cleanup"],["diagnostic","diagnostic"]] as const) await t.test(name+" hash",()=>{
    const changed={...frozen,[key]:Buffer.concat([frozen[key],Buffer.from(" ")])}
    assert.throws(()=>d.validateFrozenCorrectionEvidence(changed.receipt,changed.cleanup,changed.diagnostic),/hash mismatch/)
  })
  const cases:Array<[string,"receipt"|"cleanup"|"diagnostic",(value:any)=>void]>=[
    ["receipt batch","receipt",v=>v.batchId="direct-group-batch-2"],
    ["receipt target","receipt",v=>v.target="other"],
    ["receipt suite","receipt",v=>v.suitePassed=true],
    ["receipt classification","receipt",v=>v.failureClassification="passed"],
    ["receipt attempts complete","receipt",v=>v.attemptsComplete=true],
    ["receipt inventory complete","receipt",v=>v.inventoryComplete=true],
    ["receipt readback complete","receipt",v=>v.readbackComplete=true],
    ["receipt fatal ledger","receipt",v=>v.fatalConditions=[]],
    ["receipt survivor omission","receipt",v=>v.survivorKeys.pop()],
    ["receipt survivor addition","receipt",v=>v.survivorKeys.push(randomUUID())],
    ["receipt survivor boot","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).identity.bootId=boot],
    ["receipt survivor PID","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).identity.pid=1895117],
    ["receipt survivor start","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).starttime="3427046"],
    ["receipt survivor UID","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).identity.uid=1],
    ["receipt survivor GID","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).identity.gid=1],
    ["receipt survivor argv0","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).argv0="other"],
    ["receipt survivor birth","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).identity.birth="9999999:forged"],
    ["receipt survivor role","receipt",v=>v.identities.find((x:any)=>x.key===v.survivorKeys[0]).role="provider"],
    ["receipt survivor duplicate","receipt",v=>v.identities.push({...v.identities.find((x:any)=>x.key===v.survivorKeys[0])})],
    ["cleanup target","cleanup",v=>v.target="other"],
    ["cleanup retained boot","cleanup",v=>v.retainedIdentity.bootId=boot],
    ["cleanup retained PID","cleanup",v=>v.retainedIdentity.pid=1895117],
    ["cleanup retained start","cleanup",v=>v.retainedIdentity.starttime="3427046"],
    ["cleanup retained UID","cleanup",v=>v.retainedIdentity.uid=1],
    ["cleanup retained GID","cleanup",v=>v.retainedIdentity.gid=1],
    ["cleanup retained argv0","cleanup",v=>v.retainedIdentity.argv0="other"],
    ["cleanup observation presence","cleanup",v=>v.observation.present=false],
    ["cleanup observation stability","cleanup",v=>v.observation.identityStable=false],
    ["cleanup observation samples","cleanup",v=>v.observation.samples=2],
    ["cleanup observed generation","cleanup",v=>v.observation.observed.starttime="3427046"],
    ["cleanup signal","cleanup",v=>v.cleanup.signal="SIGTERM"],
    ["cleanup target kind","cleanup",v=>v.cleanup.signalTarget="process-group"],
    ["cleanup delivery","cleanup",v=>v.cleanup.signalSent=false],
    ["cleanup polls","cleanup",v=>v.cleanup.polls=0],
    ["cleanup absence","cleanup",v=>v.cleanup.exactGenerationAbsent=false],
    ["cleanup boot readback","cleanup",v=>v.independentReadback.bootMatches=false],
    ["cleanup observed readback","cleanup",v=>v.independentReadback.observed={}],
    ["cleanup readback absence","cleanup",v=>v.independentReadback.exactGenerationAbsent=false],
    ["cleanup qualification effect","cleanup",v=>v.qualificationEffect="passed"],
    ["cleanup failed status","cleanup",v=>v.batch1RemainsFailed=false],
    ["cleanup retry status","cleanup",v=>v.batch2Eligible=true],
    ["diagnostic target","diagnostic",v=>v.target="other"],
    ["diagnostic state root","diagnostic",v=>v.stateRoot="/tmp/other"],
    ["diagnostic case","diagnostic",v=>v.caseId=randomUUID()],
    ["diagnostic mutations","diagnostic",v=>v.remoteMutations=true],
    ["diagnostic cleanup outcome","diagnostic",v=>v.authorizedPaths[0].outcome="read"],
    ["diagnostic teardown owner","diagnostic",v=>v.authorizedPaths[1].uid=1],
    ["diagnostic teardown group","diagnostic",v=>v.authorizedPaths[1].gid=1],
    ["diagnostic teardown mode","diagnostic",v=>v.authorizedPaths[1].mode="644"],
    ["diagnostic teardown phase","diagnostic",v=>v.authorizedPaths[1].phase="cleaned"],
    ["diagnostic teardown reason","diagnostic",v=>v.authorizedPaths[1].reason="other"],
    ["diagnostic extra outcome","diagnostic",v=>v.authorizedPaths.push({...v.authorizedPaths[0]})],
    ["diagnostic duplicate outcome","diagnostic",v=>v.authorizedPaths[1]={...v.authorizedPaths[0]}],
  ]
  for(const [name,key,mutate] of cases) await t.test(name,()=>{
    const values={receipt:JSON.parse(frozen.receipt.toString()),cleanup:JSON.parse(frozen.cleanup.toString()),diagnostic:JSON.parse(frozen.diagnostic.toString())}
    mutate(values[key])
    assert.throws(()=>d.validateFrozenCorrectionSemantics(jsonBytes(values.receipt),jsonBytes(values.cleanup),jsonBytes(values.diagnostic)))
  })
  await t.test("malformed JSON",()=>assert.throws(()=>d.validateFrozenCorrectionSemantics(Buffer.from("{"),frozen.cleanup,frozen.diagnostic)))
})

synthetic("correction frozen reader qualifies metadata and reads one descriptor once", async t => {
  const d=await driver(),uid=process.getuid!(),bytes=Buffer.from("evidence"),calls:string[]=[]
  const directory={isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false,uid,mode:0o700,nlink:1,size:0}
  const file={isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,uid,mode:0o600,nlink:1,size:bytes.length}
  const dependencies={
    lstat:async(path:string)=>{calls.push("lstat:"+path);return directory},
    realpath:async(path:string)=>{calls.push("realpath:"+path);return path},
    open:async(path:string,flags:number)=>{calls.push("open:"+path+":"+flags);return {stat:async()=>{calls.push("stat");return file},read:async(buffer:Buffer)=>{calls.push("read");bytes.copy(buffer);return {bytesRead:bytes.length,buffer}},close:async()=>{calls.push("close")}}},
  }
  assert.deepEqual(await d.readFrozenEvidence("/report","direct-group-batch-1/receipt.json",64,dependencies),bytes)
  assert.equal(calls.filter(value=>value==="read").length,1)
  assert.equal(calls.filter(value=>value.startsWith("open:")).length,1)
  assert.equal(calls.filter(value=>value==="close").length,1)
  for(const [name,kind,changes] of [
    ["symlink","file",{isSymbolicLink:true}],
    ["non-file","file",{isFile:false,isDirectory:true}],
    ["owner","file",{uid:uid+1}],
    ["file mode","file",{mode:0o644}],
    ["link count","file",{nlink:2}],
    ["empty","file",{size:0}],
    ["oversized","file",{size:65}],
    ["directory symlink","directory",{isSymbolicLink:true}],
    ["non-directory","directory",{isDirectory:false,isFile:true}],
    ["directory owner","directory",{uid:uid+1}],
    ["directory mode","directory",{mode:0o755}],
  ] as const) await t.test(name,()=>{
    const base=kind==="file"?{isFile:true,isDirectory:false,isSymbolicLink:false,uid,mode:0o600,nlink:1,size:8}:{isFile:false,isDirectory:true,isSymbolicLink:false,uid,mode:0o700,nlink:1,size:0}
    assert.throws(()=>d.validateFrozenMetadata({...base,...changes},kind,64))
  })
  await t.test("noncanonical parent",async()=>{
    await assert.rejects(d.readFrozenEvidence("/report","direct-group-batch-1/receipt.json",64,{...dependencies,realpath:async()=>"/other"}),/canonical/)
  })
  await t.test("growth after stat remains bounded",async()=>{
    const grown=Buffer.alloc(65,1)
    await assert.rejects(d.readFrozenEvidence("/report","direct-group-batch-1/receipt.json",64,{...dependencies,open:async()=>({stat:async()=>file,read:async(buffer:Buffer)=>{grown.copy(buffer);return {bytesRead:grown.length,buffer}},close:async()=>undefined})}),/size|bound/)
  })
})

synthetic("correction allocation is exclusive, one-shot, and does not allocate batch 2", async t => {
  const d=await driver(),frozen=await frozenEvidenceBytes(),reader=correctionReader(frozen)
  const binding={target:preflightMetadata().target,preflightFingerprint:sha(JSON.stringify(preflightMetadata())),sourceManifestSha256:sha("source")}
  const fresh=()=>{const value=memory();value.directories.add("/report");value.directories.add("/report/direct-group-batch-1");return value}
  await t.test("concurrent allocation has one winner",async()=>{
    const filesystem=fresh(),results=await Promise.allSettled([d.allocateCorrectionBatch("/report",binding,filesystem,reader),d.allocateCorrectionBatch("/report",binding,filesystem,reader)])
    assert.equal(results.filter(value=>value.status==="fulfilled").length,1)
    assert.equal(filesystem.directories.has("/report/"+d.CORRECTION_BATCH_ID),true)
    assert.equal(filesystem.directories.has("/report/direct-group-batch-2"),false)
    await assert.rejects(d.allocateCorrectionBatch("/report",binding,filesystem,reader),/existing|exhausted/)
  })
  for(const name of ["direct-group-batch-2",d.CORRECTION_BATCH_ID,"task-6-qualified-receipt.json"]) await t.test("refuses existing "+name,async()=>{
    const filesystem=fresh()
    if(name.endsWith(".json"))filesystem.files.set("/report/"+name,"{}")
    else filesystem.directories.add("/report/"+name)
    await assert.rejects(d.allocateCorrectionBatch("/report",binding,filesystem,reader),/refused existing/)
  })
  for(const missingName of ["receipt.json","cleanup-receipt.json","diagnostic-receipt.json"]) await t.test("refuses missing "+missingName,async()=>{
    const filesystem=fresh()
    await assert.rejects(d.allocateCorrectionBatch("/report",binding,filesystem,async(_root:string,relative:string)=>{if(relative.endsWith(missingName))throw missing();return reader("",relative)}),/absent/)
    assert.equal(filesystem.directories.has("/report/"+d.CORRECTION_BATCH_ID),false)
  })
  for(const [name,scope,changes] of [
    ["file symlink","file",{isSymbolicLink:true}],
    ["file type","file",{isFile:false,isDirectory:true}],
    ["file owner","file",{uid:process.getuid!()+1}],
    ["file mode","file",{mode:0o644}],
    ["file links","file",{nlink:2}],
    ["file size","file",{size:4*1024*1024+1}],
    ["directory symlink","directory",{isSymbolicLink:true}],
    ["directory type","directory",{isDirectory:false,isFile:true}],
    ["directory owner","directory",{uid:process.getuid!()+1}],
    ["directory mode","directory",{mode:0o755}],
  ] as const) await t.test("allocator rejects "+name,async()=>{
    const filesystem=fresh(),directory={isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false,uid:process.getuid!(),mode:0o700,nlink:1,size:0}
    const makeFile=(bytes:Buffer)=>({isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,uid:process.getuid!(),mode:0o600,nlink:1,size:bytes.length})
    const injected=async(root:string,relative:string,maxBytes:number)=>d.readFrozenEvidence(root,relative,maxBytes,{
      lstat:async()=>scope==="directory"?{...directory,isFile:()=>changes.isFile??false,isDirectory:()=>changes.isDirectory??true,isSymbolicLink:()=>changes.isSymbolicLink??false,uid:changes.uid??directory.uid,mode:changes.mode??directory.mode}:directory,
      realpath:async(path:string)=>path,
      open:async()=>{
        const bytes=relative.endsWith("cleanup-receipt.json")?frozen.cleanup:relative.endsWith("diagnostic-receipt.json")?frozen.diagnostic:frozen.receipt
        const metadata=makeFile(bytes)
        const changed=scope==="file"?{...metadata,isFile:()=>changes.isFile??true,isDirectory:()=>changes.isDirectory??false,isSymbolicLink:()=>changes.isSymbolicLink??false,uid:changes.uid??metadata.uid,mode:changes.mode??metadata.mode,nlink:changes.nlink??metadata.nlink,size:changes.size??metadata.size}:metadata
        return {stat:async()=>changed,read:async(buffer:Buffer)=>{bytes.copy(buffer);return {bytesRead:bytes.length,buffer}},close:async()=>undefined}
      },
    })
    await assert.rejects(d.allocateCorrectionBatch("/report",binding,filesystem,injected))
    assert.equal(filesystem.directories.has("/report/"+d.CORRECTION_BATCH_ID),false)
  })
  await t.test("allocator rejects noncanonical prerequisite parent",async()=>{
    const filesystem=fresh(),directory={isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false,uid:process.getuid!(),mode:0o700,nlink:1,size:0}
    await assert.rejects(d.allocateCorrectionBatch("/report",binding,filesystem,async(root:string,relative:string,maxBytes:number)=>d.readFrozenEvidence(root,relative,maxBytes,{lstat:async()=>directory,realpath:async()=>"/other",open:async()=>{throw new Error("unreachable")}})),/canonical/)
  })
  for(const [name,changed] of [
    ["wrong hash",{...frozen,receipt:Buffer.concat([frozen.receipt,Buffer.from(" ")])}],
    ["malformed JSON",{...frozen,receipt:Buffer.from("{")}],
  ] as const) await t.test("allocator rejects "+name,async()=>{
    const filesystem=fresh()
    await assert.rejects(d.allocateCorrectionBatch("/report",binding,filesystem,correctionReader(changed)))
    assert.equal(filesystem.directories.has("/report/"+d.CORRECTION_BATCH_ID),false)
  })
})

synthetic("correction preflight and CLI modes are explicit", async t => {
  const d=await driver(),valid=preflightResult()
  assert.deepEqual(d.validatePreflightResult(valid).metadata,preflightMetadata())
  for(const [name,mutate] of [
    ["code",(v:any)=>v.code=1],["signal",(v:any)=>v.signal="SIGTERM"],["stderr",(v:any)=>v.stderr="warning"],["timeout",(v:any)=>v.timedOut=true],
    ["extra stdout",(v:any)=>v.stdout+="\n"],["extra metadata",(v:any)=>{const o=JSON.parse(v.stdout);o.extra=true;v.stdout=JSON.stringify(o)}],
    ["target",(v:any)=>{const o=JSON.parse(v.stdout);o.target="other";v.stdout=JSON.stringify(o)}],
    ["helper",(v:any)=>{const o=JSON.parse(v.stdout);o.helpers["/usr/bin/flock"].sha256=sha("other");v.stdout=JSON.stringify(o)}],
  ] as const) await t.test("rejects "+name,()=>{const value=structuredClone(valid);mutate(value);assert.throws(()=>d.validatePreflightResult(value))})
  await t.test("correction receipt is separate and exclusive",async()=>{
    const filesystem=memory();filesystem.directories.add("/report")
    const transport=async()=>valid
    await d.qualifyLinux({operation:"correction-preflight",reportDirectory:"/report"},{filesystem,transport})
    assert.equal(filesystem.files.has("/report/task-6-direct-group-correction-preflight.json"),true)
    assert.equal(filesystem.files.has("/report/task-6-direct-group-preflight.json"),false)
    await assert.rejects(d.qualifyLinux({operation:"correction-preflight",reportDirectory:"/report"},{filesystem,transport}),/already exists/)
  })
  const exact:Array<[string[],any]>=[
    [[],{kind:"qualify",operation:"original-batch"}],
    [["--preflight-only"],{kind:"qualify",operation:"original-preflight"}],
    [["--correction-preflight-only"],{kind:"qualify",operation:"correction-preflight"}],
    [["--correction-batch-1"],{kind:"qualify",operation:"correction-batch"}],
    [["--verify-index-manifest","receipt"],{kind:"verify-index",receipt:"receipt"}],
    [["--verify-commit-manifest","receipt","HEAD"],{kind:"verify-commit",receipt:"receipt",commit:"HEAD"}],
  ]
  for(const [args,result] of exact)assert.deepEqual(d.parseQualificationArgs(args),result)
  for(const args of [["--correction-batch-1","extra"],["--correction-batch-2"],["--correction-preflight"],["--preflight-only","--correction-batch-1"],["--verify-index-manifest"],["unknown"]])assert.throws(()=>d.parseQualificationArgs(args),/usage/)
})

synthetic("qualified correction receipts require every immutable binding and pass predicate", async t => {
  const f=await readbackFixture(),d=f.d,input={...f.input,batchId:d.CORRECTION_BATCH_ID},base=passingReceipt({...f.input,batchId:d.CORRECTION_BATCH_ID})
  d.validateQualifiedReceipt(base,input)
  const defects:Array<[string,(receipt:any)=>void]>=[
    ["batch ID",r=>r.batchId="direct-group-batch-1"],
    ["target",r=>r.target="other"],
    ["preflight",r=>r.preflightFingerprint=sha("other")],
    ["source fingerprint",r=>r.sourceManifestSha256=sha("other")],
    ["source entries",r=>r.sourceEntries=[...r.sourceEntries].reverse()],
    ["execution schema",r=>r.execution=null],
    ["execution classification",r=>r.execution.code=1],
    ["failure classification",r=>r.failureClassification="assertion"],
    ["suite status",r=>r.suitePassed=false],
    ["missing case",r=>r.cases.pop()],
    ["duplicate case",r=>r.cases.push({...r.cases[0]})],
    ["case batch",r=>r.cases[0].batchId="direct-group-batch-1"],
    ["case result",r=>r.caseResults[0].caseId=randomUUID()],
    ["attempt batch",r=>r.attempts[0].batchId="direct-group-batch-1"],
    ["attempt registration",r=>r.attempts[0].registeredIdentityKeys=[]],
    ["child batch",r=>r.children[0].batchId="direct-group-batch-1"],
    ["child registration",r=>r.children[0].registered=false],
    ["attempt completeness",r=>r.attemptsComplete=false],
    ["inventory completeness",r=>r.inventoryComplete=false],
    ["readback completeness",r=>r.readbackComplete=false],
    ["cleanup error",r=>r.cleanupObservationErrors=["error"]],
    ["readback error",r=>r.readbackErrors=["error"]],
    ["survivor",r=>r.survivorKeys=[r.identities[0].key]],
    ["terminal unreaped",r=>r.terminalUnreapedKeys=[r.identities[0].key]],
    ["fatal condition",r=>r.fatalConditions=["error"]],
  ]
  for(const [name,mutate] of defects) await t.test(name,()=>{
    const receipt=structuredClone(base);mutate(receipt)
    assert.throws(()=>d.validateQualifiedReceipt(receipt,input))
  })
  for(const defect of ["batch","target","preflight","source"]) await t.test("execution envelope "+defect,async()=>{
    const fixture=await readbackFixture(),envelope={batchId:fixture.input.batchId,binding:{...fixture.input.binding},result:fixture.receipt.execution}
    if(defect==="batch")envelope.batchId=d.CORRECTION_BATCH_ID
    if(defect==="target")envelope.binding.target="other"
    if(defect==="preflight")envelope.binding.preflightFingerprint=sha("other")
    if(defect==="source")envelope.binding.sourceManifestSha256=sha("other")
    fixture.filesystem.files.set(fixture.input.stateRoot+"/execution.json",JSON.stringify(envelope))
    const result=await d.remoteReadback(fixture.input,fixture.dependencies)
    assert.equal(result.execution,null)
    assert.ok(result.fatalConditions.length>0)
  })
})

synthetic("correction qualification publishes only an exact passing receipt", async t => {
  const d=await driver(),frozen=await frozenEvidenceBytes(),reader=correctionReader(frozen)
  async function run(mutate?:(receipt:any)=>void,transportMode:"normal"|"execution-error"|"readback-error"="normal"){
    const fixture=await readbackFixture(),filesystem=memory(),report="/report",calls:string[]=[]
    filesystem.directories.add(report);filesystem.directories.add(report+"/direct-group-batch-1")
    filesystem.files.set(report+"/task-6-direct-group-correction-preflight.json",JSON.stringify(preflightResult()))
    const inventory=async()=>({sourceEntries:fixture.input.sourceEntries,files:fixture.input.files,sourceManifestSha256:fixture.input.binding.sourceManifestSha256})
    const transport=async(script:string)=>{
      calls.push(script)
      if(calls.length===1){if(transportMode==="execution-error")throw new Error("execution transport failed");return {code:0,signal:null,stdout:"execution",stderr:"",timedOut:false}}
      if(transportMode==="readback-error")throw new Error("readback transport failed")
      const allocation=JSON.parse([...filesystem.files.entries()].find(([path])=>path.endsWith("/allocation.json"))![1])
      const receipt=passingReceipt(allocation);mutate?.(receipt)
      return {code:0,signal:null,stdout:JSON.stringify(receipt),stderr:"",timedOut:false}
    }
    let value:any,error:unknown
    try{value=await d.qualifyLinux({operation:"correction-batch",reportDirectory:report},{filesystem,inventory,transport,frozenReader:reader})}catch(caught){error=caught}
    return {filesystem,report,calls,value,error}
  }
  await t.test("passing correction uses one exact name and never creates batch 2",async()=>{
    const result=await run()
    assert.equal(result.error,undefined)
    assert.equal(result.value.batchId,d.CORRECTION_BATCH_ID)
    assert.equal(result.filesystem.directories.has(result.report+"/"+d.CORRECTION_BATCH_ID),true)
    assert.equal(result.filesystem.directories.has(result.report+"/direct-group-batch-2"),false)
    assert.equal(result.filesystem.files.has(result.report+"/task-6-qualified-receipt.json"),true)
    assert.equal(result.calls.length,2)
  })
  const stops:Array<[string,(receipt:any)=>void]>=[
    ["timeout",r=>{r.execution.timedOut=true;r.execution.code=124}],
    ["cancellation",r=>r.execution.signal="SIGTERM"],
    ["partial inventory",r=>r.attemptsComplete=false],
    ["readback incomplete",r=>r.readbackComplete=false],
    ["source drift",r=>r.sourceManifestSha256=sha("other")],
    ["target drift",r=>r.target="other"],
    ["preflight drift",r=>r.preflightFingerprint=sha("other")],
    ["registration gap",r=>r.attempts[0].registeredIdentityKeys=[]],
    ["child gap",r=>r.children[0].registered=false],
    ["cleanup error",r=>r.cleanupObservationErrors=["error"]],
    ["readback error",r=>r.readbackErrors=["error"]],
    ["survivor",r=>r.survivorKeys=[r.identities[0].key]],
    ["terminal unreaped",r=>r.terminalUnreapedKeys=[r.identities[0].key]],
    ["fatal ledger",r=>r.fatalConditions=["error"]],
  ]
  for(const [name,mutate] of stops) await t.test(name,async()=>{
    const result=await run(mutate)
    assert.ok(result.error)
    assert.equal(result.filesystem.files.has(result.report+"/"+d.CORRECTION_BATCH_ID+"/receipt.json"),true)
    assert.equal(result.filesystem.files.has(result.report+"/task-6-qualified-receipt.json"),false)
  })
  for(const mode of ["execution-error","readback-error"] as const) await t.test(mode,async()=>{
    const result=await run(undefined,mode)
    assert.ok(result.error)
    assert.equal(result.filesystem.files.has(result.report+"/task-6-qualified-receipt.json"),false)
    assert.equal(result.filesystem.files.has(result.report+"/"+d.CORRECTION_BATCH_ID+"/transport.json"),true)
  })
  await t.test("parseable malformed readback survives a simultaneous execution error",async()=>{
    const result=await run(receipt=>{delete receipt.fatalConditions},"execution-error")
    assert.ok(result.error)
    const path=result.report+"/"+d.CORRECTION_BATCH_ID+"/receipt.json"
    assert.equal(result.filesystem.files.has(path),true)
    assert.equal("fatalConditions" in JSON.parse(result.filesystem.files.get(path)!),false)
    assert.equal(result.filesystem.files.has(result.report+"/task-6-qualified-receipt.json"),false)
  })
  await t.test("historical preflight cannot substitute for correction preflight",async()=>{
    const fixture=await readbackFixture(),filesystem=memory();filesystem.directories.add("/report");filesystem.directories.add("/report/direct-group-batch-1")
    filesystem.files.set("/report/task-6-direct-group-preflight.json",JSON.stringify(preflightResult()))
    let calls=0
    await assert.rejects(d.qualifyLinux({operation:"correction-batch",reportDirectory:"/report"},{filesystem,inventory:async()=>({sourceEntries:fixture.input.sourceEntries,files:fixture.input.files,sourceManifestSha256:fixture.input.binding.sourceManifestSha256}),transport:async()=>{calls++;return preflightResult()},frozenReader:reader}),/absent/)
    assert.equal(calls,0)
  })
  await t.test("default original path still refuses failed batch 1 before transport",async()=>{
    const fixture=await readbackFixture(),filesystem=memory();filesystem.directories.add("/report");filesystem.directories.add("/report/direct-group-batch-1")
    filesystem.files.set("/report/task-6-direct-group-preflight.json",JSON.stringify(preflightResult()))
    filesystem.files.set("/report/direct-group-batch-1/receipt.json",frozen.receipt.toString())
    let calls=0
    await assert.rejects(d.qualifyLinux({operation:"original-batch",reportDirectory:"/report"},{filesystem,inventory:async()=>({sourceEntries:fixture.input.sourceEntries,files:fixture.input.files,sourceManifestSha256:fixture.input.binding.sourceManifestSha256}),transport:async()=>{calls++;return preflightResult()}}),/terminal|ineligible/)
    assert.equal(calls,0)
    assert.equal(filesystem.directories.has("/report/direct-group-batch-2"),false)
  })
})

synthetic("correction batch propagates through real evidence validation helpers", async () => {
  const d=await driver(),fixture=await readbackFixture(d.CORRECTION_BATCH_ID)
  const result=await d.remoteReadback(fixture.input,fixture.dependencies)
  assert.equal(result.batchId,d.CORRECTION_BATCH_ID)
  assert.equal(result.cases.every((value:any)=>value.batchId===d.CORRECTION_BATCH_ID),true)
  assert.equal(result.attempts.every((value:any)=>value.batchId===d.CORRECTION_BATCH_ID),true)
  assert.equal(result.children.every((value:any)=>value.batchId===d.CORRECTION_BATCH_ID),true)
  assert.equal(result.execution?.code,fixture.receipt.execution.code)
  const environment=d.qualificationProcessEnvironment(fixture.input,{RETAINED:"yes"})
  assert.equal(environment.RETAINED,"yes")
  assert.equal(environment.AGENCY_DIRECT_GROUP_BATCH,d.CORRECTION_BATCH_ID)
  assert.equal(environment.AGENCY_DIRECT_GROUP_ROOT,fixture.input.stateRoot)
  assert.equal(environment.AGENCY_LINUX_REAL,"1")
  const execution={code:0,signal:null,stdout:"",stderr:"",timedOut:false}
  assert.deepEqual(d.createExecutionEnvelope(fixture.input,execution),{batchId:d.CORRECTION_BATCH_ID,binding:fixture.input.binding,result:execution})
  const handler=await readFile(new URL("../../test/fixtures/handler.ts",import.meta.url),"utf8")
  const provider=await readFile(new URL("../../test/fixtures/provider-tree.ts",import.meta.url),"utf8")
  assert.match(handler,/AGENCY_PROVIDER_BATCH: config\.batchId/)
  assert.match(provider,/batchId: process\.env\.AGENCY_PROVIDER_BATCH/)
})


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

if (process.env.AGENCY_LINUX_REAL === "1") {
  if (process.platform !== "linux") throw new Error("real Linux fixtures require Linux")
  const d = await driver()
  for (const [index,name] of LINUX_REAL_CASES.entries()) test(name, { timeout: 20000 }, async () => {
    const result = await d.runRealCase(index)
    if(index === 0) {
      assert.equal(result.leaderExited,true)
      assert.deepEqual(result.signals,["SIGTERM","SIGKILL"])
      assert.equal(result.absent,true)
    } else if(index === 1) {
      assert.match(result.stateRoot,/^\/pay\/home\/moon\/\.local\/state\/agency\/hosts\//)
    } else if(index >= 2 && index <= 6) {
      assert.equal(result.disposition,index === 3 ? "quarantined" : index === 2 ? "released":"cleaned")
      if(index === 3) assert.equal(result.productionSignals,0)
      assert.equal(result.absent,true)
    } else if(index === 7) {
      assert.equal(result.ambiguous,"quarantined")
      assert.equal(result.unrelated,"released")
      assert.equal(result.productionSignals,0)
    } else {
      assert.equal(result.count,32)
      assert.equal(result.generations,1)
      assert.equal(result.handlers,1)
      assert.equal(result.absent,true)
    }
  })
}


synthetic("direct-group receipts validate the exact source closure", async t => {
  const d = await driver(), readers = { index: async () => "source", working: async () => "source", commit: async () => "source" }
  for (const defect of ["omission", "duplicate", "path", "hash", "fingerprint"]) await t.test(defect, async () => {
    const receipt = completeReceipt(), binding = { ...receipt }
    if (defect === "omission") receipt.sourceEntries.splice(4, 1)
    if (defect === "duplicate") receipt.sourceEntries.push({ ...receipt.sourceEntries[0] })
    if (defect === "path") receipt.sourceEntries[4].compiledPath = "dist/src/platform/other.js"
    if (defect === "hash") receipt.sourceEntries[4].compiledSha256 = sha("changed")
    if (defect === "fingerprint") receipt.sourceManifestSha256 = sha("stale")
    assert.equal(d.canRetry(receipt,binding),false)
    await assert.rejects(d.verifySourceManifest(receipt,"index",undefined,readers),/manifest|source|fingerprint/i)
  })
})

synthetic("direct-group inventory readback survives malformed neighboring evidence and drift", async t => {
  for (const defect of ["attempt", "identity", "preflight"]) await t.test(defect, async () => {
    const f = await readbackFixture()
    if (defect === "attempt") f.filesystem.files.set(f.input.stateRoot+"/attempts/"+randomUUID()+".json",JSON.stringify({ attemptId: randomUUID(), pid: 99 }))
    if (defect === "identity") f.filesystem.files.set(f.input.stateRoot+"/identities/"+randomUUID()+".json",JSON.stringify({ key: randomUUID(), identity: { pid: 99 } }))
    if (defect === "preflight") f.dependencies.preflight = async () => { throw new Error("private validation parent drift") }
    const result = await f.d.remoteReadback(f.input,f.dependencies)
    assert.deepEqual(f.observed.sort((a,b)=>a-b),f.receipt.identities.map((entry:any)=>entry.identity.pid).sort((a:number,b:number)=>a-b))
    if (defect !== "preflight") assert.deepEqual(f.pids,[99])
    assert.ok(result.fatalConditions.length + result.readbackErrors.length > 0)
    assert.equal(f.d.canRetry(result,f.input.binding),false)
  })
  await t.test("qualifyLinux retains execution and readback preflight errors", async () => {
    const f = await readbackFixture(), report = "/report", calls: string[] = []
    f.filesystem.files.set(report+"/task-6-direct-group-preflight.json",JSON.stringify(preflightResult()))
    await assert.rejects(f.d.qualifyLinux({operation:"original-batch",reportDirectory:report},{
      filesystem: f.filesystem, inventory: async () => ({sourceEntries:f.input.sourceEntries,files:f.input.files,sourceManifestSha256:f.input.binding.sourceManifestSha256}),
      transport: async (script: string) => {
        calls.push(script)
        if (calls.length === 1) throw new Error("original transport failure")
        assert.ok(script.includes("remotePreflight"))
        throw new Error("revalidation failed")
      },
    }),/independent readback transport failed/)
    assert.equal(calls.length,2)
    assert.equal(f.filesystem.files.has(report+"/direct-group-batch-1/receipt.json"),false)
    const transport=JSON.parse(f.filesystem.files.get(report+"/direct-group-batch-1/transport.json")!)
    assert.match(transport.executionError,/original transport failure/)
    assert.match(transport.readbackError,/revalidation failed/)
  })
})

synthetic("direct-group allocation rejects non-assertion execution with complete evidence", async t => {
  for (const defect of ["timeout124", "timeout137", "cancelled", "incomplete", "infrastructure"]) await t.test(defect, async () => {
    const f = await readbackFixture(), execution = f.receipt.execution
    if (defect === "timeout124") execution.code = 124
    if (defect === "timeout137") execution.code = 137
    if (defect === "cancelled") execution.signal = "SIGTERM"
    if (defect === "incomplete") execution.stdout = ""
    if (defect === "infrastructure") execution.stdout = execution.stdout.replace("ERR_ASSERTION","ECONNRESET")
    f.filesystem.files.set(f.input.stateRoot+"/execution.json",JSON.stringify({batchId:f.input.batchId,binding:f.input.binding,result:execution}))
    const result = await f.d.remoteReadback(f.input,f.dependencies)
    assert.equal(result.inventoryComplete,true)
    assert.equal(result.readbackComplete,true)
    assert.notEqual(result.failureClassification,"assertion")
    assert.equal(f.d.canRetry(result,f.input.binding),false)
  })
})

synthetic("direct-group inventory binds case attempts and expected child receipts", async t => {
  for (const defect of ["missing-child", "foreign-child", "duplicate-child", "removed-attempt", "unbound-attempt", "missing-case"]) await t.test(defect, async () => {
    const f = await readbackFixture(), r = f.receipt, root = f.input.stateRoot
    if (defect === "missing-child") f.filesystem.files.delete(root+"/children/"+r.children[0].key+".json")
    if (defect === "foreign-child") { r.children[0].providerAttemptId=randomUUID(); f.filesystem.files.set(root+"/children/"+r.children[0].key+".json",JSON.stringify(r.children[0])) }
    if (defect === "duplicate-child") f.filesystem.files.set(root+"/children/"+randomUUID()+".json",JSON.stringify(r.children[0]))
    if (defect === "removed-attempt") {
      f.filesystem.files.delete(root+"/attempts/"+r.attempts[0].attemptId+".json")
      for (const entry of r.identities) f.filesystem.files.delete(root+"/identities/"+entry.key+".json")
    }
    if (defect === "unbound-attempt") { r.cases[0].expectedAttemptIds=[]; f.filesystem.files.set(root+"/case-inventory/"+r.cases[0].key+".json",JSON.stringify(r.cases[0])) }
    if (defect === "missing-case") f.filesystem.files.delete(root+"/case-inventory/"+r.cases[0].key+".json")
    const result=await f.d.remoteReadback(f.input,f.dependencies)
    assert.equal(result.inventoryComplete,false)
    assert.equal(f.d.canRetry(result,f.input.binding),false)
    if (defect !== "removed-attempt") assert.deepEqual(f.observed.sort((a,b)=>a-b),f.receipt.identities.map((entry:any)=>entry.identity.pid).sort((a:number,b:number)=>a-b))
  })
})

synthetic("direct-group inventory drains singleton contenders before discovery and teardown", async () => {
  const d=await driver(), filesystem=memory(), events:string[]=[]
  let count=0
  const result=d.singletonRealCase("/root","direct-group-batch-1","/root/case",{
    filesystem, adapter: { platform:"linux",bootId:async()=>boot,readProcess:async()=>null },
    start: async () => {
      const index=count++
      if(index===0){events.push("reject");throw new Error("early contender failure")}
      await new Promise(resolve=>setTimeout(resolve,20))
      events.push("settled:"+index)
      return {record:{generation:"one"}}
    },
    discoverAndStop: async () => { events.push("cleanup");assert.equal(events.filter(value=>value.startsWith("settled:")).length,31) },
  })
  await assert.rejects(result,/early contender failure/)
  assert.equal(events.at(-1),"cleanup")
})

synthetic("direct-group receipts establish a private umask only at executable boundaries", async () => {
  const before=process.umask()
  await driver()
  assert.equal(process.umask(),before)
  for (const path of ["test/fixtures/provider-tree.ts","test/fixtures/handler.ts","test/fixtures/singleton-handler.ts","scripts/qualify-linux.ts"]) {
    const source=await readFile(new URL("../../"+path,import.meta.url),"utf8")
    assert.match(source,/process\.umask\(0o077\)/)
    if(path.includes("provider-tree")) assert.match(source,/async function main\(\): Promise<void> \{\s*process\.umask\(0o077\)/)
    if(path.includes("qualify-linux")) {
      assert.match(source,/remoteRun[^]*?process\.umask\(0o077\)/)
      assert.match(source,/stageScript[^]*?process\.umask\(0o077\)/)
    }
  }
})


synthetic("direct-group allocation rejects case-result and deleted launch obligations", async t => {
  const d=await driver()
  for(const defect of ["case-result","deleted-obligation","child-binding"]) await t.test(defect,()=>{
    const receipt=completeReceipt(), binding={...receipt}
    if(defect==="case-result") receipt.caseResults[0].caseId=randomUUID()
    if(defect==="child-binding") receipt.children[0].providerAttemptId=randomUUID()
    if(defect==="deleted-obligation") {
      const ids=receipt.cases[0].expectedAttemptIds
      const keys=receipt.attempts.filter((value:any)=>ids.includes(value.attemptId)).flatMap((value:any)=>value.registeredIdentityKeys)
      receipt.attempts=receipt.attempts.filter((value:any)=>!ids.includes(value.attemptId))
      receipt.identities=receipt.identities.filter((value:any)=>!keys.includes(value.key))
      receipt.children=receipt.children.filter((value:any)=>!ids.includes(value.providerAttemptId))
      receipt.cases[0].expectedAttemptIds=[]
    }
    assert.equal(d.canRetry(receipt,binding),false)
  })
})

synthetic("direct-group receipts reject staged bytes inconsistent with source mapping", async () => {
  const f=await readbackFixture()
  f.input.files[1]={...f.input.files[1]!,sha256:sha("changed"),contents:Buffer.from("changed").toString("base64")}
  f.filesystem.files.set(f.input.sourceRoot+"/"+f.input.files[1]!.path,"changed")
  const receipt=await f.d.remoteReadback(f.input,f.dependencies)
  assert.ok(receipt.fatalConditions.some((value:string)=>/manifest|mapping/.test(value)))
  assert.equal(f.observed.length,f.receipt.identities.length)
})

synthetic("direct-group inventory retains every delayed singleton launch after rejection", async () => {
  const d=await driver(), filesystem=memory()
  let count=0, current:any
  const completed:number[]=[]
  await assert.rejects(d.singletonRealCase("/root","direct-group-batch-1","/root/case",{
    filesystem,adapter:{platform:"linux",bootId:async()=>boot,readProcess:async()=>null},
    readRecord:async()=>current,
    start:async(options:any)=>{
      const index=count++
      if(index===0)throw new Error("early contender failure")
      await new Promise(resolve=>setTimeout(resolve,index*3))
      const launchAttemptId=randomUUID(), pid=1000+index
      current={launchAttemptId,generation:String(index),process:procIdentity({pid,processGroupId:pid,sessionId:pid,birth:pid+":agy-handler:"+launchAttemptId})}
      await options.onTransition("launch_attempt_recorded")
      await options.onTransition("handler_spawned",pid)
      await options.onTransition("identity_published")
      completed.push(index)
      return {record:current}
    },
    discoverAndStop:async(attempts:any[],handlers:any[])=>{
      assert.equal(completed.length,31)
      assert.equal(attempts.length,31)
      assert.equal(handlers.length,31)
      assert.equal(new Set(attempts.map(value=>value.pid)).size,31)
    },
  }),/early contender failure/)
  assert.equal(completed.length,31)
})

synthetic("direct-group receipts execute serialized staging without launcher closure state", async () => {
  const d=await driver(), local=memory(), fixture=await readbackFixture(),frozen=await frozenEvidenceBytes()
  local.directories.add("/report");local.directories.add("/report/direct-group-batch-1")
  const writes:Array<{path:string;bytes:Buffer;mode:number;flag:string}>=[], events:string[]=[]
  const target="qa-mydev--02dbd33bb95212175.northwest.stripe.io"
  const node="/usr/stripe/nodenv/versions/24.13.0/bin/node"
  const parent="/pay/home/moon/.acp-attachment-validation"
  const nodeHash="53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc"
  const remoteFs={
    readFile:async(path:string)=>{
      if(path===node)return Buffer.from("qualified-node")
      if(path==="/usr/bin/flock")return Buffer.from("qualified-flock")
      if(path==="/usr/bin/timeout")return Buffer.from("qualified-timeout")
      if(path.endsWith("/boot_id"))return boot
      if(path==="/etc/machine-id")return "a".repeat(32)
      return Buffer.from("helper")
    },
    lstat:async(path:string)=>{
      const directory=path===parent||path==="/tmp"||path==="/proc"
      return {isFile:()=>!directory,isDirectory:()=>directory,isSymbolicLink:()=>false,uid:path===node?1001:path===parent?12683:0,gid:path===node?1001:path===parent?9000:0,mode:path===parent?0o700:path==="/tmp"?0o1777:0o755}
    },
    realpath:async(path:string)=>path,
    mkdir:async(path:string)=>{events.push("mkdir:"+path)},
    writeFile:async(path:string,bytes:Buffer,options:{mode:number;flag:string})=>{
      writes.push({path,bytes,...options});events.push("write:"+path)
    },
  }
  const remoteCrypto={createHash:()=>{
    let input:string|Buffer=""
    return {update(value:string|Buffer){input=value;return this},digest(){
      const fixed:Record<string,string>={"qualified-node":nodeHash,"qualified-flock":"e619344dc3eec4023498465679262f9ca27d1e8cef9cfc4c1ae72b428577b806","qualified-timeout":"12690a043dfd555a6c14ccc1564f5649c18f1762c0d6ff66729948130898ec52"}
      return Buffer.isBuffer(input)&&fixed[input.toString()]!==undefined?fixed[input.toString()]!:createHash("sha256").update(input).digest("hex")
    }}
  }}
  const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor
  let invoked=false
  const transport=async(script:string)=>{
    let stdout=""
    const remoteProcess={platform:"linux",arch:"x64",getuid:()=>12683,getgid:()=>9000,execPath:node,version:"v24.13.0",env:{HOME:"/pay/home/moon"},umask:(value:number)=>{assert.equal(value,0o077);events.push("umask");return 0o022},stdout:{write:(value:string)=>{stdout+=value}}}
    const loadModule=async(name:string)=>{
      if(name==="node:fs/promises")return remoteFs
      if(name==="node:crypto")return remoteCrypto
      if(name==="node:path")return import("node:path")
      if(name==="node:os")return {hostname:()=>target}
      assert.match(name,/^file:\/\/.*\/dist\/scripts\/qualify-linux\.js$/)
      return {
        remoteRun:async(input:any)=>{
          invoked=true;events.push("driver")
          assert.equal(input.batchId,d.CORRECTION_BATCH_ID)
          assert.deepEqual(writes.map(value=>value.path),input.files.map((file:any)=>input.sourceRoot+"/"+file.path))
          assert.deepEqual(writes.map(value=>value.bytes.toString("base64")),input.files.map((file:any)=>file.contents))
          assert.ok(writes.every(value=>value.mode===0o600&&value.flag==="wx"))
          return {code:0,signal:null,stdout:"fixture execution",stderr:"",timedOut:false}
        },
        remoteReadback:async(input:any)=>{assert.equal(input.batchId,d.CORRECTION_BATCH_ID);return passingReceipt(input)},
      }
    }
    await new AsyncFunction("process","Buffer","loadModule",script.replace(/\bimport\s*\(/g,"loadModule("))(remoteProcess,Buffer,loadModule)
    return {code:0,signal:null,stdout,stderr:"",timedOut:false}
  }
  await d.qualifyLinux({operation:"correction-preflight",reportDirectory:"/report"},{filesystem:local,transport})
  await d.qualifyLinux({operation:"correction-batch",reportDirectory:"/report"},{filesystem:local,transport,frozenReader:correctionReader(frozen),inventory:async()=>({sourceEntries:fixture.input.sourceEntries,files:fixture.input.files,sourceManifestSha256:fixture.input.binding.sourceManifestSha256})})
  assert.equal(invoked,true)
  assert.equal(writes.length,d.STAGED_COMPILED_PATHS.length+d.STAGED_RAW_PATHS.length)
  assert.equal(events[0],"umask")
  assert.equal(events.at(-1),"driver")
})

synthetic("direct-group inventory independently observes retained descendant PIDs without receipts", async t => {
  for (const malformedAttempt of [false,true]) for (const evidence of ["missing","invalid"]) for (const outcome of ["present","absent","error"]) await t.test([malformedAttempt?"malformed attempt":"valid attempt",evidence,outcome].join(": "), async () => {
    const f=await readbackFixture(), attempt=f.receipt.attempts[0], descendant=f.receipt.identities.find((entry:any)=>entry.identity.pid===42)
    const identityPath=f.input.stateRoot+"/identities/"+descendant.key+".json"
    const childPath=f.input.stateRoot+"/children/"+attempt.expectedChildReceiptKey+".json"
    if(evidence==="missing") {
      f.filesystem.files.delete(identityPath)
      f.filesystem.files.delete(childPath)
    } else {
      f.filesystem.files.set(identityPath,JSON.stringify({key:descendant.key,invalid:true}))
      f.filesystem.files.set(childPath,JSON.stringify({key:attempt.expectedChildReceiptKey,invalid:true}))
    }
    if(malformedAttempt) delete attempt.registeredIdentityKeys
    if(outcome==="error") attempt.expectedDescendantPids.push(43)
    f.filesystem.files.set(f.input.stateRoot+"/attempts/"+attempt.attemptId+".json",JSON.stringify(attempt))
    f.dependencies.readPid=async(pid:number)=>{
      f.pids.push(pid)
      if(outcome==="error"&&pid===42)throw new Error("expected descendant observation failed")
      return outcome==="present"&&pid===42
    }
    const result=await f.d.remoteReadback(f.input,f.dependencies)
    assert.deepEqual(f.pids.sort((a,b)=>a-b),outcome==="error"?[42,43]:[42])
    assert.deepEqual(f.observed.sort((a,b)=>a-b),f.receipt.identities.filter((entry:any)=>entry.identity.pid!==42).map((entry:any)=>entry.identity.pid).sort((a:number,b:number)=>a-b))
    assert.equal(result.survivorKeys.includes("unregistered-pid-42"),outcome==="present")
    if(outcome==="error")assert.ok(result.readbackErrors.some((value:string)=>value.includes("pid 42: Error: expected descendant observation failed")))
    assert.ok(result.fatalConditions.includes("recorded PID lacks durable generation: 42"))
    assert.equal(result.attemptsComplete,false)
    assert.equal(result.inventoryComplete,false)
    assert.equal(result.readbackComplete,false)
    assert.equal(f.d.canRetry(result,f.input.binding),false)
  })
  for(const scenario of ["mixed","unsafe-only","non-array"]) await t.test("rejects unsafe expected PID values: "+scenario,async()=>{
    const f=await readbackFixture(), attempt=f.receipt.attempts[0], descendant=f.receipt.identities.find((entry:any)=>entry.identity.pid===42)
    f.filesystem.files.delete(f.input.stateRoot+"/identities/"+descendant.key+".json")
    f.filesystem.files.delete(f.input.stateRoot+"/children/"+attempt.expectedChildReceiptKey+".json")
    const unsafe=[0,1,-1,1.5,Number.MAX_SAFE_INTEGER+1,"42",null,{},[42],"non-finite"]
    attempt.expectedDescendantPids=scenario==="mixed"?[42,42,Number.MAX_SAFE_INTEGER,...unsafe]:scenario==="unsafe-only"?unsafe:{pid:42}
    const serialized=JSON.stringify(attempt).replace('"non-finite"',"1e309")
    f.filesystem.files.set(f.input.stateRoot+"/attempts/"+attempt.attemptId+".json",serialized)
    const result=await f.d.remoteReadback(f.input,f.dependencies)
    assert.deepEqual(f.pids.sort((a,b)=>a-b),scenario==="mixed"?[42,Number.MAX_SAFE_INTEGER]:[])
    assert.ok(result.readbackErrors.some((value:string)=>value.includes("evidence schema invalid")))
    assert.equal(result.inventoryComplete,false)
    assert.equal(f.d.canRetry(result,f.input.binding),false)
  })
})