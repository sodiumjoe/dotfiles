import { basename,dirname } from "node:path"
import { posixQuote } from "../../src/bridge/bootstrap.js"
import type { PrivateConfig } from "./config.js"
export function editorText(c:PrivateConfig):string {
  if(!c.editor||basename(c.launcherPath)!=="agy")throw new Error("EDITOR_NOT_CONFIGURED")
  const path=[dirname(c.launcherPath),...c.editor.toolDirectories].join(":")
  if(path.includes("\n")||path.includes("\0"))throw new Error("EDITOR_PATH")
  return "#!/bin/sh\nunset NVIM NVIM_LISTEN_ADDRESS\nPATH="+posixQuote(path)+"\nexport PATH\nexec "+[c.editor.executable,"--clean","-u",c.editor.initPath].map(posixQuote).join(" ")+' "$@"'
}