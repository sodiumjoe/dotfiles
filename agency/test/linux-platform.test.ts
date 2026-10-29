import assert from "node:assert/strict"
import test from "node:test"

async function driver() {
  return import("../scripts/qualify-linux.js")
}

export const LINUX_REAL_CASES = [
  "Linux real procfs identity and group enumeration",
  "Linux production paths canonicalize implicit HOME",
  "Linux before-spawn Handler death releases the unattempted launch",
  "Linux after-attempt Handler death quarantines incomplete identity",
  "Linux identity-published Handler death cleans the exact process group",
  "Linux readiness Handler death cleans the exact process group",
  "Linux active Handler death cleans the exact process group",
  "Linux process-group ambiguity remains checkout-scoped",
  "Linux singleton contenders converge through flock",
] as const

if (process.env.AGENCY_LINUX_REAL === "1") {
  if (process.platform !== "linux") throw new Error("real Linux fixtures require Linux")
  const d = await driver()
  for (const [index,name] of LINUX_REAL_CASES.entries()) test(name, { timeout: 20000 }, async () => {
    const result = await d.runRealCase(index)
    if(index === 0) {
      assert.equal(result.leaderExited,true)
      assert.deepEqual(result.signals,["SIGTERM","SIGKILL"])
      assert.equal(result.absent,true)
    } else if(index === 1) {
      assert.match(String(result.stateRoot),/^\/pay\/home\/moon\/\.local\/state\/agency\/hosts\//)
    } else if(index >= 2 && index <= 6) {
      assert.equal(result.disposition,index === 3 ? "quarantined" : index === 2 ? "released":"cleaned")
      if(index === 3) assert.equal(result.productionSignals,0)
      assert.equal(result.absent,true)
    } else if(index === 7) {
      assert.equal(result.ambiguous,"quarantined")
      assert.equal(result.unrelated,"released")
      assert.equal(result.productionSignals,0)
    } else {
      assert.equal(result.count,32)
      assert.equal(result.generations,1)
      assert.equal(result.handlers,1)
      assert.equal(result.absent,true)
    }
  })
}