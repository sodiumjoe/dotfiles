import { join } from "node:path"
import { Socket } from "node:net"
import { fstatSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import type { HandlerInspection } from "../../src/platform/types.js"
import { assertRuntime,ensurePrivateChild,type HandlerEnvironment } from "../../src/handler/environment.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { startOrConnect,inspectHandlerGeneration } from "../../src/platform/singleton.js"
import { productionControlDependencies,type ControlDependencies } from "../../src/cli/control.js"
import type { HandlerOptions } from "../../src/handler/daemon.js"
import { createTaskService } from "../../src/tasks/service.js"
import { createRuntimeEntryDriver } from "../../src/entry/editor.js"
import { id } from "../../src/catalog/types.js"
import { privatePaths,candidateDescriptor,validatePrivateConfig,privateFile,type PrivateConfig } from "./config.js"
export async function privateEnvironment(config:PrivateConfig):Promise<HandlerEnvironment>{await validatePrivateConfig(config);assertRuntime(process.versions.node,process.platform);const paths=privatePaths(config),adapter=process.platform==="darwin"?createDarwinAdapter():createLinuxAdapter();await ensurePrivateChild(paths.persistentRoot,"launches");return {paths,adapter}}
const ownerBinding=(c:PrivateConfig,generation:string)=>({version:1,hostId:c.hostId,generation,binding:c.binding})
const bindingPath=(c:PrivateConfig,generation:string)=>join(c.runtimeRoot,"qualification-"+id(generation)+".json")
async function boundOwner(c:PrivateConfig,owner:HandlerInspection|null):Promise<HandlerInspection|null>{
  if(owner?.disposition==="live"&&owner.record.phase==="ready"&&!isDeepStrictEqual(JSON.parse((await privateFile(bindingPath(c,owner.record.generation))).toString("utf8")),ownerBinding(c,owner.record.generation)))throw new Error("PRIVATE_OWNER_BINDING_CHANGED")
  return owner
}
export function privateControl(c:PrivateConfig,handlerEntry=join(c.packageRoot,"dist/scripts/qualification/main.js")):ControlDependencies{return {...productionControlDependencies(),environment:()=>privateEnvironment(c),start:async env=>(await boundOwner(c,await startOrConnect({root:env.paths.runtimeRoot,hostId:c.hostId,adapter:env.adapter,handler:{file:c.node,args:[handlerEntry,"--config",c.configPath,"internal-handler"]}})))!,inspect:async env=>boundOwner(c,await inspectHandlerGeneration(env.paths.runtimeRoot,env.adapter))}}
export async function privateHandlerOptions(c:PrivateConfig):Promise<HandlerOptions>{
  if(process.env.AGENCY_HANDLER_RECORD!==join(c.runtimeRoot,"handler.json")||!fstatSync(3).isSocket()||!fstatSync(4).isSocket())throw new Error("HANDLER_LAUNCH_REQUIRED")
  const env=await privateEnvironment(c),generation=id(process.env.AGENCY_HANDLER_GENERATION)
  await writeFile(bindingPath(c,generation),JSON.stringify(ownerBinding(c,generation)),{flag:"wx",mode:0o600})
  const disabled=async():Promise<never>=>{throw new Error("ENTRY_NOT_CONFIGURED")}
  return {...env,recordPath:process.env.AGENCY_HANDLER_RECORD,generation,status:new Socket({fd:3,readable:true,writable:true}),gate:new Socket({fd:4,readable:true,writable:true}),entryDriver:c.editor?createRuntimeEntryDriver({runtimeRoot:c.runtimeRoot,editor:c.editor.shimPath}):{ensure:disabled,activate:disabled,inspect:disabled},taskFactory:async input=>{await input.store.initialize();return createTaskService({...input,descriptor:ref=>candidateDescriptor(c,ref)})}}
}