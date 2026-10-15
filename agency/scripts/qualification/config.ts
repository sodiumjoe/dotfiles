import { lstat, realpath } from "node:fs/promises"
import { join, dirname, parse, relative } from "node:path"
import { homedir } from "node:os"
import { readBoundedFile, decodeJson } from "../../src/catalog/config.js"
import { absolutePath, object, keys, hash, id } from "../../src/catalog/types.js"
import { parseTaskRef, type TaskRef } from "../../src/tasks/types.js"
import type { JsonObject } from "../../src/agent/session-config.js"
import type { PlatformPaths } from "../../src/platform/paths.js"
import { readHostId } from "../../src/platform/host-id.js"
import { assertPrivateDirectory } from "../../src/platform/private-state.js"
import { verifyBuildManifest } from "../build-manifest.js"
import { posixQuote } from "../../src/bridge/bootstrap.js"
export type CandidateBinding = { sourceRevision:string; sourceDigest:string; distDigest:string; nodeVersion:"v24.13.0"; protocol:"agency-bridge/2" }
export type PrivateConfig = {
  version:1; batchId:string; hostId:string; packageRoot:string; persistentRoot:string; runtimeRoot:string
  node:string; launcherPath:string; configPath:string
  editor:null | { executable:string; shimPath:string; initPath:string; toolDirectories:string[]; luaRoot:string; plugins:Array<{path:string;revision:string}> }
  binding:CandidateBinding; taskCreate:null | {allowancePath:string;sha256:string}
}
export const inside = (parent:string, path:string):boolean => path===parent || path.startsWith(parent+"/")
export function parseBinding(raw:unknown):CandidateBinding {
  const v=object(raw); keys(v,["sourceRevision","sourceDigest","distDigest","nodeVersion","protocol"])
  if(typeof v.sourceRevision!=="string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.sourceRevision) || v.nodeVersion!=="v24.13.0" || v.protocol!=="agency-bridge/2") throw new Error("CANDIDATE_BINDING")
  return {sourceRevision:v.sourceRevision,sourceDigest:hash(v.sourceDigest),distDigest:hash(v.distDigest),nodeVersion:v.nodeVersion,protocol:v.protocol}
}
export function ordinaryPaths(hostId:string, home=process.env.HOME??homedir(), xdg=process.env.XDG_STATE_HOME, platform=process.platform):PlatformPaths {
  const persistentRoot=join(xdg??join(home,".local/state"),"agency/hosts",hostId), runtimeRoot=join(platform==="darwin"?"/private/tmp":"/tmp",`agy-${process.getuid!()}-${hostId.slice(0,12)}`)
  return {hostKey:hostId,persistentRoot,runtimeRoot,handlerSocketPath:join(runtimeRoot,"handler.sock")}
}
const canonicalAlias=(path:string)=>process.platform==="darwin" && (path==="/tmp"||path.startsWith("/tmp/"))?"/private"+path:path
export function parsePrivateConfig(raw:unknown):PrivateConfig {
  const v=object(raw); keys(v,["version","batchId","hostId","packageRoot","persistentRoot","runtimeRoot","node","launcherPath","configPath","editor","binding","taskCreate"])
  if(v.version!==1) throw new Error("CONFIG_VERSION")
  const c:PrivateConfig={version:1,batchId:id(v.batchId),hostId:hash(v.hostId),packageRoot:absolutePath(v.packageRoot),persistentRoot:absolutePath(v.persistentRoot),runtimeRoot:absolutePath(v.runtimeRoot),node:absolutePath(v.node),launcherPath:absolutePath(v.launcherPath),configPath:absolutePath(v.configPath),editor:null,binding:parseBinding(v.binding),taskCreate:null}
  if(v.editor!==null) {
    const e=object(v.editor); keys(e,["executable","shimPath","initPath","toolDirectories","luaRoot","plugins"])
    if(!Array.isArray(e.toolDirectories)||!Array.isArray(e.plugins)) throw new Error("EDITOR_CONFIG")
    c.editor={executable:absolutePath(e.executable),shimPath:absolutePath(e.shimPath),initPath:absolutePath(e.initPath),luaRoot:absolutePath(e.luaRoot),toolDirectories:e.toolDirectories.map(absolutePath),plugins:e.plugins.map(raw=>{const p=object(raw);keys(p,["path","revision"]);if(typeof p.revision!=="string"||!/^[a-f0-9]{40}$/.test(p.revision))throw new Error("PLUGIN_REVISION");return {path:absolutePath(p.path),revision:p.revision}})}
  }
  if(c.editor&&(!inside(c.persistentRoot,c.editor.shimPath)||!inside(c.persistentRoot,c.editor.initPath)))throw new Error("EDITOR_LAYOUT")
  if(v.taskCreate!==null){const g=object(v.taskCreate);keys(g,["allowancePath","sha256"]);c.taskCreate={allowancePath:absolutePath(g.allowancePath),sha256:hash(g.sha256)};if(!inside(join(c.persistentRoot,"qualification/allowances"),c.taskCreate.allowancePath))throw new Error("ALLOWANCE_PATH")}
  const ordinary=ordinaryPaths(c.hostId), roots=[c.persistentRoot,c.runtimeRoot].map(canonicalAlias)
  if(inside(roots[0]!,roots[1]!)||inside(roots[1]!,roots[0]!)) throw new Error("OVERLAPPING_ROOTS")
  for(const root of roots) for(const normal of [ordinary.persistentRoot,ordinary.runtimeRoot].map(canonicalAlias)) if(inside(root,normal)||inside(normal,root))throw new Error("ORDINARY_ROOT")
  for(const root of roots) if(inside(c.packageRoot,root)||inside(root,c.packageRoot)) throw new Error("SOURCE_STATE_OVERLAP")
  if(!inside(c.persistentRoot,c.configPath)||!inside(c.persistentRoot,c.launcherPath)||Buffer.byteLength(join(c.runtimeRoot,"handler.sock"))>=100)throw new Error("PRIVATE_LAYOUT")
  return c
}
export async function canonicalPath(path:string):Promise<void> {
  absolutePath(path)
  let current=parse(path).root
  for(const component of relative(current,path).split("/").filter(Boolean)){current=join(current,component);if((await lstat(current)).isSymbolicLink())throw new Error("SYMLINK_COMPONENT")}
  if(await realpath(path)!==path)throw new Error("NONCANONICAL_PATH")
}
export async function privateFile(path:string, max=65536):Promise<Buffer> {
  await canonicalPath(path);const s=await lstat(path)
  if(!s.isFile()||s.uid!==process.getuid!()||(s.mode&0o777)!==0o600)throw new Error("PRIVATE_FILE")
  const bytes=await readBoundedFile(path,max,true);if(!bytes)throw new Error("MISSING_FILE");return bytes
}
export async function validatePrivateConfig(c:PrivateConfig):Promise<void> {
  parsePrivateConfig(c)
  if(process.version!==c.binding.nodeVersion||await realpath(process.execPath)!==c.node||await readHostId(process.platform as "darwin"|"linux")!==c.hostId)throw new Error("HOST_OR_NODE_CHANGED")
  for(const root of [c.persistentRoot,c.runtimeRoot]){await canonicalPath(root);await assertPrivateDirectory(root)}
  await canonicalPath(c.packageRoot);await canonicalPath(c.node)
  for(const path of [c.launcherPath,c.configPath,...(c.editor?[c.editor.shimPath,c.editor.initPath]:[])]){
    await canonicalPath(dirname(path))
    const info=await lstat(path).catch(error=>{if(error.code==="ENOENT")return null;throw error})
    if(info)await canonicalPath(path)
    const installed=await realpath(join(process.env.HOME??homedir(),"bin/agy")).catch(()=>null)
    if(path===installed||path===join(process.env.HOME??homedir(),"bin/agy"))throw new Error("INSTALLED_EXECUTABLE")
  }
  const manifest=decodeJson((await readBoundedFile(join(c.packageRoot,"dist/build-manifest.json"),65536))!) as Record<string,unknown>
  if(manifest.sourceRevision!==c.binding.sourceRevision||manifest.sourceDigest!==c.binding.sourceDigest||manifest.distDigest!==c.binding.distDigest||manifest.nodeVersion!==c.binding.nodeVersion||!await verifyBuildManifest(c.packageRoot))throw new Error("BUILD_CHANGED")
}
export async function readPrivateConfig(path:string):Promise<PrivateConfig> {const c=parsePrivateConfig(decodeJson(await privateFile(path)));if(c.configPath!==path)throw new Error("CONFIG_PATH");await validatePrivateConfig(c);return c}
export function privatePaths(c:PrivateConfig):PlatformPaths {return {hostKey:c.hostId,persistentRoot:c.persistentRoot,runtimeRoot:c.runtimeRoot,handlerSocketPath:join(c.runtimeRoot,"handler.sock")}}
export function candidateDescriptor(c:PrivateConfig,ref?:TaskRef):JsonObject{return {name:"agency_tasks",command:c.launcherPath,args:["internal-task-tools",...(ref?["--default-ref-json",JSON.stringify(parseTaskRef(ref))]:[])],env:[]}}
export function launcherText(c:PrivateConfig,entry=join(c.packageRoot,"dist/scripts/qualification/main.js")):string {for(const path of [c.node,entry,c.configPath])absolutePath(path);return "#!/bin/sh\nexec "+[c.node,entry,"--config",c.configPath].map(posixQuote).join(" ")+' "$@"'}