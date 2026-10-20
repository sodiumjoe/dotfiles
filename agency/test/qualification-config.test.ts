import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, chmod, symlink, rm, realpath } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parsePrivateConfig, readPrivateConfig, privatePaths, candidateDescriptor, launcherText, type PrivateConfig } from "../scripts/qualification/config.js"
import { createTaskGuard, taskClaimPath, type TaskAllowance } from "../scripts/qualification/task-guard.js"
import { editorText } from "../scripts/qualification/editor.js"
import { readHostId } from "../src/platform/host-id.js"
import type { HostRoute } from "../src/hosts/router.js"
const execute = (file:string,args:string[],options:import("node:child_process").ExecFileOptions={})=>promisify(execFile)(file,args,{timeout:15000,...options,encoding:"utf8"})
const binding = { sourceRevision: "a".repeat(40), sourceDigest: "b".repeat(64), distDigest: "c".repeat(64), nodeVersion: "v24.13.0", protocol: "agency-bridge/2" } as const
const sample = (root: string): PrivateConfig => ({ version: 1, batchId: randomUUID(), hostId: "a".repeat(64), packageRoot: join(root,"pkg"), persistentRoot: join(root,"p"), runtimeRoot: join(root,"r"), node: process.execPath, launcherPath: join(root,"p/agy"), configPath: join(root,"p/config.json"), editor: null, binding, taskCreate: null })
async function fixture(t: test.TestContext) { const root = await mkdtemp("/private/tmp/qc-"); t.after(() => rm(root,{recursive:true,force:true})); return {root, config: sample(root)} }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
test("private descriptors carry explicit candidate paths and refs", async t => {
  const {config} = await fixture(t), ref = {hostId:config.hostId, taskId:randomUUID()}
  assert.deepEqual(candidateDescriptor(config),{name:"agency_tasks",command:config.launcherPath,args:["internal-task-tools"],env:[]})
  assert.deepEqual(candidateDescriptor(config,ref),{name:"agency_tasks",command:config.launcherPath,args:["internal-task-tools","--default-ref-json",JSON.stringify(ref)],env:[]})
  assert.equal(privatePaths(config).handlerSocketPath,join(config.runtimeRoot,"handler.sock"))
  assert.deepEqual(parsePrivateConfig(config),config)
})
test("strict config rejects malformed paths, identities, keys and overlapping roots", async t => {
  const {config} = await fixture(t)
  for (const patch of [{extra:1},{batchId:"bad"},{hostId:"bad"},{node:"relative"},{runtimeRoot:config.persistentRoot},{runtimeRoot:config.persistentRoot+"/child"},{launcherPath:"/bad\npath"},{runtimeRoot:"/private/tmp/"+"x".repeat(100)},{binding:{...binding,protocol:"agency-bridge/1"}},{binding:{...binding,nodeVersion:"v22"}},{binding:{...binding,sourceRevision:"bad"}}]) assert.throws(()=>parsePrivateConfig({...config,...patch}),JSON.stringify(patch))
  for (const key of Object.keys(config)) { const bad:any = {...config}; delete bad[key]; assert.throws(()=>parsePrivateConfig(bad),key) }
})
test("disk config rejects symlinks, mode, actual host, executable and build mismatch without creating state", async t => {
  const {root,config} = await fixture(t)
  await mkdir(config.persistentRoot,{mode:0o700}); await mkdir(config.runtimeRoot,{mode:0o700})
  config.hostId = await readHostId(process.platform as "darwin")
  await writeFile(config.configPath,JSON.stringify(config),{mode:0o600})
  await assert.rejects(readPrivateConfig(config.configPath))
  await chmod(config.configPath,0o644); await assert.rejects(readPrivateConfig(config.configPath)); await chmod(config.configPath,0o600)
  const link=join(root,"link"); await symlink(config.configPath,link); await assert.rejects(readPrivateConfig(link))
  await assert.rejects(readFile(join(config.persistentRoot,"launches")))
})
test("launcher quoting preserves literal shell arguments", async t => {
  const {root,config} = await fixture(t), entry = join(root,"entry ' space.mjs"), cfg=join(root,"cfg ' file")
  config.configPath=cfg
  await writeFile(entry,"process.stdout.write(JSON.stringify(process.argv.slice(2)))")
  const shim=join(root,"agy"); await writeFile(shim,launcherText(config,entry),{mode:0o700})
  const argv=["", "literal `uname` $(uname) $HOME ' \\","x y"]
  const result=await execute(shim,argv)
  assert.deepEqual(JSON.parse(result.stdout),["--config",cfg,...argv])
})
test("editor shim pins clean init and removes ambient Neovim sockets",async t=>{
  const {root,config}=await fixture(t), recorder=join(root,"editor"), output=join(root,"seen.json")
  await mkdir(config.persistentRoot,{mode:0o700}); await writeFile(config.launcherPath,"#!/bin/sh\nexit 0",{mode:0o700})
  await writeFile(recorder,"#!/bin/sh\nexec "+JSON.stringify(process.execPath)+" -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),path:process.env.PATH,nvim:process.env.NVIM}))' -- \"$@\"",{mode:0o700})
  config.editor={executable:recorder,shimPath:join(root,"nvim"),initPath:join(root,"init.lua"),toolDirectories:["/usr/bin","/bin"],luaRoot:root,plugins:[]}
  await writeFile(config.editor.shimPath,editorText(config),{mode:0o700})
  const seen=JSON.parse((await execute(config.editor.shimPath,["--headless"],{env:{...process.env,NVIM:output}})).stdout)
  assert.deepEqual(seen.argv,["--clean","-u",config.editor.initPath,"--headless"]); assert.equal(seen.nvim,undefined); assert.equal(seen.path.split(":")[0],config.persistentRoot)
})
async function guardFixture(t:test.TestContext) {
  const {root,config}=await fixture(t), dir=join(config.persistentRoot,"qualification/allowances")
  await mkdir(dir,{recursive:true,mode:0o700})
  const allowance:TaskAllowance={version:1,batchId:config.batchId,operationId:randomUUID(),sourceHostId:config.hostId,hostId:config.hostId,handlerGeneration:randomUUID(),binding,input:{taskId:randomUUID(),description:"fixture",cwd:root,backendId:"codex-acp",text:"only this"},notBefore:Date.now()-1000,deadline:Date.now()+60000}
  const bytes=JSON.stringify(allowance), path=join(dir,"allowance.json"); await writeFile(path,bytes,{mode:0o600}); config.taskCreate={allowancePath:path,sha256:digest(bytes)}
  const route:HostRoute={hostId:config.hostId,channel:"task-write",payload:{protocol:"agency-task/1",requestId:randomUUID(),hostId:config.hostId,handlerGeneration:allowance.handlerGeneration,op:"create",input:allowance.input}}
  return {root,config,allowance,route}
}
test("task guard forwards the exact request once across concurrent instances and restart",async t=>{
  const {config,allowance,route}=await guardFixture(t); let count=0
  const forward=async()=>{ count++; return {accepted:true} }
  const a=createTaskGuard(config,forward), b=createTaskGuard(config,forward)
  const replies=await Promise.all([a(route),b(route)])
  assert.equal(count,1); assert.equal(replies.filter((r:any)=>r.accepted).length,1)
  await createTaskGuard(config,forward)(route); assert.equal(count,1)
  const claim=JSON.parse(await readFile(taskClaimPath(config.taskCreate!.allowancePath,allowance.operationId),"utf8")); assert.deepEqual(claim.input,allowance.input)
})
test("task guard denies changed full inputs and worker or absent allowances before forwarding",async t=>{
  const {config,allowance,route}=await guardFixture(t); let count=0; const forward=async()=>{count++;return {}}
  for(const patch of [{text:"other"},{taskId:randomUUID()},{cwd:"/other"},{backendId:"claude-agent-acp"},{description:"other"},{parent:{hostId:config.hostId,taskId:randomUUID()}},{settings:{modelId:"other"}},{settings:{modeId:"other"}},{settings:{configValues:{reasoning:"other"}}},{nativeParams:{mcpServers:[]}}]) {
    const result:any=await createTaskGuard(config,forward)({...route,payload:{...(route.payload as object),input:{...allowance.input,...patch}}}); assert.equal(result.ok,false)
  }
  assert.equal((await createTaskGuard(config,forward,{hostId:config.hostId,taskId:allowance.input.taskId})(route) as any).ok,false)
  assert.equal((await createTaskGuard({...config,taskCreate:null},forward)(route) as any).ok,false)
  assert.equal(count,0)
})
test("task guard preserves forwarding uncertainty and consumes the allowance",async t=>{
  const {config,route}=await guardFixture(t); let count=0
  const forward=async()=>{count++;throw new Error("lost reply")}
  await assert.rejects(createTaskGuard(config,forward)(route),/lost reply/)
  assert.equal((await createTaskGuard(config,forward)(route) as any).ok,false); assert.equal(count,1)
  assert.equal(await createTaskGuard(config,async()=>"read")({...route,channel:"host-identity",payload:{}}),"read")
})

