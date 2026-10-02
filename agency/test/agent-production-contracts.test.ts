import assert from "node:assert/strict"
import test from "node:test"
import { parseLaunchContract, productionLaunchContracts } from "../src/agent/contracts.js"

test("production exposes a static Codex ACP restoration contract", () => {
  const contracts = productionLaunchContracts(), [contract] = contracts
  assert.equal(contracts.length, 1)
  assert.equal(contract!.providerId, "codex-acp")
  assert.equal(contract!.adapterPackage, "@agentclientprotocol/codex-acp")
  assert.equal(contract!.adapterVersion, "1.7.0")
  assert.equal(contract!.sessionLoad, true)
  assert.deepEqual(contract!.permissionProfiles, ["deny-all"])
  assert.equal(Object.hasOwn(contract!, "qualification"), false)
  assert.equal(Object.hasOwn(contract!, "entrypoint"), false)
  assert.equal(Object.hasOwn(contract!, "fingerprint"), false)
  assert.deepEqual(parseLaunchContract(contract), contract)
  assert.ok(Object.isFrozen(contracts))
  assert.ok(Object.isFrozen(contract))
})

test("production contract rejects obsolete qualification fields", () => {
  const [contract] = productionLaunchContracts()
  for (const extra of [{ qualification: null }, { manifest: {} }, { candidate: true }, { entrypoint: "/tmp/adapter" }, { fingerprint: "a".repeat(64) }])
    assert.throws(() => parseLaunchContract({ ...contract, ...extra }), { code: "ADAPTER_UNQUALIFIED" })
})