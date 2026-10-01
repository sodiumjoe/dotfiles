import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { isDeepStrictEqual } from "node:util"
import { launchEnvironmentDigest, MAX_ENVIRONMENT_BYTES, MAX_ENVIRONMENT_ENTRIES, parseLaunchEnvironment, snapshotLaunchEnvironment, type LaunchEnvironment } from "../src/agent/environment.js"

const secret = "not-for-state"

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function captureThrownMessage(operation: () => unknown): string {
  try { operation() } catch (error) { return error instanceof Error ? error.message : "non-error thrown" }
  return "did not throw"
}

async function readChildDigest(environment: LaunchEnvironment): Promise<{ code: number | null; output: string; error: string }> {
  const childSource = "const {createHash}=require('node:crypto');process.stdout.write(createHash('sha256').update(JSON.stringify(['BOUNDARY',process.env.BOUNDARY])).digest('hex'))"
  const child = spawn(process.execPath, ["-e", childSource], { env: environment, stdio: ["ignore", "pipe", "pipe"] })
  let output = "", error = ""
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk })
  child.stderr.setEncoding("utf8").on("data", chunk => { error += chunk })
  const [code] = await once(child, "close") as [number | null]
  return { code, output, error }
}

test("launch environments preserve exact defined values and digest without persisting them", () => {
  const source = {
    HOME: "/Users/moon",
    NODE_OPTIONS: "--trace-warnings",
    GIT_CONFIG_NOSYSTEM: "0",
    EMPTY: "",
    UNICODE: "λ",
    SECRET_TOKEN: secret,
  }
  const parsed = parseLaunchEnvironment(source)
  assert.ok(isDeepStrictEqual(parsed, source), "defined environment values changed")
  assert.ok(parsed !== source, "environment was not copied")
  assert.equal(launchEnvironmentDigest(parsed), launchEnvironmentDigest({ ...source }))
  assert.notEqual(launchEnvironmentDigest(parsed), launchEnvironmentDigest({ ...source, EMPTY: "x" }))
  const durableFixture = JSON.stringify({ environmentDigest: launchEnvironmentDigest(parsed) })
  assert.equal(durableFixture.includes(secret), false, "serialized durable fixture contains an environment value")
  const thrownMessage = captureThrownMessage(() => parseLaunchEnvironment({ SECRET_TOKEN: secret, BAD: undefined }))
  assert.equal(thrownMessage.includes(secret), false, "validation error contains an environment value")
})

test("environment digests use ordinal key ordering independent of insertion order", () => {
  const left = { z: "last", A: "first", a: "middle" }
  const right = { a: "middle", z: "last", A: "first" }
  assert.equal(launchEnvironmentDigest(left), launchEnvironmentDigest(right))
  assert.equal(launchEnvironmentDigest(left), digest([["A", "first"], ["a", "middle"], ["z", "last"]]))
})

test("process environment snapshots omit only undefined values", () => {
  const source = { HOME: "/Users/moon", EMPTY: "", SECRET_TOKEN: secret, OMIT: undefined } as NodeJS.ProcessEnv
  const snapshot = snapshotLaunchEnvironment(source)
  assert.ok(isDeepStrictEqual(snapshot, { HOME: "/Users/moon", EMPTY: "", SECRET_TOKEN: secret }), "snapshot changed a defined environment value")
})

test("environment parser rejects invalid keys, values, shapes, and map sizes without disclosing values", () => {
  const invalidValues: unknown[] = [
    { "": "value" },
    { "HAS=EQUALS": "value" },
    { "HAS\0NUL": "value" },
    { KEY: "HAS\0NUL" },
    { KEY: "\ud800" },
    { "\ud800": "value" },
    { KEY: undefined },
    { KEY: 1 },
    ["value"],
  ]
  for (const value of invalidValues) {
    const message = captureThrownMessage(() => parseLaunchEnvironment(value))
    assert.notEqual(message, "did not throw", "invalid environment was accepted")
    assert.equal(message.includes(secret), false, "validation error contains the secret sentinel")
  }
  const manyEntries = Object.fromEntries(Array.from({ length: MAX_ENVIRONMENT_ENTRIES + 1 }, (_, index) => [`KEY_${index}`, ""]))
  const oversized = { A: "x".repeat(MAX_ENVIRONMENT_BYTES - 2) }
  for (const value of [manyEntries, oversized]) {
    const message = captureThrownMessage(() => parseLaunchEnvironment(value))
    assert.notEqual(message, "did not throw", "oversized environment was accepted")
  }
  assert.equal(parseLaunchEnvironment({ A: "x".repeat(MAX_ENVIRONMENT_BYTES - 3) }).A?.length, MAX_ENVIRONMENT_BYTES - 3)
})

test("oversized environments are rejected before the process spawn boundary", () => {
  let spawnCalls = 0
  const spawnAfterParse = (value: unknown): void => {
    const environment = parseLaunchEnvironment(value)
    spawnCalls++
    spawn(process.execPath, ["-e", "process.exit(0)"], { env: environment })
  }
  const message = captureThrownMessage(() => spawnAfterParse({ A: "x".repeat(MAX_ENVIRONMENT_BYTES) }))
  assert.notEqual(message, "did not throw", "oversized environment was accepted")
  assert.equal(spawnCalls, 0)
})

test("near-limit accepted values cross the operating system process boundary byte-exactly", async () => {
  const value = "λ".repeat(120 * 1024)
  const environment = parseLaunchEnvironment({ BOUNDARY: value, SECRET_TOKEN: secret })
  const childResult = await readChildDigest(environment)
  assert.equal(childResult.code, 0, "boundary child exited unsuccessfully")
  assert.equal(childResult.output, digest(["BOUNDARY", value]), "child observed a changed environment value")
  assert.equal(childResult.output.includes(secret), false, "child diagnostics contain the secret sentinel")
  assert.equal(childResult.error.includes(secret), false, "child diagnostics contain the secret sentinel")
})