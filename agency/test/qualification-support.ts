import assert from "node:assert/strict"
import type { TestContext } from "node:test"
import { spawn as nodeSpawn,type SpawnOptions,type ChildProcessWithoutNullStreams } from "node:child_process"
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
import { fixtureRuntime, registerFixtureChild, cleanFixtureEnvironment } from "./fixtures/fixture-spawn.js"
import { workerReceiver } from "./fixtures/run-boundary.js"
import { nativeFixtureAccess, type LaunchRef } from "./fixtures/run-scope.js"
type CommandResult={code:number;stdout:string;stderr:string}
export async function retryQualificationShutdown(first: CommandResult, generation: string, absent: () => Promise<void>, retry: () => Promise<CommandResult>): Promise<CommandResult> {
  if(first.code!==75)return first
  const envelope=JSON.parse(first.stdout)
  assert.equal(envelope.error.code,"INCOMPLETE")
  assert.match(envelope.error.message,/did not have a stable complete observation|same process generation changed identity|^terminal process remains unreaped$/)
  assert.equal(envelope.handlerGeneration,generation)
  await absent()
  return retry()
}
export type QualificationFixture={config:PrivateConfig;paths:PlatformPaths;root:string;workspace:string;adapter:PlatformAdapter;command(argv:string[]):Promise<CommandResult>;shutdown():Promise<CommandResult>;spawn(argv:string[]):Promise<ChildProcessWithoutNullStreams>;native(role:string,file:string,args:string[],options:SpawnOptions,source?:boolean):ChildProcessWithoutNullStreams;owner():Promise<{generation:string;process:ProcessIdentity}>;bridge():Promise<Awaited<ReturnType<typeof connectHandlerBridge>>>;sentinel():Promise<Array<{pid:number;operation:string;path:string}>>;verifyCleanup():Promise<void>}
export async function qualificationFixture(t:TestContext,options:{provider?:"ordinary"|"reporting";editor?:boolean;taskInput?:TaskCreateInput}={}):Promise<QualificationFixture>{
  const root=await mkdtemp(process.platform==="darwin"?"/private/tmp/qq-":"/tmp/qq-"),runtimeRoot=await mkdtemp(process.platform==="darwin"?"/private/tmp/qr-":"/tmp/qr-"),persistentRoot=join(root,"p"),workspace=join(root,"workspace"),packageRoot=fileURLToPath(new URL("../../",import.meta.url))
  for(const path of [persistentRoot,workspace,join(root,"home"),join(persistentRoot,"profile"),join(persistentRoot,"catalog")])await mkdir(path,{mode:0o700})
  const adapter=process.platform==="darwin"?createDarwinAdapter():createLinuxAdapter(),hostId=await readHostId(adapter.platform),manifest=JSON.parse(await readFile(join(packageRoot,"dist/build-manifest.json"),"utf8"))
  let config:PrivateConfig={version:1,batchId:randomUUID(),hostId,packageRoot:packageRoot.replace(/\/$/,""),persistentRoot,runtimeRoot,node:process.execPath,launcherPath:join(persistentRoot,"agy"),configPath:join(persistentRoot,"config.json"),editor:null,binding:{sourceRevision:manifest.sourceRevision,sourceDigest:manifest.sourceDigest,distDigest:manifest.distDigest,nodeVersion:"v24.13.0",protocol:"agency-bridge/2"},taskCreate:null}
  if(options.editor){
    const {execFile}=await import("node:child_process"),{promisify}=await import("node:util"),{editorText}=await import("../scripts/qualification/editor.js")
    const execute=(file:string,args:string[])=>promisify(execFile)(file,args,{timeout:15000}),directory=join(persistentRoot,"editor"),plugin=await realpath(join(process.env.HOME!,".local/share/nvim/lazy/agentic.nvim")),revision=(await execute("git",["-C",plugin,"rev-parse","HEAD"])).stdout.trim()
    await mkdir(directory,{mode:0o700})
    config.editor={executable:await realpath((await execute("which",["nvim"])).stdout.trim()),shimPath:join(persistentRoot,"nvim"),initPath:join(directory,"init.lua"),toolDirectories:["/usr/bin","/bin","/opt/homebrew/bin"],luaRoot:join(packageRoot,"../home/.config/nvim"),plugins:[{path:plugin,revision}]}
    config.editor.luaRoot=await realpath(config.editor.luaRoot)
    const init=await readFile(join(packageRoot,"scripts/qualification/editor-init.lua"),"utf8")
    const adapter=fileURLToPath(new URL("../../test/fixtures/acp-neovim.lua",import.meta.url))
    await writeFile(config.editor.initPath,init.replace("local providers = {}", "dofile("+JSON.stringify(adapter)+")\nlocal providers = {}").replace("Control.new({ executable = c.launcherPath })","Control.new({ executable = c.launcherPath, system = AgencyFixture.system })"),{mode:0o600,flag:"wx"})
    await writeFile(join(directory,"editor.json"),JSON.stringify({launcherPath:config.launcherPath,luaRoot:config.editor.luaRoot,plugins:config.editor.plugins}),{mode:0o600,flag:"wx"})
    await writeFile(config.editor.shimPath,editorText(config),{mode:0o700,flag:"wx"})
  }
  const paths=privatePaths(config),normal=ordinaryPaths(hostId),sentinelFile=join(root,"sentinel.jsonl"),preload=fileURLToPath(new URL("./fixtures/qualification-sentinel.js",import.meta.url)),sentinelSetting=JSON.stringify({file:sentinelFile,roots:[normal.persistentRoot,normal.runtimeRoot]})
  const env={PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.LOGNAME,SHELL:"/bin/sh",LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,HOME:join(root,"home"),QUALIFICATION_ROOT:root,QUALIFICATION_REPORTING_PROVIDER:options.provider==="reporting"?"1":"0",QUALIFICATION_SENTINEL:sentinelSetting,NODE_OPTIONS:"--import="+new URL("./fixtures/qualification-sentinel.js",import.meta.url).href,AGENCY_TEST_EVIDENCE_ROOT:root,FIXTURE_ROOT:root,FIXTURE_BACKEND:"codex-acp"}
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
  const runtime=await fixtureRuntime(),scope=runtime.scope,receiver=await workerReceiver(),refs=new Set<string>(),sourceRefs:LaunchRef[]=[]
  scope.artifact(root);scope.artifact(runtimeRoot)
  const completed=new WeakMap<ChildProcessWithoutNullStreams,Promise<number>>()
  const commandResults:Array<{pid:number|undefined;argv:string[];code:number|null;signal:NodeJS.Signals|null;stderr:string;error:string|null}>=[]
  const children=new Set<ChildProcessWithoutNullStreams>(),pending=new Set<Promise<number>>(),peers=new Set<Awaited<ReturnType<typeof connectHandlerBridge>>>(),errors:string[]=[]
  const launches=()=>{
    const values=scope.snapshot().launches,known=new Set(refs)
    let changed=true
    while(changed){changed=false;for(const value of values)if(known.has(value.ownerId)&&!known.has(value.ref.launchId)){known.add(value.ref.launchId);changed=true}}
    return values.filter(value=>known.has(value.ref.launchId))
  }
  const native=(role:string,file:string,args:string[],options:SpawnOptions,source=false):ChildProcessWithoutNullStreams=>{
    const ref=scope.intent(role,{ownGroup:options.detached??false}),environment=cleanFixtureEnvironment(options.env)
    if(role==="editor"){environment.AGENCY_FIXTURE_NODE=process.execPath;environment.AGENCY_FIXTURE_PROCESS=fileURLToPath(new URL("./fixtures/editor-process.js",import.meta.url))}
    refs.add(ref.launchId)
    if(source){sourceRefs.push(ref);environment.AGENCY_FIXTURE_CONNECTION=JSON.stringify(receiver.connection(ref))}
    const child=registerFixtureChild(runtime,ref,()=>nodeSpawn(file,args,{...options,env:environment,stdio:"pipe"}),source&&(role==="qualification-command"||role==="qualification-shell"||role==="editor")?(role==="editor"?config.editor!.executable:config.node):undefined)
    children.add(child)
    const result={pid:child.pid,argv:args,code:null as number|null,signal:null as NodeJS.Signals|null,stderr:"",error:null as string|null}
    child.stderr.on("data",b=>{result.stderr=(result.stderr+String(b)).slice(-32768)})
    child.once("error",error=>{result.error=String(error);errors.push(String(error))})
    const settled=new Promise<number>(resolve=>child.once("close",(code,signal)=>{children.delete(child);result.code=code;result.signal=signal;commandResults.push(result);resolve(code??70)}))
    completed.set(child,settled);pending.add(settled);void settled.finally(()=>pending.delete(settled))
    const timer=setTimeout(()=>{errors.push("CHILD_DEADLINE "+child.pid);void nativeFixtureAccess(scope).signalPid(ref,"SIGTERM").catch(error=>errors.push(String(error)))},75000)
    timer.unref();child.once("close",()=>clearTimeout(timer))
    return child
  }
  const childSpawn=async(argv:string[],remaining=()=>Infinity)=>{
    remaining()
    const source=!["acp","internal-task-tools","internal-runtime-bridge"].includes(argv[0]??"")
    return source?native("qualification-command",config.launcherPath,argv,{cwd:workspace,env},true):native("qualification-command",config.node,[fixtureEntry,"--config",config.configPath,...argv],{cwd:workspace,env})
  }
  const command=async(argv:string[],remaining=()=>Infinity)=>{const child=await childSpawn(argv,remaining);let stdout="",stderr="";child.stdout.on("data",b=>stdout+=String(b));child.stderr.on("data",b=>stderr+=String(b));child.stdin.end();const code=await completed.get(child)!;return {code,stdout,stderr}}
  const shutdown=async(remaining=()=>Infinity):Promise<CommandResult>=>{
    remaining()
    const current=await owner(),args=["shutdown","--stop-agents","--handler-generation",current.generation,"--command-id",randomUUID(),"--json"]
    const first=await command(args,remaining)
    return retryQualificationShutdown(first,current.generation,()=>until(async()=>{remaining();try{return await adapter.readProcess(current.process.pid)===null?true:undefined}catch(error){if(error instanceof Error&&error.name.endsWith("ObservationUnavailable"))return undefined;throw error}},Math.min(15000,remaining())).then(()=>undefined),()=>command(args,remaining))
  }
  const owner=async()=>{const inspection=await inspectHandlerGeneration(runtimeRoot,adapter);assert.ok(inspection?.disposition==="live"&&inspection.record.phase==="ready"&&inspection.record.process);return {generation:inspection.record.generation,process:inspection.record.process}}
  const sentinel=async()=> (await readFile(sentinelFile,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))
  let cleanup:Promise<void>|undefined
  const verifyCleanup=()=>{cleanup??=cleanupOwned();return cleanup}
  const cleanupOwned=async()=>{
    const failures:unknown[]=[],end=Date.now()+60000
    const attempt=async(label:string,work:(remaining:()=>number)=>Promise<unknown>,ms=15000)=>{
      const deadline=Math.min(end,Date.now()+ms)
      let active=true,timer:NodeJS.Timeout|undefined
      const remaining=()=>{const value=deadline-Date.now();if(!active||value<=0)throw new Error(label+" deadline");return value}
      try{remaining();await Promise.race([Promise.resolve().then(()=>{remaining();return work(remaining)}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{active=false;reject(new Error(label+" deadline"))},remaining())})])}
      catch(error){failures.push(error)}finally{active=false;clearTimeout(timer)}
    }
    for(const peer of peers)try{peer.close()}catch(error){failures.push(error)}
    for(const child of children)try{child.stdin.end()}catch(error){failures.push(error)}
    await attempt("private owner shutdown",async remaining=>{
      const inventory=await createAgentStore(persistentRoot).inventory().catch(()=>null)
      remaining()
      await writeFile(join(root,"before-cleanup.json"),JSON.stringify({inventory,launches:launches()}),{mode:0o600})
      const current=await inspectHandlerGeneration(runtimeRoot,adapter)
      if(current?.disposition==="live"){
        const expected=current.record.process
        assert.ok(expected&&launches().some(value=>value.identity&&sameProcess(value.identity,expected)),"private owner is not registered in this run")
        const reply=await shutdown(remaining)
        assert.equal(reply.code,0,reply.stdout+reply.stderr)
      }
    })
    for(const child of children)await attempt("owned command stop",async remaining=>{
      const launch=launches().find(value=>value.pid===child.pid)
      assert.ok(launch,"unregistered owned command")
      if(child.exitCode===null&&child.signalCode===null)await nativeFixtureAccess(scope).signalPid(launch.ref,"SIGTERM",remaining())
    },5000)
    await attempt("owned command join",()=>until(async()=>pending.size===0?true:undefined,5000),5000)
    for(const child of children)await attempt("owned command kill",async remaining=>{
      const launch=launches().find(value=>value.pid===child.pid)
      assert.ok(launch,"unregistered owned command")
      if(child.exitCode===null&&child.signalCode===null)await nativeFixtureAccess(scope).signalPid(launch.ref,"SIGKILL",remaining())
    },5000)
    await attempt("owned command close",()=>until(async()=>pending.size===0?true:undefined,5000),5000)
    await attempt("fixture reports",()=>receiver.settle(sourceRefs))
    for(const launch of launches())if(launch.pid!==null)await attempt(launch.role+" absence",async()=>{
      await until(async()=>{const actual=await adapter.readProcess(launch.pid!);return !actual||launch.identity&&!sameProcessGeneration(launch.identity,actual)?true:undefined},Math.max(1,Math.min(15000,end-Date.now())))
      if(launch.pid===launch.identity?.processGroupId)assert.deepEqual(await adapter.readGroup(launch.pid),[])
    })
    await attempt("fixture checks",()=>nativeFixtureAccess(scope).settleChecks(launches().map(value=>value.ref)))
    await attempt("private fixture isolation",async()=>{assert.deepEqual(errors,[]);assert.deepEqual(await sentinel(),[])})
    if(failures.length)throw new AggregateError(failures,"qualification cleanup incomplete: "+failures.map(String).join("; "))
    const values=launches().map(value=>({...value,absent:value.pid===null?value.absent:true})),identities=values.flatMap(value=>value.identity?[value.identity]:[])
    await writeFile(join(root,"cleanup.json"),JSON.stringify({identities,launches:values,survivors:[],verifiedAt:Date.now()}),{mode:0o600})
    await writeFile(join(root,"result.json"),JSON.stringify({revision:config.binding.sourceRevision,commands:commandResults,identities,cleanup:"verified",root,runtimeRoot}),{mode:0o600})
    if(evidence)await cp(root,join(evidence,"fixtures",root.split("/").at(-1)!),{recursive:true,filter:async path=>!(await lstat(path)).isSocket()})
    t.diagnostic("retained qualification fixture: "+root)
  }
  t.after(async()=>{try{await verifyCleanup()}catch(error){await writeFile(join(root,"result.json"),JSON.stringify({revision:config.binding.sourceRevision,commands:commandResults,launches:launches(),cleanup:"incomplete",error:String(error),root,runtimeRoot}),{mode:0o600});throw new AggregateError([error],"qualification fixture retained "+root)}})
  const result:QualificationFixture={config,paths,root,workspace,adapter,command,shutdown,spawn:childSpawn,native,owner,sentinel,verifyCleanup,async bridge(){const current=await owner(),peer=await connectHandlerBridge({root:runtimeRoot,hostId,handlerGeneration:current.generation});peers.add(peer);return peer}}
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