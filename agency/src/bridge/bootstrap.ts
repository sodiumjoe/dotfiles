import { parseHostEnrollment, type HostEnrollment } from "../hosts/inventory.js"
import { bridgeError } from "./protocol.js"

export function sanitizedBootstrapEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_STATE_HOME"].filter(key => source[key] !== undefined).map(key => [key, source[key]!]))
}
export function posixQuote(value: string): string {
  if (!value.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/u.test(value)) bridgeError("INVALID_SHELL_ARGUMENT")
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
export function destinationShellCommand(enrollment: HostEnrollment, action: "internal-host-call" | "internal-host-bridge" | "internal-runtime-bridge"): string {
  const e = parseHostEnrollment(enrollment), args = action === "internal-host-bridge" ? ` --agy-path ${posixQuote(e.agyPath)} --login-shell ${posixQuote(e.loginShell)}` : "", command = `exec ${posixQuote(e.agyPath)} ${action}${args} >&3 3>&-`
  return `exec 3>&1; exec ${posixQuote(e.loginShell)} -lc ${posixQuote(command)} 1>&2`
}