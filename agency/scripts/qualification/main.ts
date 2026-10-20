import { fileURLToPath } from "node:url"
import { readPrivateConfig } from "./config.js"
import { privateControl,privateHandlerOptions } from "./runtime.js"
import { runPrivateTaskTools } from "./task-guard.js"
import { runControl } from "../../src/cli/control.js"
import { runHandler,type HandlerOptions } from "../../src/handler/daemon.js"
import { runRuntimeBridgeCli } from "../../src/bridge/runtime-remote.js"
import { connectHandlerBridge } from "../../src/bridge/handler-client.js"
import { runRuntimeEntryHelper } from "../../src/entry/cli.js"
import { runAcpEndpoint } from "../../src/acp/endpoint.js"
import { snapshotLaunchEnvironment } from "../../src/agent/environment.js"
import { assertPrivateSocket } from "../../src/platform/private-socket.js"
import { parseTaskRef } from "../../src/tasks/types.js"
export type QualificationHooks={handlerEntry?:string;handlerOptions?:(options:HandlerOptions)=>HandlerOptions;enter?:(file:string,args:string[])=>Promise<number>}
export async function runQualification(argv:string[],hooks:QualificationHooks={}):Promise<number>{
  if(argv[0]!=="--config"||!argv[1])throw new Error("CONFIG_REQUIRED")
  const c=await readPrivateConfig(argv[1]),args=argv.slice(2),control=privateControl(c,hooks.handlerEntry)
  const ready=async()=>{const env=await control.environment(),owner=await control.inspect(env);if(!owner||owner.disposition!=="live"||owner.record.phase!=="ready")throw new Error("PRIVATE_HANDLER_NOT_READY");return owner}
  const connect=async()=>{const owner=await ready(),peer=await connectHandlerBridge({root:c.runtimeRoot,hostId:c.hostId,handlerGeneration:owner.record.generation});const h=await peer.ready;if(h.protocol!==c.binding.protocol||h.sourceRevision!==c.binding.sourceRevision||h.nodeVersion!==c.binding.nodeVersion){peer.close();throw new Error("PRIVATE_HELLO_CHANGED")}return peer}
  switch(args[0]){
    case "internal-handler":{if(args.length!==1)throw new Error("USAGE");const options=await privateHandlerOptions(c);await runHandler(hooks.handlerOptions?hooks.handlerOptions(options):options);return 0}
    case "internal-runtime-bridge":if(args.length!==1)throw new Error("USAGE");await runRuntimeBridgeCli([],{input:process.stdin,output:process.stdout,connect});return 0
    case "internal-runtime-entry":return runRuntimeEntryHelper(args.slice(1),control,hooks.enter)
    case "internal-task-tools":{if(args.length!==1&&(args.length!==3||args[1]!=="--default-ref-json"))throw new Error("USAGE");const ref=args.length===3?parseTaskRef(JSON.parse(args[2]!)):undefined;if(ref&&ref.hostId!==c.hostId)throw new Error("WORKER_HOST");await runPrivateTaskTools(c,control,{input:process.stdin,output:process.stdout},ref);return 0}
    case "acp":return runAcpEndpoint(args.slice(1),{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,environment:snapshotLaunchEnvironment(process.env),discover:async()=>{const owner=await ready();return {socketPath:await assertPrivateSocket(c.runtimeRoot,"acp.sock"),generation:owner.record.generation}}})
    default:return runControl(args,control)
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){process.umask(0o077);try{process.exitCode=await runQualification(process.argv.slice(2))}catch{process.stderr.write("Qualification command refused\n");process.exitCode=70}}