import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import test from "node:test"
import { deterministicFiles, nativeFiles, stressFiles, stressNames, stressPattern, testArguments, testFiles, testExitCode } from "../scripts/test-groups.js"

test("routine, native, stress, and complete test commands are available", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"))
  for (const name of ["test", "test:native", "test:stress", "test:all"]) assert.equal(typeof scripts[name], "string", name)
})

test("all test files belong to exactly one normal group", async () => {
  const files = (await readdir("test")).filter(file => file.endsWith(".test.ts")).map(file => file.replace(/\.ts$/, ".js")).sort()
  const classified = [...deterministicFiles, ...nativeFiles].sort()
  assert.deepEqual(classified, files)
  assert.equal(new Set(classified).size, classified.length)
  for (const file of stressFiles) assert.ok(nativeFiles.includes(file))
})

test("stress cases have complementary normal filters and remain included in test:all", async () => {
  assert.equal(stressNames.length, 3)
  const pattern = new RegExp(stressPattern)
  for (const [index, name] of stressNames.entries()) {
    assert.ok(pattern.test(name))
    assert.equal(pattern.test("ordinary native concurrency smoke"), false)
    const source = await readFile("test/" + stressFiles[index]!.replace(/\.js$/, ".ts"), "utf8")
    assert.ok(source.includes('"' + name + '"'))
  }
  assert.ok(testArguments("stress").includes("--test-name-pattern=" + stressPattern))
  for (const group of ["deterministic", "native"] as const) assert.ok(testArguments(group).includes("--test-skip-pattern=" + stressPattern))
  assert.ok(testArguments("all").every(argument => !argument.startsWith("--test-skip-pattern")))
  assert.ok(testArguments("all").every(argument => !argument.startsWith("--test-name-pattern")))
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"))
  assert.match(scripts["test:all"], /test-groups\.js all$/)
})

test("runner preserves failures and treats missing exit status as failure", () => {
  assert.equal(testExitCode({ status: 0, signal: null }), 0)
  assert.equal(testExitCode({ status: 7, signal: null }), 7)
  assert.equal(testExitCode({ status: null, signal: "SIGTERM" }), 1)
  assert.equal(testExitCode({ status: null, signal: null, error: new Error("spawn failed") }), 1)
  assert.equal(testExitCode({ status: null, signal: null }), 1)
})

test("selected stress workers are exact and normal selections include every file", () => {
  assert.deepEqual(testFiles("stress"), ["singleton.test.js", "darwin-platform.test.js", "handler-control-plane.test.js"])
  assert.deepEqual(testFiles("all"), [...deterministicFiles, ...nativeFiles])
  for (const group of ["deterministic", "native", "stress", "all"] as const) {
    assert.ok(testArguments(group).some(value => value.startsWith("--import=") && value.endsWith("/test/fixtures/run-boundary.js")))
    assert.deepEqual(testArguments(group).filter(value => value.startsWith("dist/test/")), testFiles(group).map(file => "dist/test/" + file))
  }
})