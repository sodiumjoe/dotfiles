import { mkdir, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { boundedBytes, parsePreflightRequest } from "./preflight.js"
import { buildCollectorBootstrap } from "./bootstrap.js"
import { freezePhase, verifyPhaseEvidence, writeFrozenPhase, type PhaseInput } from "./batch.js"
import { posixQuote } from "../../src/bridge/bootstrap.js"
export async function runRunbook(argv:string[],packageRoot:string):Promise<void>{
  const [mode,...args]=argv,values=new Map<string,string>()
  for(let n=0;n<args.length;n+=2){const key=args[n],value=args[n+1];if(!key||!value||values.has(key)||!key.startsWith("--"))throw new Error("CLI_ARGUMENTS");values.set(key,value)}
  const expected=mode==="prepare-preflight"?["--input-json-file","--output"]:mode==="freeze"?["--input-json-file","--evidence-root","--output"]:[]
  if(!expected.length||values.size!==expected.length||expected.some(k=>!values.has(k)))throw new Error("CLI_ARGUMENTS")
  const bytes=await boundedBytes(values.get("--input-json-file")!),raw:unknown=JSON.parse(bytes.toString("utf8")),output=values.get("--output")!
  if(mode==="freeze"){
    const parsed=freezePhase(raw,Date.now())
    await verifyPhaseEvidence(parsed.input,values.get("--evidence-root")!)
    await writeFrozenPhase(output,freezePhase(parsed.input,Date.now()))
    return
  }
  const request=parsePreflightRequest(raw)
  if(request.issuedAt>Date.now()||request.deadline<=Date.now()||request.deadline-request.issuedAt>30000)throw new Error("REQUEST_WINDOW")
  const bootstrap=await buildCollectorBootstrap(packageRoot)
  if(Date.now()>request.deadline)throw new Error("REQUEST_EXPIRED")
  const requestJson=JSON.stringify(request),requestArgs=Array.from(requestJson).reduce<string[]>((parts,value)=>{if(!parts.length||Buffer.byteLength(parts.at(-1)!+value)>512)parts.push(value);else parts[parts.length-1]+=value;return parts},[]),destination="exec "+posixQuote(request.target.node)+" --input-type=commonjs - "+requestArgs.map(posixQuote).join(" "),sshArgv=["-T","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=10","--",request.target.hostname,destination]
  await mkdir(output,{mode:0o700});const marker=join(output,"incomplete-output.json")
  await writeFile(marker,JSON.stringify({state:"incomplete"}),{flag:"wx",mode:0o600})
  try{
    for(const [name,data]of [["request.json",requestJson],["collector.cjs",bootstrap.bytes],["preflight.json",JSON.stringify({version:1,request,requestSha256:createHash("sha256").update(requestJson).digest("hex"),bootstrapSha256:bootstrap.sha256,ssh:{file:"ssh",argv:sshArgv,stdinFile:"collector.cjs"},local:{file:request.target.node,argv:["--input-type=commonjs","-",...requestArgs],stdinFile:"collector.cjs"}})]] as const)await writeFile(join(output,name),data,{flag:"wx",mode:0o600})
    await unlink(marker)
  }catch{throw new Error("INCOMPLETE_OUTPUT")}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  runRunbook(process.argv.slice(2),fileURLToPath(new URL("../../../",import.meta.url)).replace(/\/$/,"")).catch(()=>{process.stderr.write("QUALIFICATION_PREPARATION_REFUSED\n");process.exitCode=1})
}