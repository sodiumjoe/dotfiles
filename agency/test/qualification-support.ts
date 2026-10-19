import assert from "node:assert/strict"
import type { TestContext } from "node:test"
import { spawn as nodeSpawn,type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp,mkdir,readFile,writeFile,appendFile,cp,readdir,lstat,realpath } from "node:fs/promises"
import { join,dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID,createHash } from "node:crypto"
import { launcherText,privatePaths,ordinaryPaths,type PrivateConfig } from "../scripts/qualification/config.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { readHostId } from "../src/platform/host-id.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { sameProcess,sameProcessGeneration,type PlatformAdapter,type ProcessIdentity } from "../src/platform/types.js"
import { createAgentStore } from "../src/agent/store.js"
import { until } from "./control-support.js"
import type { TaskCreateInput } from "../src/tasks/types.js"
import type { TaskAllowance } from "../scripts/qualification/task-guard.js"
import type { PlatformPaths } from "../src/platform/paths.js"
import { fixtureLaunch,fixtureSpawn } from "./fixtures/ownership.js"
export type QualificationFixture={config:PrivateConfig;paths:PlatformPaths;root:string;workspace:string;adapter:PlatformAdapter;command(argv:string[]):Promise<{code:number;stdout:string;stderr:string}>;spawn(argv:string[]):Promise<ChildProcessWithoutNullStreams>;owner():Promise<{generation:string;process:ProcessIdentity}>;bridge():Promise<Awaited<ReturnType<typeof connectHandlerBridge>>>;sentinel():Promise<Array<{pid:number;operation:string;path:string}>>;verifyCleanup():Promise<void>}
export async function qualificationFixture(t:TestContext,options:{provider?:"ordinary"|"reporting";editor?:boolean;taskInput?:TaskCreateInput}={}):Promise<QualificationFixture>{
  const root=await mkdtemp(process.platform==="darwin"?"/private/tmp/qq-":"/tmp/qq-"),runtimeRoot=await mkdtemp(process.platform==="darwin"?"/private/tmp/qr-":"/tmp/qr-"),persistentRoot=join(root,"p"),workspace=join(root,"workspace"),packageRoot=fileURLToPath(new URL("../../",import.meta.url))
  for(const path of [persistentRoot,workspace,join(root,"home"),join(persistentRoot,"profile"),join(persistentRoot,"catalog")])await mkdir(path,{mode:0o700})
  const adapter=process.platform==="darwin"?createDarwinAdapter():createLinuxAdapter(),hostId=await readHostId(adapter.platform),manifest=JSON.parse(await readFile(join(packageRoot,"dist/build-manifest.json"),"utf8"))
  let config:PrivateConfig={version:1,batchId:randomUUID(),hostId,packageRoot:packageRoot.replace(/\/$/,""),persistentRoot,runtimeRoot,node:process.execPath,launcherPath:join(persistentRoot,"agy"),configPath:join(persistentRoot,"config.json"),editor:null,binding:{sourceRevision:manifest.sourceRevision,sourceDigest:manifest.sourceDigest,distDigest:manifest.distDigest,nodeVersion:"v24.13.0",protocol:"agency-bridge/2"},taskCreate:null}
  if(options.editor){
    const {execFile}=await import("node:child_process"),{promisify}=await import("node:util"),{editorText}=await import("../scripts/qualification/editor.js")
    const execute=promisify(execFile),directory=join(persistentRoot,"editor"),plugin=await realpath(join(process.env.HOME!,".local/share/nvim/lazy/agentic.nvim")),revision=(await execute("git",["-C",plugin,"rev-parse","HEAD"])).stdout.trim()
    await mkdir(directory,{mode:0o700})
    config.editor={executable:await realpath((await execute("which",["nvim"])).stdout.trim()),shimPath:join(persistentRoot,"nvim"),initPath:join(directory,"init.lua"),toolDirectories:["/usr/bin","/bin","/opt/homebrew/bin"],luaRoot:join(packageRoot,"../home/.config/nvim"),plugins:[{path:plugin,revision}]}
    config.editor.luaRoot=await realpath(config.editor.luaRoot)
    await writeFile(config.editor.initPath,await readFile(join(packageRoot,"scripts/qualification/editor-init.lua")),{mode:0o600,flag:"wx"})
    await writeFile(join(directory,"editor.json"),JSON.stringify({launcherPath:config.launcherPath,luaRoot:config.editor.luaRoot,plugins:config.editor.plugins}),{mode:0o600,flag:"wx"})
    await writeFile(config.editor.shimPath,editorText(config),{mode:0o700,flag:"wx"})
  }
  const paths=privatePaths(config),normal=ordinaryPaths(hostId),sentinelFile=join(root,"sentinel.jsonl"),preload=fileURLToPath(new URL("./fixtures/qualification-sentinel.js",import.meta.url)),sentinelSetting=JSON.stringify({file:sentinelFile,roots:[normal.persistentRoot,normal.runtimeRoot]})
  const env={PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.LOGNAME,SHELL:"/bin/sh",LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,HOME:join(root,"home"),QUALIFICATION_ROOT:root,QUALIFICATION_SENTINEL:sentinelSetting,NODE_OPTIONS:"--import="+new URL("./fixtures/qualification-sentinel.js",import.meta.url).href,AGENCY_TEST_EVIDENCE_ROOT:root,FIXTURE_ROOT:root,FIXTURE_BACKEND:"codex-acp"}
  const evidence=process.env.QUALIFICATION_EVIDENCE_ROOT
  if(evidence){await mkdir(evidence,{recursive:true,mode:0o700});const registry=join(evidence,"fixture-roots.json");const roots=JSON.parse(await readFile(registry,"utf8").catch(()=>"[]"));roots.push({root,runtimeRoot,persistentRoot,test:t.name,createdAt:Date.now()});await writeFile(registry,JSON.stringify(roots),{mode:0o600})}
  await writeFile(join(root,"allocation.json"),JSON.stringify({root,runtimeRoot,persistentRoot,hostId}),{mode:0o600})
  const profile=join(persistentRoot,"profile"),provider=options.provider==="reporting"?"qualification-provider.js":"acp-provider.js"
  await writeFile(join(profile,"native"),"fixture executable metadata",{mode:0o700})
  await writeFile(join(profile,"adapter.json"),JSON.stringify({name:"@agentclientprotocol/codex-acp",version:"1.0.0",main:"provider.mjs"}),{mode:0o600})
  await writeFile(join(profile,"provider.mjs"),"await import("+JSON.stringify(new URL("./fixtures/"+provider,import.meta.url).href)+")",{mode:0o600})
  await writeFile(join(profile,"declared.json"),"{}",{mode:0o600})
  await writeFile(join(persistentRoot,"catalog/providers.json"),JSON.stringify({version:1,providers:[{id:"codex-acp",enabled:true,executable:join(profile,"native"),adapterPackageJson:join(profile,"adapter.json"),sdkPackageJson:null,configurationFiles:[join(profile,"declared.json")]}]}),{mode:0o600})
  await writeFile(join(persistentRoot,"catalog/backends.json"),JSON.stringify({version:1,defaultBackendId:"codex-acp",backends:[{id:"codex-acp",args:[],initial:{},compatibilityId:"fixture-v1",environmentDefaults:{FIXTURE_ROOT:root,FIXTURE_BACKEND:"codex-acp",QUALIFICATION_ROOT:root,QUALIFICATION_SENTINEL:sentinelSetting,NODE_OPTIONS:env.NODE_OPTIONS,AGENCY_TEST_EVIDENCE_ROOT:root}}]}),{mode:0o600})
  const fixtureEntry=fileURLToPath(new URL("./fixtures/qualification-launcher.js",import.meta.url))
  await writeFile(config.configPath,JSON.stringify(config),{mode:0o600,flag:"wx"});await writeFile(config.launcherPath,launcherText(config,fixtureEntry),{mode:0o700,flag:"wx"})
  const completed=new WeakMap<ChildProcessWithoutNullStreams,Promise<number>>()
  const commandResults:Array<{pid:number|undefined;argv:string[];code:number|null;signal:NodeJS.Signals|null;stderr:string}>=[]
  const children=new Set<ChildProcessWithoutNullStreams>(),identities:ProcessIdentity[]=[],peers=new Set<Awaited<ReturnType<typeof connectHandlerBridge>>>(),errors:string[]=[]
  const childSpawn=async(argv:string[])=>{
    const intent=fixtureLaunch("qualification-command")
    await appendFile(join(root,"launches.jsonl"),JSON.stringify({type:"intent",...intent,argv,at:Date.now()})+"\n",{mode:0o600})
    const child=nodeSpawn(config.launcherPath,argv,{cwd:workspace,env,stdio:["pipe","pipe","pipe"]});children.add(child)
    completed.set(child,new Promise<number>((resolve,reject)=>{child.once("error",reject);child.once("close",code=>resolve(code??70))}))
    let stderr="";child.stderr.on("data",b=>{stderr=(stderr+String(b)).slice(-32768)})
    child.on("close",(code,signal)=>{children.delete(child);commandResults.push({pid:child.pid,argv,code,signal,stderr})})
    child.on("error",error=>errors.push(String(error)))
    const identity=await until(async()=>{try{return await adapter.readProcess(child.pid!)??(child.exitCode!==null?{exited:true}:undefined)}catch{return undefined}},3000)
    if("pid" in identity)identities.push(identity)
    await appendFile(join(root,"launches.jsonl"),JSON.stringify({type:"spawn",...intent,pid:child.pid,identity,exitCode:child.exitCode})+"\n",{mode:0o600})
    const timer=setTimeout(()=>{errors.push("CHILD_DEADLINE "+child.pid);child.kill("SIGTERM")},75000);timer.unref();child.once("close",()=>clearTimeout(timer))
    return child
  }
  const command=async(argv:string[])=>{const child=await childSpawn(argv);let stdout="",stderr="";child.stdout.on("data",b=>stdout+=String(b));child.stderr.on("data",b=>stderr+=String(b));child.stdin.end();const code=await completed.get(child)!;return {code,stdout,stderr}}
  const owner=async()=>{const inspection=await inspectHandlerGeneration(runtimeRoot,adapter);assert.ok(inspection?.disposition==="live"&&inspection.record.phase==="ready"&&inspection.record.process);const process=inspection.record.process;if(!identities.some(value=>sameProcess(value,process)))identities.push(process);return {generation:inspection.record.generation,process}}
  const sentinel=async()=>{const records=(await readFile(sentinelFile,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));return records.filter(row=>!["bootstrap","identity"].includes(row.operation))}
  let cleaned=false
  const verifyCleanup=async()=>{
    if(cleaned)return
    for(const peer of peers)peer.close()
    for(const child of children){child.stdin.end();child.kill("SIGTERM")}
    const records=(await readFile(sentinelFile,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))
    for(const row of records)if(row.operation==="identity"&&row.identity&&!identities.some(v=>sameProcess(v,row.identity)))identities.push(row.identity)
    const inventory=await createAgentStore(persistentRoot).inventory().catch(()=>null)
    await writeFile(join(root,"before-cleanup.json"),JSON.stringify({inventory,identities,records}),{mode:0o600})
    if(evidence)await cp(root,join(evidence,"fixtures",root.split("/").at(-1)!),{recursive:true,errorOnExist:false,filter:async path=>!(await lstat(path)).isSocket()})
    const current=await inspectHandlerGeneration(runtimeRoot,adapter)
    if(current?.disposition==="live"){
      const reply=await command(["shutdown","--stop-agents","--handler-generation",current.record.generation,"--command-id",randomUUID(),"--json"])
      assert.equal(reply.code,0,reply.stdout+reply.stderr)
    }
    const finalRecords=(await readFile(sentinelFile,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))
    const launched=(await readFile(join(root,"launches.jsonl"),"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==="spawn")
    for(const launch of launched)assert.ok(finalRecords.some(row=>row.operation==="bootstrap"&&row.pid===launch.pid),"missing child preload "+launch.pid)
    for(const row of finalRecords.filter(row=>row.operation==="bootstrap"))assert.ok(finalRecords.some(value=>value.operation==="identity"&&value.pid===row.pid&&value.identity),"missing bootstrap identity "+row.pid)
    for(const row of finalRecords)if(row.operation==="identity"&&row.identity&&!identities.some(v=>sameProcess(v,row.identity)))identities.push(row.identity)
    for(const identity of identities){
      await until(async()=>{const actual=await adapter.readProcess(identity.pid);return !actual||!sameProcessGeneration(identity,actual)?true:undefined},15000)
      const actual=await adapter.readProcess(identity.pid);assert.ok(!actual||!sameProcessGeneration(identity,actual))
      if(identity.pid===identity.processGroupId)assert.deepEqual(await adapter.readGroup(identity.processGroupId),[])
    }
    assert.deepEqual(errors,[])
    assert.deepEqual(await sentinel(),[])
    await writeFile(join(root,"cleanup.json"),JSON.stringify({identities,survivors:[],verifiedAt:Date.now()}),{mode:0o600})
    await writeFile(join(root,"result.json"),JSON.stringify({revision:config.binding.sourceRevision,commands:commandResults,identities,cleanup:"verified",root,runtimeRoot}),{mode:0o600})
    if(evidence)await cp(root,join(evidence,"fixtures",root.split("/").at(-1)!),{recursive:true,filter:async path=>!(await lstat(path)).isSocket()})
    cleaned=true
    t.diagnostic("retained qualification fixture: "+root)
  }
  t.after(async()=>{try{await verifyCleanup()}catch(error){await writeFile(join(root,"result.json"),JSON.stringify({revision:config.binding.sourceRevision,commands:commandResults,identities,cleanup:"incomplete",error:String(error),root,runtimeRoot}),{mode:0o600});throw new AggregateError([error],"qualification fixture retained "+root)}})
  const result:QualificationFixture={config,paths,root,workspace,adapter,command,spawn:childSpawn,owner,sentinel,verifyCleanup,async bridge(){const current=await owner(),peer=await connectHandlerBridge({root:runtimeRoot,hostId,handlerGeneration:current.generation});peers.add(peer);return peer}}
  if(options.taskInput){
    const started=await command(["status","--json"]);assert.equal(started.code,0,started.stderr+started.stdout)
    const generation=(await owner()).generation,dir=join(persistentRoot,"qualification/allowances");await mkdir(dir,{recursive:true,mode:0o700})
    const allowance:TaskAllowance={version:1,batchId:config.batchId,operationId:randomUUID(),sourceHostId:hostId,hostId,handlerGeneration:generation,binding:config.binding,input:{...options.taskInput,cwd:workspace},notBefore:Date.now()-1000,deadline:Date.now()+180000}
    const bytes=JSON.stringify(allowance),allowancePath=join(dir,"create.json");await writeFile(allowancePath,bytes,{flag:"wx",mode:0o600})
    config={...config,configPath:join(persistentRoot,"supervisor.json"),launcherPath:join(persistentRoot,"supervisor"),taskCreate:{allowancePath,sha256:createHash("sha256").update(bytes).digest("hex")}}
    await writeFile(config.configPath,JSON.stringify(config),{flag:"wx",mode:0o600});await writeFile(config.launcherPath,launcherText(config,fixtureEntry),{flag:"wx",mode:0o700});result.config=config
  }
  return result
}