import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { appendFileSync } from "node:fs"
import { readFile,appendFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { runQualification } from "../../scripts/qualification/main.js"
import { createCatalogService } from "../../src/catalog/service.js"
import { observeConfig } from "../../src/catalog/config.js"
import { createAgentService } from "../../src/agent/service.js"
import { createAgentProcess } from "../../src/agent/process.js"
import { fixtureLaunch,fixtureSpawn,fixtureIdentity } from "./ownership.js"
import type { LaunchContract } from "../../src/agent/contracts.js"
import type { ProviderProfile,CatalogSnapshot } from "../../src/catalog/types.js"
const contract:LaunchContract={id:"fixture-v1",sessionLoad:true,providerId:"codex-acp",adapterPackage:"@agentclientprotocol/codex-acp",adapterVersion:"1.0.0",modes:{state:"values",values:["plan","review"]},reasoning:{state:"values",values:["high","low"]},effectiveMode:null,permissionProfiles:["fixture-deny-v1"],modelOption:"model",reasoningOption:"reasoning",modeOption:"mode",permissionEvidence:"fixture-contract-v1",deadlines:{commandMs:5000,spawnMs:5000,initializeMs:15000,sessionMs:15000,optionMs:5000,promptMs:90000,transportCloseMs:1000,processTerminateMs:5000,absenceMs:2000,overallMs:150000},promptCapabilities:{image:true,audio:false,embeddedContext:true}}
process.umask(0o077)
const config=JSON.parse(await readFile(process.argv[3]!,"utf8")), root=process.env.QUALIFICATION_ROOT!
try{
  process.exitCode=await runQualification(process.argv.slice(2),{handlerEntry:fileURLToPath(import.meta.url),handlerOptions(options){
    appendFileSync(join(root,"hook-entered.jsonl"),JSON.stringify({pid:process.pid,generation:options.generation,paths:options.paths})+"\n",{mode:0o600})
    let editor:import("../../src/entry/runtime.js").RuntimeEditor|null=null
    return {...options,onPhase:async phase=>{const identity=await options.adapter.readProcess(process.pid);if(identity)fixtureIdentity("handler-"+phase,identity)},launchContracts:[contract],
      entryDriver:{async ensure(ref){editor={editorId:randomUUID(),session:"qualification-editor",pane:"%1",tmuxSocketPath:join(options.paths.runtimeRoot,"entry-tmux.sock")};await appendFile(join(root,"entry-driver.jsonl"),JSON.stringify({ref,editor,executable:config.editor?.shimPath??null})+"\n",{mode:0o600});return editor},async activate(){},async inspect(){return editor}},
      catalogFactory(context){
        const service=createCatalogService({...context,queue:context.mutations.queue,probes:{verifyDischarged:async()=>undefined,run:async()=>{throw new Error("FIXTURE_DISCOVERY_FORBIDDEN")}}})
        return {...service,async initialize(){
          const profiles=JSON.parse(await readFile(join(context.paths.persistentRoot,"catalog/providers.json"),"utf8")).providers as ProviderProfile[]
          const evidence=await observeConfig(profiles[0]!)
          const snapshot:CatalogSnapshot={version:1,hostId:context.paths.hostKey,handlerGeneration:context.generation,snapshotId:randomUUID(),createdAt:Date.now(),providers:[{providerId:"codex-acp",fingerprint:evidence.fingerprint,verifiedAt:Date.now(),verifiedHandlerGeneration:context.generation,providerVersion:null,providerVersionSource:"unknown",adapterVersion:"1.0.0",sdkVersion:null,error:null,models:[{providerId:"codex-acp",modelId:"model-a",resolvedModelId:null,displayName:"Synthetic model",reasoning:{state:"values",values:["high","low"]},modes:{state:"values",values:["plan","review"]},availability:"advertised"}]}]}
          await context.store.writeSnapshot(snapshot);await context.store.publishCurrent(snapshot);await service.initialize()
        }}
      },agentFactory(input){return createAgentService(input,{processFactory(options){return createAgentProcess(options,{spawn:((...args:Parameters<typeof spawn>)=>{const launch=fixtureLaunch("provider"),child=spawn(...args);void fixtureSpawn(launch,child.pid).catch(error=>{appendFileSync(join(root,"ownership-errors"),String(error)+"\n",{mode:0o600})});return child}) as typeof spawn})}})}
    }
  },async enter(file,args){await appendFile(join(root,"entered.jsonl"),JSON.stringify({file,args})+"\n",{mode:0o600});return 0}})
}catch(error){process.stderr.write(String(error instanceof Error?error.stack:error)+"\n");process.exitCode=70}