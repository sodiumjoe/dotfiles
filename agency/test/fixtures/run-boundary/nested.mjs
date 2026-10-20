const { workerScope } = await import(process.env.AGENCY_TEST_BOUNDARY_MODULE)
try { await workerScope(); throw new Error("nested scope activated") }
catch (error) {
  if (!/worker|inactive/.test(error.message)) throw error
}
console.log(JSON.stringify({ args: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null }))