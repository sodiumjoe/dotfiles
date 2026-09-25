process.stdin.once("data", () => process.stdout.write("registered\n"))
if (process.argv.includes("--ignore-term")) process.on("SIGTERM", () => undefined)
setInterval(() => undefined, 1000)