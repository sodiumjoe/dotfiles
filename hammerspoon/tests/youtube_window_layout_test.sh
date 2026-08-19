#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
rules="$repo_root/hammerspoon/window_rules.lua"

if [[ ! -f "$rules" ]]; then
    echo "FAIL: YouTube window rules are missing"
    exit 1
fi

lua - "$repo_root" <<'LUA'
local repo_root = assert(arg[1])
package.path = repo_root .. "/hammerspoon/?.lua;" .. package.path

local window_rules = require("window_rules")

local function window(app_name, title)
    return {
        application = function()
            if not app_name then
                return nil
            end
            return { name = function() return app_name end }
        end,
        title = function() return title end,
    }
end

assert(window_rules.isYouTubeTitle("Video - YouTube - Google Chrome"))
assert(window_rules.isYouTubeTitle("youtube music - Google Chrome"))
assert(window_rules.isYouTubeTitle("YOUTUBE - Google Chrome"))
assert(not window_rules.isYouTubeTitle("Documentation - Google Chrome"))
assert(not window_rules.isYouTubeTitle(nil))
assert(type(window_rules.isYouTubeWindow) == "function", "isYouTubeWindow is missing")
assert(window_rules.isYouTubeWindow(window("Google Chrome", "Video - YouTube")))
assert(not window_rules.isYouTubeWindow(window("Safari", "Video - YouTube")))
assert(not window_rules.isYouTubeWindow(window("Google Chrome", "Documentation")))
assert(not window_rules.isYouTubeWindow(window(nil, "Video - YouTube")))

assert(type(window_rules.forEachManagedWindow) == "function", "forEachManagedWindow is missing")
local ignored_window_calls = 0
window_rules.forEachManagedWindow({ window("Google Chrome", "Video - YouTube") }, function()
    ignored_window_calls = ignored_window_calls + 1
end)
assert(ignored_window_calls == 0, "YouTube Chrome window reached a layout callback")

local managed_windows = {}
local ordinary_chrome = window("Google Chrome", "Documentation")
local youtube_safari = window("Safari", "Video - YouTube")
window_rules.forEachManagedWindow({
    window("Google Chrome", "Video - YouTube"),
    ordinary_chrome,
    youtube_safari,
}, function(win)
    table.insert(managed_windows, win)
end)
assert(#managed_windows == 2)
assert(managed_windows[1] == ordinary_chrome)
assert(managed_windows[2] == youtube_safari)
LUA

echo "PASS: layout ignores Chrome windows with YouTube titles"
