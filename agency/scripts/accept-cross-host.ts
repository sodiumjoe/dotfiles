import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { absolutePath, hash, id, keys, object, text } from "../src/catalog/types.js"
import { parseOverrides, type AssignmentSpec } from "../src/orchestration/types.js"

type Host = { inventoryId: string; hostId: string; handlerGeneration: string; hostname: string; agyPath: string; nodePath: string; loginShell: string; cwd: string; platform: "darwin" | "linux"; sourceRevision: string; sourceDigest: string; distDigest: string; nodeVersion: "v24.13.0" }
type Selection = { backendId: "codex-acp"; modelId: string; overrides: AssignmentSpec["overrides"] }
export type CrossHostConfig = {
  protocol: "agency-cross-host-config/1"
  hosts: { laptop: Host; a: Host; b: Host }
  settings: { supervisor: Selection; worker: Selection }
  commands: { start: string; delegate: string; wait: string; report: string; supervisorSubmission: string; stopSupervisor: string; stopWorker: string }
  prompts: { supervisor: string; worker: string }
  promptBudget: 2
  git: null
  editor: { socketPath: string; detach: true; reattach: true }
  interruption: { host: "a" | "b"; count: 1 }
  cleanup: { stopSupervisor: true; stopWorker: true; readbackPasses: 2 }
  authority: { ssh: true; prompts: true; scopedStops: true; editorRouting: true; bridgeInterruption: true; install: false; restore: false; reboot: false; push: false }
  evidenceRoot: string
}
function reject(): never { throw new Error("INVALID_CROSS_HOST_CONFIG") }
function host(raw: unknown, local: boolean): Host {
  const v = object(raw)
  keys(v, ["inventoryId", "hostId", "handlerGeneration", "hostname", "agyPath", "nodePath", "loginShell", "cwd", "platform", "sourceRevision", "sourceDigest", "distDigest", "nodeVersion"])
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(String(v.hostname)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(v.sourceRevision)) || v.nodeVersion !== "v24.13.0" || (local ? !["linux", "darwin"].includes(String(v.platform)) : v.platform !== "linux")) reject()
  return { inventoryId: id(v.inventoryId), hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), hostname: text(v.hostname), agyPath: absolutePath(v.agyPath), nodePath: absolutePath(v.nodePath), loginShell: absolutePath(v.loginShell), cwd: absolutePath(v.cwd), platform: v.platform as Host["platform"], sourceRevision: text(v.sourceRevision), sourceDigest: hash(v.sourceDigest), distDigest: hash(v.distDigest), nodeVersion: "v24.13.0" }
}
function selection(raw: unknown): Selection {
  const v = object(raw); keys(v, ["backendId", "modelId", "overrides"])
  const overrides = parseOverrides(v.overrides)
  if (v.backendId !== "codex-acp" || !text(v.modelId).trim() || !overrides.modeId || !overrides.configValues || !Object.keys(overrides.configValues).length) reject()
  return { backendId: "codex-acp", modelId: text(v.modelId), overrides }
}
export function parseCrossHostConfig(raw: unknown): CrossHostConfig {
  try {
    const v = object(raw)
    keys(v, ["protocol", "hosts", "settings", "commands", "prompts", "promptBudget", "git", "editor", "interruption", "cleanup", "authority", "evidenceRoot"])
    if (v.protocol !== "agency-cross-host-config/1" || v.promptBudget !== 2 || v.git !== null) reject()
    const h = object(v.hosts); keys(h, ["laptop", "a", "b"])
    const hosts = { laptop: host(h.laptop, true), a: host(h.a, false), b: host(h.b, false) }, all = Object.values(hosts)
    if (["inventoryId", "hostId", "hostname"].some(key => new Set(all.map(value => value[key as keyof Host])).size !== 3) || all.some(value => value.sourceRevision !== hosts.laptop.sourceRevision || value.sourceDigest !== hosts.laptop.sourceDigest)) reject()
    const s = object(v.settings); keys(s, ["supervisor", "worker"])
    const c = object(v.commands); keys(c, ["start", "delegate", "wait", "report", "supervisorSubmission", "stopSupervisor", "stopWorker"])
    const commands = { start: id(c.start), delegate: id(c.delegate), wait: id(c.wait), report: id(c.report), supervisorSubmission: id(c.supervisorSubmission), stopSupervisor: id(c.stopSupervisor), stopWorker: id(c.stopWorker) }
    if (new Set(Object.values(commands)).size !== 7) reject()
    const prompts = object(v.prompts); keys(prompts, ["supervisor", "worker"])
    if (!text(prompts.supervisor, 65536).trim() || !text(prompts.worker, 65536).trim()) reject()
    const editor = object(v.editor); keys(editor, ["socketPath", "detach", "reattach"])
    const interruption = object(v.interruption); keys(interruption, ["host", "count"])
    const cleanup = object(v.cleanup); keys(cleanup, ["stopSupervisor", "stopWorker", "readbackPasses"])
    if (editor.detach !== true || editor.reattach !== true || !["a", "b"].includes(String(interruption.host)) || interruption.count !== 1 || cleanup.stopSupervisor !== true || cleanup.stopWorker !== true || cleanup.readbackPasses !== 2) reject()
    const authority = object(v.authority); keys(authority, ["ssh", "prompts", "scopedStops", "editorRouting", "bridgeInterruption", "install", "restore", "reboot", "push"])
    if (["ssh", "prompts", "scopedStops", "editorRouting", "bridgeInterruption"].some(key => authority[key] !== true) || ["install", "restore", "reboot", "push"].some(key => authority[key] !== false)) reject()
    return { protocol: "agency-cross-host-config/1", hosts, settings: { supervisor: selection(s.supervisor), worker: selection(s.worker) }, commands, prompts: { supervisor: text(prompts.supervisor, 65536), worker: text(prompts.worker, 65536) }, promptBudget: 2, git: null, editor: { socketPath: absolutePath(editor.socketPath), detach: true, reattach: true }, interruption: { host: interruption.host as "a" | "b", count: 1 }, cleanup: { stopSupervisor: true, stopWorker: true, readbackPasses: 2 }, authority: { ssh: true, prompts: true, scopedStops: true, editorRouting: true, bridgeInterruption: true, install: false, restore: false, reboot: false, push: false }, evidenceRoot: absolutePath(v.evidenceRoot) }
  } catch { return reject() }
}
export function parseCrossHostArguments(argv: readonly string[]): { configPath: string; check: true } {
  try { if (argv.length !== 3 || argv[0] !== "--check" || argv[1] !== "--config") throw new Error(); return { configPath: absolutePath(argv[2]), check: true } }
  catch { throw new Error("INVALID_CROSS_HOST_ARGUMENTS") }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { configPath } = parseCrossHostArguments(process.argv.slice(2)), config = parseCrossHostConfig(JSON.parse(await readFile(configPath, "utf8")))
  process.stdout.write(JSON.stringify({ protocol: "agency-cross-host-preflight/1", scope: "configuration-only", acceptanceVerified: false, config }) + "\n")
}