test("guard refusal is a definite INVALID_INPUT through ordinary MCP bindings",async t=>{
  const {config,allowance}=await guardFixture(t)
  const {createHostTaskClient}=await import("../src/tasks/client.js"), {createTaskToolBindings}=await import("../src/tasks/mcp.js")
  const guard=createTaskGuard({...config,taskCreate:null},async()=>({hostId:config.hostId,handlerGeneration:allowance.handlerGeneration}))
  const client=createHostTaskClient({localHostId:config.hostId,route:guard})
  t.after(()=>client.close())
  const result=await createTaskToolBindings({client}).call("agency_task_create",{hostId:config.hostId,input:allowance.input})
  assert.equal(result.isError,true)
  assert.equal((JSON.parse((result.content[0] as {text:string}).text)).error.code,"INVALID_INPUT")
})
test("config compares declared bindings without recursively hashing candidate files",async t=>{
  const {root,config}=await fixture(t)
  const {captureBuildManifest,publishBuildManifest}=await import("../scripts/build-manifest.js")
  await mkdir(join(config.packageRoot,"dist"),{recursive:true,mode:0o700})
  await mkdir(config.persistentRoot,{mode:0o700});await mkdir(config.runtimeRoot,{mode:0o700})
  await writeFile(join(config.packageRoot,"dist/leaf.js"),"export const candidate = 1")
  config.hostId=await readHostId(process.platform as "darwin")
  config.node=await realpath(process.execPath)
  const manifest={...await captureBuildManifest(config.packageRoot),sourceRevision:"d".repeat(40)}
  await publishBuildManifest(config.packageRoot,manifest)
  config.binding={...manifest,protocol:"agency-bridge/2"} as any
  delete (config.binding as any).version
  await writeFile(config.configPath,JSON.stringify(config),{mode:0o600})
  assert.deepEqual(await readPrivateConfig(config.configPath),config)
  await chmod(config.runtimeRoot,0o755);await assert.rejects(readPrivateConfig(config.configPath));await chmod(config.runtimeRoot,0o700)
  await chmod(config.configPath,0o644);await assert.rejects(readPrivateConfig(config.configPath));await chmod(config.configPath,0o600)
  await symlink(config.node,config.launcherPath);await assert.rejects(readPrivateConfig(config.configPath),/SYMLINK/);await rm(config.launcherPath)
  for(const patch of [{hostId:"e".repeat(64)},{node:"/usr/bin/false"},{binding:{...config.binding,sourceRevision:"e".repeat(40)}},{binding:{...config.binding,sourceDigest:"e".repeat(64)}},{binding:{...config.binding,distDigest:"e".repeat(64)}}]){
    await writeFile(config.configPath,JSON.stringify({...config,...patch}))
    await assert.rejects(readPrivateConfig(config.configPath),JSON.stringify(patch))
  }
  await writeFile(config.configPath,JSON.stringify(config))
  await writeFile(join(config.packageRoot,"dist/leaf.js"),"export const candidate = 2")
  assert.deepEqual(await readPrivateConfig(config.configPath),config)
  await mkdir(join(config.packageRoot,"src"),{mode:0o700})
  await writeFile(join(config.packageRoot,"src/unrelated.ts"),"export const added = 1")
  assert.deepEqual(await readPrivateConfig(config.configPath),config)
  await assert.rejects(readFile(join(config.persistentRoot,"launches")))
  assert.throws(()=>parsePrivateConfig({...config,packageRoot:join(config.persistentRoot,"pkg")}))
  assert.throws(()=>parsePrivateConfig({...config,editor:{executable:"/usr/bin/true",shimPath:"/outside/nvim",initPath:"/outside/init.lua",toolDirectories:[],luaRoot:root,plugins:[]}}))
})
test("guard claims are exclusive across helper processes and survive their exit",async t=>{
  const {root,config,allowance,route}=await guardFixture(t), child=join(root,"guard.mjs")
  await writeFile(join(root,"fixture.json"),JSON.stringify({config,route}),{mode:0o600})
  await writeFile(child,`import {readFile,appendFile} from 'node:fs/promises'; import {createTaskGuard} from ${JSON.stringify(new URL("../scripts/qualification/task-guard.js",import.meta.url).href)}; const {config,route}=JSON.parse(await readFile(process.argv[2],'utf8')); const reply=await createTaskGuard(config,async()=>{await appendFile(process.argv[3],'accepted\\n');return {accepted:true}})(route); process.stdout.write(JSON.stringify(reply));`)
  const args=[child,join(root,"fixture.json"),join(root,"forwarded")]
  await Promise.all([execute(process.execPath,args),execute(process.execPath,args)])
  await execute(process.execPath,args)
  assert.equal(await readFile(join(root,"forwarded"),"utf8"),"accepted\n")
  assert.deepEqual(JSON.parse(await readFile(taskClaimPath(config.taskCreate!.allowancePath,allowance.operationId),"utf8")).input,allowance.input)
})
test("guard rejects changed identity digest batch and expired windows before forwarding",async t=>{
  const {config,allowance,route}=await guardFixture(t);let count=0
  const forward=async()=>{count++;return {}}
  for(const patch of [{batchId:randomUUID()},{sourceHostId:"e".repeat(64)},{hostId:"e".repeat(64)},{handlerGeneration:randomUUID()},{binding:{...binding,sourceDigest:"e".repeat(64)}},{notBefore:Date.now()-20000,deadline:Date.now()-10000}]){
    const bytes=JSON.stringify({...allowance,...patch});await writeFile(config.taskCreate!.allowancePath,bytes)
    const cfg={...config,taskCreate:{...config.taskCreate!,sha256:digest(bytes)}}
    assert.equal((await createTaskGuard(cfg,forward)(route) as any).ok,false)
  }
  await writeFile(config.taskCreate!.allowancePath,JSON.stringify(allowance))
  assert.equal((await createTaskGuard({...config,taskCreate:{...config.taskCreate!,sha256:"e".repeat(64)}},forward)(route) as any).ok,false)
  const abort=new AbortController();abort.abort()
  assert.equal((await createTaskGuard(config,forward)(route,abort.signal) as any).ok,false)
  assert.equal(count,0)
})
test("headless private editor config disables direct providers and binds real Control argv",async t=>{
  const {root,config}=await fixture(t), executable=(await execute("which",["nvim"])).stdout.trim(), init=join(root,"init.lua"), stub=join(root,"stub.lua")
  await mkdir(config.persistentRoot,{mode:0o700});await writeFile(config.launcherPath,"#!/bin/sh\nprintf '%s\\n' \"$@\" > "+JSON.stringify(join(root,"argv")),{mode:0o700})
  config.editor={executable,shimPath:join(root,"nvim"),initPath:init,toolDirectories:["/usr/bin","/bin"],luaRoot:new URL("../../../home/.config/nvim",import.meta.url).pathname,plugins:[]}
  await writeFile(init,await readFile(new URL("../../scripts/qualification/editor-init.lua",import.meta.url)))
  await writeFile(join(root,"editor.json"),JSON.stringify({launcherPath:config.launcherPath,luaRoot:config.editor.luaRoot,plugins:[]}),{mode:0o600})
  await writeFile(stub,`package.preload['agentic.config_default']=function() return {acp_providers={codex={},claude={},new_provider={}}} end
package.preload['agentic']=function() return {setup=function(c) assert(c.provider=='agency'); assert(c.acp_providers.agency.command==${JSON.stringify(config.launcherPath)}); assert(vim.deep_equal(c.acp_providers.agency.args,{'acp'})); for _,name in ipairs({'codex','claude','new_provider'}) do assert(c.acp_providers[name]==false) end end} end
package.preload['sodium.agency']=function() return {setup=function(c) assert(vim.fn.exepath('agy')==${JSON.stringify(config.launcherPath)}); c.client.command({'doctor'},{},function() end) end} end`)
  await writeFile(config.editor.shimPath,editorText(config),{mode:0o700})
  const result=await execute(config.editor.shimPath,["--headless","--cmd","lua dofile("+JSON.stringify(stub)+")","-c","lua vim.wait(1000, function() return vim.uv.fs_stat("+JSON.stringify(join(root,"argv"))+") ~= nil end)","-c","qa!"],{timeout:10000})
  assert.equal(result.stderr,"")
  assert.equal(await readFile(join(root,"argv"),"utf8"),"doctor\n--json\n")
})

test("cancellation after durable claim consumes allowance while reads and reports remain usable",async t=>{
  const {config,allowance,route}=await guardFixture(t);let count=0,checks=0
  const signal={get aborted(){return ++checks>1}} as AbortSignal
  const guard=createTaskGuard(config,async()=>{count++;return "forwarded"})
  assert.equal((await guard(route,signal) as any).ok,false)
  assert.equal(count,0)
  assert.equal(JSON.parse(await readFile(taskClaimPath(config.taskCreate!.allowancePath,allowance.operationId),"utf8")).operationId,allowance.operationId)
  assert.equal((await guard(route) as any).ok,false)
  const identity={protocol:"agency-task/1",requestId:randomUUID(),hostId:config.hostId,handlerGeneration:allowance.handlerGeneration}
  assert.equal(await guard({...route,channel:"task-read",payload:{...identity,op:"inspect",taskId:allowance.input.taskId}}),"forwarded")
  assert.equal(await guard({...route,payload:{...identity,op:"report",taskId:allowance.input.taskId,report:{outcome:"completed",summary:"kept"}}}),"forwarded")
  assert.equal(count,2)
})