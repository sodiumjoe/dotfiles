import fs from "node:fs"
import promises from "node:fs/promises"
import net from "node:net"
import { syncBuiltinESMExports } from "node:module"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
const setting=process.env.QUALIFICATION_SENTINEL
if(setting){
  const c=JSON.parse(setting) as {file:string;roots:string[]}, append=fs.appendFileSync
  const record=(value:object)=>append(c.file,JSON.stringify({pid:process.pid,...value})+"\n",{mode:0o600})
  const canonical=(value:string)=>{const path=resolve(value);return process.platform==="darwin"&&(path==="/tmp"||path.startsWith("/tmp/"))?"/private"+path:path}
  function check(operation:string,value:unknown){
    const path=value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():typeof value==="string"?value:null
    if(path===null)return
    const normalized=canonical(path)
    if(c.roots.some(root=>normalized===canonical(root)||normalized.startsWith(canonical(root)+"/"))){record({operation,path:normalized});throw new Error("ORDINARY_PATH_ACCESS")}
  }
  for(const name of ["lstat","stat","realpath","access","open","readFile","writeFile","appendFile","mkdir","readdir","rename","unlink","rm","rmdir","chmod","readlink","symlink","link","copyFile","cp","opendir","truncate","chown","lchown","utimes","watch"]){
    for(const [target,key] of [[fs,name],[fs,name+"Sync"],[promises,name]] as const){
      const object=target as unknown as Record<string,any>, original=object[key]
      if(typeof original!=="function")continue
      object[key]=function(...args:unknown[]){check(key,args[0]);if(["rename","symlink","link","copyFile","cp"].includes(name))check(key,args[1]);return original.apply(this,args)}
    }
  }
  for(const [target,key] of [[net,"connect"],[net,"createConnection"],[net.Socket.prototype,"connect"]] as const){
    const object=target as unknown as Record<string,any>,original=object[key]
    object[key]=function(...args:any[]){for(const arg of args){if(arg&&typeof arg==="object"&&"path" in arg)check("net."+key,arg.path);else if(typeof arg==="string"&&arg.startsWith("/"))check("net."+key,arg)}return original.apply(this,args)}
  }
  syncBuiltinESMExports()
}