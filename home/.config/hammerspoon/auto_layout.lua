local M = {}

local function screensReady()
    local positions = {}
    for _, position in pairs(hs.screen.screenPositions()) do
        positions[position.x] = true
    end
    return positions[0] and positions[1] and positions[2] or false
end

function M.start(layout)
    local applied = screensReady()
    local systemSleeping = false
    local screensSleeping = false
    local locked = false
    local events = hs.caffeinate.watcher

    local function check()
        if not screensReady() then
            applied = false
            return
        end
        if applied or systemSleeping or screensSleeping or locked then
            return
        end
        applied = true
        local ok, err = pcall(layout)
        if not ok then
            applied = false
            error(err, 0)
        end
    end

    local function powerChanged(event)
        if event == events.systemWillSleep then
            systemSleeping = true
            applied = false
        elseif event == events.screensDidSleep then
            screensSleeping = true
            applied = false
        elseif event == events.screensDidLock then
            locked = true
        elseif event == events.systemDidWake then
            systemSleeping = false
            check()
        elseif event == events.screensDidWake then
            screensSleeping = false
            check()
        elseif event == events.screensDidUnlock then
            locked = false
            check()
        end
    end

    local watchers = {}
    watchers.screen = hs.screen.watcher.new(check):start()
    watchers.power = events.new(powerChanged):start()
    return watchers
end

return M