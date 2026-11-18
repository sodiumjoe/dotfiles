import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteListing, parseRemoteListing } from "../src/hosts/remote-listing.js"
import { until } from "./control-support.js"

const one = "qa-mydev--1.northwest.stripe.io", two = "qa-mydev--2.northwest.stripe.io", three = "qa-mydev--3.northwest.stripe.io"

test("a listing maps each host to its name and drops ambiguous or blank names", () => {
  const listing = parseRemoteListing(JSON.stringify([
    { name: "climate", host: one, status: "running" },
    { name: "twin", host: two }, { name: "other", host: two },
    { name: " ", host: three },
    { name: "gone", host: null, status: "scheduledfordeletion" },
  ]), 5)
  assert.deepEqual([listing.at, listing.complete, [...listing.names].sort()], [5, true, [[one, "climate"], [two, null], [three, null]]])
})

test("a box without a host makes the listing incomplete unless it is scheduled for deletion", () => {
  assert.equal(parseRemoteListing(JSON.stringify([{ name: "climate", host: one }, { name: "paused", host: null, status: "stopped" }]), 5).complete, false)
  assert.equal(parseRemoteListing(JSON.stringify([{ name: "new" }]), 5).complete, false)
  assert.equal(parseRemoteListing(JSON.stringify([{ name: "gone", host: null, status: "scheduledfordeletion" }]), 5).complete, true)
})

test("output that is not an array of objects is refused", () => {
  for (const stdout of ["", "{}", "[1]", "[null]", "2FA required. Please manually run 'sc-2fa --force'"]) assert.throws(() => parseRemoteListing(stdout, 0), /INVALID_LISTING/)
})

test("a request runs at most once per age, and a failure keeps the last good listing and is reported", async () => {
  let output: string | Error = JSON.stringify([{ name: "climate", host: one }]), runs = 0
  const failures: string[] = []
  const listing = createRemoteListing({ run: async () => { runs++; if (output instanceof Error) throw output; return output }, onFailure: message => failures.push(message) })
  assert.deepEqual([listing.latest(), listing.attemptedAt()], [null, null])
  listing.request(1000); listing.request(1000)
  const first = await until(async () => listing.latest() ?? undefined)
  assert.deepEqual([runs, first.at, first.names.get(one)], [1, listing.attemptedAt(), "climate"])
  listing.request(60000)
  assert.equal(runs, 1)
  output = new Error("Command failed: pay remote list -a --raw\n2FA required")
  listing.request(0)
  await until(async () => failures.length === 1 ? true : undefined)
  assert.equal(listing.latest(), first)
  assert.match(failures[0]!, /2FA required/)
  assert.ok(listing.attemptedAt()! >= first.at)
  output = "not json"
  listing.request(0)
  await until(async () => failures.length === 2 ? true : undefined)
  assert.deepEqual([listing.latest(), failures[1]], [first, "INVALID_LISTING"])
})

test("a run that never settles times out and does not block the next request", async () => {
  let runs = 0
  const failures: string[] = []
  const listing = createRemoteListing({ timeoutMs: 30, run: () => { runs++; return new Promise<string>(() => undefined) }, onFailure: message => failures.push(message) })
  listing.request(0)
  await until(async () => failures.length === 1 ? true : undefined)
  assert.equal(failures[0], "LISTING_TIMEOUT")
  listing.request(0)
  assert.equal(runs, 2)
})