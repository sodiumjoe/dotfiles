#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
config="$repo_root/hammerspoon/init.lua"

lua - "$repo_root" <<'LUA'
local repo_root = assert(arg[1])
package.path = repo_root .. "/hammerspoon/?.lua;" .. package.path

local window_rules = require("window_rules")

local function window(title, options)
    options = options or {}
    return {
        application = function()
            return { name = function() return options.app_name or "Zoom" end }
        end,
        title = function() return title end,
        isVisible = function() return options.visible ~= false end,
        isStandard = function() return options.standard ~= false end,
        frame = function()
            return { w = options.width or 100, h = options.height or 100 }
        end,
    }
end

assert(type(window_rules.classifyZoomWindows) == "function", "classifyZoomWindows is missing")

local workplace = window("Zoom Workplace")
local first_meeting = window("Zoom Meeting")
local second_meeting = window("Zoom Meeting")
local classification = window_rules.classifyZoomWindows({
    workplace,
    first_meeting,
    window("Zoom Meeting", { width = 0 }),
    window("Zoom Meeting", { visible = false }),
    window("ZM_HUD_TOAST_WINDOW", { standard = false }),
    second_meeting,
})

assert(classification.main == workplace, "Zoom Workplace was not selected as the main window")
assert(#classification.meetings == 2, "invalid Zoom windows affected meeting detection")
assert(classification.meetings[1] == first_meeting)
assert(classification.meetings[2] == second_meeting)

assert(type(window_rules.planZoomMeetingLayout) == "function", "planZoomMeetingLayout is missing")

local top, bottom = window_rules.planZoomMeetingLayout(classification.meetings, function(win)
    return win == first_meeting
end)
assert(top == second_meeting, "bottom meeting window did not move to the top slot")
assert(bottom == first_meeting, "top meeting window did not move to the bottom slot")

top, bottom = window_rules.planZoomMeetingLayout({ first_meeting }, function()
    return false
end)
assert(top == first_meeting, "single meeting window was not assigned to the top slot")
assert(bottom == nil, "single meeting window produced a bottom assignment")

assert(
    type(window_rules.forEachUsableManagedWindow) == "function",
    "forEachUsableManagedWindow is missing"
)

local managed_windows = {}
local ordinary_chrome = window("Documentation", { app_name = "Google Chrome" })
window_rules.forEachUsableManagedWindow({
    ordinary_chrome,
    window("Video - YouTube", { app_name = "Google Chrome" }),
    window("Hidden", { app_name = "Google Chrome", visible = false }),
    window("Invalid", { app_name = "Google Chrome", width = 0 }),
}, function(win)
    table.insert(managed_windows, win)
end)
assert(#managed_windows == 1, "Chrome layout included an unusable or ignored window")
assert(managed_windows[1] == ordinary_chrome)
LUA

echo "PASS: Zoom layout classifies current accessibility windows"

if rg -q 'zoomMeetingFilter|zoomNonMeetingFilter' "$config"; then
    echo "FAIL: Zoom layout still depends on cached title filters"
    exit 1
fi

if ! rg -q 'classifyZoomWindows\([^)]*:allWindows\(\)' "$config"; then
    echo "FAIL: Zoom layout does not classify a fresh allWindows snapshot"
    exit 1
fi

if rg -q 'chromeFilter' "$config"; then
    echo "FAIL: Chrome layout still depends on a cached window filter"
    exit 1
fi

if ! rg -q 'forEachUsableManagedWindow\([^)]*:allWindows\(\)' "$config"; then
    echo "FAIL: Chrome layout does not use a fresh allWindows snapshot"
    exit 1
fi

echo "PASS: Zoom layout uses fresh application windows"
