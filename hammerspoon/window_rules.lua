local M = {}

function M.isYouTubeTitle(title)
    return type(title) == "string" and title:lower():find("youtube", 1, true) ~= nil
end

function M.isYouTubeWindow(win)
    local app = win:application()
    return app and app:name() == "Google Chrome" and M.isYouTubeTitle(win:title())
end

function M.forEachManagedWindow(windows, callback)
    for _, win in ipairs(windows) do
        if not M.isYouTubeWindow(win) then
            callback(win)
        end
    end
end

local function isUsableWindow(win)
    local ok, visible, standard, frame = pcall(function()
        return win:isVisible(), win:isStandard(), win:frame()
    end)

    return ok and visible and standard and frame.w > 0 and frame.h > 0
end

function M.forEachUsableManagedWindow(windows, callback)
    for _, win in ipairs(windows) do
        if isUsableWindow(win) and not M.isYouTubeWindow(win) then
            callback(win)
        end
    end
end

function M.classifyZoomWindows(windows)
    local result = { meetings = {} }

    for _, win in ipairs(windows) do
        if isUsableWindow(win) then
            local title = win:title()
            if title == "Zoom Meeting" then
                table.insert(result.meetings, win)
            elseif title == "Zoom Workplace" then
                result.main = win
            end
        end
    end

    return result
end

function M.planZoomMeetingLayout(meetings, isTop)
    local first = meetings[1]
    local second = meetings[2]

    if not second then
        return first
    end

    if isTop(first) then
        return second, first
    end

    return first, second
end

return M
