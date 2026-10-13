#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

lua - "$repo_root" <<'LUA'
local repo_root = assert(arg[1])
package.path = repo_root .. "/home/.config/hammerspoon/?.lua;" .. package.path

local positions = {}
local callbacks = {}
local events = {
    systemWillSleep = 1,
    systemDidWake = 2,
    screensDidSleep = 3,
    screensDidWake = 4,
    screensDidLock = 5,
    screensDidUnlock = 6,
    screensaverDidStart = 7,
}

local function watcher(kind)
    return function(callback)
        callbacks[kind] = callback
        return {
            start = function(self)
                self.started = true
                return self
            end,
        }
    end
end

events.new = watcher("power")
hs = {
    screen = {
        screenPositions = function() return positions end,
        watcher = { new = watcher("screen") },
    },
    caffeinate = { watcher = events },
}

local auto_layout = require("auto_layout")
local calls = 0

local function screens(...)
    positions = {}
    for i, x in ipairs({ ... }) do
        positions[i] = { x = x, y = 0 }
    end
end

local function start(...)
    screens(...)
    calls = 0
    local retained = auto_layout.start(function()
        calls = calls + 1
        callbacks.screen()
    end)
    assert(retained.screen.started, "screen watcher was not started and retained")
    assert(retained.power.started, "power watcher was not started and retained")
    assert(calls == 0, "loading the configuration moved windows")
end

local function power(event)
    callbacks.power(events[event])
end

start(0)
callbacks.screen()
screens(0, 1)
callbacks.screen()
assert(calls == 0, "layout ran before both external monitors connected")
screens(0, 1, -1)
callbacks.screen()
assert(calls == 0, "screen count was accepted without the required positions")
screens(0, 1, 2)
callbacks.screen()
assert(calls == 1, "layout did not run immediately when both monitors connected")
callbacks.screen()
power("systemDidWake")
power("screensDidWake")
power("screensDidUnlock")
power("screensaverDidStart")
assert(calls == 1, "duplicate notifications reapplied the layout")

screens(0, 1)
callbacks.screen()
assert(calls == 1, "disconnect triggered a partial layout")
screens(0, 1, 2)
callbacks.screen()
assert(calls == 2, "reconnecting a monitor did not rearm the layout")

start(0, 1, 2)
callbacks.screen()
assert(calls == 0, "an unrelated display notification moved windows after reload")

for _, order in ipairs({
    { "systemDidWake", "screensDidWake" },
    { "screensDidWake", "systemDidWake" },
}) do
    start(0, 1, 2)
    power("systemWillSleep")
    power("screensDidSleep")
    callbacks.screen()
    assert(calls == 0, "display notifications moved windows while asleep")
    power(order[1])
    assert(calls == 0, "layout ran before both system and displays were awake")
    power(order[2])
    assert(calls == 1, "wake did not restore layout with unchanged screen count")
    power(order[1])
    power(order[2])
    power("screensDidUnlock")
    assert(calls == 1, "the same wake cycle applied the layout twice")
end

start(0, 1, 2)
power("screensDidLock")
power("systemWillSleep")
power("screensDidSleep")
power("systemDidWake")
power("screensDidWake")
callbacks.screen()
assert(calls == 0, "layout ran while the session was locked")
power("screensDidUnlock")
assert(calls == 1, "unlock did not apply the pending wake layout")

start(0, 1, 2)
power("screensDidSleep")
power("screensDidWake")
assert(calls == 1, "display-only sleep did not restore the layout")
power("screensDidWake")
assert(calls == 1, "duplicate display wake reapplied the layout")

start(0, 1, 2)
power("systemWillSleep")
screens(0)
power("systemDidWake")
assert(calls == 0, "undocked wake applied the single-screen layout")
screens(0, 1)
callbacks.screen()
assert(calls == 0, "wake applied layout before the second monitor connected")
screens(0, 1, 2)
callbacks.screen()
assert(calls == 1, "late monitor connection did not apply the pending layout")

start(0)
power("screensDidLock")
screens(0, 1, 2)
callbacks.screen()
assert(calls == 0, "monitor connection applied layout while locked")
power("screensDidUnlock")
assert(calls == 1, "unlock did not apply layout after monitors connected")

start(0, 1, 2)
power("screensDidLock")
power("screensDidUnlock")
assert(calls == 0, "locking alone reset an already applied layout")

start(0, 1, 2)
power("screensDidLock")
power("systemWillSleep")
power("screensDidSleep")
power("screensDidUnlock")
power("screensDidWake")
assert(calls == 0, "early unlock bypassed the system sleep gate")
power("systemDidWake")
assert(calls == 1, "early unlock prevented the eventual wake layout")

screens(0)
local failed = true
calls = 0
auto_layout.start(function()
    calls = calls + 1
    if failed then
        error("layout failure")
    end
end)
screens(0, 1, 2)
local ok, err = pcall(callbacks.screen)
assert(not ok and err:find("layout failure"), "layout failure was not reported")
failed = false
callbacks.screen()
assert(calls == 2, "a failed layout permanently suppressed later attempts")
callbacks.screen()
assert(calls == 2, "a successful retry did not suppress duplicates")
LUA

echo "PASS: automatic layout waits for both monitors and runs once per connection or wake"