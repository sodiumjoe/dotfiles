import test from "node:test"
const { workerScope } = await import(process.env.AGENCY_TEST_BOUNDARY_MODULE)
test("standalone", async () => {
  const scope = await workerScope()
  console.log("scope-root=" + scope.snapshot().artifacts[0])
})