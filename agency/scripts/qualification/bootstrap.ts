import { createHash } from "node:crypto"
import { builtinModules } from "node:module"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join, relative, dirname, resolve, posix } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { API } from "typescript/unstable/sync"
import { SyntaxKind, type Node, isCallExpression, isIdentifier, isStringLiteral, isImportDeclaration, isExportDeclaration } from "typescript/unstable/ast"
import { boundedBytes, inspectPath } from "./preflight.js"
const entry="scripts/qualification/preflight.js"
const expected=["scripts/qualification/preflight.ts","src/catalog/types.ts","src/platform/darwin.ts","src/platform/host-id.ts","src/platform/launch-marker.ts","src/platform/linux.ts","src/platform/private-state.ts","src/platform/types.ts"].sort()
const sha=(v:Buffer|string)=>createHash("sha256").update(v).digest("hex")
export async function buildCollectorBootstrap(packageRoot:string):Promise<{bytes:Buffer;sha256:string}>{
  const temporary=await mkdtemp(join(tmpdir(),"agency-collector-"))
  let api:API|undefined
  try{
    const config=join(temporary,"tsconfig.json"),output=join(temporary,"emit"),sourceRoot=join(temporary,"source")
    const sourceIndex=[]
    for(const path of expected){const bytes=await boundedBytes(join(packageRoot,path));sourceIndex.push({path,size:bytes.length,sha256:sha(bytes)});await mkdir(dirname(join(sourceRoot,path)),{recursive:true});await writeFile(join(sourceRoot,path),bytes)}
    await writeFile(config,JSON.stringify({compilerOptions:{target:"ES2022",module:"Node16",moduleResolution:"node16",rootDir:sourceRoot,outDir:output,noCheck:true,skipLibCheck:true,types:[],ignoreDeprecations:"6.0"},files:[join(sourceRoot,"scripts/qualification/preflight.ts")]}))
    await promisify(execFile)(process.execPath,[join(packageRoot,"node_modules/typescript/bin/tsc"),"-p",config],{timeout:30000,maxBuffer:1024*1024})
    const astConfig=join(temporary,"ast.json")
    await writeFile(astConfig,JSON.stringify({compilerOptions:{allowJs:true,noLib:true,types:[]},include:["emit/**/*.js"]}))
    api=new API({cwd:temporary})
    const snapshot=api.updateSnapshot({openProjects:[astConfig]}),project=snapshot.getProject(astConfig)
    if(!project)throw new Error("COLLECTOR_AST")
    const modules=new Map<string,string>()
    async function visit(moduleId:string):Promise<void>{
      if(modules.has(moduleId))return
      const path=join(output,moduleId),sourcePath=moduleId.replace(/\.js$/,".ts")
      if(!expected.includes(sourcePath))throw new Error("COLLECTOR_CLOSURE")
      await inspectPath(join(packageRoot,sourcePath))
      const code=await readFile(path,"utf8"),file=project!.program.getSourceFile(path)
      if(!file||project!.program.getSyntacticDiagnostics(path).length)throw new Error("COLLECTOR_AST")
      const dependencies:string[]=[]
      function walk(node:Node):void{
        if(node.kind===SyntaxKind.MetaProperty||node.kind===SyntaxKind.ImportKeyword)throw new Error("COLLECTOR_UNSUPPORTED_IMPORT")
        if(isImportDeclaration(node)||isExportDeclaration(node)&&node.moduleSpecifier)throw new Error("COLLECTOR_UNSUPPORTED_IMPORT")
        if(isCallExpression(node)&&isIdentifier(node.expression)&&node.expression.text==="require"){
          if(node.arguments.length!==1||!isStringLiteral(node.arguments[0]!))throw new Error("COLLECTOR_DYNAMIC_REQUIRE")
          dependencies.push(node.arguments[0].text)
        }else if(isIdentifier(node)&&node.text==="require"){
          const parent=node.parent
          if(!parent||!isCallExpression(parent)||parent.expression!==node)throw new Error("COLLECTOR_REQUIRE_ALIAS")
        }
        node.forEachChild(child=>{walk(child)})
      }
      walk(file);modules.set(moduleId,code)
      for(const name of dependencies){
        if(name.startsWith("node:")&&builtinModules.includes(name.slice(5)))continue
        if(!name.startsWith("./")&&!name.startsWith("../"))throw new Error("COLLECTOR_EXTERNAL_IMPORT")
        const next=posix.normalize(posix.join(posix.dirname(moduleId),name))
        if(next.startsWith("../")||!next.endsWith(".js"))throw new Error("COLLECTOR_TRAVERSAL")
        await visit(next)
      }
    }
    await visit(entry)
    if(JSON.stringify([...modules.keys()].map(v=>v.replace(/\.js$/,".ts")).sort())!==JSON.stringify(expected))throw new Error("COLLECTOR_CLOSURE")
    for(const item of sourceIndex)if(sha(await boundedBytes(join(packageRoot,item.path)))!==item.sha256)throw new Error("COLLECTOR_SOURCE_CHANGED")
    const registry=[...modules].sort(([a],[b])=>a.localeCompare(b)).map(([name,code])=>JSON.stringify(name)+":function(module,exports,require){\n"+code+"\n}").join(",\n")
    const bytes=Buffer.from('"use strict";\nconst sourceIndex='+JSON.stringify(sourceIndex)+';\nconst modules={'+registry+'};\nconst nativeRequire=require,path=require("node:path").posix,cache=Object.create(null);\nfunction load(id){if(cache[id])return cache[id].exports;if(!Object.hasOwn(modules,id))throw Error("COLLECTOR_MODULE");const module={exports:{}};cache[id]=module;modules[id](module,module.exports,name=>{if(name.startsWith("node:"))return nativeRequire(name);return load(path.normalize(path.join(path.dirname(id),name)))});return module.exports}\nload('+JSON.stringify(entry)+').collectPreflight(JSON.parse(process.argv.slice(2).join(""))).then(result=>process.stdout.write(JSON.stringify(result)+"\\n"),()=>{process.stderr.write("COLLECTOR_REFUSED\\n");process.exitCode=1});')
    snapshot.dispose();return {bytes,sha256:sha(bytes)}
  }finally{api?.close();await rm(temporary,{recursive:true,force:true})}
}