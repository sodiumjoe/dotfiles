import { parseHostEnrollment, type HostEnrollment } from "../hosts/inventory.js"

export function sanitizedBootstrapEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_STATE_HOME"].filter(key => source[key] !== undefined).map(key => [key, source[key]!]))
}
export function destinationShellCommand(enrollment: HostEnrollment, action: "internal-runtime-bridge"): string {
  parseHostEnrollment(enrollment)
  return `exec agy ${action}`
}