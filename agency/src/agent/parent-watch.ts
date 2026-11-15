import { spawn } from "node:child_process"

const parent = Number(process.env.AGENCY_PARENT_PID) || process.ppid
delete process.env.AGENCY_PARENT_PID
const watch = setInterval(() => {
  if (process.ppid === parent) return
  clearInterval(watch)
  try { spawn("/bin/sh", ["-c", `sleep 2; kill -KILL -${process.pid} 2>/dev/null`], { detached: true, stdio: "ignore" }).unref() } catch {}
  try { process.kill(-process.pid, "SIGTERM") } catch { process.kill(process.pid, "SIGTERM") }
}, 1000)
watch.unref()